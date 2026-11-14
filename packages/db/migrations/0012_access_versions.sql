-- People and access: every editable access entity carries a version for If-Match (spec 8.1), and policies are retired, not erased,
-- so a deleted policy keeps its version history and its id is never reused.
alter table freezes add column version int not null default 1;
alter table policies add column deleted_at timestamptz;
