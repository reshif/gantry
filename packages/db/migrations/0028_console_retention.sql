-- Console threads (spec 7.4): 90-day retention. A thread expires `retention_days` after its last message; expired threads are deleted
-- (their messages follow by cascade). `model` and `usage` of an answer live in console_messages.data.
alter table console_threads
  add column retention_days int not null default 90 check (retention_days between 1 and 3650),
  add column expires_at timestamptz not null default (now() + interval '90 days');
create index console_threads_person_idx on console_threads (org_id, person_id, updated_at desc);
create index console_threads_expiry_idx on console_threads (org_id, expires_at);
alter table console_threads alter column created_at set default clock_timestamp();
alter table console_messages alter column created_at set default clock_timestamp();
