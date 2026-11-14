-- Queue, durable timers and outbound deliveries (spec 6.6: Postgres is the queue).
-- Claim pattern: SELECT ... FOR UPDATE SKIP LOCKED, with a lease; an expired lease makes a running job claimable again.

create table jobs (
  id text primary key default gen_random_uuid()::text,
  org_id uuid not null references orgs(id),
  queue text not null default 'default',
  kind text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','done','dead')),
  priority int not null default 0,              -- higher runs first
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts >= 1),
  lease_owner text,
  lease_until timestamptz,
  dedupe_key text,
  last_error text,
  result jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'running') = (lease_owner is not null))
);
create index jobs_claim_idx on jobs (queue, priority desc, run_at) where status = 'queued';
create index jobs_lease_idx on jobs (lease_until) where status = 'running';
create unique index jobs_dedupe_idx on jobs (org_id, dedupe_key) where dedupe_key is not null and status in ('queued','running');

create table timers (
  id text primary key default gen_random_uuid()::text,
  org_id uuid not null references orgs(id),
  kind text not null,
  subject text,                                  -- e.g. a work order id
  fire_at timestamptz not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','fired','cancelled')),
  dedupe_key text,
  job_id text references jobs(id),
  fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index timers_due_idx on timers (fire_at) where status = 'pending';
create unique index timers_dedupe_idx on timers (org_id, dedupe_key) where dedupe_key is not null and status = 'pending';
create index timers_subject_idx on timers (org_id, subject) where status = 'pending';

create table outbox (
  id text primary key default gen_random_uuid()::text,
  org_id uuid not null references orgs(id),
  event_id uuid not null references events(id),
  destination text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','sending','delivered','dead')),
  attempts int not null default 0,
  max_attempts int not null default 8 check (max_attempts >= 1),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, destination),
  check ((status = 'sending') = (lease_owner is not null))
);
create index outbox_claim_idx on outbox (destination, next_attempt_at) where status = 'pending';
create index outbox_lease_idx on outbox (lease_until) where status = 'sending';
