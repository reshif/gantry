-- The work-order session (spec 8.4): one agent conversation per work order, for its whole life. Messages are shared by the people who may see the work order's
-- project. `author` is a person id, a station agent id (`ag-intake`, ...) or `system`; `data` holds the cards, the model, the tools and the usage of an answer.
-- The scripted intake questionnaire keeps its own rows (conversations/messages) and is shown first as history.
create table workorder_messages (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  author text not null,
  body text not null default '',
  data jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade
);
create index workorder_messages_wo_idx on workorder_messages (org_id, wo_id, created_at, id);
grant select, insert, update, delete on workorder_messages to gantry_app;

-- Which updates of a work order's session a person has seen: the bell lists a session with an update newer than this.
create table workorder_session_seen (
  org_id uuid not null,
  wo_id text not null,
  person_id text not null,
  seen_at timestamptz not null default clock_timestamp(),
  primary key (org_id, wo_id, person_id),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade
);
grant select, insert, update, delete on workorder_session_seen to gantry_app;
