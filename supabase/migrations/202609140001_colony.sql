-- Private shared world memory. Only the trusted bot backend may call this RPC.
create schema if not exists colony;
revoke all on schema colony from public;
create table colony.containers (
  world uuid not null, dimension text not null, id text not null,
  position jsonb not null, blocks jsonb not null, category text not null default 'overflow',
  managed boolean not null default false, slots jsonb not null default '[]',
  capacity integer not null default 27 check (capacity in (27,54)),
  revision bigint not null default 0, checked_at timestamptz,
  primary key(world,dimension,id),
  check (category in ('tools','wood','building','food','materials','overflow'))
);
create table colony.sessions (
  world uuid not null, dimension text not null, session uuid not null,
  bot text not null, seen_at timestamptz not null default now(),
  primary key(world,dimension,session)
);
create table colony.leases (
  world uuid not null, dimension text not null, container text not null,
  token uuid not null, session uuid not null, expires_at timestamptz not null,
  primary key(world,dimension,container),
  foreign key(world,dimension,container) references colony.containers(world,dimension,id)
);
create table colony.jobs (
  world uuid not null, dimension text not null, id uuid not null,
  item text not null, quantity integer not null check(quantity between 1 and 128),
  state text not null default 'queued' check(state in ('queued','running','complete','blocked','cancelled')),
  session uuid, detail text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(world,dimension,id)
);
create table colony.operations (
  world uuid not null, dimension text not null, id uuid not null,
  container text, session uuid not null, token uuid, job uuid,
  kind text not null check(kind in ('deposit','withdraw','craft')),
  state text not null default 'pending' check(state in ('pending','confirmed','reconciled')),
  detail jsonb not null, created_at timestamptz not null default now(),
  primary key(world,dimension,id)
);
create index on colony.operations(world,dimension,container) where state='pending';
create table colony.reservations (
  world uuid not null, dimension text not null, job uuid not null,
  container text not null, fingerprint text not null, quantity integer not null check(quantity>0),
  primary key(world,dimension,job,container,fingerprint),
  foreign key(world,dimension,job) references colony.jobs(world,dimension,id),
  foreign key(world,dimension,container) references colony.containers(world,dimension,id)
);
-- No browser roles can directly access these tables, even if a schema is later exposed.
alter table colony.containers enable row level security;
alter table colony.sessions enable row level security;
alter table colony.leases enable row level security;
alter table colony.jobs enable row level security;
alter table colony.operations enable row level security;
alter table colony.reservations enable row level security;

