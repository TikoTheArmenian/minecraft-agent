-- Explicit repair after stopping the old worker. Normal transfers remain quarantined.
create or replace function public.colony_reconcile_rpc(action text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, colony as $$
declare
  w uuid := (payload->>'world')::uuid; d text := payload->>'dimension';
  s uuid := (payload->>'session')::uuid; cid text := payload->>'container';
  tok uuid := (payload->>'token')::uuid;
  c colony.containers; l colony.leases;
begin
  if w is null or d is null or s is null or tok is null then raise exception 'Colony: Invalid reconciliation scope.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(w::text || ':' || d,0));
  select * into c from colony.containers where world=w and dimension=d and id=cid;
  if c.id is null then raise exception 'Colony: Unknown chest.'; end if;
  select * into l from colony.leases where world=w and dimension=d and container=cid;
  if action='reconcile_acquire' then
    if l.expires_at>now() then raise exception 'Colony: Chest is still leased; stop the worker and wait for expiry.'; end if;
    if exists(select 1 from colony.operations o join colony.sessions b
      on b.world=o.world and b.dimension=o.dimension and b.session=o.session
      where o.world=w and o.dimension=d and o.container=cid and o.state='pending'
      and b.seen_at>now()-interval '90 seconds') then
      raise exception 'Colony: Original worker was recently active. Disconnect it before reconciling.';
    end if;
    insert into colony.leases values(w,d,cid,tok,s,now()+interval '90 seconds')
      on conflict(world,dimension,container) do update set token=tok,session=s,expires_at=now()+interval '90 seconds';
    return to_jsonb(c);
  elsif action='reconcile_finish' then
    if l.token is distinct from tok or l.session is distinct from s or l.expires_at<=now() then
      raise exception 'Colony: Reconciliation lease was lost.';
    end if;
    if jsonb_typeof(payload->'slots') is distinct from 'array' or jsonb_array_length(payload->'slots')>c.capacity then
      raise exception 'Colony: Invalid reconciliation snapshot.';
    end if;
    update colony.jobs set state='blocked',detail='Transfer reconciled by inspection; review remaining work before a new job.',updated_at=now()
      where world=w and dimension=d and id in (select job from colony.operations where world=w and dimension=d and container=cid and state='pending');
    delete from colony.reservations where world=w and dimension=d and job in
      (select job from colony.operations where world=w and dimension=d and container=cid and state='pending');
    update colony.operations set state='reconciled',detail=detail || jsonb_build_object(
      'reconciledAt',now(),'inspectorSession',s,'observedSlots',payload->'slots','inspectorInventory',payload->'playerInventory')
      where world=w and dimension=d and container=cid and state='pending';
    update colony.containers set slots=payload->'slots',checked_at=now(),revision=revision+1 where world=w and dimension=d and id=cid;
    return '{}'::jsonb;
  else raise exception 'Colony: Unknown reconciliation action.';
  end if;
end $$;
revoke all on function public.colony_reconcile_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.colony_reconcile_rpc(text,jsonb) to service_role;
notify pgrst, 'reload schema';
