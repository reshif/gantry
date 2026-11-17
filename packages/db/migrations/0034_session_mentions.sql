-- @mentioning a person in a work order's session. A mention notifies the person; it never grants access. When the person cannot read the project, it also opens an
-- access request for the project's admins (who decide in the people screen); a mention of someone who can read just lands in their inbox.
create table workorder_mentions (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  message_id text not null,
  project_id text not null,
  person_id text not null,
  by_person text not null,
  has_access boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade,
  unique (org_id, message_id, person_id)
);
create index workorder_mentions_person_idx on workorder_mentions (org_id, person_id, created_at desc);
grant select, insert, update, delete on workorder_mentions to gantry_app;

create table access_requests (
  org_id uuid not null,
  id text not null,
  project_id text not null,
  person_id text not null,
  wo_id text,
  message_id text,
  requested_by text not null,
  status text not null default 'open' check (status in ('open', 'dismissed')),
  created_at timestamptz not null default clock_timestamp(),
  decided_by text,
  decided_at timestamptz,
  primary key (org_id, id)
);
-- One open request per person and project: a second mention adds nothing new for the admin to read.
create unique index access_requests_open_idx on access_requests (org_id, project_id, person_id) where status = 'open';
grant select, insert, update, delete on access_requests to gantry_app;
