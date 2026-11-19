-- Agent workspace, Phase 2: governed web research. Every page a station agent read through the edge's research fetcher is a source: the URL as
-- recorded (credential-like query parameters dropped), what the page was when fetched (title, status, type), and the text the agent saw, kept
-- with its hash (the snapshot in object storage is sha256/<content_hash>). `ref` is the short id the agent cites (`s1`, `s2`, ... per work order).
create table research_sources (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  ref text not null,
  kind text not null default 'web' check (kind in ('web', 'repo', 'internal')),
  station text not null,
  attempt_id text,
  run_id text,
  fetched_by text,
  url text not null,
  final_url text not null,
  host text not null,
  title text not null default '',
  http_status int,
  content_type text not null default '',
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null default 0,
  truncated boolean not null default false,
  why text not null default '',
  excerpt text not null default '',
  fetched_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  unique (org_id, wo_id, ref),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade
);
create index research_sources_wo_idx on research_sources (org_id, wo_id, fetched_at);
grant select, insert, update, delete on research_sources to gantry_app;
