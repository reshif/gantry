-- Immutability of published versions, and updated_at maintenance.

-- A row whose published_at is set is frozen: no UPDATE, no DELETE. Drafts may change until published.
create function gantry_reject_published_change() returns trigger language plpgsql as $$
begin
  if old.published_at is not null then
    raise exception '% is immutable once published (% rejected)', tg_table_name, tg_op using errcode = '23000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'flow_versions','role_matrix_versions','policy_versions','approver_rule_versions','agent_versions',
    'skill_versions','instruction_versions','guideline_versions','routing_versions','price_versions',
    'trust_criteria_versions','security_settings'
  ] loop
    execute format('create trigger %I before update or delete on %I for each row execute function gantry_reject_published_change()',
      t || '_immutable', t);
  end loop;

  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'updated_at'
  loop
    execute format('create trigger %I before update on %I for each row execute function gantry_touch()', t || '_touch', t);
  end loop;
end $$;
