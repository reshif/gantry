-- Projects, flow, repos and onboarding (spec 7.3: Projects, Flow, Repos).

create table projects (
  org_id uuid not null references orgs(id),
  id text not null,
  key text not null,
  name text not null,
  description text not null default '',
  status text not null default 'new' check (status in ('new','onboarding','active','archived')),
  owner_id text,
  template_id text,
  regulated boolean not null default false,
  overlay text not null default '',
  halted jsonb,
  killed jsonb,
  config jsonb not null default '{}',
  current_flow_version int,
  version int not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, key)
);

create table project_members (
  org_id uuid not null,
  project_id text not null,
  person_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id, person_id),
  foreign key (org_id, project_id) references projects(org_id, id) on delete cascade,
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);
create index project_members_person_idx on project_members (org_id, person_id);

create table project_teams (
  org_id uuid not null,
  project_id text not null,
  team_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id, team_id),
  foreign key (org_id, project_id) references projects(org_id, id) on delete cascade,
  foreign key (org_id, team_id) references teams(org_id, id) on delete cascade
);

create table templates (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  description text not null default '',
  builtin boolean not null default false,
  body jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table budgets (
  org_id uuid not null,
  project_id text not null,
  monthly_limit_micros bigint not null default 0,
  alert_at numeric(4,3) not null default 0.8,
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id),
  foreign key (org_id, project_id) references projects(org_id, id) on delete cascade
);

create table saved_views (
  org_id uuid not null,
  id text not null,
  person_id text not null,
  project_id text,
  screen text not null,
  name text not null,
  body jsonb not null default '{}',
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);

-- One document per version: stations, gates, bays, classes, routes, slots, limits. Immutable once published.
create table flow_versions (
  org_id uuid not null,
  project_id text not null,
  version int not null,
  doc jsonb not null,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id, version),
  foreign key (org_id, project_id) references projects(org_id, id)
);

create table approver_rules (
  org_id uuid not null,
  project_id text not null,
  gate_id text not null,
  current_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id, gate_id),
  foreign key (org_id, project_id) references projects(org_id, id)
);

create table approver_rule_versions (
  org_id uuid not null,
  project_id text not null,
  gate_id text not null,
  version int not null,
  rule jsonb not null,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id, gate_id, version),
  foreign key (org_id, project_id, gate_id) references approver_rules(org_id, project_id, gate_id)
);

create table gate_modes (
  org_id uuid not null,
  project_id text not null,
  gate_id text not null,
  mode text not null check (mode in ('human','auto','mixed')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id, gate_id),
  foreign key (org_id, project_id) references projects(org_id, id) on delete cascade
);

create table repos (
  org_id uuid not null,
  id text not null,
  project_id text not null,
  team_id text,
  name text not null,
  github_repo_id bigint,
  installation_id bigint,
  lang text not null default '',
  tags text[] not null default '{}',
  onboarding_stage text not null default 'connected' check (onboarding_stage in ('connected','assessed','pr_opened','pr_checks','pr_merged','verified','ready','person')),
  halted jsonb,
  frozen boolean not null default false,
  ready_at timestamptz,
  guidelines text not null default '',
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, project_id) references projects(org_id, id),
  unique (org_id, name)
);
create index repos_project_idx on repos (org_id, project_id);

create table repo_config (
  org_id uuid not null,
  repo_id text not null,
  default_branch text not null default 'main',
  branch_prefix text not null default 'gantry/',
  merge_strategy text not null default 'squash' check (merge_strategy in ('squash','merge','rebase')),
  tagging text not null default 'semver-patch',
  required_checks text[] not null default '{}',
  protected_paths text[] not null default '{}',
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, repo_id),
  foreign key (org_id, repo_id) references repos(org_id, id) on delete cascade
);

create table onboarding_runs (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  status text not null default 'running' check (status in ('running','succeeded','failed','needs_person','cancelled')),
  guideline_version int,
  blocker text,
  timeline jsonb not null default '[]',
  exception jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, repo_id) references repos(org_id, id) on delete cascade
);
create index onboarding_runs_repo_idx on onboarding_runs (org_id, repo_id, started_at desc);

create table onboarding_findings (
  org_id uuid not null,
  id text not null,
  run_id text not null,
  check_id text not null,
  label text not null,
  ok boolean not null,
  severity text not null check (severity in ('high','medium','low')),
  fix text not null default '',
  file text,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, run_id) references onboarding_runs(org_id, id) on delete cascade
);

create table onboarding_prs (
  org_id uuid not null,
  id text not null,
  run_id text not null,
  repo_id text not null,
  number int,
  github_pr_id bigint,
  title text not null,
  branch text not null,
  state text not null default 'open' check (state in ('open','merged','closed')),
  checks text not null default 'pending',
  files jsonb not null default '[]',
  reviewers text[] not null default '{}',
  merged_by text,
  merged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, run_id) references onboarding_runs(org_id, id) on delete cascade,
  foreign key (org_id, repo_id) references repos(org_id, id) on delete cascade
);

-- scope 'org' (project_id null) or 'project'. Immutable once published.
create table guideline_versions (
  org_id uuid not null,
  scope text not null check (scope in ('org','project')),
  project_id text,
  version int not null,
  body jsonb not null,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id) references orgs(id),
  check ((scope = 'org') = (project_id is null))
);
create unique index guideline_versions_key_idx on guideline_versions (org_id, scope, coalesce(project_id, ''), version);
