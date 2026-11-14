-- Work orders, execution, code, gates and stop state (spec 7.3).

create sequence attempt_fencing_seq as bigint;

create table work_orders (
  org_id uuid not null,
  id text not null,
  project_id text not null,
  repo_id text,
  title text not null,
  class text not null,
  priority text not null default 'P2',
  source text not null default 'web',
  position text not null,                 -- station id or bay id: one position per work order
  state text not null check (state in ('running','waiting','blocked','failed','parked','killed','done','declined')),
  flow_version int not null,
  assignee text,
  submitter text,
  parent_id text,
  risk text,
  size_est text,
  sla_due_at timestamptz,
  closed_at timestamptz,
  data jsonb not null default '{}',
  version int not null default 1,           -- increases on every change
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, project_id) references projects(org_id, id),
  foreign key (org_id, repo_id) references repos(org_id, id),
  foreign key (org_id, project_id, flow_version) references flow_versions(org_id, project_id, version)
);
create index work_orders_project_idx on work_orders (org_id, project_id, state);
create index work_orders_position_idx on work_orders (org_id, project_id, position);
create index work_orders_assignee_idx on work_orders (org_id, assignee) where assignee is not null;

create table requests (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  original_text text not null,           -- verbatim
  submitted_by text,
  via text not null default 'web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, wo_id),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);

create table conversations (
  org_id uuid not null,
  id text not null,
  wo_id text,
  project_id text,
  kind text not null default 'intake',
  status text not null default 'open' check (status in ('open','answered','closed')),
  opened_by text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);
create index conversations_wo_idx on conversations (org_id, wo_id);

create table messages (
  org_id uuid not null,
  id text not null,
  conversation_id text not null,
  author text not null,
  author_kind text not null check (author_kind in ('person','agent','system')),
  kind text not null default 'text',
  body text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, conversation_id) references conversations(org_id, id)
);
create index messages_conversation_idx on messages (org_id, conversation_id, created_at);

create table brief_versions (
  org_id uuid not null,
  wo_id text not null,
  version int not null,
  body jsonb not null,
  class text,
  route jsonb,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, wo_id, version),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);

create table epic_children (
  org_id uuid not null,
  epic_id text not null,
  child_id text not null,
  ord int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, epic_id, child_id),
  foreign key (org_id, epic_id) references work_orders(org_id, id),
  foreign key (org_id, child_id) references work_orders(org_id, id)
);

create table bay_stays (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  bay text not null,
  reason text not null default '',
  entered_by text,
  entered_at timestamptz not null default now(),
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);
create index bay_stays_wo_idx on bay_stays (org_id, wo_id);

create table slots (
  org_id uuid not null,
  id text not null,
  project_id text not null,
  repo_id text,
  wo_id text,
  attempt_id text,
  state text not null default 'free' check (state in ('free','held','queued')),
  acquired_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, project_id) references projects(org_id, id)
);
create index slots_project_idx on slots (org_id, project_id, state);

-- ---------- Execution ----------

create table agent_version_tuples (
  org_id uuid not null,
  id text not null,
  agent_id text not null,
  agent_version int not null,
  skill_versions jsonb not null default '{}',
  instruction_hash text not null,
  harness_version text not null,
  model_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, agent_id, agent_version, instruction_hash, harness_version, model_id, skill_versions)
);

create table attempts (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  station text not null,
  visit int not null,
  fencing bigint not null default nextval('attempt_fencing_seq'),
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','cancelled','superseded')),
  lease_holder text,
  lease_until timestamptz,
  tuple_id text,
  outcome text,
  started_at timestamptz,
  ended_at timestamptz,
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, wo_id, station, visit),
  unique (fencing),
  foreign key (org_id, wo_id) references work_orders(org_id, id),
  foreign key (org_id, tuple_id) references agent_version_tuples(org_id, id)
);
create index attempts_wo_idx on attempts (org_id, wo_id);
create index attempts_lease_idx on attempts (lease_until) where state = 'running';

create table runs (
  org_id uuid not null,
  id text not null,
  attempt_id text not null,
  wo_id text not null,
  state text not null default 'starting' check (state in ('starting','running','succeeded','failed','stopped','reaped')),
  container_id text,
  model_id text,
  exit_code int,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  pinned boolean not null default false,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, attempt_id) references attempts(org_id, id),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);
create index runs_attempt_idx on runs (org_id, attempt_id);

create table run_usage (
  org_id uuid not null,
  id bigint generated always as identity,
  run_id text not null,
  attempt_id text,
  wo_id text,
  project_id text,
  model_id text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  cost_micros bigint not null default 0,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, run_id) references runs(org_id, id)
);
create index run_usage_run_idx on run_usage (org_id, run_id);

create table artefacts (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  attempt_id text,
  kind text not null,
  name text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),   -- object storage key sha256/<hash>
  media_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);
create index artefacts_wo_idx on artefacts (org_id, wo_id);

create table checkpoints (
  org_id uuid not null,
  id text not null,
  run_id text not null,
  attempt_id text not null,
  seq int not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, run_id, seq),
  foreign key (org_id, run_id) references runs(org_id, id)
);

create table station_results (
  org_id uuid not null,
  id text not null,
  attempt_id text not null,
  wo_id text not null,
  station text not null,
  outcome text not null,
  summary text not null default '',
  body jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, attempt_id) references attempts(org_id, id),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);

-- ---------- Code (copied from GitHub when it occurs, keyed by GitHub ids) ----------

