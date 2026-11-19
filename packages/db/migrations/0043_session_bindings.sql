-- Which configured agent backs a conversational surface that is not a station: the console. (The Intake interview and the work-order session are backed by the
-- agent of the work order's current station; the onboarding session by the Onboarding Agent.) No row means the console speaks with Gantry's fixed rails only,
-- and says so. Changed through the agents area with `agent.edit`; each change is audited.
create table session_bindings (
  org_id uuid not null,
  surface text not null check (surface in ('console')),
  agent_id text not null,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (org_id, surface),
  foreign key (org_id, agent_id) references agents (org_id, id) on delete cascade
);
grant select, insert, update, delete on session_bindings to gantry_app;
-- Conversational turns record the agent version tuple they ran with, like station runs do.
grant select, insert on agent_version_tuples to gantry_app;
