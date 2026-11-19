-- Agent workspace, Phase 4: one inbox over every conversation.
--
-- A conversation is keyed by what it is about: `wo:<id>` (a work order's primary thread, workorder_messages), `repo:<id>` (a repository's onboarding
-- thread, onboarding_messages) or a chat id `ct-...` (console_threads). Chats gain a scope and an agent, so a side thread with a work order's
-- Researcher is a chat scoped to that work order; the factory-scope chat with the console assistant is what the Console always was.
--
-- Visibility of a chat: `private` (the owner and the people invited), `project` (anyone who may see the scope's project can read; only the owner and
-- invited people post). Archived chats are read-only and still searchable. Primary and onboarding threads cannot be archived for everyone: a person
-- files them away for themselves (thread_prefs.archived), and a closed work order's thread is archived automatically 14 days after it closed.
alter table console_threads
  add column scope_kind text not null default 'factory' check (scope_kind in ('factory', 'project', 'work_order', 'repo')),
  add column scope_id text,
  add column project_id text,
  add column agent_id text,
  add column visibility text not null default 'private' check (visibility in ('private', 'project')),
  add column status text not null default 'active' check (status in ('active', 'archived')),
  add column archived_at timestamptz,
  add column archived_by text,
  add constraint console_threads_scope_ck check ((scope_kind = 'factory') = (scope_id is null));
create index console_threads_scope_idx on console_threads (org_id, scope_kind, scope_id) where scope_id is not null;
create index console_threads_project_idx on console_threads (org_id, project_id) where visibility = 'project';

-- Who wrote a person's message in a shared chat (null: the chat's owner, as before), and which person asked for an answer (its cost counts to them).
alter table console_messages add column author text;

-- People invited to a chat. They read it and may post in it; their own rights decide what the assistant's tools show them.
create table thread_members (
  org_id uuid not null,
  thread_id text not null,
  person_id text not null,
  added_by text not null,
  added_at timestamptz not null default clock_timestamp(),
  primary key (org_id, thread_id, person_id),
  foreign key (org_id, thread_id) references console_threads (org_id, id) on delete cascade,
  foreign key (org_id, person_id) references people (org_id, id) on delete cascade
);
create index thread_members_person_idx on thread_members (org_id, person_id);
grant select, insert, update, delete on thread_members to gantry_app;

-- A person's own marks on any conversation (any key): pinned to the top of their inbox, or filed away in their Archived view.
create table thread_prefs (
  org_id uuid not null,
  person_id text not null,
  thread_key text not null,
  pinned boolean not null default false,
  archived boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, person_id, thread_key),
  foreign key (org_id, person_id) references people (org_id, id) on delete cascade
);
grant select, insert, update, delete on thread_prefs to gantry_app;

-- Full-text search over what people and agents wrote. The expressions match the search queries exactly, so each one can use its index.
create index console_messages_fts on console_messages using gin (to_tsvector('english', body));
create index workorder_messages_fts on workorder_messages using gin (to_tsvector('english', body));
create index onboarding_messages_fts on onboarding_messages using gin (to_tsvector('english', body));
create index artefacts_doc_fts on artefacts using gin (to_tsvector('english', coalesce(body, ''))) where doc is not null;
create index research_sources_fts on research_sources using gin (to_tsvector('english', title || ' ' || excerpt));
create index wo_questions_fts on wo_questions using gin (to_tsvector('english', question || ' ' || coalesce(answer, '')));
