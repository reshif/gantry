-- Skills are pinned by agent versions. A version used to store only the ids of its skills, so saving a skill changed what every attached agent ran at its next dispatch, with no eval.
-- From now on a version records the skill version each skill was tested at (body.skillVersions) and a skill edit makes a candidate agent version instead.
-- Backfill: every existing version is pinned to what it would have run with today (the attachment's own pin, else the skill's latest), so nothing changes for a run in flight.
-- Published agent versions are immutable (0009); the trigger is lifted for this one statement, which only adds a key and rewrites nothing that was recorded.
alter table agent_versions disable trigger agent_versions_immutable;
update agent_versions v
   set body = v.body || jsonb_build_object('skillVersions', coalesce((
         select jsonb_object_agg(e.id, coalesce(ag.pinned_version, s.live_version))
           from jsonb_array_elements_text(v.body->'skills') as e(id)
           join skills s on s.org_id = v.org_id and s.id = e.id
           left join agent_skills ag on ag.org_id = v.org_id and ag.agent_id = v.agent_id and ag.skill_id = e.id
          where coalesce(ag.pinned_version, s.live_version) is not null), '{}'::jsonb))
 where jsonb_typeof(v.body->'skills') = 'array' and not (v.body ? 'skillVersions');
alter table agent_versions enable trigger agent_versions_immutable;
