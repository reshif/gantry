# Gantry guides

Gantry is a software factory. You hand it a piece of work (a work order), AI agents do the work station by station, and people approve it at gates before anything moves on. Every action is checked against what the person is allowed to do, and every action is written to an audit ledger that cannot be edited.

These guides are for people who are new to Gantry.

| Guide | Read it if you | Covers |
| --- | --- | --- |
| [User guide](user-guide.md) | submit, follow, approve or discuss work | Submitting work orders, the floor, gates and approvals, talking to agents, onboarding a repo, stopping work |
| [Admin guide](admin-guide.md) | run the factory or a project | People, roles and teams, access policies, models and vendors, integrations, notifications, API keys, kill switches, audit, backups |
| [Running Gantry in production](../../deploy/PRODUCTION.md) | install and operate the servers | Install, sign-in provider, TLS, mail, backups and restore, upgrades |

## The ideas behind everything

- **Agents propose, people approve.** An agent can draft a brief, a spec, a plan or a pull request. It cannot approve its own work, change who is allowed to do what, or merge on its own authority. A person always decides, using their own rights.
- **Default deny.** Nobody can do or even see anything until a role says so. If a button is greyed out, point at it (or focus it with the keyboard): it says why and what you would need.
- **Everything is on the record.** Approvals, refusals, sign-ins, settings changes and stops all appear in the Audit ledger, with who, what and when.
- **You can always stop the line.** Anyone with the right can halt a repo or project (a pause that can be resumed) or kill a work order, project or the whole factory (a hard stop).

## Words you will meet

| Word | Meaning |
| --- | --- |
| Work order | One request for the factory to do something, with an id such as `WO-1003`. |
| Station | A step in the line, staffed by an agent. The built-in line is Intake, Research, Spec, Design, Plan, Build, Verify, Review and merge, and Close. |
| Gate | A checkpoint after a station. A gate is decided by a person, by automatic checks, or by both. |
| Class | The kind of work (feature, bug, hotfix and so on). The class decides which stations are skipped and how urgent the work is. |
| Floor | The live view of a project: every work order on the line. |
| Traveler | The panel for one work order: its journey, brief, documents, run, artefacts and history. |
| Bay | A place off the line where a work order waits: On hold, Needs a person, Security hold, Queue or Declined. |
| Project | A line in the factory with its own repos, flow, approvers, budget and kill switch. |
| Repo | A source repository connected to a project. It must be Ready (onboarded) before it accepts work. |
| Andon | The halt cord: a resumable pause on a repo or project. |
| Kill | A hard stop with a recorded reason. Restoring needs a fresh sign-in. |
