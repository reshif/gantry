-- Worker liveness for the system health view. Each worker process upserts one row per organisation every few seconds; the API reads the newest.
-- The worker has no HTTP port, so the database is the one place both containers share. Live workers prune rows older than a day.
create table if not exists worker_heartbeats (
  org_id uuid not null references orgs (id),
  worker_id text not null,
  started_at timestamptz not null default now(),
  seen_at timestamptz not null default now(),
  -- The launcher is only reachable from the worker's network, so the worker reports whether it answered its last probe.
  launcher_ok boolean,
  launcher_checked_at timestamptz,
  primary key (org_id, worker_id)
);
grant select, insert, update, delete on worker_heartbeats to gantry_app;
