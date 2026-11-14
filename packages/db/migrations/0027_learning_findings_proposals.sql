-- Learning loop (spec 8.7, 13.4). Findings group repeated signals; proposals carry the change, the declared metric and window, the baseline taken when
-- the change was applied, and the way to undo it. Proposal states: open (proposed), applied (accepted and applied), verified, rejected (declined), rolled_back.

alter table findings
  add column signal text,
  add column title text not null default '',
  add column agent_id text,
  add column project_id text,
  add column evidence jsonb not null default '[]',
  add column evidence_count int not null default 0,
  add column first_at timestamptz,
  add column last_at timestamptz,
  add column addressed_at timestamptz,
  add column version int not null default 1;

-- One open finding per signal, agent and project: a refresh updates it instead of making a duplicate.
create unique index findings_open_key on findings (org_id, signal, coalesce(agent_id, ''), coalesce(project_id, '')) where status = 'open' and signal is not null;
create index findings_project_idx on findings (org_id, project_id);

alter table proposals drop constraint proposals_status_check;
alter table proposals add constraint proposals_status_check check (status in ('open','accepted','rejected','applied','superseded','verified','rolled_back'));

alter table proposals
  add column title text not null default '',
  add column owner text,
  add column expected text not null default '',
  add column history jsonb not null default '[]',
  add column metric jsonb,
  add column window_days int,
  add column baseline jsonb,
  add column applied_at timestamptz,
  add column applied_by text,
  add column rollback jsonb,
  add column rolled_back_at timestamptz,
  add column rolled_back_by text,
  add column verification jsonb,
  add column reason text;

create index proposals_finding_idx on proposals (org_id, finding_id);
