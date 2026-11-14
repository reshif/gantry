-- GitHub: content-addressed blobs for patches and raw webhook payloads (until MinIO wiring), and extra commit/repo columns (spec 11.4, 11.6).
-- Large content belongs in object storage under sha256/<hash>; the API has no S3 client yet, so this table is the store behind the same hash keys.
create table github_blobs (
  org_id uuid not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('patch', 'payload')),
  content bytea not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  primary key (org_id, hash)
);

-- Which commit the runner made and which commit GitHub now holds (publishing through the git data API rewrites ids).
alter table commits add column if not exists local_sha text;
alter table commits add column if not exists parent_shas text[] not null default '{}';
create index if not exists commits_local_sha_idx on commits (org_id, repo_id, local_sha);

-- Repo identity for the broker and for matching webhook payloads.
alter table repos add column if not exists github_full_name text;
create unique index if not exists repos_github_full_name_idx on repos (org_id, github_full_name) where github_full_name is not null;

-- 0010 granted only the tables that existed then.
grant select, insert, update, delete on github_blobs to gantry_app;
