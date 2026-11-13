/**
 * Constant catalogue ported from legacy/js/data.js, catalog.js, store.js and sim.js.
 * Built-ins only: custom stations, gates, bays, classes and roles are data (see Catalog in types.ts).
 */
import type { Action, AuditCategory, Bay, Catalog, Gate, IntegrationType, Matrix, Role, Station, Template, TrustLevelDef, WorkClass, WoStateId, WoStateInfo } from "./types.js";

export const STATIONS: readonly Station[] = [
  {
    id: "intake",
    no: "S0",
    name: "Intake",
    agent: "ag-intake",
    purpose: "Classify the request and run the intake conversation until the brief is confirmed."
  },
  {
    id: "research",
    no: "S1",
    name: "Research",
    agent: "ag-research",
    purpose: "Read the code, prior art and tickets; write a short research note."
  },
  {
    id: "spec",
    no: "S2",
    name: "Spec",
    agent: "ag-spec",
    purpose: "Turn the brief into a spec with acceptance criteria."
  },
  {
    id: "design",
    no: "S3",
    name: "Design",
    agent: "ag-design",
    purpose: "Interfaces, data shapes and UX decisions."
  },
  {
    id: "plan",
    no: "S4",
    name: "Plan",
    agent: "ag-plan",
    purpose: "Ordered steps, files, tests and rollback."
  },
  {
    id: "build",
    no: "S5",
    name: "Build",
    agent: "ag-build",
    purpose: "Implement on a branch inside a coding slot."
  },
  {
    id: "verify",
    no: "S6",
    name: "Verify",
    agent: "ag-test",
    purpose: "Run required checks and write missing tests."
  },
  {
    id: "review",
    no: "S7",
    name: "Review and merge",
    agent: "ag-review",
    purpose: "Agent review, human approval, merge."
  },
  {
    id: "close",
    no: "S8",
    name: "Close",
    agent: "ag-close",
    purpose: "Tag, release notes, close the issue, confirm after release."
  }
];

export const GATES: readonly Gate[] = [
  {
    id: "G0G1",
    label: "G0+G1",
    name: "Brief confirmed",
    after: "intake",
    kind: "human",
    purpose: "The submitter (or a permitted person) confirms the brief, class and route.",
    checks: []
  },
  {
    id: "G1f",
    label: "G1f",
    name: "Feasibility",
    after: "research",
    kind: "auto",
    purpose: "Research note exists and has no blocking unknowns.",
    checks: [
      "Research note attached",
      "No blocking unknowns"
    ]
  },
  {
    id: "G2",
    label: "G2",
    name: "Spec approved",
    after: "spec",
    kind: "human",
    purpose: "Scope and acceptance criteria agreed.",
    checks: []
  },
  {
    id: "G3d",
    label: "G3d",
    name: "Design review",
    after: "design",
    kind: "human",
    purpose: "Interfaces and data shapes reviewed.",
    checks: []
  },
  {
    id: "G3G3s",
    label: "G3+G3s",
    name: "Plan and security",
    after: "plan",
    kind: "mixed",
    purpose: "Plan approved by a person; security checks run automatically.",
    checks: [
      "Threat model present",
      "Dependency scan",
      "Protected paths untouched"
    ]
  },
  {
    id: "G4",
    label: "G4",
    name: "Checks green",
    after: "verify",
    kind: "auto",
    purpose: "Required checks pass, coverage on changed lines, no new flaky tests.",
    checks: [
      "Required checks",
      "Coverage on changed lines",
      "No new flaky tests"
    ]
  },
  {
    id: "G5",
    label: "G5",
    name: "Review and merge",
    after: "review",
    kind: "human",
    purpose: "A human approves the PR; the agent merges with the repo's strategy.",
    checks: []
  },
  {
    id: "G6",
    label: "G6",
    name: "Release confirmed",
    after: "close",
    kind: "human",
    action: "release",
    purpose: "Release Manager confirms the release went out and is healthy.",
    checks: []
  }
];

