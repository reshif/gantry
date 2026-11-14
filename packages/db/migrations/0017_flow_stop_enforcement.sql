-- Stop enforcement marker (spec 4.4, 8.5, 9.7). The stop command commits only the stop row and its event. Everything a stop does to work orders
-- (cancel attempts, release slots, mark killed) is applied afterwards by the worker (`reconcileStop`) and stamped here, so a stop whose
-- stop.enforce job was lost is found by the reaper (active stops with enforced_at null) and enforced again. Lifting a stop clears the marker
-- so that the resume/restore side is reconciled the same way.
alter table stops add column if not exists enforced_at timestamptz;
alter table stops add column if not exists reconciled_version int not null default 0;
create index if not exists stops_unenforced_idx on stops (org_id, set_at) where lifted_at is null and enforced_at is null;
