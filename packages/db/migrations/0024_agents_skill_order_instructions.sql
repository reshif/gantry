-- Agents area (spec 8.7): the order of an agent's attached skills ("in order": earlier skills win).
alter table agent_skills add column position int not null default 0;
-- Existing rows keep the order they had (created_at, skill id): number them per agent.
update agent_skills k set position = o.n
  from (select org_id, agent_id, skill_id, row_number() over (partition by org_id, agent_id order by created_at, skill_id) as n from agent_skills) o
 where k.org_id = o.org_id and k.agent_id = o.agent_id and k.skill_id = o.skill_id;