export const BAYS: readonly Bay[] = [
  {
    id: "declined",
    name: "Declined",
    desc: "Requests the factory will not do"
  },
  {
    id: "hold",
    name: "On hold",
    desc: "Paused by a person"
  },
  {
    id: "sechold",
    name: "Security hold",
    desc: "Stopped by a security check"
  },
  {
    id: "person",
    name: "Needs a person",
    desc: "Waiting for a person to answer or take over"
  },
  {
    id: "queue",
    name: "Queue",
    desc: "Waiting for a free coding slot"
  }
];

export const CLASSES: readonly WorkClass[] = [
  {
    id: "feature",
    name: "Feature",
    skips: [],
    priority: "P2",
    slaH: 120,
    est: "M"
  },
  {
    id: "bug",
    name: "Bug",
    skips: [
      "research",
      "design"
    ],
    priority: "P2",
    slaH: 48,
    est: "S"
  },
  {
    id: "hotfix",
    name: "Hotfix",
    skips: [
      "research",
      "design"
    ],
    priority: "P1",
    slaH: 6,
    est: "S"
  },
  {
    id: "epic",
    name: "Epic",
    skips: [],
    priority: "P2",
    slaH: 480,
    est: "L",
    splits: true
  },
  {
    id: "chore",
    name: "Chore / dependency",
    skips: [
      "research",
      "spec",
      "design"
    ],
    priority: "P3",
    slaH: 168,
    est: "S"
  },
  {
    id: "refactor",
    name: "Refactor",
    skips: [
      "research"
    ],
    priority: "P3",
    slaH: 168,
    est: "M"
  },
  {
    id: "security",
    name: "Security fix",
    skips: [
      "research"
    ],
    priority: "P1",
    slaH: 24,
    est: "S"
  },
  {
    id: "docs",
    name: "Docs",
    skips: [
      "research",
      "design",
      "plan"
    ],
    priority: "P3",
    slaH: 120,
    est: "S"
  },
  {
    id: "spike",
    name: "Spike / research",
    skips: [
      "spec",
      "design",
      "plan",
      "build",
      "verify",
      "review",
      "close"
    ],
    priority: "P3",
    slaH: 72,
    est: "S",
    endsAfter: "research"
  }
];

export const ROLES: readonly Role[] = [
  {
    id: "factory_admin",
    name: "Factory Admin",
    level: "factory"
  },
  {
    id: "auditor",
    name: "Auditor",
    level: "factory"
  },
  {
    id: "project_admin",
    name: "Project Admin",
    level: "project"
  },
  {
    id: "line_lead",
    name: "Line Lead",
    level: "project"
  },
  {
    id: "engineer",
    name: "Engineer",
    level: "project"
  },
  {
    id: "reviewer",
    name: "Reviewer",
    level: "project"
  },
  {
    id: "approver",
    name: "Approver",
    level: "project"
  },
  {
    id: "release_manager",
    name: "Release Manager",
    level: "project"
  },
  {
    id: "viewer",
    name: "Viewer",
    level: "project"
  }
];

