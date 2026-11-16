# Gantry user guide

For people who submit work, follow it through the factory, approve it, or talk to the agents doing it. Read the [overview](README.md) first if you have not used Gantry before. Admins have their own [guide](admin-guide.md).

Contents: [Signing in](#signing-in) · [Finding your way around](#finding-your-way-around) · [Submit a work order](#submit-a-work-order) · [Follow work on the floor](#follow-work-on-the-floor) · [The work order panel](#the-work-order-panel) · [Gates and approvals](#gates-and-approvals) · [Talk to agents](#talk-to-agents) · [Onboard a repo](#onboard-a-repo) · [Stop work](#stop-work) · [When something is greyed out or refused](#when-something-is-greyed-out-or-refused)

## Signing in

Open your organisation's Gantry address and choose how to sign in. Your organisation's identity provider handles the password and any multi-factor step. Gantry never sees your password.

- **First time.** An admin invites you by email. Follow the sign-in link in that email. Until you accept the invite you have no access.
- **Signed in but see "No access yet".** Your account exists but has no role. Ask a Factory Admin or the Project Admin of the project you need to give you one.
- **Signed out on its own.** Sessions end after an idle period and after a maximum lifetime, both set by your admins. Sign in again.

## Finding your way around

The left menu has groups. You only see pages you are allowed to read.

| Group | Pages | What they are for |
| --- | --- | --- |
| Overview | Home, Projects, Agents at work | Your starting point, the list of projects, and every conversation with agents |
| Project | Floor, Work orders, Onboarding, Project config | The project you have chosen |
| Agents | Agents, Skills, Models, Evals, Trust, Learning | How the agents are set up (mostly read by admins) |
| Connect | Integrations, Notifications, MCP servers, API and triggers | Connections to other systems |
| Govern | People and teams, Workload, Access, Security, Audit, System health | Who can do what, and the record |

The **project switcher** next to the logo chooses which project the Project group shows. **Search** (Ctrl K) jumps to pages and runs actions. The **status chip** in the top bar shows whether the factory is running, halted or killed. Your **account menu** has sign-out.

**Home** shows what needs your attention: gates waiting on you, work in flight, and spend. **Projects** lists every project you can see with its health, and **New project** is there for people who may create one.

## Submit a work order

You need the right to submit work in the project (Engineers, Line Leads, Project Admins and Factory Admins have it by default) and a repo that is **Ready** (see [Onboard a repo](#onboard-a-repo)).

1. Open the **Floor** or **Work orders** page for your project and choose **New work order**. If the button is locked, point at it: it tells you why (for example, no repo is Ready yet, or the project is halted).
2. Pick the **project** and **repo**. Only Ready repos accept work.
3. Write a **title** (at least three characters) and a **description**. Say what should change and how you will know it is done. Acceptance criteria help the Spec agent.
4. Optional fields:
   - **Attachment names**: names only, files are not uploaded here.
   - **Requested class**: leave it as "Let the Intake agent decide" unless you are sure. The classifier may disagree, and overrides are audited.
   - **Priority**: P1 urgent, P2 normal, P3 when free. By default it comes from the class.
   - **Source**: where the request came from (Web, Console, Slack message, GitHub issue).
5. As you type, a **classifier preview** shows the class, its confidence and the route the work would take.
6. Choose **Submit work order**. One click makes one work order.

The work order starts at **Intake**. The Intake agent classifies the request, proposes a route and opens a conversation with you to complete the brief. You can also submit from the Console with `/new payments-api: Fix refund rounding`, or by API, trigger, Slack or GitHub if your admins have set those up.

### Classes decide the route

| Class | Skipped stations | Default priority |
| --- | --- | --- |
| Feature | none | P2 |
| Bug | Research, Design | P2 |
| Hotfix | Research, Design | P1 |
| Epic | none (it can be split into child work orders) | P2 |
| Chore or dependency | Research, Spec, Design | P3 |
| Refactor | Research | P3 |
| Security fix | Research | P1 |
| Docs | Research, Design, Plan | P3 |
| Spike or research | everything after Research | P3 |

Your project may add its own classes or change the line (see Project config).

### Confirm the brief

The first gate is **Brief confirmed**. The Intake agent asks questions and, when it has enough, proposes a brief: scope, class and route. The proposal appears as a card in the conversation. Read it, and then either confirm it or ask for changes. Only a person can confirm. The agent cannot, and it cannot propose a brief while one of its own blocking questions is still unanswered. The submitter can confirm their own brief. Other people with the right to confirm briefs can too. The agent may also propose a different class or propose declining the request. These are cards for a person to approve.

## Follow work on the floor

The **Floor** is the live view of one project. Across the top are figures: work in flight, gates waiting (and how long the oldest has waited), stuck work, coding slots in use, shipped work, and spend this month against the budget.

Switch between three views:

- **Belt**: the line drawn as a conveyor, with stations, gates, the bays off the line and a shipped strip. Select a station or gate for details.
- **Board**: columns by station. Drag a card to move it, or use the keyboard "Move to" menu. Filter by class, priority, repo and assignee, and group by swimlane.
- **List**: a sortable table.

Select any work order to open its panel. **Replay** rebuilds the floor as it was at a past time. It is read-only; choose **Back to live** to act again.

The **Work orders** page is the searchable table of everything in the project. Filter by class, station or bay, repo, priority, source and state. Each row has links to the full record and the conversation.

### What the states mean

| State | Meaning |
| --- | --- |
| Running | An agent is working at a station |
| Waiting on gate | The work is done and a gate needs a decision |
| Blocked | Something stops it, and the panel says what |
| Failed check | An automatic check did not pass |
| Parked | Held in a bay off the line |
| Killed | Hard-stopped |
| Done | Shipped, or split into children |

Bays: **Declined** (the factory will not do it), **On hold** (paused by a person), **Security hold** (stopped by a security check), **Needs a person** (waiting for someone to answer or take over) and **Queue** (waiting for a free coding slot).

## The work order panel

Opening a work order shows its panel (the "traveler"). The header gives the repo, where it is now, class and confidence, who requested it, SLA due date, the pull request, coding slot, tokens and spend, and risk. Banners show when it is killed, stopped or blocked, and why.

The tabs:

- **Journey**: station by station, with each gate, who approved it and when, and a scrubber to see how it looked earlier.
- **Lifecycle**: the whole life of the work order as a timeline.
- **Brief**: scope, acceptance criteria, risks, open questions and decisions.
- **Documents**: the markdown document each station's agent wrote (research note, spec, design, plan). Documents are versioned. Compare versions, and download them. You cannot edit a document directly. You steer it through the conversation, and the agent writes a new version that records the turn that caused it.
- **Run**: a live timeline of the station's run: files read, pages fetched, what it wrote and what it costs.
- **Artefacts**: the files and pull request the work produced.
- **History**: every event on this work order.

Buttons you may see, each only if you hold the right: **Approve** and **Reject** at a waiting gate, **Retry**, **Return to** an earlier station, **Send back**, **Move to bay**, **Reassign agent**, **Reclassify**, **Halt repo** and **Kill work order**. Use **Open full record** for the complete record of the work order, which you can copy as markdown, and **Open conversation** to talk to the agent at the current station.

## Gates and approvals

A gate sits after a station. It is decided one of three ways: by a **person**, by **automatic checks**, or both ("mixed").

| Gate | After | Decided by | What it asks |
| --- | --- | --- | --- |
| Brief confirmed | Intake | Person | Are the brief, class and route right? |
| Feasibility | Research | Automatic | Research note attached, no blocking unknowns |
| Spec approved | Spec | Person | Scope and acceptance criteria agreed |
| Design review | Design | Person | Interfaces and data shapes reviewed |
| Plan and security | Plan | Person plus automatic | A person approves the plan while the security checks run |
| Checks green | Verify | Automatic | Required checks pass, coverage on changed lines, no new flaky tests |
| Review and merge | Review and merge | Person | A human approves the pull request, then the agent merges |
| Release confirmed | Close | Person | The Release Manager confirms the release is out and healthy |

Four gates cannot be switched off in any project: Brief confirmed, Plan and security, Checks green and Review and merge. Regulated projects keep every gate on. Project admins can configure the others.

### Approve a gate

1. Open the work order. A waiting gate shows who may approve it, how many approvals it needs and how many it has. The rule is written in words, such as "Needs 2 approvals from Line Lead or Project Admin, and the author cannot approve".
2. Read the evidence: the documents, the diff and checks, the risk tags and any open assumptions. Ask the agent questions in the conversation if something is unclear.
3. Choose **Approve** (the button is named for the gate, for example "Approve G2"; it is "Confirm brief" at the first gate and "Confirm release" at the last). To refuse, choose **Reject** with a reason. To ask for rework at an earlier station, use **Send back** with a note for the agent.

You can also approve from the Console (`/approve WO-2417`) or from a Slack card if your organisation has connected Slack. A Slack card offers **Approve** and **Open**. Rejecting needs a written reason, so it happens in Gantry.

Things to know:

- **The requester is never the only approver.** At least one approver must be someone other than the person who requested the work. If a rule has "the author can't approve" and too few people hold the role, the panel warns that the gate cannot pass as configured. Ask an admin to add approvers.
- **Risk tags force a person.** If the diff touches CI or workflow files, dependency manifests, code owners, authentication or crypto paths, migrations, Gantry config, or tests the agent edited, an automatic gate is sent to a person with a note naming the tags.
- **Away and delegates.** If you are away, a delegate can approve wherever you could. Admins set this in Project config.
- **Overrides.** If nobody eligible is available, a Factory Admin can approve as a break-glass override. They must give a reason, and it is audited.
- **Trust.** The more an agent has earned, the more gates pass without you: at the lowest level a person approves everything, at the next the agent acts and a person approves every gate, then gates pass automatically except a sampled share, then within guardrails. Release confirmation still needs a person until the top level. Trust levels are set by people with the right to change them; see [Trust in the admin guide](admin-guide.md#agents-trust-and-evals).

### Spend limits

Each work order has one spending cap that covers every station, research run and scout. A research plan shows how much of the remaining budget it expects to use. A work order that reaches its cap pauses and asks. Raising the cap needs someone with the right to do so.

## Talk to agents

Open **Agents at work** in the Overview group. It is one inbox over every conversation you can read.

The filter tabs are **Needs me** (questions, proposals and gates you may decide), **Active**, **Mine** and **Shared**, with **Archived** under the list. Conversations are grouped by work order, side thread, repository and factory chat. Rows show who the conversation is waiting on: you, an approver, someone else, or an agent working. Type to filter the list by name. Press Enter to search messages, documents, sources and questions across everything you may read.

Use a row's menu to **pin** it to the top or **archive** it. Archiving is a mark per person for threads you do not own. A closed work order's thread archives itself after 14 days.

### The work order thread

Every work order has one primary thread with its station agents. The agent at the current station speaks first.

- **Questions.** An agent can stop and ask you. The question appears as a card, sometimes with suggested answers. Answer it, or choose **I don't know** or **Not relevant**. The agent resumes and carries your answer to later stations. Everyone sees who answered.
- **Assumptions.** When an agent proceeds on a guess, it records it. Use **Correct it** and **Save correction** if it is wrong. The gate card lists the open assumptions.
- **Proposals.** An agent may propose a brief, a different class, a decline, a research plan, or (during onboarding) a pull request. Each is a card that only does something when a person approves it with their own rights.
- **Research plan.** Before an agent reads the web, it proposes a plan: scope, domains and budget. **Approve plan** lets it proceed. It can only reach hosts on the allow-list your admins keep, plus any new hosts the plan names that you approve. Every page it reads is snapshotted and audited, and the sources are cited as chips in the document.
- **Scouts and objections.** A research agent may start small child runs (scouts) that draw on the work order's budget. You can stop a scout. An agent may also raise an objection to another agent's work. An objection always comes to a person, who decides whether it stands.

Everyone who can read the project can read its work order threads. Only the people taking part can post: the requester, the assignees, the approvers of the current gate, and anyone they invite.

### Side threads and chats

Choose **New chat** to start:

- a **side thread** about a work order with a chosen station agent (for example the Researcher or the Spec writer). It answers read-only from the work order's documents, dialogue and sources, in that agent's voice. It cannot change the work order.
- a chat with the **Gantry assistant**, or with **the factory (Console)**.

In a thread you can **Invite a person** (they must be able to see the project), rename it, archive it (it becomes read-only), leave it, and export it as markdown or JSON. Type `@Researcher` or another agent's name in a work order thread to open a side thread with it. A thread shows what its answers have cost, and each person has a 24-hour chat spending cap set by admins.

### The Console

The Console answers questions about the factory and can prepare actions. Reading is always limited to what you may read yourself. Anything that changes something comes back as a confirm card, and the click needs the underlying right, with a fresh sign-in for kills. Only people holding the matching console right may have it prepare changes. Type `/help` for the list. These work today:

`/projects`, `/status`, `/mine`, `/why WO-2398`, `/summary WO-2417`, `/who-can release payments friday 22:00`, `/changes`, `/bottlenecks`, `/workload`, `/trust`, `/evals`, `/triggers`, `/onboarding`, `/onboard`, `/new`, `/approve`, `/halt`, `/resume`, `/kill`, `/restore`.

## Onboard a repo

A repo must reach **Ready** before anyone can submit work to it. Open **Onboarding** in the Project group.

You need the right to connect repos (Project Admins have it), and a GitHub connection set up by an admin (see [Integrations](admin-guide.md#integrations)).

1. **Connect repo.** Choose a repository that Gantry's GitHub connection can see. Optionally name the owning team.
2. **Assessed.** Gantry reads the repo's own files and lists findings: CI, test command, branch protection, code owners, lint, a secrets scan, an `AGENTS.md` file, toolchain pin, lockfile and whether tests need Docker. Each finding is marked required or advisory against the guidelines. If a model vendor is connected the Onboarding Agent adds its own judgement. Otherwise the work is rule-based, and the screen says so.
3. **PR opened.** Gantry opens one onboarding pull request with the files the repo is missing. The agent may draft `AGENTS.md`. You can read the lines the pull request really adds.
4. **PR checks.** Wait for the repo's CI to run on the pull request.
5. **PR merged.** Someone with the right to merge onboarding pull requests (for example a Release Manager) approves and merges it, after reading it. Ask for changes if it is not right.
6. **Verified.** Gantry checks that the branch protections, code owners and a live canary hold. **Verify now** re-checks.
7. **Ready.** The repo accepts work orders.

Each repo has its own conversation with the Onboarding Agent. It shows progress, findings, and proposal cards for the pull request and the merge, each with **Approve**, **Ask for changes** and **Discard**. The agent only proposes. A person approves.

Under **Details and settings** you can edit the repo's default branch, branch prefix, merge method, release tagging, required checks, protected paths and owning team, and mark an **exception** (with a reason) so a repo that cannot meet every guideline can still take work. Guidelines say what a repo must have and what the onboarding pull request may and may never change. A project can add its own items.

A Ready repo is re-checked on a schedule. If a check definitely fails twice, or your own verification fails, the repo goes back to "Needs a person" and its line halts until it is fixed or given an exception. A GitHub outage never halts a repo.

## Stop work

You have two kinds of stop. Both need a reason, which goes on the record and to the notification routes.

- **Halt (andon).** A resumable pause. Agents on that repo or project stop at their current step. Use **Halt repo** on a work order's panel, the **Halt** button on the floor, or `/halt payments-api duplicate refunds`. Anyone with the line-halt right can do it, which includes Engineers and Reviewers. **Resume** restarts it, and needs the resume right (Line Leads, Release Managers, Project Admins).
- **Kill.** A hard stop. Agents stop, coding slots are freed, open pull requests become drafts and new submissions are refused. You can kill a **work order**, a **project**, or the **factory**. The dialog first shows what it would touch: work orders in flight, running agents, slots freed and open pull requests, and who will be notified. For a project or factory you choose whether to **hold in place** (resumable) or **cancel in-flight work**. Killing a project needs you to type its name. Killing the factory needs you to type `KILL FACTORY`. A kill needs a recent sign-in (15 minutes by default) unless your admins turned that off. A **restore** always needs a fresh sign-in, and restoring the whole factory needs two Factory Admins.

The status chip in the top bar and a banner show when something is halted or killed.

## When something is greyed out or refused

- **Greyed out buttons** explain themselves on hover, focus or touch: what is blocking you and what you would need (a role, a different project, an unfinished onboarding).
- **403, "not allowed".** You lack the right. The message says what is needed. Ask a project admin or factory admin for the role.
- **409, "changed since you opened it".** Someone else changed the same thing. Reload and try again.
- **A fresh sign-in is requested.** Kills, restores, and changes to roles, policy, security, API keys and people need a sign-in within the last few minutes. Sign in again, and your draft is kept.
- **A page says you cannot view it.** You hold no read right for it. Pages you cannot read are hidden from the menu, and reaching one by its address shows this notice.
