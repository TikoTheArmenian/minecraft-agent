-- One explicit destination area per world/dimension, shared by every controller.
create table if not exists colony.storage_hubs (
  world uuid not null, dimension text not null, position jsonb not null,
  primary key(world, dimension)
);
alter table colony.storage_hubs enable row level security;
create or replace function public.colony_hub_rpc(action text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, colony as $$
declare w uuid := (payload->>'world')::uuid; d text := payload->>'dimension'; p jsonb;
begin
  if w is null or d is null then raise exception 'Colony: Invalid hub scope.'; end if;
  if action='hub_set' then
    p := payload->'position';
    if p is null or jsonb_typeof(p->'x') is distinct from 'number' or jsonb_typeof(p->'y') is distinct from 'number' or jsonb_typeof(p->'z') is distinct from 'number'
      or abs((p->>'x')::numeric)>30000000 or abs((p->>'z')::numeric)>30000000 or (p->>'y')::numeric not between -64 and 319 then
      raise exception 'Colony: Invalid hub position.';
    end if;
    insert into colony.storage_hubs values(w,d,p) on conflict(world,dimension) do update set position=excluded.position;
  elsif action<>'hub_get' then raise exception 'Colony: Unknown hub action.';
  end if;
  select position into p from colony.storage_hubs where world=w and dimension=d;
  return jsonb_build_object('position',p);
end $$;
revoke all on function public.colony_hub_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.colony_hub_rpc(text,jsonb) to service_role;
notify pgrst, 'reload schema';