export const ACTIONS: readonly Action[] = [
  {
    id: "project.view",
    name: "See the project",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.submit",
    name: "Submit work orders",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.answer",
    name: "Answer intake questions",
    scope: "project",
    group: "Work"
  },
  {
    id: "brief.confirm",
    name: "Confirm briefs (G0+G1)",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.classify",
    name: "Override a class",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.decline",
    name: "Decline requests",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.move",
    name: "Move work on the board",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.park",
    name: "Park and unpark in bays",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.sendback",
    name: "Send back a station",
    scope: "project",
    group: "Work"
  },
  {
    id: "wo.reassign",
    name: "Reassign agents",
    scope: "project",
    group: "Work"
  },
  {
    id: "outcome.record",
    name: "Record post-release outcomes",
    scope: "project",
    group: "Work"
  },
  {
    id: "gate.approve",
    name: "Approve gates",
    scope: "project",
    group: "Gates"
  },
  {
    id: "release",
    name: "Confirm releases (G6)",
    scope: "project",
    group: "Gates"
  },
  {
    id: "line.halt",
    name: "Pull the andon cord",
    scope: "project",
    group: "Stops"
  },
  {
    id: "line.resume",
    name: "Resume a halted repo",
    scope: "project",
    group: "Stops"
  },
  {
    id: "kill.workorder",
    name: "Kill a work order",
    scope: "project",
    group: "Stops"
  },
  {
    id: "restore.workorder",
    name: "Restore a killed work order",
    scope: "project",
    group: "Stops"
  },
  {
    id: "kill.project",
    name: "Kill a project",
    scope: "project",
    group: "Stops"
  },
  {
    id: "restore.project",
    name: "Restore a killed project",
    scope: "project",
    group: "Stops"
  },
  {
    id: "kill.factory",
    name: "Kill the factory",
    scope: "factory",
    group: "Stops"
  },
  {
    id: "restore.factory",
    name: "Restore the factory",
    scope: "factory",
    group: "Stops"
  },
  {
    id: "repo.onboard",
    name: "Connect and onboard repos",
    scope: "project",
    group: "Onboarding"
  },
  {
    id: "onboarding.manage",
    name: "Re-run and steer onboarding",
    scope: "project",
    group: "Onboarding"
  },
  {
    id: "onboarding.merge",
    name: "Merge onboarding PRs",
    scope: "project",
    group: "Onboarding"
  },
  {
    id: "onboarding.exception",
    name: "Grant onboarding exceptions",
    scope: "project",
    group: "Onboarding"
  },
  {
    id: "onboarding.guidelines",
    name: "Edit project onboarding guidelines",
    scope: "project",
    group: "Onboarding"
  },
  {
    id: "project.config",
    name: "Edit project flow and config",
    scope: "project",
    group: "Project"
  },
  {
    id: "approvers.edit",
    name: "Edit approver rules",
    scope: "project",
    group: "Project"
  },
  {
    id: "project.members",
    name: "Manage project members",
    scope: "project",
    group: "Project"
  },
  {
    id: "project.archive",
    name: "Archive the project",
    scope: "project",
    group: "Project"
  },
  {
    id: "notify.edit",
    name: "Edit notification routes",
    scope: "project",
    group: "Project"
  },
  {
    id: "api.keys",
    name: "Manage API keys",
    scope: "project",
    group: "Project"
  },
  {
    id: "triggers.edit",
    name: "Manage triggers",
    scope: "project",
    group: "Project"
  },
  {
    id: "project.create",
    name: "Create projects",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "template.edit",
    name: "Edit templates",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "agent.edit",
    name: "Configure agents",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "skill.edit",
    name: "Edit skills",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "model.edit",
    name: "Manage models and routing",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "mcp.edit",
    name: "Manage MCP servers",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "integration.edit",
    name: "Manage integrations",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "eval.run",
    name: "Run eval suites",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "people.manage",
    name: "Invite and manage people",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "policy.edit",
    name: "Edit access policy",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "security.manage",
    name: "Manage security settings",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "audit.view",
    name: "View the audit ledger",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "trust.grant",
    name: "Grant or change trust levels",
    scope: "project",
    group: "Trust"
  },
  {
    id: "trust.criteria",
    name: "Edit trust criteria and ceilings",
    scope: "factory",
    group: "Trust"
  },
  {
    id: "class.edit",
    name: "Add and edit work classes",
    scope: "project",
    group: "Project"
  },
  {
    id: "flow.edit",
    name: "Add stations, gates and bays",
    scope: "project",
    group: "Project"
  },
  {
    id: "integration.add",
    name: "Add integrations and custom types",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "role.edit",
    name: "Create and edit roles",
    scope: "factory",
    group: "Factory"
  },
  {
    id: "learning.apply",
    name: "Accept learning proposals",
    scope: "factory",
    group: "Factory"
  }
];

export const WO_STATES: Record<WoStateId, WoStateInfo> = {
  running: { label: "Running", glyph: "st-run" },
  waiting: { label: "Waiting on gate", glyph: "st-wait" },
  blocked: { label: "Blocked", glyph: "st-block" },
  failed: { label: "Failed check", glyph: "st-fail" },
  parked: { label: "Parked", glyph: "st-park" },
  killed: { label: "Killed", glyph: "st-kill" },
  done: { label: "Done", glyph: "st-done" },
};

