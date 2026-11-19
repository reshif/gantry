-- Operator recovery for a Factory Admin locked out by the IP allow-list (S-24). A window is opened only by the operator command on the server
-- host (never by a route): it lets ONE sign-in by ONE named admin through from any address, once, before it expires. The session that sign-in
-- creates may use the API from that same address for a short time (long enough to confirm adding the address to the allow-list in the app).
create table allowlist_recovery (
  org_id uuid not null,
  id text not null,
  person_id text not null,
  status text not null default 'open' check (status in ('open', 'used', 'added', 'declined', 'replaced')),
  expires_at timestamptz not null,
  opened_by text not null default 'operator',
  used_at timestamptz,
  used_ip inet,
  session_id text,
  created_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id)
);
create index allowlist_recovery_person_idx on allowlist_recovery (org_id, person_id, status);
grant select, insert, update on allowlist_recovery to gantry_app;
