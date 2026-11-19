-- Agent workspace, Phase 1: station documents and the dialogue log.
--
-- Documents. A station agent writes markdown documents with its `write_document` tool; each run's last write of a name becomes the next version of
-- that document on the work order. The text is kept with the row (after the edge's secret scan) so people can read and compare versions; the
-- object in storage under sha256/<content_hash> stays the record. `author_kind` is `agent` for a station run and `person` for a direct edit.
alter table artefacts
  add column station text,
  add column doc text,
  add column version int,
  add column supersedes text,
  add column author_kind text not null default 'agent' check (author_kind in ('agent', 'person', 'system')),
  add column author_id text,
  add column body text,
  add column accepted_by text,
  add column accepted_at timestamptz;
create unique index artefacts_doc_version_key on artefacts (org_id, wo_id, doc, version) where doc is not null;

-- Questions a station agent asked (its `ask` tool). A blocking one parks the work order until it is answered; then the station runs again with the
-- answers. `ask_of` names who can answer: requester, approvers, anyone, or role:<role id>. The answer is recorded with who gave it.
create table wo_questions (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  station text not null,
  attempt_id text,
  asked_by text not null,
  question text not null,
  why text not null default '',
  options jsonb not null default '[]',
  blocking boolean not null default false,
  ask_of text not null default 'requester',
  status text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  answer text,
  answer_kind text check (answer_kind in ('answer', 'dont_know', 'not_relevant')),
  answered_by text,
  answered_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade
);
create index wo_questions_wo_idx on wo_questions (org_id, wo_id, created_at);
create index wo_questions_open_idx on wo_questions (org_id, status) where status = 'open';
grant select, insert, update, delete on wo_questions to gantry_app;

-- Assumptions a station agent proceeded on (its `assume` tool). People confirm or correct them; an open one is shown on later documents and gates.
create table wo_assumptions (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  station text not null,
  attempt_id text,
  made_by text not null,
  statement text not null,
  because text not null default '',
  impact text not null default 'medium' check (impact in ('low', 'medium', 'high')),
  status text not null default 'open' check (status in ('open', 'confirmed', 'corrected')),
  note text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade
);
create index wo_assumptions_wo_idx on wo_assumptions (org_id, wo_id, created_at);
grant select, insert, update, delete on wo_assumptions to gantry_app;