export const ONBOARD_STAGES: ReadonlyArray<{ id: string; name: string }> = [
  {
    id: "connected",
    name: "Connected"
  },
  {
    id: "assessed",
    name: "Assessed"
  },
  {
    id: "pr_opened",
    name: "PR opened"
  },
  {
    id: "pr_checks",
    name: "PR checks"
  },
  {
    id: "pr_merged",
    name: "PR merged"
  },
  {
    id: "verified",
    name: "Verified"
  },
  {
    id: "ready",
    name: "Ready"
  }
];

export const TEMPLATES_SEED: readonly Template[] = [
  {
    id: "tpl-backend",
    name: "Backend service",
    desc: "API or worker with full flow, plan and security gate.",
    stationsOff: [],
    gatesOff: [],
    slots: 2,
    classesSkip: {},
    mcp: [
      "mcp-issues",
      "mcp-observe",
      "mcp-apicat"
    ],
    approverPreset: "standard",
    notify: "standard",
    builtIn: true
  },
  {
    id: "tpl-web",
    name: "Web app",
    desc: "Frontend app. Design station on, research light.",
    stationsOff: [],
    gatesOff: [],
    slots: 2,
    classesSkip: {
      feature: [
        "research"
      ]
    },
    mcp: [
      "mcp-issues",
      "mcp-design"
    ],
    approverPreset: "light",
    notify: "standard",
    builtIn: true
  },
  {
    id: "tpl-lib",
    name: "Library / SDK",
    desc: "Public API surface. Design review required, no Close release confirmation.",
    stationsOff: [],
    gatesOff: [
      "G6"
    ],
    slots: 1,
    classesSkip: {},
    mcp: [
      "mcp-issues",
      "mcp-docs"
    ],
    approverPreset: "standard",
    notify: "light",
    builtIn: true
  },
  {
    id: "tpl-data",
    name: "Data pipeline",
    desc: "Batch and streaming jobs. No design station.",
    stationsOff: [
      "design"
    ],
    gatesOff: [
      "G3d"
    ],
    slots: 2,
    classesSkip: {},
    mcp: [
      "mcp-issues",
      "mcp-db",
      "mcp-observe"
    ],
    approverPreset: "standard",
    notify: "standard",
    builtIn: true
  },
  {
    id: "tpl-regulated",
    name: "Regulated service",
    desc: "Two approvers on spec and merge, security on every plan, strict release windows.",
    stationsOff: [],
    gatesOff: [],
    slots: 1,
    classesSkip: {
      docs: [
        "research",
        "design"
      ]
    },
    mcp: [
      "mcp-issues",
      "mcp-observe"
    ],
    approverPreset: "strict",
    notify: "strict",
    builtIn: true
  },
  {
    id: "tpl-blank",
    name: "Blank",
    desc: "Every station and gate on, defaults everywhere.",
    stationsOff: [],
    gatesOff: [],
    slots: 1,
    classesSkip: {},
    mcp: [],
    approverPreset: "standard",
    notify: "light",
    builtIn: true
  }
];

export const INTEGRATION_CATEGORIES: ReadonlyArray<{ id: string; name: string }> = [
  {
    id: "source",
    name: "Source control"
  },
  {
    id: "chat",
    name: "Chat"
  },
  {
    id: "email",
    name: "Email"
  },
  {
    id: "issues",
    name: "Issue trackers"
  },
  {
    id: "ci",
    name: "CI"
  },
  {
    id: "paging",
    name: "Paging"
  },
  {
    id: "webhook",
    name: "Webhooks"
  },
  {
    id: "custom",
    name: "Custom"
  }
];

/** The one list of notification events (routes, card defaults, integration type events, onboarding overrides). */
export const NOTIFY_EVENTS: ReadonlyArray<{ id: string; name: string }> = [
  {
    id: "submitted",
    name: "Work order submitted"
  },
  {
    id: "question",
    name: "Question for a person"
  },
  {
    id: "gate.waiting",
    name: "Gate waiting"
  },
  {
    id: "gate.decided",
    name: "Gate approved or rejected"
  },
  {
    id: "blocked",
    name: "Work order blocked"
  },
  {
    id: "security.hold",
    name: "Security hold"
  },
  {
    id: "andon",
    name: "Andon halt"
  },
  {
    id: "kill",
    name: "Kill switch pulled"
  },
  {
    id: "restore",
    name: "Restored after kill"
  },
  {
    id: "onboarding.pr",
    name: "Onboarding PR opened, merged or failed"
  },
  {
    id: "released",
    name: "Released"
  },
  {
    id: "eval.regression",
    name: "Eval regression"
  },
  {
    id: "budget",
    name: "Budget threshold"
  },
  {
    id: "trust.changed",
    name: "Trust level changed or proposed"
  },
  {
    id: "learning.proposed",
    name: "Learning finding or proposal"
  },
  {
    id: "outcome.recorded",
    name: "Post-release outcome recorded"
  }
];

