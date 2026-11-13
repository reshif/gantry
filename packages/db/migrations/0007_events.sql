-- The append-only event log and audit ledger (spec 7.2).
-- seq is assigned per org by a trigger from a counter row locked FOR UPDATE, so concurrent appends serialise and stay gapless.
-- prev_hash/hash form a sha256 chain over canonical fields. Callers cannot choose seq, recorded_at, prev_hash or hash.

create table event_counters (
  org_id uuid primary key references orgs(id),
  last_seq bigint not null default 0,
  last_hash text not null default repeat('0', 64)
);

create table events (
  id uuid not null default gen_random_uuid() unique,
  org_id uuid not null references orgs(id),
  seq bigint not null,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  type text not null,
  category text not null check (category in ('auth','access','flow','onboarding','approvals','config','integrations','api','agents','kill','trust','learning')),
  actor text not null,
  on_behalf_of text,
  channel text not null check (channel in ('web','console','slack','teams','api','github','schedule','system')),
  subject jsonb,
  project_id text,
  wo_id text,
  wo_version int,
  outcome text not null default 'ok' check (outcome in ('ok','denied','failed','regression')),
  rule text,
  before jsonb,
  after jsonb,
  command_id text,
  idempotency_key text,
  causation_id text,
  session_id text,
  source_ip inet,
  request_id text,
  prev_hash text not null,
  hash text not null,
  primary key (org_id, seq),
  check (prev_hash ~ '^[0-9a-f]{64}$' and hash ~ '^[0-9a-f]{64}$')
);
create index events_project_idx on events (org_id, project_id, seq) where project_id is not null;
create index events_wo_idx on events (org_id, wo_id, seq) where wo_id is not null;
create index events_type_idx on events (org_id, type, seq);
create index events_occurred_idx on events (org_id, occurred_at);

-- sha256 over a canonical JSON array of every field the hash protects, in fixed order.
create function gantry_event_hash(e events) returns text language sql stable as $$
  select encode(digest(jsonb_build_array(
    e.id, e.org_id, e.seq, e.prev_hash,
    to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    e.type, e.category, e.actor, e.on_behalf_of, e.channel, e.subject,
    e.project_id, e.wo_id, e.wo_version, e.outcome, e.rule, e.before, e.after,
    e.command_id, e.idempotency_key, e.causation_id, e.session_id,
    host(e.source_ip), e.request_id
  )::text, 'sha256'), 'hex')
$$;

-- SECURITY DEFINER so gantry_app can append without any privilege on event_counters.
create function gantry_events_before_insert() returns trigger language plpgsql
  security definer set search_path = public, pg_catalog as $$
declare
  c event_counters;
begin
  insert into event_counters (org_id) values (new.org_id) on conflict (org_id) do nothing;
  select * into c from event_counters where org_id = new.org_id for update;
  new.seq := c.last_seq + 1;
  new.prev_hash := c.last_hash;
  new.recorded_at := clock_timestamp();
  new.hash := gantry_event_hash(new);
  update event_counters set last_seq = new.seq, last_hash = new.hash where org_id = new.org_id;
  return new;
end $$;

create trigger events_before_insert before insert on events
  for each row execute function gantry_events_before_insert();

create function gantry_events_reject_change() returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only (% rejected)', tg_op using errcode = '42501';
end $$;

create trigger events_no_update_delete before update or delete on events
  for each row execute function gantry_events_reject_change();
create trigger events_no_truncate before truncate on events
  for each statement execute function gantry_events_reject_change();

-- Read access to the counter for the chain verifier, without granting the table.
create function gantry_event_head(p_org uuid) returns table (last_seq bigint, last_hash text)
  language sql stable security definer set search_path = public, pg_catalog as $$
  select last_seq, last_hash from event_counters where org_id = p_org
$$;
