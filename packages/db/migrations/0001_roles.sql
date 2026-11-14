-- migrate:login-role
-- Roles. gantry_owner owns the schema and runs migrations; gantry_app is what services connect as.
-- Passwords are never in SQL: the migrate entry sets gantry_app's password from the secret file.
create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gantry_owner') then
    create role gantry_owner login nocreatedb nocreaterole nosuperuser;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'gantry_app') then
    create role gantry_app login nocreatedb nocreaterole nosuperuser;
  end if;
end $$;

-- gantry_app must never create objects or inherit owner powers.
alter role gantry_app nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

revoke create on schema public from public;
grant usage, create on schema public to gantry_owner;
grant usage on schema public to gantry_app;