export const INTEGRATION_TYPES: readonly IntegrationType[] = [
  {
    id: "github",
    name: "GitHub",
    category: "source",
    icon: "github",
    auth: "app",
    payload: "json",
    builtIn: true,
    source: true,
    destination: false,
    fields: [
      {
        key: "org",
        label: "Organisation",
        type: "text",
        required: true
      },
      {
        key: "host",
        label: "Host",
        type: "url",
        required: false,
        placeholder: "https://github.com (cloud) or your Enterprise URL"
      },
      {
        key: "appId",
        label: "App ID",
        type: "text",
        required: true
      },
      {
        key: "privateKey",
        label: "App private key",
        type: "secret",
        required: true
      }
    ],
    events: [
      "issue.opened",
      "issue.labeled",
      "pr.comment",
      "check.failed",
      "push"
    ],
    actions: [
      "open_pr",
      "merge_pr",
      "comment",
      "tag_release",
      "read_repo"
    ]
  },
  {
    id: "gitlab",
    name: "GitLab",
    category: "source",
    icon: "branch",
    auth: "token",
    payload: "json",
    builtIn: true,
    source: true,
    destination: false,
    fields: [
      {
        key: "host",
        label: "Host",
        type: "url",
        required: true,
        placeholder: "https://gitlab.com"
      },
      {
        key: "group",
        label: "Group",
        type: "text",
        required: true
      },
      {
        key: "token",
        label: "Access token",
        type: "secret",
        required: true
      }
    ],
    events: [
      "issue.opened",
      "mr.comment",
      "pipeline.failed"
    ],
    actions: [
      "open_mr",
      "merge_mr",
      "comment",
      "read_repo"
    ]
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    category: "source",
    icon: "branch",
    auth: "oauth",
    payload: "json",
    builtIn: true,
    source: true,
    destination: false,
    fields: [
      {
        key: "workspace",
        label: "Workspace",
        type: "text",
        required: true
      },
      {
        key: "clientId",
        label: "OAuth client id",
        type: "text",
        required: true
      },
      {
        key: "clientSecret",
        label: "OAuth client secret",
        type: "secret",
        required: true
      }
    ],
    events: [
      "issue.created",
      "pr.comment"
    ],
    actions: [
      "open_pr",
      "merge_pr",
      "comment"
    ]
  },
  {
    id: "slack",
    name: "Slack",
    category: "chat",
    icon: "slack",
    auth: "oauth",
    payload: "blocks",
    builtIn: true,
    destination: true,
    targetLabel: "Channel or @person",
    fields: [
      {
        key: "workspace",
        label: "Workspace",
        type: "text",
        required: true
      },
      {
        key: "botToken",
        label: "Bot token",
        type: "secret",
        required: true
      },
      {
        key: "approve",
        label: "Allow approvals from Slack",
        type: "bool",
        required: false
      }
    ],
    events: [
      "message.posted",
      "button.clicked"
    ],
    actions: [
      "post_card",
      "update_card",
      "dm"
    ]
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    category: "chat",
    icon: "teams",
    auth: "oauth",
    payload: "adaptive",
    builtIn: true,
    destination: true,
    targetLabel: "Team / channel",
    fields: [
      {
        key: "tenant",
        label: "Tenant",
        type: "text",
        required: true
      },
      {
        key: "clientId",
        label: "App client id",
        type: "text",
        required: true
      },
      {
        key: "clientSecret",
        label: "App secret",
        type: "secret",
        required: true
      }
    ],
    events: [
      "message.posted",
      "card.action"
    ],
    actions: [
      "post_card",
      "update_card"
    ]
  },
  {
    id: "gchat",
    name: "Google Chat",
    category: "chat",
    icon: "chat",
    auth: "token",
    payload: "json",
    builtIn: true,
    destination: true,
    targetLabel: "Space",
    fields: [
      {
        key: "domain",
        label: "Workspace domain",
        type: "text",
        required: true
      },
      {
        key: "serviceAccount",
        label: "Service account key",
        type: "secret",
        required: true
      }
    ],
    events: [
      "message.posted"
    ],
    actions: [
      "post_card"
    ]
  },
  {
    id: "discord",
    name: "Discord",
    category: "chat",
    icon: "chat",
    auth: "token",
    payload: "json",
    builtIn: true,
    destination: true,
    targetLabel: "Channel",
    fields: [
      {
        key: "guild",
        label: "Server",
        type: "text",
        required: true
      },
      {
        key: "botToken",
        label: "Bot token",
        type: "secret",
        required: true
      }
    ],
    events: [
      "message.posted"
    ],
    actions: [
      "post_message"
    ]
  },
  {
    id: "email",
    name: "Email (SMTP)",
    category: "email",
    icon: "mail",
    auth: "smtp",
    payload: "html",
    builtIn: true,
    destination: true,
    targetLabel: "Address or role (submitter, approvers, project admins)",
    fields: [
      {
        key: "from",
        label: "From address",
        type: "text",
        required: true
      },
      {
        key: "smtpHost",
        label: "SMTP host",
        type: "text",
        required: true
      },
      {
        key: "smtpUser",
        label: "SMTP user",
        type: "text",
        required: true
      },
      {
        key: "smtpPassword",
        label: "SMTP password",
        type: "secret",
        required: true
      }
    ],
    events: [],
    actions: [
      "send_email",
      "send_digest"
    ]
  },
  {
    id: "jira",
    name: "Jira-style tracker",
    category: "issues",
    icon: "list",
    auth: "token",
    payload: "json",
    builtIn: true,
    source: true,
    destination: true,
    targetLabel: "Project key",
    fields: [
      {
        key: "site",
        label: "Site URL",
        type: "url",
        required: true
      },
      {
        key: "email",
        label: "Service account email",
        type: "text",
        required: true
      },
      {
        key: "token",
        label: "API token",
        type: "secret",
        required: true
      }
    ],
    events: [
      "issue.created",
      "issue.labeled",
      "issue.transitioned"
    ],
    actions: [
      "create_issue",
      "comment",
      "transition"
    ]
  },
  {
    id: "linear",
    name: "Linear-style tracker",
    category: "issues",
    icon: "list",
    auth: "token",
    payload: "json",
    builtIn: true,
    source: true,
    destination: true,
    targetLabel: "Team",
    fields: [
      {
        key: "workspace",
        label: "Workspace",
        type: "text",
        required: true
      },
      {
        key: "apiKey",
        label: "API key",
        type: "secret",
        required: true
      }
    ],
    events: [
      "issue.created",
      "issue.labeled"
    ],
    actions: [
      "create_issue",
      "comment"
    ]
  },
  {
    id: "ci",
    name: "CI runner (generic)",
    category: "ci",
    icon: "refresh",
    auth: "token",
    payload: "json",
    builtIn: true,
    source: true,
    destination: false,
    fields: [
      {
        key: "url",
        label: "Server URL",
        type: "url",
        required: true
      },
      {
        key: "token",
        label: "API token",
        type: "secret",
        required: true
      }
    ],
    events: [
      "build.failed",
      "build.passed"
    ],
    actions: [
      "trigger_build",
      "read_logs"
    ]
  },
  {
    id: "paging",
    name: "On-call paging",
    category: "paging",
    icon: "page",
    auth: "token",
    payload: "json",
    builtIn: true,
    destination: true,
    targetLabel: "Schedule",
    fields: [
      {
        key: "service",
        label: "Service",
        type: "text",
        required: true
      },
      {
        key: "routingKey",
        label: "Routing key",
        type: "secret",
        required: true
      },
      {
        key: "schedules",
        label: "On-call schedules",
        type: "text",
        required: false,
        placeholder: "Comma-separated, e.g. payments-oncall, platform-oncall"
      }
    ],
    events: [
      "incident.ack"
    ],
    actions: [
      "page",
      "resolve"
    ]
  },
  {
    id: "webhook",
    name: "Signed webhook",
    category: "webhook",
    icon: "webhook",
    auth: "hmac",
    payload: "json",
    builtIn: true,
    destination: true,
    targetLabel: "Endpoint",
    fields: [
      {
        key: "url",
        label: "Endpoint URL",
        type: "url",
        required: true
      },
      {
        key: "secret",
        label: "Signing secret",
        type: "secret",
        required: true
      },
      {
        key: "format",
        label: "Payload format",
        type: "select",
        required: true,
        options: [
          "json",
          "cloudevents"
        ]
      }
    ],
    events: [],
    actions: [
      "post_json"
    ]
  }
];