create table pull_requests (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  wo_id text,
  number int not null,
  github_id bigint,
  title text not null,
  state text not null default 'open' check (state in ('open','closed','merged')),
  draft boolean not null default false,
  head_sha text,
  base_branch text,
  head_branch text,
  url text,
  merged_at timestamptz,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, repo_id, number),
  foreign key (org_id, repo_id) references repos(org_id, id)
);
create index pull_requests_wo_idx on pull_requests (org_id, wo_id);

create table commits (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  sha text not null,
  wo_id text,
  pr_id text,
  author text,
  message text not null default '',
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, repo_id, sha),
  foreign key (org_id, repo_id) references repos(org_id, id)
);
create index commits_wo_idx on commits (org_id, wo_id);

create table changed_files (
  org_id uuid not null,
  id text not null,
  pr_id text,
  commit_id text,
  path text not null,
  status text not null default 'modified',
  additions int not null default 0,
  deletions int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index changed_files_pr_idx on changed_files (org_id, pr_id);

create table patches (
  org_id uuid not null,
  id text not null,
  wo_id text,
  pr_id text,
  commit_id text,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table reviews (
  org_id uuid not null,
  id text not null,
  pr_id text not null,
  github_id bigint,
  reviewer text not null,
  state text not null,
  body text not null default '',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, pr_id) references pull_requests(org_id, id)
);

create table review_comments (
  org_id uuid not null,
  id text not null,
  review_id text not null,
  github_id bigint,
  path text,
  line int,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, review_id) references reviews(org_id, id)
);

create table checks (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  pr_id text,
  head_sha text not null,
  name text not null,
  status text not null default 'queued' check (status in ('queued','in_progress','completed')),
  conclusion text,
  required boolean not null default false,
  github_id bigint,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, repo_id) references repos(org_id, id)
);
create index checks_head_idx on checks (org_id, repo_id, head_sha);

create table test_results (
  org_id uuid not null,
  id text not null,
  wo_id text,
  attempt_id text,
  suite text not null,
  name text not null,
  status text not null check (status in ('passed','failed','skipped','flaky')),
  duration_ms int,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index test_results_wo_idx on test_results (org_id, wo_id);

create table merges (
  org_id uuid not null,
  id text not null,
  pr_id text not null,
  wo_id text,
  sha text not null,
  strategy text not null,
  merged_by text,
  merged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, pr_id) references pull_requests(org_id, id)
);

create table releases (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  wo_id text,
  tag text not null,
  url text,
  released_at timestamptz,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, repo_id) references repos(org_id, id)
);

create table outcomes (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  kind text not null check (kind in ('healthy','regression','rollback','incident')),
  recorded_by text,
  note text not null default '',
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders(org_id, id)
);

-- ---------- Gates ----------
-- Closes on decision, send-back, kill or a new head commit.

create table gate_instances (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  gate_id text not null,
  station text,
  status text not null default 'open' check (status in ('open','closed')),
  closed_reason text check (closed_reason in ('decision','send_back','kill','new_head')),
  flow_version int not null,
  rule_version int,
  policy_version int,
  head_sha text,
  basis jsonb not null default '{}',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders(org_id, id),
  check ((status = 'closed') = (closed_reason is not null))
);
create unique index gate_instances_open_idx on gate_instances (org_id, wo_id, gate_id) where status = 'open';

create table gate_votes (
  org_id uuid not null,
  id text not null,
  gate_instance_id text not null,
  voter text not null,
  role_id text,
  role_assignment_id text,
  vote text not null check (vote in ('approve','reject')),
  comment text not null default '',
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, gate_instance_id, voter),
  foreign key (org_id, gate_instance_id) references gate_instances(org_id, id)
);

-- Stores the ids of every version in force when the gate was decided (spec 7.1). Append-only.
create table gate_decisions (
  org_id uuid not null,
  id text not null,
  gate_instance_id text not null,
  wo_id text not null,
  decision text not null check (decision in ('approved','rejected','auto_passed','auto_failed')),
  decided_by text,
  rule text,
  flow_version int not null,
  gate_rule_version int,
  policy_version int,
  trust_grant_id text,
  trust_level text,
  role_assignment_id text,
  tuple_id text,
  agent_version int,
  skill_versions jsonb,
  instruction_hash text,
  model_id text,
  commit_sha text,
  detail jsonb not null default '{}',
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, gate_instance_id),
  foreign key (org_id, gate_instance_id) references gate_instances(org_id, id)
);

-- ---------- Stop state ----------

create table stops (
  org_id uuid not null,
  id text not null,
  scope_type text not null check (scope_type in ('factory','project','repo','wo')),
  project_id text,
  repo_id text,
  wo_id text,
  mode text not null check (mode in ('halt','kill')),
  reason text not null default '',
  cause text not null default 'manual',
  in_flight text,
  set_by text not null,
  set_at timestamptz not null default now(),
  lifted_by text,
  lifted_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  check ((scope_type = 'factory' and project_id is null and repo_id is null and wo_id is null)
      or (scope_type = 'project' and project_id is not null)
      or (scope_type = 'repo' and repo_id is not null)
      or (scope_type = 'wo' and wo_id is not null)),
  check ((lifted_at is null) = (lifted_by is null))
);
create unique index stops_active_scope_idx on stops (org_id, scope_type, coalesce(project_id, ''), coalesce(repo_id, ''), coalesce(wo_id, ''), mode) where lifted_at is null;

create table restore_approvals (
  org_id uuid not null,
  id text not null,
  stop_id text not null,
  approver text not null,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, stop_id, approver),
  foreign key (org_id, stop_id) references stops(org_id, id)
);
