-- MFA merge gate (G-M1, G-M2, G-M9).
--   idp_admin_log   every change Gantry's own identity-provider client makes (not reads): the watcher compares the provider's admin events with it,
--                   and a credential or password change with no matching row here is a change made outside Gantry (auth.mfa_changed_outside).
--   people.mfa_link_at  when Gantry last sent the person a one-time enrolment link; a factor first seen with no link and no baseline is suspicious.
--   people.mfa      backfilled from the sessions that already carried a second factor (the column was never written before 0053).
create table idp_admin_log (
  id bigserial primary key,
  org_id uuid not null,
  method text not null,
  path text not null,
  at timestamptz not null default clock_timestamp()
);
create index idp_admin_log_at_idx on idp_admin_log (org_id, at);
grant select, insert on idp_admin_log to gantry_app;
grant usage on sequence idp_admin_log_id_seq to gantry_app;

alter table people add column mfa_link_at timestamptz;

update people p set mfa = true, mfa_checked_at = coalesce(mfa_checked_at, now())
 where exists (select 1 from sessions s where s.org_id = p.org_id and s.person_id = p.id and s.second_factor);
