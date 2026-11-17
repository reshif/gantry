-- Station documents, people's side: comments on a section of a document version, and the grant on the artefact row of who accepted a version as the
-- station's output. A person's direct edit is just another version (`author_kind = 'person'`, `author_id` the person), so it needs no new column.
--
-- A comment belongs to the document name (so it still reads against later versions) and records the version it was written on and the section
-- (the heading text; empty for the document as a whole). Open comments travel with the station handoff, so the agent sees what people asked for.
create table wo_doc_comments (
  org_id uuid not null,
  id text not null,
  wo_id text not null,
  artefact_id text not null,
  doc text not null,
  version int not null,
  section text not null default '',
  body text not null,
  author text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, wo_id) references work_orders (org_id, id) on delete cascade
);
create index wo_doc_comments_wo_idx on wo_doc_comments (org_id, wo_id, created_at);
grant select, insert, update, delete on wo_doc_comments to gantry_app;
