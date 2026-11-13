-- gantry_app gets the minimum. Nothing is granted by default privileges: a new table has no app access until granted here.

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename not in ('schema_migrations','event_counters') loop
    execute format('grant select, insert, update, delete on %I to gantry_app', t);
  end loop;
end $$;

-- Append-only: no UPDATE, DELETE or TRUNCATE.
revoke all on events, gate_decisions from gantry_app;
grant select, insert on events, gate_decisions to gantry_app;
-- Organisations are never deleted by services.
revoke delete on orgs from gantry_app;

grant usage, select on all sequences in schema public to gantry_app;

-- event_counters and schema_migrations are reachable only through the SECURITY DEFINER trigger and the owner.
revoke all on event_counters from gantry_app;
