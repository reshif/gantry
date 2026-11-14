-- Which session updates a person has seen (spec 11.3): the bell lists an onboarding session with an update newer than this.
create table onboarding_session_seen (
  org_id uuid not null,
  repo_id text not null,
  person_id text not null,
  seen_at timestamptz not null default clock_timestamp(),
  primary key (org_id, repo_id, person_id),
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade
);
grant select, insert, update, delete on onboarding_session_seen to gantry_app;
