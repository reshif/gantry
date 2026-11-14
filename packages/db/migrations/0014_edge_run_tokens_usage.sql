-- Run tokens (spec 5.3: issued per run, bound to run id and fencing number, stored hashed, revoked on stop)
-- and the usage detail the model gateway reports (spec 10.4: cache read and write tokens, latency, trace reference).

create table run_tokens (
  org_id uuid not null,
  id text not null,
  run_id text not null,
  attempt_id text not null,
  fencing bigint not null,
  token_hash text not null,                  -- sha256 hex of the token; the token itself is never stored
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (token_hash),
  foreign key (org_id, run_id) references runs(org_id, id),
  foreign key (org_id, attempt_id) references attempts(org_id, id)
);
create index run_tokens_run_idx on run_tokens (org_id, run_id);

alter table run_usage
  add column cache_write_tokens bigint not null default 0,
  add column latency_ms int,
  add column trace_ref text,
  add column price_version int,
  add column vendor_id text,
  add column request_id text,
  add column outcome text not null default 'ok';
create unique index run_usage_request_idx on run_usage (org_id, run_id, request_id) where request_id is not null;

alter table usage_meter
  add column cache_write_tokens bigint not null default 0,
  add column trace_ref text;
create unique index usage_meter_request_idx on usage_meter (org_id, run_id, request_id) where request_id is not null;

-- 0010 granted only the tables that existed then.
grant select, insert, update, delete on run_tokens to gantry_app;

-- Spec 12.4: every MCP call is logged with work order, agent, tool, argument hash and outcome.
alter table mcp_calls
  add column wo_id text,
  add column agent_id text,
  add column station text,
  add column args_hash text,
  add column reason text;