export const GATE_ENUM = ["human", "auto", "mixed"] as const;

/** Notification card catalogue: template id -> { name, actions }. */
export const CARD_TEMPLATES: Record<string, { name: string; actions: string[] }> = {
  gate: { name: "Gate request", actions: ["approve", "reject", "open"] },
  question: { name: "Question for a person", actions: ["answer", "open"] },
  incident: { name: "Incident", actions: ["ack", "open"] },
  kill: { name: "Kill switch", actions: ["open"] },
  release: { name: "Release", actions: ["notes", "open"] },
  onboarding: { name: "Onboarding PR", actions: ["pr", "open"] },
  submitted: { name: "Work order submitted", actions: ["open"] },
  budget: { name: "Budget threshold", actions: ["budget"] },
  eval: { name: "Eval regression", actions: ["evals"] },
};

export const CARD_ACTIONS: Record<string, string> = {
  approve: "Approve",
  reject: "Reject",
  open: "Open in Gantry",
  answer: "Answer",
  ack: "Acknowledge",
  notes: "Release notes",
  pr: "Review PR",
  budget: "Open budget",
  evals: "Open evals",
};

/** Default card template per notification event. */
export const CARD_DEFAULTS: Record<string, string> = {
  submitted: "submitted",
  question: "question",
  "gate.waiting": "gate",
  "gate.decided": "gate",
  blocked: "incident",
  "security.hold": "incident",
  andon: "incident",
  kill: "kill",
  restore: "kill",
  "onboarding.pr": "onboarding",
  released: "release",
  "eval.regression": "eval",
  budget: "budget",
  "trust.changed": "submitted",
  "learning.proposed": "submitted",
  "outcome.recorded": "incident",
};

