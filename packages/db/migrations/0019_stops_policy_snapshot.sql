-- Break-glass snapshot for the stop path (spec 8.5, I7). The API refreshes it after every successful policy load; only the stop path reads it,
-- and only when the live policy tables cannot be read. It holds the people, role grants, role matrix, policies and catalogue roles/actions
-- that halt, kill and restore decisions need, plus project and repo names so a stop target can still be resolved.
create table if not exists stop_policy_snapshot (
  org_id uuid primary key references orgs (id),
  snapshot jsonb not null,
  digest text not null,
  taken_at timestamptz not null default now()
);
grant select, insert, update, delete on stop_policy_snapshot to gantry_app;
