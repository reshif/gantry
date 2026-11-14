-- Agents, skills, models, evals, trust and learning (spec 7.3).

create table agents (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  kind text not null default 'station',
  station text,
  status text not null default 'active',
  live_version int,
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table agent_versions (
  org_id uuid not null,
  agent_id text not null,
  version int not null,
  body jsonb not null,                       -- prompt, tools, limits, harness settings
  harness_version text not null default '',
  instruction_hash text,
  model_id text,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, agent_id, version),
  foreign key (org_id, agent_id) references agents(org_id, id)
);

create table skills (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  description text not null default '',
  projects jsonb not null default '"all"',   -- "all" or [project ids]
  live_version int,
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table skill_versions (
  org_id uuid not null,
  skill_id text not null,
  version int not null,
  body jsonb not null,
  content_hash text,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, skill_id, version),
  foreign key (org_id, skill_id) references skills(org_id, id)
);

create table agent_skills (
  org_id uuid not null,
  agent_id text not null,
  skill_id text not null,
  pinned_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, agent_id, skill_id),
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade,
  foreign key (org_id, skill_id) references skills(org_id, id) on delete cascade
);

-- scope: base (org-wide), project overlay or agent. Immutable once published.
create table instruction_versions (
  org_id uuid not null references orgs(id),
  scope text not null check (scope in ('base','project','agent')),
  scope_id text not null default '',
  version int not null,
  body text not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, scope, scope_id, version)
);

create table agent_overrides (
  org_id uuid not null,
  id text not null,
  agent_id text not null,
  scope_type text not null check (scope_type in ('project','repo')),
  project_id text,
  repo_id text,
  body jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, agent_id) references agents(org_id, id)
);

alter table agent_version_tuples
  add foreign key (org_id, agent_id, agent_version) references agent_versions(org_id, agent_id, version);

-- ---------- Models ----------

create table vendors (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  product text not null default '',
  kind text not null default 'api',
  connected boolean not null default false,
  endpoint text not null default '',
  region text not null default '',
  residency text not null default '',
  secret_enc text,                           -- AES-256-GCM envelope, never returned
  secret_mask text,
  secret_fingerprint text,
  monthly_budget_micros bigint,
  config jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table models (
  org_id uuid not null,
  id text not null,
  vendor_id text not null,
  name text not null,
  enabled boolean not null default true,
  context_tokens int not null default 0,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, vendor_id) references vendors(org_id, id) on delete cascade
);

create table routing_versions (
  org_id uuid not null references orgs(id),
  version int not null,
  body jsonb not null,                        -- default, fallback, rules
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, version)
);

create table price_versions (
  org_id uuid not null references orgs(id),
  version int not null,
  body jsonb not null,                        -- model id -> input/output price per million tokens
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, version)
);

create table usage_meter (
  org_id uuid not null references orgs(id),
  id bigint generated always as identity,
  request_id text,
  run_id text,
  attempt_id text,
  station text,
  agent_id text,
  agent_version int,
  project_id text,
  vendor_id text,
  model_id text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  cost_micros bigint not null default 0,
  price_version int,
  latency_ms int,
  outcome text not null default 'ok',
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index usage_meter_project_idx on usage_meter (org_id, project_id, at);
create index usage_meter_run_idx on usage_meter (org_id, run_id);

-- ---------- Evals and trust ----------

create table suites (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  station text,
  agent_id text,
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table eval_cases (
  org_id uuid not null,
  id text not null,
  suite_id text not null,
  name text not null,
  body jsonb not null,
  golden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, suite_id) references suites(org_id, id) on delete cascade
);

create table eval_runs (
  org_id uuid not null,
  id text not null,
  suite_id text not null,
  tuple_id text,
  status text not null default 'running' check (status in ('queued','running','completed','failed','cancelled')),
  score numeric,
  started_by text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, suite_id) references suites(org_id, id)
);

create table eval_results (
  org_id uuid not null,
  id text not null,
  run_id text not null,
  case_id text not null,
  passed boolean not null,
  score numeric,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, run_id, case_id),
  foreign key (org_id, run_id) references eval_runs(org_id, id) on delete cascade,
  foreign key (org_id, case_id) references eval_cases(org_id, id)
);

create table trust_cells (
  org_id uuid not null,
  id text not null,
  project_id text,
  station text not null,
  class text,
  agent_id text,
  level text not null default 'supervised',
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table trust_grants (
  org_id uuid not null,
  id text not null,
  cell_id text not null,
  level text not null,
  granted_by text,
  evidence jsonb not null default '{}',       -- what the grant was based on (runs, eval runs, sampling)
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, cell_id) references trust_cells(org_id, id)
);

create table trust_proposals (
  org_id uuid not null,
  id text not null,
  cell_id text not null,
  proposed_level text not null,
  status text not null default 'open' check (status in ('open','accepted','rejected','expired')),
  evidence jsonb not null default '{}',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, cell_id) references trust_cells(org_id, id)
);

create table trust_criteria_versions (
  org_id uuid not null references orgs(id),
  version int not null,
  body jsonb not null,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, version)
);

create table trust_ceilings (
  org_id uuid not null references orgs(id),
  id text not null,
  scope_type text not null,
  scope_id text not null default '',
  max_level text not null,
  reason text not null default '',
  set_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table sampling_draws (
  org_id uuid not null,
  id text not null,
  cell_id text,
  wo_id text,
  gate_instance_id text,
  seed text not null,
  drawn boolean not null,
  rate numeric not null,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

-- ---------- Learning ----------

create table findings (
  org_id uuid not null references orgs(id),
  id text not null,
  kind text not null,
  subject jsonb not null default '{}',
  body text not null default '',
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table proposals (
  org_id uuid not null references orgs(id),
  id text not null,
  finding_id text,
  kind text not null,
  change jsonb not null,                      -- the change it applies
  status text not null default 'open' check (status in ('open','accepted','rejected','applied','superseded')),
  applied_ref jsonb,
  verified_eval_run_id text,
  decided_by text,
  decided_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table proposal_evidence (
  org_id uuid not null,
  id text not null,
  proposal_id text not null,
  kind text not null,
  ref jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, proposal_id) references proposals(org_id, id) on delete cascade
);
