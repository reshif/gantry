-- Team role grants (spec 8.9). A team holds roles at factory or project scope; its members inherit them while they are members.
-- A separate table from role_assignments: that one is keyed by person, and a person's own grants must stay distinguishable from
-- inherited ones (direct vs "via team", separate revoke, separate audit subject). Same columns otherwise: expiry, revoke, scope check.
create table team_role_assignments (
  org_id uuid not null,
  id text not null,
  team_id text not null,
  role_id text not null,
  scope_type text not null check (scope_type in ('factory','project')),
  project_id text,
  granted_by text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, team_id) references teams(org_id, id) on delete cascade,
  foreign key (org_id, role_id) references roles(org_id, id),
  check ((scope_type = 'factory') = (project_id is null))
);
create index team_role_assignments_team_idx on team_role_assignments (org_id, team_id) where revoked_at is null;
create unique index team_role_assignments_live_idx on team_role_assignments (org_id, team_id, role_id, coalesce(project_id, '')) where revoked_at is null;
grant select, insert, update, delete on team_role_assignments to gantry_app;

-- Everything a person holds: their own grants plus the grants of their teams. Readers that ask "who holds role R" use this view;
-- `via_team` is null for a direct grant. Callers still filter revoked_at and expires_at, exactly as they do on role_assignments.
create view effective_role_assignments as
  select org_id, id, person_id, role_id, scope_type, project_id, granted_by, expires_at, revoked_at, created_at, updated_at, null::text as via_team
    from role_assignments
  union all
  select t.org_id, t.id, m.person_id, t.role_id, t.scope_type, t.project_id, t.granted_by, t.expires_at, t.revoked_at, t.created_at, t.updated_at, t.team_id
    from team_role_assignments t
    join team_members m on m.org_id = t.org_id and m.team_id = t.team_id;
grant select on effective_role_assignments to gantry_app;
