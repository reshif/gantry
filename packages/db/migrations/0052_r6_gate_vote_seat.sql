-- Round 6 S-53: the seat a delegate's vote fills (the away approver), so N approvals count N distinct seats.
alter table gate_votes add column if not exists for_person text;

-- Round 6 S-51: a key whose maker was deactivated with "keep their keys" stays live by that explicit, audited choice; every other key acts only while its maker still holds the right to make it.
alter table api_keys add column if not exists keep_live boolean not null default false;
