-- S-43: a monthly budget of 0 is a REAL $0 cap when a person set it ("nothing metered runs"), and "no cap" is its own state. Rows written before this
-- carry 0 meaning "not set" and keep meaning it: the flag defaults to false, so this migration changes no row and halts no work. Effective cap:
-- monthly_limit_micros > 0 -> that amount; else monthly_zero_cap -> $0; else no cap.
alter table budgets add column monthly_zero_cap boolean not null default false;
