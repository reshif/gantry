-- Notifications (spec 12.2, 12.3): the delivery log carries what the outbox row does not (project, event type, route, message reference for in-place card updates),
-- and chat identity links are created by a recorded link step (a one-time code the person sends from the chat app).
create sequence if not exists deliveries_no_seq;
grant usage, select on sequence deliveries_no_seq to gantry_app;

alter table deliveries
  add column if not exists project_id text,
  add column if not exists event_type text not null default '',
  add column if not exists channel text not null default '',
  add column if not exists target text not null default '',
  add column if not exists route_id text,
  add column if not exists override_id text,
  add column if not exists repo_id text,
  add column if not exists wo_id text,
  add column if not exists error text not null default '',
  add column if not exists outbox_id text,
  add column if not exists card_key text,
  add column if not exists message_ref jsonb,
  add column if not exists is_test boolean not null default false;
create index if not exists deliveries_card_idx on deliveries (org_id, card_key) where card_key is not null;
create index if not exists deliveries_created_idx on deliveries (org_id, created_at desc);
create index if not exists deliveries_wo_card_idx on deliveries (org_id, wo_id) where card_key is not null;
create index if not exists deliveries_outbox_idx on deliveries (outbox_id) where outbox_id is not null;

-- Routes are versioned entities: an edit sends the version it loaded as If-Match.
alter table notification_routes add column if not exists version int not null default 1;

create table if not exists chat_link_requests (
  org_id uuid not null references orgs(id),
  id text not null,
  person_id text not null,
  channel text not null check (channel in ('slack','teams')),
  integration_id text,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (code_hash),
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);
grant select, insert, update, delete on chat_link_requests to gantry_app;

-- The record of an in-chat approval (spec 12.3): channel, chat user id, mapped person and gate instance id are stored with the vote.
alter table gate_votes add column if not exists chat jsonb;
