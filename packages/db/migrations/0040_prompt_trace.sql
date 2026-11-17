-- Prompt records for conversational model calls (the service gateway). Run calls already carry run_usage.trace_ref; these columns let a conversational
-- call say where it belongs, so the trace can be read by exactly the people who may read that work order or project.
alter table usage_meter
  add column surface text,
  add column wo_id text,
  add column actor_id text,
  add column turn_id text,
  add column prompt_hash text;
create index usage_meter_trace_idx on usage_meter (org_id, trace_ref) where trace_ref is not null;
create index usage_meter_wo_idx on usage_meter (org_id, wo_id) where wo_id is not null;
