-- World IDs are generated once by Postgres and reused by every bot/controller.
create table if not exists colony.worlds (
  id uuid primary key default gen_random_uuid(),
  label text not null unique check (length(label) between 1 and 64),
  created_at timestamptz not null default now()
);
alter table colony.worlds enable row level security;

create or replace function public.colony_resolve_world(p_label text, p_existing_id uuid default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, colony as $$
declare result uuid; preferred uuid;
begin
  if p_label is null or p_label <> btrim(p_label) or length(p_label) not between 1 and 64 then
    raise exception 'Colony: Use a world label between 1 and 64 characters.';
  end if;
  -- Adopt a legacy configured UUID only if it already owns data. Example placeholders
  -- must not become world identity just because .env.example was copied.
  if p_existing_id is not null and (
    exists(select 1 from colony.containers where world=p_existing_id) or
    exists(select 1 from colony.jobs where world=p_existing_id) or
    exists(select 1 from colony.sessions where world=p_existing_id)
  ) then preferred := p_existing_id; end if;
  insert into colony.worlds(id,label) values(coalesce(preferred,gen_random_uuid()),p_label)
    on conflict(label) do update set label=excluded.label returning id into result;
  return result;
end $$;
revoke all on function public.colony_resolve_world(text,uuid) from public,anon,authenticated;
grant execute on function public.colony_resolve_world(text,uuid) to service_role;
notify pgrst, 'reload schema';
