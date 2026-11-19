-- Agent workspace, Phase 3: objections. A station agent may object to an earlier station's document (its `object` tool): which document and
-- section, what it claims is wrong and why, and how much it matters. A person decides: the objection stands (upheld) or the author is right
-- (overruled), with a note. Open objections are shown next to the gate; decided ones travel with the handoff.
create table wo_objections (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  station text not null,
  attempt_id text,
  raised_by text not null,
  target_doc text not null,
  target_station text,
  section text not null default '',
  claim text not null default '',
  reason text not null,
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  status text not null default 'open' check (status in ('open', 'upheld', 'overruled')),
  note text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade
);
create index wo_objections_wo_idx on wo_objections (org_id, wo_id, created_at);
grant select, insert, update, delete on wo_objections to gantry_app;

-- Research scouts (Phase 3) are extra live attempts at the same station, by design. The one-live-attempt rule keeps holding for the station's
-- own runs; scouts are exempt from it and unique by their letter instead.
drop index if exists attempts_one_live_idx;
create unique index attempts_one_live_idx on attempts (org_id, wo_id, station) where state in ('queued', 'running') and not (data ? 'scout');
create unique index attempts_live_scout_idx on attempts (org_id, wo_id, station, (data->'scout'->>'id')) where state in ('queued', 'running') and data ? 'scout';
