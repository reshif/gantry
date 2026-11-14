-- Flow engine (wave 3): work order numbering, slots, live attempts, stop fencing (spec 9.1 F2/F3/F5, 9.7, 4.4).

-- Work order ids keep the legacy style (WO-1042); one sequence for the installation.
create sequence if not exists wo_number_seq start 1001;
grant usage, select on sequence wo_number_seq to gantry_app;

-- F3: at most one live attempt per work order and station.
create unique index if not exists attempts_one_live_idx on attempts (org_id, wo_id, station) where state in ('queued', 'running');

-- F5: a work order holds at most one coding slot. Slot rows are named `${project}:${n}` and are re-used (free <-> held).
create unique index if not exists slots_one_per_wo_idx on slots (org_id, wo_id) where state = 'held' and wo_id is not null;

-- Spec 4.4 step 1: a stop takes the next fencing number. Any attempt with a lower number inside the scope is superseded,
-- whether or not the stop has been lifted since, so the stop path never has to touch attempts.
alter table stops add column if not exists fencing bigint not null default nextval('attempt_fencing_seq');
create index if not exists stops_fencing_idx on stops (org_id, fencing);

-- One conversation per work order and kind.
create unique index if not exists conversations_wo_kind_idx on conversations (org_id, wo_id, kind) where wo_id is not null;

-- A vote remembers the channel it came from (web, slack, teams, console, api).
alter table gate_votes add column if not exists via text not null default 'web';