export const TRUST_LEVELS: readonly TrustLevelDef[] = [
  { level: 0, code: "L0", name: "Shadow", desc: "The agent suggests only; people do the work and approve every gate." },
  { level: 1, code: "L1", name: "Gated", desc: "The agent acts; a person approves every gate." },
  { level: 2, code: "L2", name: "Spot-checked", desc: "Gates pass automatically except a sampled share that a person reviews." },
  { level: 3, code: "L3", name: "Unattended", desc: "Gates pass automatically within guardrails. Release still needs a person." },
  { level: 4, code: "L4", name: "Unattended incl. release", desc: "Gates and release confirmation pass automatically within guardrails." },
];

export const AUDIT_CATEGORIES: readonly AuditCategory[] = ["auth", "access", "flow", "onboarding", "approvals", "config", "integrations", "api", "agents", "kill"];

/** Audit category by the first segment of an action id (`wo.move` -> "flow"). Unknown prefixes fall back to "flow". */
export const AUDIT_CATEGORY_BY_PREFIX: Record<string, AuditCategory> = {
  auth: "auth", session: "auth", policy: "access", role: "access", people: "access", freeze: "access", security: "auth",
  kill: "kill", restore: "kill", wo: "flow", line: "flow", check: "flow", brief: "flow",
  gate: "approvals", approvers: "config", project: "config", flow: "config", template: "config",
  repo: "onboarding", onboarding: "onboarding", guidelines: "onboarding",
  integration: "integrations", notify: "integrations", trigger: "integrations", delivery: "integrations",
  api: "api", trust: "agents", learning: "agents", class: "config", station: "config", card: "config",
  record: "flow", outcome: "flow", agent: "agents", skill: "agents", eval: "agents", model: "agents", vendor: "agents", routing: "agents", mcp: "integrations",
};

