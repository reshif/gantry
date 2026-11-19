-- OIDC back-channel logout (S-72, G-A5): the `jti` of every accepted logout token, so a replay is refused by every API process and after a restart.
-- Written in the same transaction as the session revocation (unique key), and cleaned up once the token's own window (5 minutes) is long past.
-- Numbered 0054: 0053 belongs to the MFA branch.
create table backchannel_logout_jti (
  org_id uuid not null,
  jti text not null,
  seen_at timestamptz not null default clock_timestamp(),
  primary key (org_id, jti)
);
create index backchannel_logout_jti_seen_idx on backchannel_logout_jti (seen_at);
grant select, insert, delete on backchannel_logout_jti to gantry_app;