create or replace function public.colony_rpc(action text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, colony as $$
declare
  w uuid := (payload->>'world')::uuid;
  d text := payload->>'dimension';
  s uuid := (payload->>'session')::uuid;
  cid text := payload->>'container';
  tok uuid := (payload->>'token')::uuid;
  jid uuid := (payload->>'job')::uuid;
  oid uuid := (payload->>'operation')::uuid;
  rowc colony.containers; rowl colony.leases; rowj colony.jobs; rowo colony.operations;
  r jsonb; available integer; reserved integer;
begin
  if w is null or s is null or d is null or length(d)>100 or length(payload->>'bot')>64 then
    raise exception 'Colony: Invalid world or session.';
  end if;
  -- Serializes short metadata transactions across processes, never Minecraft actions.
  perform pg_advisory_xact_lock(hashtextextended(w::text || ':' || d,0));
  insert into colony.sessions(world,dimension,session,bot) values(w,d,s,payload->>'bot')
    on conflict(world,dimension,session) do update set seen_at=now();
  update colony.jobs set state='blocked',detail='Worker stopped responding; inspect carried items before retrying.',updated_at=now()
    where world=w and dimension=d and state='running' and updated_at < now()-interval '5 minutes';
  delete from colony.reservations rr using colony.jobs j where rr.world=w and rr.dimension=d
    and j.world=rr.world and j.dimension=rr.dimension and j.id=rr.job and j.state<>'running';

  if action='list' then
    return jsonb_build_object(
      'containers',coalesce((select jsonb_agg(to_jsonb(c)) from
        (select * from colony.containers where world=w and dimension=d order by id limit 256) c),'[]'::jsonb),
      'jobs',coalesce((select jsonb_agg(to_jsonb(j)) from
        (select * from colony.jobs where world=w and dimension=d order by created_at desc limit 100) j),'[]'::jsonb),
      'reservations',coalesce((select jsonb_agg(to_jsonb(rr)) from colony.reservations rr where world=w and dimension=d),'[]'::jsonb),
      'uncertain',coalesce((select jsonb_agg(to_jsonb(o)) from
        (select * from colony.operations where world=w and dimension=d and state='pending' order by created_at desc limit 100) o),'[]'::jsonb));
  elsif action='register' then
    if cid is null or length(cid)>100 or jsonb_array_length(payload->'blocks') not between 1 and 2 then
      raise exception 'Colony: Invalid container.';
    end if;
    insert into colony.containers(world,dimension,id,position,blocks,capacity)
      values(w,d,cid,payload->'position',payload->'blocks',(payload->>'capacity')::integer)
      on conflict(world,dimension,id) do nothing;
    -- A changed double-chest topology requires explicit repair, not duplicate inventory.
    if exists(select 1 from colony.containers c where world=w and dimension=d and id<>cid
      and exists(select 1 from jsonb_array_elements(c.blocks) b where payload->'blocks' @> jsonb_build_array(b))) then
      raise exception 'Colony: Chest topology changed. Resolve the old registration before using it.';
    end if;
    return '{}'::jsonb;
  elsif action='enqueue' then
    insert into colony.jobs(world,dimension,id,item,quantity)
      values(w,d,jid,payload->>'item',(payload->>'quantity')::integer) on conflict do nothing;
    return jsonb_build_object('id',jid);
  elsif action='claim_job' then
    select * into rowj from colony.jobs where world=w and dimension=d and state='queued'
      and (jid is null or id=jid) order by created_at limit 1;
    if rowj.id is null then return 'null'::jsonb; end if;
    update colony.jobs set state='running',session=s,updated_at=now() where world=w and dimension=d and id=rowj.id
      returning * into rowj;
    return to_jsonb(rowj);
  elsif action in ('job_status','reserve') then
    select * into rowj from colony.jobs where world=w and dimension=d and id=jid;
    if rowj.state<>'running' or rowj.session<>s or rowj.id is null then
      raise exception 'Colony: Job ownership was lost.';
    end if;
    if action='job_status' then
      update colony.jobs set state=payload->>'state',detail=left(payload->>'detail',1000),updated_at=now()
        where world=w and dimension=d and id=jid;
      if payload->>'state'<>'running' then delete from colony.reservations where world=w and dimension=d and job=jid; end if;
    else
      delete from colony.reservations where world=w and dimension=d and job=jid;
      for r in select * from jsonb_array_elements(payload->'items') loop
        select coalesce(sum((v->>'count')::integer),0) into available from colony.containers c,
          lateral jsonb_array_elements(c.slots) v where c.world=w and c.dimension=d and c.id=r->>'container'
          and c.managed and c.checked_at>now()-interval '5 minutes' and v->>'fingerprint'=r->>'fingerprint';
        select coalesce(sum(quantity),0) into reserved from colony.reservations where world=w and dimension=d
          and container=r->>'container' and fingerprint=r->>'fingerprint';
        if (r->>'quantity')::integer>available-reserved then raise exception 'Colony: Ingredients changed or were reserved by another bot. Scan and retry.'; end if;
        insert into colony.reservations values(w,d,jid,r->>'container',r->>'fingerprint',(r->>'quantity')::integer);
      end loop;
      update colony.jobs set updated_at=now() where world=w and dimension=d and id=jid;
    end if;
    return '{}'::jsonb;
  end if;

  if action='begin' and payload->>'kind'='craft' then
    select * into rowj from colony.jobs where world=w and dimension=d and id=jid;
    if rowj.id is null or rowj.state<>'running' or rowj.session<>s then raise exception 'Colony: Job ownership was lost.'; end if;
    insert into colony.operations(world,dimension,id,session,job,kind,detail)
      values(w,d,oid,s,jid,'craft',payload->'detail');
    return '{}'::jsonb;
  elsif action='finish_craft' then
    update colony.operations set state='confirmed' where world=w and dimension=d and id=oid
      and session=s and kind='craft' and state='pending';
    if not found then raise exception 'Colony: Craft operation ownership was lost.'; end if;
    return '{}'::jsonb;
  end if;

  select * into rowc from colony.containers where world=w and dimension=d and id=cid;
  if rowc.id is null then raise exception 'Colony: Unknown chest.'; end if;
  select * into rowl from colony.leases where world=w and dimension=d and container=cid;
  if action='acquire' then
    if exists(select 1 from colony.operations where world=w and dimension=d and container=cid and state='pending') then
      raise exception 'Colony: Chest has an uncertain transfer. Stop its worker and reconcile inventories before reuse.';
    end if;
    if rowl.expires_at>now() then raise exception 'Colony: Another bot is using this chest.'; end if;
    insert into colony.leases values(w,d,cid,tok,s,now()+interval '90 seconds')
      on conflict(world,dimension,container) do update set token=tok,session=s,expires_at=now()+interval '90 seconds';
    return to_jsonb(rowc);
  end if;
  if rowl.token is distinct from tok or rowl.session is distinct from s then raise exception 'Colony: Chest lease ownership was lost.'; end if;
  if action='release' then
    delete from colony.leases where world=w and dimension=d and container=cid;
    return '{}'::jsonb;
  end if;
  if rowl.expires_at<=now() and action<>'finish' then raise exception 'Colony: Chest lease expired.'; end if;
  if action='renew' then
    update colony.leases set expires_at=now()+interval '90 seconds' where world=w and dimension=d and container=cid;
  elsif action='manage' then
    update colony.containers set managed=true,category=payload->>'category' where world=w and dimension=d and id=cid;
  elsif action in ('snapshot','finish') then
    if jsonb_array_length(payload->'slots')>rowc.capacity then raise exception 'Colony: Invalid chest snapshot.'; end if;
    if action='finish' then
      select * into rowo from colony.operations where world=w and dimension=d and id=oid and container=cid;
      if rowo.session is distinct from s or rowo.token is distinct from tok or rowo.state<>'pending' then
        raise exception 'Colony: Transfer operation ownership was lost.';
      end if;
      update colony.operations set state='confirmed' where world=w and dimension=d and id=oid;
      if rowo.job is not null and rowo.kind='withdraw' then
        update colony.reservations set quantity=quantity-(rowo.detail->>'count')::integer
          where world=w and dimension=d and job=rowo.job and container=cid
          and fingerprint=rowo.detail->>'fingerprint' and quantity>(rowo.detail->>'count')::integer;
        if not found then delete from colony.reservations where world=w and dimension=d and job=rowo.job
          and container=cid and fingerprint=rowo.detail->>'fingerprint'; end if;
      end if;
    end if;
    update colony.containers set slots=payload->'slots',checked_at=now(),revision=revision+1
      where world=w and dimension=d and id=cid;
  elsif action='begin' then
    if not rowc.managed then raise exception 'Colony: Enroll this chest before changing its contents.'; end if;
    if exists(select 1 from colony.operations where world=w and dimension=d and container=cid and state='pending') then
      raise exception 'Colony: Chest has an uncertain transfer.';
    end if;
    if payload->>'kind'='withdraw' then
      select coalesce(sum((v->>'count')::integer),0) into available from jsonb_array_elements(rowc.slots) v
        where v->>'fingerprint'=payload->'detail'->>'fingerprint';
      select coalesce(sum(quantity),0) into reserved from colony.reservations where world=w and dimension=d and container=cid
        and fingerprint=payload->'detail'->>'fingerprint' and (jid is null or job<>jid);
      if (payload->'detail'->>'count')::integer>available-reserved then raise exception 'Colony: Items are reserved by another job.'; end if;
    end if;
    if jid is not null and not exists(select 1 from colony.jobs where world=w and dimension=d and id=jid and state='running' and session=s) then
      raise exception 'Colony: Job ownership was lost.';
    end if;
    insert into colony.operations(world,dimension,id,container,session,token,job,kind,detail)
      values(w,d,oid,cid,s,tok,jid,payload->>'kind',payload->'detail');
  else raise exception 'Colony: Unknown operation.';
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.colony_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.colony_rpc(text,jsonb) to service_role;
