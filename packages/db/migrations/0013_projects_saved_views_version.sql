-- Saved views are versioned like every editable entity (If-Match on PATCH and DELETE).
alter table saved_views add column version int not null default 1;
-- A person owns a view name once per screen.
create unique index saved_views_name_idx on saved_views (org_id, person_id, screen, lower(name));