export function auditCategoryFor(action: string): AuditCategory {
  return AUDIT_CATEGORY_BY_PREFIX[action.split(".")[0] ?? ""] ?? "flow";
}

/**
 * Risk tags computed from the actual diff (spec 9.5). Any tag forces a human vote.
 * Each rule matches a changed file path.
 */
export interface RiskTagRule {
  tag: string;
  label: string;
  test: RegExp;
}
export const RISK_TAG_RULES: readonly RiskTagRule[] = [
  { tag: "ci", label: "CI and workflow files", test: /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml$|Jenkinsfile$|\.circleci\/|azure-pipelines\.ya?ml$)/i },
  { tag: "dependencies", label: "Dependency manifests and lockfiles", test: /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|requirements[^/]*\.txt|poetry\.lock|Pipfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|Gemfile(\.lock)?|composer\.(json|lock))$/i },
  { tag: "codeowners", label: "Code-owner files", test: /(^|\/)CODEOWNERS$/ },
  { tag: "auth-crypto", label: "Auth and crypto paths", test: /(^|\/)(auth|authn|authz|crypto|security|secrets?|tls|keys?)(\/|[._-])|\.pem$|\.key$/i },
  { tag: "gantry-config", label: "Gantry config", test: /(^|\/)(\.gantry\/|factory\.ya?ml$)/ },
  { tag: "migration", label: "Migrations", test: /(^|\/)(migrations?|db\/migrate)\/|\.sql$/i },
  { tag: "agent-tests", label: "Tests the agent edited", test: /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.(go|py)$|\.tftest\.hcl$/i },
];

export const DEFAULT_CATALOG: Catalog = {
  stations: STATIONS.map((s) => ({ ...s })),
  gates: GATES.map((g) => ({ ...g, checks: [...g.checks] })),
  bays: BAYS.map((b) => ({ ...b })),
  classes: CLASSES.map((c) => ({ ...c, skips: [...c.skips] })),
  roles: ROLES.map((r) => ({ ...r })),
  actions: ACTIONS.map((a) => ({ ...a })),
};

/** The default role-by-action matrix (legacy `matrix()`), built over the given actions. */
export function defaultMatrix(actions: readonly Action[] = ACTIONS): Matrix {
  const only = (list: string[]): Record<string, boolean> => {
    const x: Record<string, boolean> = {};
    for (const a of actions) x[a.id] = list.includes(a.id);
    return x;
  };
  const projectActions = actions.filter((a) => a.scope === "project").map((a) => a.id);
  return {
    factory_admin: only(actions.map((a) => a.id)),
    auditor: only(["project.view", "audit.view"]),
    project_admin: only(projectActions.concat(["eval.run", "audit.view"])),
    line_lead: only(["project.view", "wo.submit", "wo.answer", "brief.confirm", "wo.classify", "wo.decline", "wo.move", "wo.park", "wo.sendback", "wo.reassign", "gate.approve", "line.halt", "line.resume", "kill.workorder", "onboarding.manage", "eval.run", "outcome.record"]),
    engineer: only(["project.view", "wo.submit", "wo.answer", "brief.confirm", "wo.park", "wo.sendback", "line.halt", "onboarding.manage"]),
    reviewer: only(["project.view", "wo.answer", "gate.approve", "wo.sendback", "line.halt"]),
    approver: only(["project.view", "wo.answer", "gate.approve"]),
    release_manager: only(["project.view", "wo.answer", "gate.approve", "release", "line.halt", "line.resume", "onboarding.merge", "outcome.record"]),
    viewer: only(["project.view"]),
  };
}

/** Station/gate/bay/class/role/action lookups over a catalogue. */
export function findStation(cat: Catalog, id: string) {
  return cat.stations.find((s) => s.id === id);
}
export function findRole(cat: Catalog, id: string) {
  return cat.roles.find((r) => r.id === id);
}
export function findAction(cat: Catalog, id: string) {
  return cat.actions.find((a) => a.id === id);
}
export function findClass(cat: Catalog, id: string) {
  return cat.classes.find((c) => c.id === id);
}
