-- Console preferences per person (spec 12.6): the model they chose in the console header. Null means the routing default.
create table console_prefs (
  org_id uuid not null,
  person_id text not null,
  model_id text,
  updated_at timestamptz not null default now(),
  primary key (org_id, person_id),
  foreign key (org_id, person_id) references people(org_id, id) on delete cascade
);
grant select, insert, update, delete on console_prefs to gantry_app;
