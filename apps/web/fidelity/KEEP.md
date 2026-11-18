# Features that must survive the rebuild (owner checklist)

The prototype sets the LOOK. These working features from the current app must still exist after a screen is rebuilt, styled in the prototype's language. Most were added after the prototypes were drawn, so the prototype may not show them. Before a screen is called done, check every item that belongs to it.

## Work orders and gates
- @mention in the work-order composer: autocomplete for agents (opens a side thread) and for people (invite and notification), with notes.
- Side threads with an agent about a work order (read-only, answer shown in the thread).
- Station documents viewer: comment on a section, edit as a new version (secret and stale-base refusal), "Accept as station output".
- Gate cards show open assumptions and objections; the approver rule on each gate row; the pending wording ("Approve spec · G2").
- Pinned approvals: approve, reject and request changes carry the gate instance; a conflict refreshes and explains what changed.
- Per-class approval count shown on the gate ("1 of 1 approvals" for Docs).
- "Needs a person" bay with the reason, Retry and Assign; a failed work order never says "working".
- Traveler drawer: Journey, Documents and Activity, the URL holds `?traveler=` and the tab, and it restores from a link.
- Work order page: header, route rail, action toolbar, Document and Activity tabs, properties column; Changes page with full-review link.
- New work order: classifier preview (class and route), validation that clears as you type, attachments.
- Work orders as table or board with tabs, filter bar, sort, and compact mobile cards.

## Floor
- Line control menu (pause, halt, emergency stop, with step-up), Live/Replay switch, route legend, side bays, stat tiles, live updates without refresh.

## Agents and models
- Agent page: instructions with draft and live versions and a diff, skills with version pins, tools, model and budget, guardrails, evals; one Agent Workspace.
- Skills library with skill pages and versions; Evals, Trust (level cells, grants) and Learning (proposals) screens.
- Models: Vendors, Routing (routing versions), Prices (multi-model publish), read-only vendor budget roll-up.
- Prompt records: the manifest and trace for a work order's calls (repo_context, agent layer, skills).
- Research plans and the run timeline; scouts and objections.

## Console and workspace
- Console (#console) is the general chat with Gantry: chat list (New chat, search, Recent, Shared with me), settings popover in the chat header; the submit-a-work-order form is #console/submit, one click away via New work order in the header. Chat list: New chat, rename, delete, search, sharing and members; model picker; permission codes; audit link.
- Agents at work (workspace): conversations that need you, archive; conversation and inbox update from the live stream.

## Govern
- People as team cards and one page per person; deactivate and reactivate (offboarding dialog showing what the person holds).
- Account page: profile, access, sessions, preferences, linked accounts.
- Access: matrix with simulator; factory-only settings hidden from project roles.
- Security tabs: Sign-in, Network, Sessions, History, Emergency stop; MFA status.
- Audit: All, Denied and Config views, filters, a visible "Verify chain" result.
- System health: services, worker heartbeat, run starts, dead jobs, backups and drill, outbox, stuck jobs.
- Workload with suggestions.

## Connect
- Integrations (health status, attention list), Notifications (routes, repo overrides), MCP registry (sensitivity, grants are factory-admin only), API keys and triggers.

## Platform behaviour (invisible, but must keep working)
- Sign-in, the MFA setup screen for factory admins, step-up (password re-entry) on sensitive actions.
- Drafts with base revision and conflict UI, leave guard and dirty-dialog prompts.
- Error boundaries, lazy retry, session expiry handling, connection indicator, polling only while the stream is down.
- Project budget and spend shown (real metered spend), the 80% alert.
- Every screen: loading, empty, forbidden, failed and stale states (F-04).
