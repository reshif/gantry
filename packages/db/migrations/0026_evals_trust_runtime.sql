-- Evals and trust runtime (spec 13.1 to 13.3).

-- An outcome after release carries a person-set attribution (agent fault, spec fault, environment, unrelated) and the station it is attributed to.
alter table outcomes add column attribution text check (attribution in ('agent', 'spec', 'environment', 'unrelated'));
alter table outcomes add column station text;
alter table outcomes add column data jsonb not null default '{}';
alter table outcomes drop constraint outcomes_kind_check;
alter table outcomes add constraint outcomes_kind_check check (kind in ('healthy', 'regression', 'rollback', 'incident', 'followup'));

-- A ceiling is a rule: its conditions and whether it is enforced. The rule in words is the reason column.
alter table trust_ceilings add column data jsonb not null default '{}';
alter table trust_ceilings add column enabled boolean not null default true;
alter table trust_ceilings add column version int not null default 1;

-- A cell can be an override for one repo.
alter table trust_cells add column repo_id text;
create index trust_cells_project_idx on trust_cells (org_id, project_id, agent_id);
create index trust_grants_cell_idx on trust_grants (org_id, cell_id, created_at);
create index gate_decisions_wo_idx on gate_decisions (org_id, wo_id, at);

-- Eval runs: a suite's runs in order, and the results of a run.
create index eval_runs_suite_idx on eval_runs (org_id, suite_id, started_at);
create index eval_results_run_idx on eval_results (org_id, run_id);
create index eval_cases_suite_idx on eval_cases (org_id, suite_id, created_at);
-- A work order that only carries an eval case (source 'eval') is found by its run.
create index work_orders_eval_idx on work_orders (org_id, (data->'eval'->>'run')) where source = 'eval';
