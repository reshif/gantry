-- Integrations, MCP, API and triggers, identity, console (spec 7.3).

create table integration_types (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  builtin boolean not null default false,
  field_schema jsonb not null default '[]',   -- same schema for built-in and custom types
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table integration_instances (
  org_id uuid not null,
  id text not null,
  type_id text not null,
  name text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',         -- non-secret fields
  secret_enc text,
  secret_mask text,
  health text not null default 'unknown',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, type_id) references integration_types(org_id, id)
);

create table chat_identity_links (
  org_id uuid not null,
  id text not null,
  person_id text not null,
  channel text not null check (channel in ('slack','teams')),
  external_id text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, channel, external_id),
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);

create table notification_routes (
  org_id uuid not null,
  id text not null,
  project_id text,
  event text not null,
  destinations jsonb not null,
  template text not null default '',
  conditions jsonb not null default '{}',
  fields jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table repo_route_overrides (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  event text not null,
  destinations jsonb not null,
  template text not null default '',
  mode text not null default 'also' check (mode in ('also','instead')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, repo_id) references repos(org_id, id) on delete cascade
);

create table card_templates (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  body jsonb not null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table deliveries (
  org_id uuid not null references orgs(id),
  id text not null,
  integration_id text,
  event_id uuid,
  destination text not null,
  status text not null default 'pending' check (status in ('pending','sent','failed','dead')),
  request jsonb,
  response_status int,
  attempts int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

-- ---------- MCP ----------

create table mcp_servers (
  org_id uuid not null references orgs(id),
  id text not null,
  name text not null,
  url text not null default '',
  enabled boolean not null default true,
  disabled_reason text,
  config jsonb not null default '{}',
  secret_enc text,
  secret_mask text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table mcp_tools (
  org_id uuid not null,
  server_id text not null,
  name text not null,
  definition_hash text not null,               -- a changed hash disables the server
  tool_class text not null check (tool_class in ('read','write')),
  allowed boolean not null default false,
  definition jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, server_id, name),
  foreign key (org_id, server_id) references mcp_servers(org_id, id) on delete cascade
);

create table mcp_scopes (
  org_id uuid not null,
  id text not null,
  server_id text not null,
  projects jsonb not null default '"all"',
  repos jsonb not null default '"all"',
  agents jsonb not null default '[]',
  stations jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, server_id) references mcp_servers(org_id, id) on delete cascade
);

create table mcp_calls (
  org_id uuid not null references orgs(id),
  id bigint generated always as identity,
  server_id text not null,
  tool text not null,
  run_id text,
  project_id text,
  outcome text not null,
  latency_ms int,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index mcp_calls_server_idx on mcp_calls (org_id, server_id, at);

-- ---------- API and triggers ----------

create table api_keys (
  org_id uuid not null,
  id text not null,
  name text not null,
  project_id text,
  key_hash text not null,                      -- hash only
  key_prefix text not null,
  scopes jsonb not null default '[]',
  created_by text,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (key_hash)
);

create table api_requests (
  org_id uuid not null references orgs(id),
  id bigint generated always as identity,
  key_id text,
  method text not null,
  path text not null,
  status int not null,
  request_id text,
  source_ip inet,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index api_requests_at_idx on api_requests (org_id, at);

-- Same key and body returns the first result; same key with a different body conflicts.
create table idempotency_keys (
  org_id uuid not null references orgs(id),
  scope text not null,                         -- actor or route namespace
  key text not null,
  request_hash text not null,
  response_status int,
  response jsonb,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, scope, key)
);
create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

create table triggers (
  org_id uuid not null,
  id text not null,
  project_id text,
  kind text not null,
  name text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  secret_hash text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table trigger_runs (
  org_id uuid not null,
  id text not null,
  trigger_id text not null,
  wo_id text,
  outcome text not null,
  detail jsonb not null default '{}',
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, trigger_id) references triggers(org_id, id) on delete cascade
);

-- Deduplicated on source and delivery id.
create table inbound_deliveries (
  org_id uuid not null references orgs(id),
  id text not null,
  source text not null,
  delivery_id text not null,
  event_type text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),   -- raw payload in object storage
  status text not null default 'received' check (status in ('received','processed','failed','ignored')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, source, delivery_id)
);

-- ---------- Identity ----------

create table sessions (
  org_id uuid not null,
  id text not null,
  person_id text not null,
  token_hash text not null,                    -- the cookie value is never stored
  csrf_hash text,
  idp_sid text,
  ip inet,
  user_agent text not null default '',
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (token_hash),
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);
create index sessions_person_idx on sessions (org_id, person_id) where revoked_at is null;

create table signins (
  org_id uuid not null references orgs(id),
  id bigint generated always as identity,
  person_id text,
  method text not null,
  outcome text not null check (outcome in ('ok','denied','failed')),
  reason text,
  source_ip inet,
  user_agent text,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index signins_at_idx on signins (org_id, at);

-- Versioned, immutable once published.
create table security_settings (
  org_id uuid not null references orgs(id),
  version int not null,
  body jsonb not null,
  note text not null default '',
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, version)
);

-- ---------- Console ----------

create table console_threads (
  org_id uuid not null,
  id text not null,
  person_id text not null,
  title text not null default '',
  pinned jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);

create table console_messages (
  org_id uuid not null,
  id text not null,
  thread_id text not null,
  role text not null check (role in ('user','assistant','system')),
  body text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, thread_id) references console_threads(org_id, id) on delete cascade
);
create index console_messages_thread_idx on console_messages (org_id, thread_id, created_at);
