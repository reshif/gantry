# Gantry admin guide

For Factory Admins and Project Admins. It assumes you have read the [overview](README.md) and know the basics from the [user guide](user-guide.md). Installing and running the servers is covered in [Running Gantry in production](../../deploy/PRODUCTION.md).

Contents: [Your first hour](#your-first-hour) · [People, roles and teams](#people-roles-and-teams) · [Access policies](#access-policies) · [Projects](#projects) · [Models and vendors](#models-and-vendors) · [Agents, trust and evals](#agents-trust-and-evals) · [Integrations](#integrations) · [Notifications](#notifications) · [API keys and triggers](#api-keys-and-triggers) · [MCP servers](#mcp-servers) · [Security settings](#security-settings) · [Kill switches](#kill-switches) · [Audit](#audit) · [System health and backups](#system-health-and-backups)

## Your first hour

On a new installation the organisation starts empty. The first person to sign in with the verified email the operator configured as the bootstrap admin becomes **Factory Admin** and sees a **Set up the factory** checklist on Home. The built-in agents, skills and eval suites for each station are loaded for you. The checklist has five steps, and it disappears when they are done: connect GitHub, add a model vendor, create a project, onboard a repo, submit the first work order. Work through them in this order:

1. **Connect a model vendor** in Models, or no agent can run (see [Models and vendors](#models-and-vendors)). Without one, repo onboarding falls back to rules and the Intake dialogue uses a rule-based questionnaire.
2. **Connect GitHub** in Integrations, so repos can be onboarded.
3. **Create a project** from Projects, choosing a template (Backend service, Web app, Library or SDK, Data pipeline, Regulated service, or Blank), a monthly budget, the owning teams and the approver and notification presets.
4. **Invite people** and give them roles (next section).
5. **Set up notifications** so gates and stops reach people where they work.
6. **Onboard the first repo** (user guide: [Onboard a repo](user-guide.md#onboard-a-repo)).

Keep at least two Factory Admins. Restoring the factory after a kill needs two of them.

## People, roles and teams

Open **People and teams** in the Govern group. It shows the organisation tree: teams, the projects and repos they own, and people. Select a person to see their roles, teams, sessions and an **effective permissions** view per project. From there you can open the **simulator** to test a specific question.

### Invite a person

Choose **Invite person**. Enter a work email (it must match an allowed email domain, if you set any in Security), optionally a team, an optional first project and role, and a role end date. They receive an email with a sign-in link. A person who has not accepted the invite has no access. **Mark invite accepted** is there for a case where acceptance happened outside the email link. Identity comes from your sign-in provider. Gantry links a person only to a provider-verified email address.

### Roles

A role is a set of rights. Roles are granted on the **factory** (every project) or on **one project**. A person can be an Engineer on one project and a Reviewer on another.

| Role | Level | By default can |
| --- | --- | --- |
| Factory Admin | Factory | Everything, in every project |
| Factory Manager | Factory | Read everything and operate every project, create projects, edit templates, run evals, halt and resume the factory. Cannot manage roles, members, approver rules, trust grants, API keys, security or policy, and cannot kill or restore the factory |
| Security Reviewer | Factory | Read everything including security settings and the ledger; answer questions, approve gates, send back, halt a line, kill a work order |
| Auditor | Factory | Read everything and the ledger; change nothing |
| Project Admin | Project | Configure the project: flow, classes, approvers, members, notifications, API keys, triggers, onboarding, kill and archive it |
| Line Lead | Project | Submit, classify, decline, move, park, send back, reassign, approve gates, halt and resume, kill a work order, record outcomes |
| Engineer | Project | Submit, answer, confirm briefs, park, send back, halt, steer onboarding |
| Reviewer | Project | Answer, approve gates, send back, halt |
| Approver | Project | Answer and approve gates |
| Release Manager | Project | Approve gates, confirm releases, halt and resume, merge onboarding pull requests, record outcomes |
| Viewer | Project | See the project |

Everyone who can see a project may ask the Console questions. Changes proposed through the Console need a Console right, which only Factory Admins hold until they grant it to a role or team.

Grant a role from a person's panel (**Add role**). Rules that protect you:

- A factory-level role needs a **reason**, which goes on the ledger, and a fresh sign-in. The change has an **Undo**.
- Only a Factory Admin grants or removes Factory Admin. Nobody can grant themselves a role.
- Factory Admin goes to named people, never to a team.
- A Project Admin can only act on a person if the right covers every project that person holds a role on. Anything wider needs the people-management right.
- The last Factory Admin cannot be removed, and nobody can remove their own admin role. Ask another admin.
- A Project Admin can mark someone away and name a delegate only within what they themselves may manage.

### Teams

A team groups people and owns projects and repos. Choose **New team**, then add members from each person's panel (**Edit teams**). You can give a team a role (**Add role** on the team) so everyone in it holds the role while they are a member. Factory Admin cannot be granted to a team.

### Leaving and returning

**Deactivate** removes access immediately. Before you confirm, the dialog shows the person's open work (work they requested, or gates where they are the only named approver), their active sessions and the API keys they created. History stays on the ledger. **Reactivate** brings their roles back. Their API keys and sessions do not come back.

### On call and away

On call is set per project in **Project config**, on the Overview tab. Factory Admins always count as on call. Project admins choose who else is. A person cannot put themselves on call. The person on call can hand over to someone with a role in that project, and every hand-over and use of an on-call right is audited. On the **Approvers** tab you can mark a person **away** and set a delegate who may approve wherever they could.

## Access policies

Open **Access** in the Govern group. It has these parts.

- **Roles by actions**: the matrix of what each role can do. Click a cell to switch a right on or off for a role. Each change is audited and needs a fresh sign-in. **Add role** creates a custom role (give it a name, a description, a level, and optionally clone rights from an existing role). A role in use cannot be deleted.
- **Policies**: rules that narrow or extend rights by project, hour and on-call status. **Narrow** limits a right to a window (for example, releases only in business hours). **Extend** adds a right while a condition holds (for example, while on call). Without any policy the roles alone decide. Times are in the plant's time zone.
- **Freezes**: **Schedule freeze** blocks releases on chosen repos for a period, overriding everything.
- **Policy simulator**: ask "can this person do this action, here, at this time?" and see the deciding rule. Use it before you promise anyone access.

Safeguards you cannot turn off: Factory Admin keeps its protected rights (editing policy and roles, managing people and security, restoring the factory) and every Console right, and nobody may edit the matrix so that no one can edit it. Agents can never approve changes to policy, trust levels, evals, skills, instructions, CI or flow configuration.

## Projects

Each project is a line with its own repos, flow, approvers and budget. Open **Project config** for the chosen project. The tabs:

| Tab | What you set |
| --- | --- |
| Overview | Basics, repos, who is on call |
| Members and roles | Who works on the project |
| Flow | Stations, gates (person, automatic or mixed) and bays; the number of coding slots. Four gates cannot be turned off, and regulated projects keep all of them |
| Work classes | Classes, their skipped stations, default priority and SLA. Add your own |
| Approvers | Per gate: which roles or people, how many approvals, whether the author may approve, extra conditions by class, risk or path, and an escalation time with a fallback person |
| Notifications | Routes for this project (see below) |
| MCP | MCP servers the project's agents may use |
| Budget | Monthly budget and the percentage that raises an alert; spend by station and the most expensive work orders |
| History | Changes to this project's configuration |
| Danger zone | Kill or archive the project |

A station or class cannot be removed while work is in it. If a gate's approver rule cannot be satisfied by the people who hold its roles, the Approvers tab warns you. Fix it before work arrives at that gate.

**Trust, workload and learning.** See [Agents, trust and evals](#agents-trust-and-evals). **Workload** (Govern) shows who carries the approvals, to spot a person who is a bottleneck.

## Models and vendors

Open **Models** (Agents group). You need the models-management right to change anything.

**Vendors.** Add a vendor from the templates (Anthropic, AWS Bedrock, OpenAI, Azure OpenAI, Google Gemini, Google Vertex AI, or an OpenAI-compatible endpoint) or a custom one, and enter what its template asks for, such as an API key. The key is stored encrypted, only the model gateway can use it, and it is shown masked. Health, latency and spend per vendor come from real calls. **Disconnect** removes the stored key. A vendor that carries the factory default cannot be disconnected.

Only vendors that speak the Anthropic Messages API can run agents today, which in practice means Anthropic. Other vendors can be connected and their models listed, but the models stay switched off, and the screen says why.

**Models.** Turn models on or off, add a model, and **Refresh models**. A model that routing or an agent uses cannot be removed.

**Routing.** Decides which model a station gets. It resolves in order: the factory default, then the project's default, then station overrides, then class overrides. An agent's own pinned model replaces the routed choice, but never the filters below. The preview on the page shows what a station would get and why.

**Limits applied before any fallback**: the project's allowed vendors, allowed regions, and allowed data-retention modes, plus repo residency rules by tag (a regulated project always applies its rule). If nothing allowed is available the request is refused. It never leaves the allowed region.

**Fallback.** If a vendor fails, the gateway falls back automatically to the same model on another allowed vendor. Falling back to a different model is off in a new installation. It needs the factory switch and the project's own opt-in, and runs that did it are flagged.

**Custom vendors** must be **qualified** for each station by an eval run that meets the station's threshold (**Record qualification**), before they get work there.

**Prices and budgets.** Publish price versions (input and output per million tokens) with an effective date. Prices cannot be backdated. Each call is priced at the version in force when it happened. Set a default **per work order cap** per project. When a work order reaches its cap, its next model call is refused and the work order pauses at the turn boundary and asks.

## Agents, trust and evals

Open **Agents** to see each station's agent. You need the agent-management right to change them.

- An agent's configuration is edited as a working copy. A **version** is an immutable snapshot. What runs is the version on the floor. You cannot promote a version until the agent's **eval suite** has passed for that exact version at or above its threshold. The refusal says what is needed and is audited. **Rollback** restores an earlier version's configuration.
- Each run uses four layers of instructions: factory base, project overlay, the agent's own, and the repo's guidelines. **Instructions** shows the combined text a run would receive.
- **Skills** are reusable instruction sets attached to agents, versioned the same way and enabled per project.
- **Evals** runs suites and shows scorecards. **Learning** lists findings and proposals from outcomes. Accepting a proposal is a separate right, held by Factory Admins by default.
- **Trust** sets how much an agent decides on its own. The levels are: Shadow (the agent only suggests), Gated (the agent acts, a person approves every gate), Spot-checked (gates pass automatically except a sampled share), Unattended (gates pass within guardrails and release still needs a person), and Unattended including release. Raising a level needs the trust-grant right, requires criteria to be met, and can be capped by a ceiling. Demotions are recorded with their cause. Risk tags and always-on gates still need a person at any level.

## Integrations

**Integrations** (Connect group) lists the connection types and your connected instances.

| Category | Working in this version |
| --- | --- |
| Source control | GitHub (through a GitHub App) |
| Chat | Slack |
| Email | Email (SMTP) |
| Webhooks | Signed webhook |
| Custom | Types you build yourself |

Other types in the catalogue (such as GitLab, Bitbucket, Microsoft Teams, Jira-style and Linear-style trackers, generic CI and paging) are listed with an "Not yet available" reason and cannot be connected yet. Microsoft Teams is one of them.

To add one, choose **Add integration**, pick the type, fill in its fields (secrets are stored encrypted), give the connection a name that tells two of the same type apart, choose which projects may use it, and run the **test**. A new connection starts **switched off**. Turn it on when the test is clean.

- **GitHub.** The operator puts the GitHub App's key in place on the server (see the [production guide](../../deploy/PRODUCTION.md)). The App needs permission to write workflow files for onboarding. Without it repos cannot be onboarded.
- **Slack.** Needs a bot token and signing secret. Once connected, people link their Slack account with `/gantry link`, and cards in chat let them approve in place. Rejecting stays in Gantry because it needs a reason.
- **Custom integration builder.** Define a signed inbound webhook and a templated HTTP request out, including the events it sends, the actions it can perform and a sample payload.

## Notifications

**Notifications** (Connect group) decides which events reach which people, through which connection, with which card. It works per project, with per-repo overrides. Every notification comes from an event that was committed, and is delivered at least once.

1. **Add route**: choose the event, one or more destinations (a connection and a channel or address), a card template, and conditions (classes, priorities, business hours).
2. Use **Preview destination** and **Send test** to check it.
3. Pick which fields the card shows.

Events you can route include: work order submitted, question for a person, gate waiting, gate decided, gate escalated, blocked, security hold, andon halt, kill, restore, onboarding pull request, released, eval regression, budget threshold, trust level changed, learning proposals, post-release outcome, and delivery failures. Kill and restore dialogs list who would be told and flag destinations that are not connected, so check that those events have routes before you need them.

Failed deliveries are retried, then become dead letters. See [System health](#system-health-and-backups).

## API keys and triggers

**API and triggers** (Connect group):

- **API keys.** Each key is a service account on one project. Work it submits is recorded against the key and the person who created it. Creating a key needs a fresh sign-in. The full key is shown once and stored hashed. If it is lost, revoke it and make another. Keys expire (90 days by default, or 180), so rotate before then. Name the system that will hold the key, so it shows in the request log and the audit trail. The page also has the endpoint reference, a playground and a request log.
- **Triggers** open work from outside: a source-control event (for example a label on an issue, or a command in a pull request comment), a tracker, CI, or a schedule. Choose the source connection, the work order title and proposed class, a rate limit and a budget per 24 hours. Triggers are off until you switch them on. Proposals a trigger makes can be held for a person to accept or decline.

An API key or a trigger can never use the rights that agents are forbidden from holding.

## MCP servers

**MCP servers** (Connect group) are tools agents may call: a tracker, docs or a database. Add a server, then scope it by project, repo, agent, station and work class, and deny single tools. Tools that write need a pre-authorisation at the station. All connections go through Gantry's edge, which holds every credential, so agents never see them. If a server reports a changed tool definition, it is blocked until you **Review and re-approve**. The **Usage log** shows the calls.

## Security settings

Open **Security** (Govern group). Every change is audited.

- **Single sign-on.** Records your identity provider settings. The provider itself is configured where Gantry's sign-in client is registered (see the production guide).
- **Multi-factor authentication.** Choose who must use MFA and which methods are allowed. The identity provider enforces the sign-in itself.
- **Session lifetime and idle timeout**, with **Revoke all other sessions** and a list of active sessions you can revoke.
- **Fresh sign-in window.** Kills, restores, and changes to policy, roles, security, API keys and people need a sign-in within this window (15 minutes by default, 5 to 60). Changing it needs a fresh sign-in itself. A separate switch controls whether a kill needs it. Restores always do.
- **Allowed email domains** for invitations and sign-in.
- **IP allow-list** ranges.
- **Research allow-list**: the hosts agents may read during web research. Agents reach only these domains, plus any a person approves with a research plan. Every fetch is snapshotted and audited.
- **Chat spending per person**: the 24-hour cap in dollars. The operator view in Agents at work shows chat spend per person.
- **Sign-in history** with outcomes.

## Kill switches

You have the same stops as the user guide describes. Here is what admins decide.

| Scope | Halt (resumable) | Kill (hard stop) | Who holds it by default |
| --- | --- | --- | --- |
| Repo or project | Halt and resume | Kill project, restore project | Halt: Engineer, Reviewer, Line Lead, Release Manager, Project Admin. Resume: Line Lead, Release Manager, Project Admin. Kill project: Project Admin |
| Work order | n/a | Kill and restore | Kill: Line Lead, Project Admin, Security Reviewer. Restore: Project Admin |
| Factory | Halt and resume rights exist (Factory Admin and Factory Manager hold them) but the app offers no factory halt button yet. Use a project halt, or the API | Kill and restore the factory (Factory Admin only) | Factory Admin |

- A kill needs a reason, shows its impact first, and for the project or factory needs a typed confirmation. Project and factory kills let you choose to **hold in place** or **cancel in-flight work**.
- Kills and restores need a fresh sign-in. **Restoring the factory needs two Factory Admins**: the first starts it and the status chip then shows "1 restore approval so far" until the second approves.
- Agents are stopped at the model gateway. A halted or killed scope is refused by the gateway within a fraction of a second, and its sandbox container is removed within seconds.
- Gantry can also halt a repo for itself (for example when a readiness check fails, or a work order reaches its budget). These show their cause in the reason text. A person's own halt is never overridden.
- Kill and restore the factory are in the status chip popover and the command palette (Ctrl K), only for people who hold the right.

## Audit

**Audit** (Govern group) is the append-only ledger of every human, agent, API key and trigger action, including denied attempts and sign-ins. Nothing in it can be edited or deleted.

- Filter by category (sign-in, access, flow, onboarding, approvals, config, integrations, API, agents, kill), project, actor, outcome and channel, or search by text. Open an entry for its detail, and for before and after values where a change has them.
- Each entry carries a SHA-256 digest of its fields and the digest before it, written by the database. **Verify chain** re-checks the whole chain and reports the first break. Run it periodically, and after any restore. The weekly restore drill also checks it.
- You need the audit-view right. Auditors, Factory Managers, Security Reviewers and Project Admins hold it by default. Only whole-ledger readers see the chain's head.

There is no built-in export to a SIEM yet. Copy what you need from the page, or use the API.

## System health and backups

**System health** (Govern group) answers "is the factory working?":

- **Services**: whether each service is answering, and the worker's heartbeat.
- **Backups and restore drill**: when the last backup ran, whether it is current, and the result of the last restore drill.
- **Outbox and dead letters**: notification deliveries that gave up. Review them and requeue a delivery once its destination is fixed (audited).
- **Stuck jobs**: background jobs that have stopped moving.

**Backups** are run by the operator and set up in the [production guide](../../deploy/PRODUCTION.md#backups). In short, a set is taken daily and holds both databases, the object store (documents, traces, checkpoints), a manifest of row counts and checksums. The newest seven are kept, optionally copied off the host. A weekly restore drill restores the newest set into scratch databases and checks checksums, migration level, row counts, the audit hash chain, sign-in users and objects. If System health shows a backup older than a day or a failed drill, tell the operator the same day.

What to know as an admin:

- The recovery point is up to 24 hours. There is no point-in-time recovery.
- A backup does not hold secrets. Stored integration secrets are encrypted with a key the operator keeps separately. Without it a restored database cannot use them.
- Backups contain people's names and emails and the work itself, so keep them on encrypted storage.
- Restoring is an operator action and refuses while services are connected. After a restore, run **Verify chain** and check System health.
