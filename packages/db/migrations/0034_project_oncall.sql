-- On call is per project (owner decision 7, 2026-11-15). A project's admins choose who is on call for it, kept in
-- projects.config -> 'oncall' (person ids); a Factory Admin always counts as on call and is never listed. The old
-- self-set people.oncall switch no longer grants anything: each person it marked becomes on call for every project
-- they hold a role on (every project, for a factory-level role), then the switch is cleared.
update projects pr
   set config = jsonb_set(pr.config, '{oncall}', coalesce((
         select jsonb_agg(p.id order by p.id)
           from people p
          where p.org_id = pr.org_id and p.oncall
            and exists (select 1 from effective_role_assignments ra
                         where ra.org_id = p.org_id and ra.person_id = p.id and ra.revoked_at is null
                           and (ra.expires_at is null or ra.expires_at > now())
                           and (ra.project_id is null or ra.project_id = pr.id))), '[]'::jsonb))
 where not (pr.config ? 'oncall');

update people set oncall = false where oncall;
comment on column people.oncall is 'Unused since 0034: on call is per project (projects.config.oncall); Factory Admins always count.';
