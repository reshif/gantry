-- API keys, request log and triggers (spec 8.8, 11.7, 12.5).
-- The request log keeps how long each public API request took; keys remember who revoked them.
alter table api_requests add column if not exists duration_ms int not null default 0;
alter table api_requests add column if not exists project_id text;
create index if not exists api_requests_key_idx on api_requests (org_id, key_id, at desc);
alter table api_keys add column if not exists revoked_by text;

-- Triggers: next_run_at drives schedule triggers (the worker fires what is due), created_by names the person who set the trigger up.
alter table triggers add column if not exists next_run_at timestamptz;
alter table triggers add column if not exists last_fired_at timestamptz;
alter table triggers add column if not exists created_by text;
create index if not exists triggers_due_idx on triggers (org_id, next_run_at) where enabled and next_run_at is not null;

-- A run records the source it saw (repo#issue, PR, build, schedule tick) and a dedupe key, so a replayed delivery creates nothing new.
alter table trigger_runs add column if not exists source text not null default '';
alter table trigger_runs add column if not exists project_id text;
alter table trigger_runs add column if not exists dedupe_key text;
create unique index if not exists trigger_runs_dedupe_idx on trigger_runs (org_id, trigger_id, dedupe_key) where dedupe_key is not null;
create index if not exists trigger_runs_trigger_idx on trigger_runs (org_id, trigger_id, at desc);

-- A held proposal (spec 11.7): the acting source user does not map to a Gantry identity allowed to submit, or the trigger always asks a person (failing build).
-- A person with the right to submit releases it (it then becomes a work order through the ordinary submission) or declines it.
create table if not exists trigger_proposals (
  org_id uuid not null references orgs(id),
  id text not null,
  trigger_id text not null,
  project_id text not null,
  repo_id text,
  title text not null,
  description text not null default '',
  requested_class text,
  priority text,
  source text not null default '',
  actor text,
  reason text not null default '',
  status text not null default 'held' check (status in ('held','released','declined')),
  wo_id text,
  decided_by text,
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, trigger_id) references triggers(org_id, id) on delete cascade
);
create index if not exists trigger_proposals_status_idx on trigger_proposals (org_id, project_id, status);
grant select, insert, update, delete on trigger_proposals to gantry_app;
