-- The onboarding session (spec 11.3): one conversation per repository for its whole onboarding. Messages are shared by the people who may see the repo's project
-- (not per person like the console's threads) and live as long as the repo. `author` is a person id, `ag-onboard` or `system`; `data` holds the cards, the
-- model, the tool names and the usage of an answer.
create table onboarding_messages (
  org_id uuid not null,
  id text not null,
  repo_id text not null,
  run_id text,
  role text not null check (role in ('user', 'assistant', 'system')),
  author text not null,
  body text not null default '',
  data jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade
);
create index onboarding_messages_repo_idx on onboarding_messages (org_id, repo_id, created_at, id);
grant select, insert, update, delete on onboarding_messages to gantry_app;
