-- Common helpers, organisation and access tables (spec 7.3: Organisation, Access).
-- Convention: primary key (org_id, id) with text ids in the legacy style; composite foreign keys keep rows inside one org.

create function gantry_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create table orgs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid generated always as (id) stored not null,
  slug text not null unique,
  name text not null,
  plant text,
  tz text not null default 'UTC',
  factory_stop jsonb,
  settings jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table teams (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  description text not null default '',
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table people (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  title text not null default '',
  email text not null,
  idp_subject text,
  github_login text,
  status text not null default 'active' check (status in ('active','suspended','deactivated','invited')),
  mfa boolean not null default false,
  oncall boolean not null default false,
  away jsonb,
  last_seen_at timestamptz,
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, email)
);
create unique index people_idp_subject_idx on people (org_id, idp_subject) where idp_subject is not null;

create table team_members (
  org_id uuid not null,
  team_id text not null,
  person_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, team_id, person_id),
  foreign key (org_id, team_id) references teams(org_id, id) on delete cascade,
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);
create index team_members_person_idx on team_members (org_id, person_id);

create table invites (
  org_id uuid not null references orgs(id),
  id text not null,
  email text not null,
  role_id text,
  project_id text,
  invited_by text,
  token_hash text not null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (token_hash)
);

create table roles (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  level text not null check (level in ('factory','project')),
  builtin boolean not null default false,
  description text not null default '',
  data jsonb not null default '{}',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

-- Immutable once published (trigger in 0009). matrix: { roleId: { actionId: boolean } }
create table role_matrix_versions (
  org_id uuid not null references orgs(id),
  version int not null,
  matrix jsonb not null,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, version)
);

create table role_assignments (
  org_id uuid not null,
  id text not null,
  person_id text not null,
  role_id text not null,
  scope_type text not null check (scope_type in ('factory','project')),
  project_id text,
  granted_by text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, person_id) references people(org_id, id),
  foreign key (org_id, role_id) references roles(org_id, id),
  check ((scope_type = 'factory') = (project_id is null))
);
create index role_assignments_person_idx on role_assignments (org_id, person_id) where revoked_at is null;
create index role_assignments_project_idx on role_assignments (org_id, project_id) where revoked_at is null;

create table policies (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  kind text not null,
  enabled boolean not null default true,
  current_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table policy_versions (
  org_id uuid not null,
  policy_id text not null,
  version int not null,
  body jsonb not null,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, policy_id, version),
  foreign key (org_id, policy_id) references policies(org_id, id)
);

create table freezes (
  org_id uuid not null references orgs(id),
  id text not null,
  scope_type text not null check (scope_type in ('factory','project')),
  project_id text,
  name text not null default '',
  reason text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz,
  recurrence jsonb,
  created_by text,
  lifted_at timestamptz,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table delegations (
  org_id uuid not null,
  id text not null,
  from_person text not null,
  to_person text not null,
  role_id text,
  project_id text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, from_person) references people(org_id, id),
  foreign key (org_id, to_person) references people(org_id, id)
);

create table oncall (
  org_id uuid not null,
  id text not null,
  person_id text not null,
  project_id text,
  role_id text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, person_id) references people(org_id, id)
);
create index oncall_window_idx on oncall (org_id, starts_at, ends_at);
