-- The ledger's SECURITY DEFINER functions run as the schema owner (a superuser in the default install). Their search_path put `public`
-- first and left `pg_temp` implicit, which Postgres searches FIRST for relations: a session holding TEMP on the database could create a
-- temp table named event_counters and make the trigger read and write that instead, forging seq and the chain head. Fixed twice over:
-- pg_temp is pinned last (so it can never shadow a real table), and the application role no longer holds TEMP.

create or replace function gantry_events_before_insert() returns trigger language plpgsql
  security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  c public.event_counters;
begin
  insert into public.event_counters (org_id) values (new.org_id) on conflict (org_id) do nothing;
  select * into c from public.event_counters where org_id = new.org_id for update;
  new.seq := c.last_seq + 1;
  new.prev_hash := c.last_hash;
  new.recorded_at := clock_timestamp();
  new.hash := public.gantry_event_hash(new);
  update public.event_counters set last_seq = new.seq, last_hash = new.hash where org_id = new.org_id;
  return new;
end $$;

create or replace function gantry_event_head(p_org uuid) returns table (last_seq bigint, last_hash text)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select last_seq, last_hash from public.event_counters where org_id = p_org
$$;

do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
  if exists (select 1 from pg_roles where rolname = 'gantry_app') then
    execute format('revoke temporary on database %I from gantry_app', current_database());
  end if;
end $$;
