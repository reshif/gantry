-- Repo onboarding at runtime (spec 8.6, 11.3): the failed stage, run metadata, live verification results and the readiness state of a repo.

alter table repos drop constraint if exists repos_onboarding_stage_check;
alter table repos add constraint repos_onboarding_stage_check
  check (onboarding_stage in ('connected', 'assessed', 'pr_opened', 'pr_checks', 'pr_merged', 'verified', 'ready', 'person', 'failed'));

-- Readiness re-check (spec 11.3): when the last live verification ran, whether it held, and how many in a row did not (a broker outage is unknown and never counts).
alter table repos add column if not exists readiness_checked_at timestamptz;
alter table repos add column if not exists readiness_state text not null default 'unknown' check (readiness_state in ('ok', 'lost', 'unknown'));
alter table repos add column if not exists readiness_failures int not null default 0;

-- One row per assessment: who asked, the agent and adapter that ran, the facts it read and the guideline versions it checked against.
alter table onboarding_runs add column if not exists started_by text;
alter table onboarding_runs add column if not exists data jsonb not null default '{}';

-- A finding is required (blocks Ready) or advisory, from the guideline item it checks.
alter table onboarding_findings add column if not exists required boolean not null default false;
alter table onboarding_findings add column if not exists detail text not null default '';

alter table onboarding_prs add column if not exists head_sha text;
alter table onboarding_prs add column if not exists url text;
alter table onboarding_prs add column if not exists data jsonb not null default '{}';

-- Live checks (spec 11.3 "Verified means"): every run of the list, kept so a person can see what held and what did not.
create table onboarding_verifications (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  run_id text,
  trigger text not null check (trigger in ('merge', 'manual', 'schedule')),
  ok boolean not null,
  unavailable boolean not null default false,
  checks jsonb not null default '[]',
  requested_by text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, repo_id) references repos(org_id, id) on delete cascade
);
create index onboarding_verifications_repo_idx on onboarding_verifications (org_id, repo_id, checked_at desc);

grant select, insert, update, delete on onboarding_verifications to gantry_app;
