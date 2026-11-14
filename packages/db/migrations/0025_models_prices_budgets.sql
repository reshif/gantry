-- Models, prices and budgets (spec 10.4, 10.5). Published price versions are immutable, so the effective date is a new nullable column
-- (null means "effective when published"); vendors keep their custom flag, retention mode and per-station qualification in vendors.config.
alter table price_versions add column effective_from timestamptz;
create index price_versions_effective_idx on price_versions (org_id, effective_from desc, version desc) where published_at is not null;

-- A default per-work-order cost cap for a project (micro-dollars, 0 = none). A work order may carry a tighter or looser own cap in its data.
alter table budgets add column wo_limit_micros bigint not null default 0;

-- Vendors and models list in the order they were added (rows inserted in one transaction would otherwise share one timestamp).
alter table vendors alter column created_at set default clock_timestamp();
alter table models alter column created_at set default clock_timestamp();
