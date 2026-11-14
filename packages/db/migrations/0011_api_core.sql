-- gantry-api core: sign-in strength and method live on the session row (spec 14.1, step-up uses auth_time).
alter table sessions
  add column auth_time timestamptz,
  add column method text not null default 'sso',
  add column acr text;

-- Rows created in one transaction must keep their creation order (now() is constant inside a transaction).
alter table teams alter column created_at set default clock_timestamp();
alter table people alter column created_at set default clock_timestamp();
alter table projects alter column created_at set default clock_timestamp();
alter table repos alter column created_at set default clock_timestamp();
alter table templates alter column created_at set default clock_timestamp();
alter table policies alter column created_at set default clock_timestamp();
alter table freezes alter column created_at set default clock_timestamp();
alter table roles alter column created_at set default clock_timestamp();
alter table role_assignments alter column created_at set default clock_timestamp();

-- Display order of projects (the seed keeps its array order; new projects have none and sort after, by creation time).
alter table projects add column position int;
alter table notification_routes alter column created_at set default clock_timestamp();
alter table project_teams alter column created_at set default clock_timestamp();
alter table team_members alter column created_at set default clock_timestamp();
