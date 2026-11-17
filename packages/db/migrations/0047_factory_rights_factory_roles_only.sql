-- Factory-wide rights (read access, policy, security, models, integrations, people, factory stop and restore ...) belong to factory-level roles only
-- (owner decision 2026-11-17). An org created before the Read rights were factory scope kept them as project scope in its stored catalogue and
-- published a matrix that gave them to Project Admin, so a Project Admin could read Access, Security, System health, vendors, prices, budgets
-- and routing. Three repairs, all per org, each only when something is wrong:
--   1. the stored catalogue's built-in actions take the scope the code fixes (the factory-scope list below is that catalogue, 2026-11-17);
--   2. a new matrix version is published with every factory-scope right switched off for every project-level role (the old versions stay);
--   3. the removal is written to the audit ledger (matrix.sanitised), naming each role and right removed.
create temporary table _factory_actions (id text primary key) on commit drop;
insert into _factory_actions (id) values
  ('people.view'), ('policy.view'), ('agents.view'), ('models.view'), ('integrations.view'), ('halt.factory'), ('resume.factory'),
  ('kill.factory'), ('restore.factory'), ('project.create'), ('template.edit'), ('agent.edit'), ('skill.edit'), ('model.edit'), ('mcp.edit'),
  ('integration.edit'), ('eval.run'), ('people.manage'), ('policy.edit'), ('security.manage'), ('audit.view'), ('trust.criteria'),
  ('integration.add'), ('role.edit'), ('learning.apply');

-- 1. catalogue scopes
update orgs o
   set settings = jsonb_set(o.settings, '{catalog,actions}', (
         select jsonb_agg(case when f.id is not null and a->>'scope' is distinct from 'factory' then jsonb_set(a, '{scope}', '"factory"') else a end order by t.i)
           from jsonb_array_elements(o.settings->'catalog'->'actions') with ordinality as t(a, i)
           left join _factory_actions f on f.id = t.a->>'id'))
 where jsonb_typeof(o.settings->'catalog'->'actions') = 'array'
   and exists (select 1 from jsonb_array_elements(o.settings->'catalog'->'actions') a join _factory_actions f on f.id = a->>'id' where a->>'scope' is distinct from 'factory');

-- 2 and 3. matrix and ledger
do $$
declare
  o record;
  cur record;
  removed jsonb;
  nextm jsonb;
  v int;
begin
  for o in select id from orgs loop
    select version, matrix into cur from role_matrix_versions where org_id = o.id and published_at is not null order by version desc limit 1;
    if not found then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('role', r.id, 'right', c.key) order by r.id, c.key), '[]'::jsonb) into removed
      from roles r
      join lateral jsonb_each(cur.matrix -> r.id) c on true
      join _factory_actions f on f.id = c.key
     where r.org_id = o.id and r.level = 'project' and c.value = 'true'::jsonb;
    if jsonb_array_length(removed) = 0 then continue; end if;
    nextm := cur.matrix;
    for v in 0 .. jsonb_array_length(removed) - 1 loop
      nextm := jsonb_set(nextm, array[removed -> v ->> 'role', removed -> v ->> 'right'], 'false'::jsonb);
    end loop;
    insert into role_matrix_versions (org_id, version, matrix, note, published_at, published_by)
    values (o.id, cur.version + 1, nextm, 'Factory-wide rights removed from project-level roles', now(), 'system');
    insert into events (org_id, type, category, actor, channel, subject, before, after)
    values (o.id, 'matrix.sanitised', 'access', 'system', 'system', jsonb_build_object('type', 'matrix', 'id', (cur.version + 1)::text),
            jsonb_build_object('version', cur.version),
            jsonb_build_object('version', cur.version + 1, 'removed', removed, 'note', 'Factory-wide rights belong to factory-level roles only; these project-role grants were removed.'));
  end loop;
end $$;
