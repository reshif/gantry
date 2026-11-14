/* Gantry sample data and constants. Everything here is mock data for the demo workspace.
   G.seed() returns a fresh state tree (it needs flow.js for routes); the store owns it after load. */
window.G = window.G || {};

(function (G) {
  "use strict";

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  G.rng = rng;

  /* ---------- flow constants ---------- */
  G.STATIONS = [
    { id: "intake",   no: "S0", name: "Intake",           agent: "ag-intake",   purpose: "Classify the request and run the intake conversation until the brief is confirmed." },
    { id: "research", no: "S1", name: "Research",         agent: "ag-research", purpose: "Read the code, prior art and tickets; write a short research note." },
    { id: "spec",     no: "S2", name: "Spec",             agent: "ag-spec",     purpose: "Turn the brief into a spec with acceptance criteria." },
    { id: "design",   no: "S3", name: "Design",           agent: "ag-design",   purpose: "Interfaces, data shapes and UX decisions." },
    { id: "plan",     no: "S4", name: "Plan",             agent: "ag-plan",     purpose: "Ordered steps, files, tests and rollback." },
    { id: "build",    no: "S5", name: "Build",            agent: "ag-build",    purpose: "Implement on a branch inside a coding slot." },
    { id: "verify",   no: "S6", name: "Verify",           agent: "ag-test",     purpose: "Run required checks and write missing tests." },
    { id: "review",   no: "S7", name: "Review and merge", agent: "ag-review",   purpose: "Agent review, human approval, merge." },
    { id: "close",    no: "S8", name: "Close",            agent: "ag-close",    purpose: "Tag, release notes, close the issue, confirm after release." }
  ];

  G.GATES = [
    { id: "G0G1", label: "G0+G1", name: "Brief confirmed", after: "intake", kind: "human", purpose: "The submitter (or a permitted person) confirms the brief, class and route.", checks: [] },
    { id: "G1f", label: "G1f", name: "Feasibility", after: "research", kind: "auto", purpose: "Research note exists and has no blocking unknowns.", checks: ["Research note attached", "No blocking unknowns"] },
    { id: "G2", label: "G2", name: "Spec approved", after: "spec", kind: "human", purpose: "Scope and acceptance criteria agreed.", checks: [] },
    { id: "G3d", label: "G3d", name: "Design review", after: "design", kind: "human", purpose: "Interfaces and data shapes reviewed.", checks: [] },
    { id: "G3G3s", label: "G3+G3s", name: "Plan and security", after: "plan", kind: "mixed", purpose: "Plan approved by a person; security checks run automatically.", checks: ["Threat model present", "Dependency scan", "Protected paths untouched"] },
    { id: "G4", label: "G4", name: "Checks green", after: "verify", kind: "auto", purpose: "Required checks pass, coverage on changed lines, no new flaky tests.", checks: ["Required checks", "Coverage on changed lines", "No new flaky tests"] },
    { id: "G5", label: "G5", name: "Review and merge", after: "review", kind: "human", purpose: "A human approves the PR; the agent merges with the repo's strategy.", checks: [] },
    { id: "G6", label: "G6", name: "Release confirmed", after: "close", kind: "human", action: "release", purpose: "Release Manager confirms the release went out and is healthy.", checks: [] }
  ];

  G.BAYS = [
    { id: "declined", name: "Declined", desc: "Requests the factory will not do" },
    { id: "hold", name: "On hold", desc: "Paused by a person" },
    { id: "sechold", name: "Security hold", desc: "Stopped by a security check" },
    { id: "person", name: "Needs a person", desc: "Waiting for a person to answer or take over" },
    { id: "queue", name: "Queue", desc: "Waiting for a free coding slot" }
  ];

  G.CLASSES = [
    { id: "feature", name: "Feature", skips: [], priority: "P2", slaH: 120, est: "M" },
    { id: "bug", name: "Bug", skips: ["research", "design"], priority: "P2", slaH: 48, est: "S" },
    { id: "hotfix", name: "Hotfix", skips: ["research", "design"], priority: "P1", slaH: 6, est: "S" },
    { id: "epic", name: "Epic", skips: [], priority: "P2", slaH: 480, est: "L", splits: true },
    { id: "chore", name: "Chore / dependency", skips: ["research", "spec", "design"], priority: "P3", slaH: 168, est: "S" },
    { id: "refactor", name: "Refactor", skips: ["research"], priority: "P3", slaH: 168, est: "M" },
    { id: "security", name: "Security fix", skips: ["research"], priority: "P1", slaH: 24, est: "S" },
    { id: "docs", name: "Docs", skips: ["research", "design", "plan"], priority: "P3", slaH: 120, est: "S" },
    { id: "spike", name: "Spike / research", skips: ["spec", "design", "plan", "build", "verify", "review", "close"], priority: "P3", slaH: 72, est: "S", endsAfter: "research" }
  ];

  G.STATES = {
    running: { label: "Running", glyph: "st-run" },
    waiting: { label: "Waiting on gate", glyph: "st-wait" },
    blocked: { label: "Blocked", glyph: "st-block" },
    failed: { label: "Failed check", glyph: "st-fail" },
    parked: { label: "Parked", glyph: "st-park" },
    killed: { label: "Killed", glyph: "st-kill" },
    done: { label: "Done", glyph: "st-done" }
  };

  G.ROLES = [
    { id: "factory_admin", name: "Factory Admin", level: "factory" },
    { id: "auditor", name: "Auditor", level: "factory" },
    { id: "project_admin", name: "Project Admin", level: "project" },
    { id: "line_lead", name: "Line Lead", level: "project" },
    { id: "engineer", name: "Engineer", level: "project" },
    { id: "reviewer", name: "Reviewer", level: "project" },
    { id: "approver", name: "Approver", level: "project" },
    { id: "release_manager", name: "Release Manager", level: "project" },
    { id: "viewer", name: "Viewer", level: "project" }
  ];

  G.ACTIONS = [
    { id: "project.view", name: "See the project", scope: "project", group: "Work" },
    { id: "wo.submit", name: "Submit work orders", scope: "project", group: "Work" },
    { id: "wo.answer", name: "Answer intake questions", scope: "project", group: "Work" },
    { id: "brief.confirm", name: "Confirm briefs (G0+G1)", scope: "project", group: "Work" },
    { id: "wo.classify", name: "Override a class", scope: "project", group: "Work" },
    { id: "wo.decline", name: "Decline requests", scope: "project", group: "Work" },
    { id: "wo.move", name: "Move work on the board", scope: "project", group: "Work" },
    { id: "wo.park", name: "Park and unpark in bays", scope: "project", group: "Work" },
    { id: "wo.sendback", name: "Send back a station", scope: "project", group: "Work" },
    { id: "wo.reassign", name: "Reassign agents", scope: "project", group: "Work" },
    { id: "outcome.record", name: "Record post-release outcomes", scope: "project", group: "Work" },
    { id: "gate.approve", name: "Approve gates", scope: "project", group: "Gates" },
    { id: "release", name: "Confirm releases (G6)", scope: "project", group: "Gates" },
    { id: "line.halt", name: "Pull the andon cord", scope: "project", group: "Stops" },
    { id: "line.resume", name: "Resume a halted repo", scope: "project", group: "Stops" },
    { id: "kill.workorder", name: "Kill a work order", scope: "project", group: "Stops" },
    { id: "restore.workorder", name: "Restore a killed work order", scope: "project", group: "Stops" },
    { id: "kill.project", name: "Kill a project", scope: "project", group: "Stops" },
    { id: "restore.project", name: "Restore a killed project", scope: "project", group: "Stops" },
    { id: "kill.factory", name: "Kill the factory", scope: "factory", group: "Stops" },
    { id: "restore.factory", name: "Restore the factory", scope: "factory", group: "Stops" },
    { id: "repo.onboard", name: "Connect and onboard repos", scope: "project", group: "Onboarding" },
    { id: "onboarding.manage", name: "Re-run and steer onboarding", scope: "project", group: "Onboarding" },
    { id: "onboarding.merge", name: "Merge onboarding PRs", scope: "project", group: "Onboarding" },
    { id: "onboarding.exception", name: "Grant onboarding exceptions", scope: "project", group: "Onboarding" },
    { id: "onboarding.guidelines", name: "Edit project onboarding guidelines", scope: "project", group: "Onboarding" },
    { id: "project.config", name: "Edit project flow and config", scope: "project", group: "Project" },
    { id: "approvers.edit", name: "Edit approver rules", scope: "project", group: "Project" },
    { id: "project.members", name: "Manage project members", scope: "project", group: "Project" },
    { id: "project.archive", name: "Archive the project", scope: "project", group: "Project" },
    { id: "notify.edit", name: "Edit notification routes", scope: "project", group: "Project" },
    { id: "api.keys", name: "Manage API keys", scope: "project", group: "Project" },
    { id: "triggers.edit", name: "Manage triggers", scope: "project", group: "Project" },
    { id: "project.create", name: "Create projects", scope: "factory", group: "Factory" },
    { id: "template.edit", name: "Edit templates", scope: "factory", group: "Factory" },
    { id: "agent.edit", name: "Configure agents", scope: "factory", group: "Factory" },
    { id: "skill.edit", name: "Edit skills", scope: "factory", group: "Factory" },
    { id: "model.edit", name: "Manage models and routing", scope: "factory", group: "Factory" },
    { id: "mcp.edit", name: "Manage MCP servers", scope: "factory", group: "Factory" },
    { id: "integration.edit", name: "Manage integrations", scope: "factory", group: "Factory" },
    { id: "eval.run", name: "Run eval suites", scope: "factory", group: "Factory" },
    { id: "people.manage", name: "Invite and manage people", scope: "factory", group: "Factory" },
    { id: "policy.edit", name: "Edit access policy", scope: "factory", group: "Factory" },
    { id: "security.manage", name: "Manage security settings", scope: "factory", group: "Factory" },
    { id: "audit.view", name: "View the audit ledger", scope: "factory", group: "Factory" },
    { id: "trust.grant", name: "Grant or change trust levels", scope: "project", group: "Trust" },
    { id: "trust.criteria", name: "Edit trust criteria and ceilings", scope: "factory", group: "Trust" },
    { id: "class.edit", name: "Add and edit work classes", scope: "project", group: "Project" },
    { id: "flow.edit", name: "Add stations, gates and bays", scope: "project", group: "Project" },
    { id: "integration.add", name: "Add integrations and custom types", scope: "factory", group: "Factory" },
    { id: "role.edit", name: "Create and edit roles", scope: "factory", group: "Factory" },
    { id: "learning.apply", name: "Accept learning proposals", scope: "factory", group: "Factory" }
  ];

  function matrix() {
    var m = {};
    function only(list) { var x = {}; G.ACTIONS.forEach(function (a) { x[a.id] = list.indexOf(a.id) >= 0; }); return x; }
    m.factory_admin = only(G.ACTIONS.map(function (a) { return a.id; }));
    m.auditor = only(["project.view", "audit.view"]);
    m.project_admin = only(G.ACTIONS.filter(function (a) { return a.scope === "project"; }).map(function (a) { return a.id; }).concat(["eval.run", "audit.view"]));
    m.line_lead = only(["project.view", "wo.submit", "wo.answer", "brief.confirm", "wo.classify", "wo.decline", "wo.move", "wo.park", "wo.sendback", "wo.reassign", "gate.approve", "line.halt", "line.resume", "kill.workorder", "onboarding.manage", "eval.run", "outcome.record"]);
    m.engineer = only(["project.view", "wo.submit", "wo.answer", "brief.confirm", "wo.park", "wo.sendback", "line.halt", "onboarding.manage"]);
    m.reviewer = only(["project.view", "wo.answer", "gate.approve", "wo.sendback", "line.halt"]);
    m.approver = only(["project.view", "wo.answer", "gate.approve"]);
    m.release_manager = only(["project.view", "wo.answer", "gate.approve", "release", "line.halt", "line.resume", "onboarding.merge", "outcome.record"]);
    m.viewer = only(["project.view"]);
    return m;
  }

  G.TEMPLATES_SEED = [
    { id: "tpl-backend", name: "Backend service", desc: "API or worker with full flow, plan and security gate.", stationsOff: [], gatesOff: [], slots: 2, classesSkip: {}, mcp: ["mcp-issues", "mcp-observe", "mcp-apicat"], approverPreset: "standard", notify: "standard", builtIn: true },
    { id: "tpl-web", name: "Web app", desc: "Frontend app. Design station on, research light.", stationsOff: [], gatesOff: [], slots: 2, classesSkip: { feature: ["research"] }, mcp: ["mcp-issues", "mcp-design"], approverPreset: "light", notify: "standard", builtIn: true },
    { id: "tpl-lib", name: "Library / SDK", desc: "Public API surface. Design review required, no Close release confirmation.", stationsOff: [], gatesOff: ["G6"], slots: 1, classesSkip: {}, mcp: ["mcp-issues", "mcp-docs"], approverPreset: "standard", notify: "light", builtIn: true },
    { id: "tpl-data", name: "Data pipeline", desc: "Batch and streaming jobs. No design station.", stationsOff: ["design"], gatesOff: ["G3d"], slots: 2, classesSkip: {}, mcp: ["mcp-issues", "mcp-db", "mcp-observe"], approverPreset: "standard", notify: "standard", builtIn: true },
    { id: "tpl-regulated", name: "Regulated service", desc: "Two approvers on spec and merge, security on every plan, strict release windows.", stationsOff: [], gatesOff: [], slots: 1, classesSkip: { docs: ["research", "design"] }, mcp: ["mcp-issues", "mcp-observe"], approverPreset: "strict", notify: "strict", builtIn: true },
    { id: "tpl-blank", name: "Blank", desc: "Every station and gate on, defaults everywhere.", stationsOff: [], gatesOff: [], slots: 1, classesSkip: {}, mcp: [], approverPreset: "standard", notify: "light", builtIn: true }
  ];

  var DAY = 86400000, HOUR = 3600000, MIN = 60000;

  G.seed = function () {
    var now = Date.now();
    var r = rng(2417);
    function pick(arr) { return arr[Math.floor(r() * arr.length)]; }
    function between(a, b) { return a + r() * (b - a); }

    var teams = [
      { id: "payments", name: "Payments", desc: "Card processing, payouts and ledgers." },
      { id: "platform", name: "Platform", desc: "Identity, gateways and shared infrastructure." },
      { id: "growth", name: "Growth", desc: "Storefront, onboarding and messaging." },
      { id: "data", name: "Data", desc: "Risk scoring and analytics pipelines." },
      { id: "security", name: "Security", desc: "Application security and compliance." }
    ];

    function P(id, name, title, teamsOf, roles, extra) {
      return Object.assign({ id: id, name: name, title: title, email: id.slice(2) + "@acme.dev", teams: teamsOf, roles: roles, status: "active", oncall: false, github: id.slice(2) + "-acme", away: null }, extra || {});
    }
    var people = [
      P("p-asha", "Asha Raman", "Head of Engineering", ["platform"], [{ role: "factory_admin", scope: "factory" }], { mfa: true }),
      P("p-daniel", "Daniel Okafor", "Factory Manager", ["platform"], [{ role: "project_admin", scope: "payments" }, { role: "project_admin", scope: "storefront" }], { mfa: true }),
      P("p-meera", "Meera Iyer", "Engineering Lead, Payments", ["payments"], [{ role: "line_lead", scope: "payments" }]),
      P("p-tomas", "Tomás Ferreira", "Software Engineer", ["payments"], [{ role: "engineer", scope: "payments" }]),
      P("p-priya", "Priya Nair", "Staff Engineer", ["payments", "data"], [{ role: "reviewer", scope: "payments" }, { role: "line_lead", scope: "risk" }]),
      P("p-kenji", "Kenji Watanabe", "Release Manager", ["platform"], [{ role: "release_manager", scope: "payments" }, { role: "release_manager", scope: "storefront" }, { role: "release_manager", scope: "risk" }]),
      P("p-sam", "Sam Whitfield", "Compliance Auditor", ["security"], [{ role: "auditor", scope: "factory" }]),
      P("p-lena", "Lena Fischer", "Engineering Lead, Platform", ["platform"], [{ role: "project_admin", scope: "identity" }, { role: "release_manager", scope: "identity" }], { oncall: true, mfa: true }),
      P("p-chloe", "Chloe Martin", "Engineering Lead, Growth", ["growth"], [{ role: "line_lead", scope: "storefront" }]),
      P("p-arjun", "Arjun Mehta", "Frontend Engineer", ["growth"], [{ role: "engineer", scope: "storefront" }]),
      P("p-fatima", "Fatima Zahra", "Senior Engineer", ["growth"], [{ role: "reviewer", scope: "storefront" }, { role: "engineer", scope: "storefront" }]),
      P("p-nikhil", "Nikhil Rao", "Engineering Lead, Data", ["data"], [{ role: "project_admin", scope: "risk" }]),
      P("p-grace", "Grace Liu", "Security Engineer", ["security"], [{ role: "approver", scope: "risk" }, { role: "approver", scope: "payments" }], { oncall: true }),
      P("p-rui", "Rui Costa", "Platform Engineer", ["platform"], [{ role: "engineer", scope: "identity" }, { role: "viewer", scope: "payments" }], { oncall: true }),
      P("p-omar", "Omar Haddad", "VP Platform", ["platform"], [{ role: "factory_admin", scope: "factory" }], { mfa: true })
    ];
    people.find(function (p) { return p.id === "p-meera"; }).away = { from: now - DAY, to: now + 2 * DAY, delegate: "p-priya" };

    /* ---------- flows and approvers ---------- */
    /* a project's flow definition. order = station ids in belt order; stations/gates hold per-project settings
       for every catalogue entry (custom entries of other projects are present with absent:true so lookups never fail) */
    function flowFrom(tpl) {
      var stations = {};
      G.STATIONS.forEach(function (s) { stations[s.id] = s.custom ? { enabled: false, wip: 5, absent: true } : { enabled: tpl.stationsOff.indexOf(s.id) < 0, wip: s.id === "build" ? 4 : 5 }; });
      var gates = {};
      G.GATES.forEach(function (g) { gates[g.id] = g.custom ? { enabled: false, mode: g.kind, absent: true } : { enabled: tpl.gatesOff.indexOf(g.id) < 0, mode: g.kind }; });
      var order = (tpl.order || G.STATIONS.filter(function (s) { return !s.custom; }).map(function (s) { return s.id; })).slice();
      var bays = (tpl.bays || G.BAYS.filter(function (b) { return !b.custom; }).map(function (b) { return b.id; })).slice();
      var classes = G.CLASSES.filter(function (c) { return !c.custom; }).map(function (c) {
        var x = JSON.parse(JSON.stringify(c));
        if (tpl.classesSkip[c.id]) x.skips = tpl.classesSkip[c.id].slice();
        x.enabled = true;
        return x;
      });
      return { stations: stations, gates: gates, slots: tpl.slots, classes: classes, order: order, bays: bays };
    }
    G.flowFrom = flowFrom;
    function approversPreset(kind) {
      var strict = kind === "strict", light = kind === "light";
      var out = {
        G0G1: { roles: ["engineer", "line_lead", "project_admin"], people: [], required: 1, sod: false, conditions: [], escalateH: 24, fallback: null, note: "Submitter confirms. Engineers may confirm only briefs they submitted." },
        G1f: { roles: [], people: [], required: 0, sod: false, conditions: [], escalateH: 0, fallback: null },
        G2: { roles: ["line_lead", "project_admin"], people: [], required: strict ? 2 : 1, sod: true, conditions: [], escalateH: 24, fallback: null },
        G3d: { roles: ["reviewer", "line_lead"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null },
        G3G3s: { roles: ["line_lead", "project_admin"], people: [], required: 1, sod: true, conditions: light ? [] : [{ id: "c1", when: { type: "path", value: "/payments" }, needs: { roles: ["approver"], people: [], oncall: false }, text: "Changes under /payments need Security" }], escalateH: 12, fallback: null },
        G4: { roles: [], people: [], required: 0, sod: false, conditions: [], escalateH: 0, fallback: null },
        G5: { roles: light ? ["reviewer", "line_lead", "engineer"] : ["reviewer", "line_lead"], people: [], required: strict ? 2 : 1, sod: true,
          conditions: [{ id: "c2", when: { type: "class", value: "hotfix" }, needs: { roles: ["release_manager"], people: [], oncall: true }, text: "Hotfix needs a Release Manager who is on call" }].concat(strict ? [{ id: "c3", when: { type: "risk", value: "high" }, needs: { roles: ["approver"], people: [], oncall: false }, text: "High-risk changes need an Approver (Security)" }] : []),
          escalateH: 8, fallback: null },
        G6: { roles: ["release_manager"], people: [], required: 1, sod: false, conditions: [], escalateH: 24, fallback: null }
      };
      /* rules for custom gates exist in every project (unused unless the gate is in that project's flow) */
      G.GATES.forEach(function (g) { if (g.custom && !out[g.id]) out[g.id] = { roles: ["line_lead", "project_admin"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null }; });
      return out;
    }
    G.approversPreset = approversPreset;
    function routesPreset(kind) {
      var list = [
        { event: "gate.waiting", dest: [{ channel: "slack", target: "#factory-gates" }], template: "gate", cond: { classes: [], priority: [], hours: "any" } },
        { event: "question", dest: [{ channel: "slack", target: "@submitter" }, { channel: "email", target: "submitter" }], template: "question", cond: { classes: [], priority: [], hours: "business" } },
        { event: "andon", dest: [{ channel: "slack", target: "#incidents" }, { channel: "paging", target: "payments-oncall" }], template: "incident", cond: { classes: [], priority: [], hours: "any" } },
        { event: "kill", dest: [{ channel: "slack", target: "#incidents" }, { channel: "paging", target: "factory-oncall" }, { channel: "email", target: "project admins" }], template: "kill", cond: { classes: [], priority: [], hours: "any" } },
        { event: "restore", dest: [{ channel: "slack", target: "#incidents" }, { channel: "email", target: "project admins" }], template: "kill", cond: { classes: [], priority: [], hours: "any" } },
        { event: "released", dest: [{ channel: "slack", target: "#releases" }, { channel: "teams", target: "Releases" }], template: "release", cond: { classes: [], priority: [], hours: "any" } },
        { event: "onboarding.pr", dest: [{ channel: "slack", target: "#factory-onboarding" }], template: "onboarding", cond: { classes: [], priority: [], hours: "any" } },
        { event: "security.hold", dest: [{ channel: "slack", target: "#security" }, { channel: "webhook", target: "siem" }], template: "incident", cond: { classes: [], priority: [], hours: "any" } },
        { event: "submitted", dest: [{ channel: "webhook", target: "jira-sync" }], template: "submitted", cond: { classes: [], priority: [], hours: "any" } },
        { event: "budget", dest: [{ channel: "email", target: "project admins" }], template: "budget", cond: { classes: [], priority: [], hours: "any" } }
      ];
      if (kind === "strict") list.push({ event: "gate.decided", dest: [{ channel: "email", target: "compliance@acme.dev" }], template: "gate", cond: { classes: [], priority: [], hours: "any" } });
      if (kind === "light") list = list.filter(function (x) { return ["gate.waiting", "question", "andon", "kill", "restore", "released"].indexOf(x.event) >= 0; });
      return list.map(function (x, i) { x.id = "NR-" + (i + 1); x.enabled = true; x.fields = { title: true, repo: true, class: true, priority: true, approvers: true, link: true }; return x; });
    }
    G.routesPreset = routesPreset;

    var tpls = {}; G.TEMPLATES_SEED.forEach(function (t) { tpls[t.id] = t; });
    var projects = [
      { id: "payments", name: "Payments Platform", key: "PAY", status: "active", teams: ["payments", "security"], owner: "p-daniel", template: "tpl-backend", regulated: false, desc: "Card processing, payouts and ledgers. Busiest line in the plant.",
        flow: flowFrom(tpls["tpl-backend"]), approvers: approversPreset("standard"), notifications: routesPreset("standard"), mcp: ["mcp-issues", "mcp-observe", "mcp-apicat", "mcp-db"],
        budget: { monthly: 7000, mtd: 4310, alertAt: 0.8 }, created: now - 140 * DAY, halted: null, killed: null,
        overlay: "Money moves here. Prefer idempotent changes, never log card data, and add a migration rollback note to every plan." },
      { id: "storefront", name: "Storefront", key: "WEB", status: "onboarding", teams: ["growth"], owner: "p-chloe", template: "tpl-web", regulated: false, desc: "Customer web app and messaging. Two repos still onboarding.",
        flow: flowFrom(tpls["tpl-web"]), approvers: approversPreset("light"), notifications: routesPreset("standard"), mcp: ["mcp-issues", "mcp-design", "mcp-docs"],
        budget: { monthly: 3000, mtd: 1120, alertAt: 0.8 }, created: now - 21 * DAY, halted: null, killed: null,
        overlay: "Ship behind feature flags. Every UI change needs a screenshot in the PR description." },
      { id: "risk", name: "Risk & Compliance", key: "RSK", status: "active", teams: ["data", "security"], owner: "p-nikhil", template: "tpl-regulated", regulated: true, desc: "Regulated scoring and KYC. Strict approvers and EU-only models.",
        flow: flowFrom(tpls["tpl-regulated"]), approvers: approversPreset("strict"), notifications: routesPreset("strict"), mcp: ["mcp-issues", "mcp-observe"],
        budget: { monthly: 2500, mtd: 2140, alertAt: 0.8 }, created: now - 90 * DAY, halted: null, killed: null,
        guidelines: { items: [{ id: "pg-1", text: "Model code changes need a signed model card in /models/cards.", required: true }], notes: "Regulated: the onboarding PR must not add CI steps that call external services.", version: 1, history: [{ v: 1, at: now - 30 * DAY, by: "p-nikhil", note: "First version" }] },
        overlay: "Regulated: models must run in eu-central-1 or on-prem. Never touch /models/approved without an Approver." },
      { id: "identity", name: "Identity", key: "IDN", status: "new", teams: ["platform"], owner: "p-lena", template: "tpl-backend", regulated: false, desc: "Auth gateway and platform infra. Created this week.",
        flow: flowFrom(tpls["tpl-backend"]), approvers: approversPreset("standard"), notifications: routesPreset("light"), mcp: ["mcp-issues"],
        budget: { monthly: 1500, mtd: 42, alertAt: 0.8 }, created: now - 3 * DAY, halted: null, killed: null, overlay: "" }
    ];
    projects[0].approvers.G3G3s.people = ["p-grace"];
    projects[2].approvers.G6.roles = ["release_manager", "project_admin"];
    projects[2].approvers.G6.required = 2;
    projects[2].flow.slots = 1;
    projects[0].flow.slots = 2;
    projects[0].approvers.G2.fallback = "p-daniel";

    /* ---------- repos and onboarding ---------- */
    function repo(id, project, team, tags, lang, stage, extra) {
      return Object.assign({
        id: id, name: "acme/" + id, project: project, team: team, tags: tags, lang: lang, halted: null,
        config: { defaultBranch: "main", branchPrefix: "gantry/", merge: tags.indexOf("regulated") >= 0 ? "merge" : "squash", tagging: "semver-patch", requiredChecks: ["ci/test", "ci/lint"], protectedPaths: ["infra/prod/**", ".github/workflows/**"] },
        mcp: [], notifyOverrides: [], triggers: true,
        guidelines: "# AGENTS.md\n- Run `make test` before opening a PR.\n- Keep handlers thin; logic lives in /internal.\n- Never commit fixtures with real customer data.",
        onboarding: { stage: stage, findings: [], pr: null, timeline: [], exception: null, startedAt: now - 10 * DAY }
      }, extra || {});
    }
    var repos = [
      repo("payments-api", "payments", "payments", ["pci"], "Go", "ready", { mcp: ["mcp-db", "mcp-observe"], notifyOverrides: [{ id: "RO-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#payments-api" }], template: "gate", mode: "also" }] }),
      repo("payouts-worker", "payments", "payments", [], "Go", "ready"),
      repo("ledger-service", "payments", "payments", ["pci"], "Go", "ready"),
      repo("web-storefront", "storefront", "growth", [], "TypeScript", "ready", { mcp: ["mcp-design"] }),
      repo("notifications", "storefront", "growth", [], "TypeScript", "ready"),
      repo("mobile-app", "storefront", "growth", [], "Kotlin", "pr_checks"),
      repo("search-indexer", "storefront", "growth", [], "Java", "person"),
      repo("risk-models", "risk", "data", ["regulated"], "Python", "ready"),
      repo("kyc-service", "risk", "security", ["regulated"], "Go", "ready"),
      repo("auth-gateway", "identity", "platform", ["critical"], "Rust", "assessed"),
      repo("platform-infra", "identity", "platform", ["infra"], "Terraform", "connected")
    ];
    function tl(rp, minsAgo, who, text) { rp.onboarding.timeline.push({ at: now - minsAgo * MIN, who: who, text: text }); }
    repos.forEach(function (rp) {
      var st = rp.onboarding.stage;
      var order = G.ONBOARD_STAGES.map(function (s) { return s.id; });
      var idx = order.indexOf(st);
      tl(rp, 60 * 24 * 9, "p-daniel", "Connected through the GitHub app.");
      if (idx >= 1 || st === "person") { G.assessRepo(rp, r); tl(rp, 60 * 24 * 9 - 20, "ag-onboard", "Assessment finished: " + rp.onboarding.findings.length + " findings."); }
      if (idx >= 2 || st === "person") { G.makeOnboardingPR(rp, 300 + Math.floor(r() * 200)); tl(rp, 60 * 24 * 9 - 40, "ag-onboard", "Opened PR #" + rp.onboarding.pr.number + "."); }
      if (idx >= 3) { rp.onboarding.pr.checks = idx >= 4 ? "green" : "running"; tl(rp, 60 * 24 * 8, "ag-onboard", "Checks " + (idx >= 4 ? "passed" : "running") + "."); }
      if (idx >= 4) { rp.onboarding.pr.state = "merged"; rp.onboarding.pr.mergedBy = "p-daniel"; tl(rp, 60 * 24 * 7, "p-daniel", "Approved and merged the onboarding PR."); }
      if (idx >= 5) tl(rp, 60 * 24 * 7 - 30, "ag-onboard", "Verified: a dry-run work order built and passed checks.");
      if (idx >= 6) tl(rp, 60 * 24 * 7 - 31, "ag-onboard", "Ready. Work orders can be submitted.");
      if (st === "person") { rp.onboarding.pr.checks = "red"; rp.onboarding.blocker = "Branch protection on main can only be changed by a GitHub org owner. The onboarding PR cannot fix it."; tl(rp, 60 * 5, "ag-onboard", "Needs a person: " + rp.onboarding.blocker); }
      if (idx === 6) rp.onboarding.readyAt = now - (7 + r() * 30) * DAY;
    });
    repos.find(function (x) { return x.id === "payouts-worker"; }).freeze = true;

    /* ---------- vendors and models ---------- */
    var vendors = [
      { id: "anthropic", name: "Anthropic", product: "Claude API", connected: true, health: "healthy", latency: 820, mtd: 4182.4, budget: 9000, keyMask: "sk-ant-••••••••3f9a", region: "us-east / eu (API)", endpoint: "", residency: "Processed in the US by default. EU processing available on the enterprise plan.",
        models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5", enabled: true, context: 500000, inPrice: 5, outPrice: 25 }, { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", enabled: true, context: 500000, inPrice: 3, outPrice: 15 }, { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", enabled: true, context: 200000, inPrice: 1, outPrice: 5 }] },
      { id: "openai", name: "OpenAI", product: "Codex", connected: true, health: "degraded", latency: 1460, mtd: 912.1, budget: 2500, keyMask: "sk-proj-••••••••a71c", region: "us", endpoint: "", residency: "Processed in the US. Zero data retention enabled on this key.",
        models: [{ id: "codex-pro", name: "Codex Pro (sample)", enabled: true, context: 400000, inPrice: 4, outPrice: 20 }, { id: "codex-mini", name: "Codex Mini (sample)", enabled: false, context: 200000, inPrice: 0.8, outPrice: 3.2 }] },
      { id: "bedrock", name: "Amazon Bedrock", product: "Bedrock runtime", connected: true, health: "healthy", latency: 990, mtd: 1288.7, budget: 3000, keyMask: "AKIA••••••••QX2M", region: "eu-central-1", endpoint: "", residency: "Requests stay in eu-central-1 (Frankfurt). Used for regulated projects.",
        models: [{ id: "bedrock-claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Bedrock)", enabled: true, context: 500000, inPrice: 3.3, outPrice: 16.5 }, { id: "bedrock-claude-opus-5-5", name: "Claude Opus 5.5 (Bedrock)", enabled: true, context: 500000, inPrice: 5.5, outPrice: 27.5 }, { id: "bedrock-nova-coder", name: "Nova Coder L (sample)", enabled: false, context: 300000, inPrice: 1.2, outPrice: 4.8 }] },
      { id: "local", name: "Local models", product: "vLLM endpoint", connected: false, health: "offline", latency: 0, mtd: 0, budget: 0, keyMask: "", region: "on-prem", endpoint: "http://gpu-pool.internal:8000/v1", residency: "Never leaves the acme network. No per-token cost.",
        models: [{ id: "local-coder-34b", name: "coder-34b-instruct (sample)", enabled: false, context: 128000, inPrice: 0, outPrice: 0 }, { id: "local-coder-7b", name: "coder-7b-fast (sample)", enabled: false, context: 64000, inPrice: 0, outPrice: 0 }] }
    ];
    var routing = {
      defaultModel: "claude-opus-5-5",
      overrides: { intake: "claude-haiku-5-5", verify: "claude-sonnet-5-5", close: "claude-haiku-5-5" },
      fallback: ["claude-opus-5-5", "claude-sonnet-5-5", "bedrock-claude-sonnet-5-5", "codex-pro"],
      rules: [
        { id: "RR-1", tag: "regulated", use: "bedrock", region: "eu-central-1", alt: "local", note: "Regulated repos stay in the EU or on-prem." },
        { id: "RR-2", tag: "infra", use: "anthropic", region: "", alt: "", note: "Infra changes always use the default vendor." }
      ]
    };

    /* ---------- skills ---------- */
    function skill(id, name, desc, when, owner, cov, body, res) {
      return { id: id, name: name, desc: desc, when: when, owner: owner, body: body, resources: res || [], version: "1.2.0", projects: "all",
        versions: [{ v: "1.0.0", at: now - 60 * DAY, by: owner, note: "First version" }, { v: "1.2.0", at: now - 9 * DAY, by: owner, note: "Tightened wording, added examples" }],
        coverage: { suite: null, cases: cov[0], pass: cov[1] } };
    }
    var skills = [
      skill("sk-assess", "Repo assessment", "Inspect a repo and list what blocks agent work.", "When onboarding or re-assessing a repo.", "p-daniel", [14, 13], "Check CI, test command, branch protection, CODEOWNERS, lint config, secrets history, AGENTS.md, reproducible build, dependency manifest and MCP needs. Rate each finding high, medium or low.", ["readiness-checklist.md"]),
      skill("sk-onboardpr", "Writing onboarding PRs", "Open a minimal PR that makes a repo ready.", "After an assessment finds fixable gaps.", "p-daniel", [10, 9], "Only add files listed in the onboarding guidelines. Never change application code. One commit per concern. Describe every file in the PR body.", ["pr-template.md", "factory.yml.example"]),
      skill("sk-classify", "Request classification", "Assign a work class with confidence and rationale.", "On every submission.", "p-meera", [40, 37], "Pick one of the configured classes. Give confidence 0-1 and one sentence of rationale. If below 0.6, ask the submitter.", []),
      skill("sk-intake", "Intake interviewing", "Ask the fewest questions that make a brief complete.", "During the intake conversation.", "p-meera", [18, 16], "Ask about scope, acceptance criteria, rollback and test data. Offer quick replies. Record every decision.", ["question-bank.md"]),
      skill("sk-spec", "Spec writing", "Write a one-page spec from a confirmed brief.", "At Spec.", "p-meera", [16, 14], "Problem, acceptance criteria, out of scope, affected services, risks. Cite files and owners.", []),
      skill("sk-testdesign", "Test design", "Design tests that fail on the bug and pass on the fix.", "At Plan and Verify.", "p-priya", [20, 18], "Prefer behaviour tests. Name the failure mode each test catches.", []),
      skill("sk-migration", "Migration safety", "Plan schema and data changes with rollback.", "When a plan touches migrations.", "p-priya", [9, 7], "Expand, migrate, contract. Backfills in batches with a kill switch. Write the rollback first.", ["migration-checklist.md"]),
      skill("sk-security", "Security review", "Find secrets, injection, authz gaps and risky dependencies.", "At G3s and Review.", "p-grace", [26, 24], "Block on high severity. Explain the fix with a code pointer.", ["owasp-cheatsheet.md"]),
      skill("sk-relnotes", "Release notes", "Write user-facing release notes and changelog entries.", "At Close.", "p-kenji", [8, 8], "Group by feature, fix, breaking. Link the work order.", []),
      skill("sk-research", "Codebase research", "Answer a question about the code with citations.", "At Research and for spikes.", "p-priya", [12, 10], "State the question, the answer, and the evidence with file paths. List unknowns.", [])
    ];

    /* ---------- agents ---------- */
    function tools(o) {
      var b = { readRepo: true, writeBranch: false, runTests: false, openPR: false, merge: false, postSlack: true, sendEmail: false, readSecrets: false };
      Object.keys(o || {}).forEach(function (k) { b[k] = o[k]; });
      return b;
    }
    function A(id, name, station, model, fb, version, autonomy, tl, sk, mcp, budget, instr, vers) {
      return { id: id, name: name, station: station, model: model, fallbacks: fb, version: version, status: "active", autonomy: autonomy, tools: tools(tl), skills: sk, mcp: mcp,
        stations: station ? [station] : [], projects: "all", budget: budget, guardrails: { paths: [], maxDiff: 0 }, suite: "SUITE-" + id.slice(3).toUpperCase(), instructions: instr, overrides: {},
        versions: vers.map(function (v, i) { return { v: v[0], at: now - v[1] * DAY, note: v[2], diff: v[3] || v[2], suiteScore: 0, live: false, rc: !!v[4], snapshot: null }; }) };
    }
    var agents = [
      A("ag-intake", "Intake Clerk", "intake", "claude-haiku-5-5", ["claude-sonnet-5-5"], "1.4.0", "auto", {}, ["sk-intake", "sk-classify"], ["mcp-issues"], 0.5, "Run the intake conversation. Ask only what the brief needs. Never promise dates.", [["1.3.1", 41, "Duplicate detection", "+ duplicate check against open issues"], ["1.4.0", 12, "Asks about rollback", "+ rollback question for hotfix and migration work"]]),
      A("ag-classifier", "Intake classifier", "intake", "claude-haiku-5-5", [], "2.0.1", "auto", {}, ["sk-classify"], [], 0.1, "Classify every submission into a configured class with confidence and rationale.", [["1.9.0", 50, "Nine classes", "+ spike and docs classes"], ["2.0.1", 6, "Calibrated confidence", "~ confidence now calibrated on 400 labelled requests"]]),
      A("ag-research", "Researcher", "research", "claude-opus-5-5", ["claude-sonnet-5-5"], "1.1.0", "auto", {}, ["sk-research"], ["mcp-docs", "mcp-issues", "mcp-observe"], 2, "Answer the open questions in the brief with evidence from code, docs and dashboards.", [["1.1.0", 20, "Cites dashboards", "+ observability MCP for incident context"]]),
      A("ag-spec", "Spec Writer", "spec", "claude-opus-5-5", ["claude-sonnet-5-5", "bedrock-claude-opus-5-5"], "2.1.0", "gate", {}, ["sk-spec"], ["mcp-docs"], 1.5, "Write a one-page spec from the confirmed brief.", [["2.0.0", 60, "AC template", "+ acceptance criteria template"], ["2.1.0", 18, "Cites CODEOWNERS", "+ owners section"]]),
      A("ag-design", "Designer", "design", "claude-opus-5-5", ["claude-sonnet-5-5"], "0.9.0", "gate", {}, ["sk-spec"], ["mcp-design", "mcp-apicat"], 2, "Propose interfaces, data shapes and UI states. Reuse existing components.", [["0.9.0", 15, "First release", "First release"]]),
      A("ag-plan", "Planner", "plan", "claude-opus-5-5", ["claude-sonnet-5-5"], "1.9.2", "gate", {}, ["sk-testdesign", "sk-migration"], ["mcp-issues"], 2, "Break the spec into ordered steps with files, tests and a rollback note.", [["1.8.0", 70, "Rollback notes", "+ rollback section"], ["1.9.2", 22, "Migration detection", "+ migration safety skill attached"]]),
      A("ag-build", "Builder", "build", "claude-opus-5-5", ["claude-sonnet-5-5", "bedrock-claude-sonnet-5-5", "codex-pro"], "2.6.1", "gate", { writeBranch: true, runTests: true, openPR: true }, ["sk-testdesign"], ["mcp-apicat", "mcp-db"], 12, "Implement the approved plan on a branch. Keep diffs small; add tests for every behaviour change.", [["2.5.0", 52, "Convention detection", "+ detects repo conventions"], ["2.6.1", 16, "Smaller diffs", "~ max diff 800 lines, test-first"], ["2.7.0-rc1", 2, "Sonnet 5.5 primary trial", "~ primary model claude-sonnet-5-5", true]]),
      A("ag-test", "Test Engineer", "verify", "claude-sonnet-5-5", ["claude-haiku-5-5"], "1.7.0", "gate", { writeBranch: true, runTests: true }, ["sk-testdesign"], ["mcp-observe"], 4, "Run required checks, write missing tests, report flaky tests with evidence.", [["1.6.0", 48, "Flake evidence", "+ flaky test report"], ["1.7.0", 9, "Coverage deltas", "+ coverage on changed lines"]]),
      A("ag-review", "Reviewer", "review", "claude-opus-5-5", ["bedrock-claude-opus-5-5"], "3.0.2", "suggest", {}, ["sk-security", "sk-testdesign"], [], 3, "Review the diff against spec and plan. Recommend; a human decides.", [["2.9.0", 66, "Spec traceability", "+ maps comments to acceptance criteria"], ["3.0.2", 20, "Fewer nitpicks", "- style-only comments"]]),
      A("ag-close", "Release Captain", "close", "claude-haiku-5-5", ["claude-sonnet-5-5"], "1.3.0", "gate", { openPR: true, merge: true, sendEmail: true }, ["sk-relnotes"], ["mcp-issues"], 0.8, "Tag, write release notes, close linked issues, then watch health for 30 minutes.", [["1.2.0", 55, "Changelog format", "~ keep-a-changelog format"], ["1.3.0", 14, "Tagging rules", "+ per-repo tagging"]]),
      A("ag-onboard", "Onboarding agent", null, "claude-sonnet-5-5", ["claude-opus-5-5"], "1.5.0", "gate", { writeBranch: true, openPR: true }, ["sk-assess", "sk-onboardpr"], ["mcp-issues"], 3, "Assess repos against the onboarding guidelines and open one PR with the fixes.", [["1.4.0", 30, "factory.yml", "+ writes factory config file"], ["1.5.0", 8, "Guidelines v3", "~ follows onboarding guidelines v3"]]),
      A("ag-sec", "Security auditor", "plan", "bedrock-claude-sonnet-5-5", ["local-coder-34b"], "1.2.0", "suggest", {}, ["sk-security"], ["mcp-observe"], 2.5, "Run G3s on every plan and scan every diff. Block on high severity.", [["1.1.0", 40, "Dependency checks", "+ CVE lookup"], ["1.2.0", 10, "AuthZ rules", "+ authz gap rules"]])
    ];
    agents.find(function (a) { return a.id === "ag-sec"; }).stations = ["plan", "review"];
    agents.find(function (a) { return a.id === "ag-build"; }).guardrails = { paths: ["infra/prod/**", ".github/workflows/**", "**/*.pem"], maxDiff: 800 };
    agents.find(function (a) { return a.id === "ag-build"; }).overrides = { risk: { model: "bedrock-claude-sonnet-5-5", autonomy: "gate" } };
    agents.forEach(function (a, i) {
      var liveIdx = -1; a.versions.forEach(function (v, j) { if (!v.rc) liveIdx = j; });
      a.versions.forEach(function (v, j) { v.live = j === liveIdx; });
      var base = [0.9, 0.88, 0.84, 0.86, 0.8, 0.86, 0.84, 0.9, 0.9, 0.95, 0.88, 0.92][i] || 0.85;
      a.spark = []; for (var d = 0; d < 7; d++) a.spark.push(Math.min(1, Math.max(0.5, base + between(-0.06, 0.05))));
      a.spend7d = [21, 6, 70, 88, 40, 140, 612, 210, 196, 18, 55, 74][i] || 20;
      a.initials = a.name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    });

    /* ---------- MCP servers ---------- */
    function T(name, write) { return { name: name, write: !!write, allowed: true }; }
    var mcp = [
      { id: "mcp-issues", name: "Issue tracker", transport: "http", url: "https://mcp.issues.acme.dev/v1", auth: "OAuth", authMask: "client ••••7d2", health: "healthy", sensitivity: "internal", writeGate: true,
        tools: [T("search_issues"), T("get_issue"), T("create_issue", true), T("comment_issue", true)], projects: "all", repos: "all", agents: ["ag-intake", "ag-research", "ag-plan", "ag-close", "ag-onboard"], stations: ["intake", "research", "plan", "close"] },
      { id: "mcp-docs", name: "Docs and wiki", transport: "http", url: "https://mcp.wiki.acme.dev", auth: "API key", authMask: "wk_••••a01", health: "healthy", sensitivity: "internal", writeGate: true,
        tools: [T("search_pages"), T("get_page"), T("update_page", true)], projects: "all", repos: "all", agents: ["ag-research", "ag-spec"], stations: ["research", "spec"] },
      { id: "mcp-observe", name: "Observability", transport: "http", url: "https://mcp.observe.acme.dev", auth: "API key", authMask: "obs_••••99c", health: "degraded", sensitivity: "confidential", writeGate: true,
        tools: [T("query_metrics"), T("get_logs"), T("list_incidents"), T("silence_alert", true)], projects: ["payments", "risk"], repos: "all", agents: ["ag-research", "ag-test", "ag-sec"], stations: ["research", "verify", "plan"] },
      { id: "mcp-db", name: "Database read replica", transport: "stdio", url: "runner://pg-replica-ro", auth: "Vault role", authMask: "vault:pg-ro", health: "healthy", sensitivity: "restricted", writeGate: true,
        tools: [T("describe_schema"), T("explain_query"), T("sample_rows")], projects: ["payments"], repos: ["payments-api", "ledger-service"], agents: ["ag-build", "ag-plan"], stations: ["plan", "build"] },
      { id: "mcp-design", name: "Design files", transport: "http", url: "https://mcp.design.acme.dev", auth: "OAuth", authMask: "client ••••e40", health: "healthy", sensitivity: "internal", writeGate: true,
        tools: [T("get_frame"), T("list_components"), T("export_tokens")], projects: ["storefront"], repos: ["web-storefront", "mobile-app"], agents: ["ag-design"], stations: ["design"] },
      { id: "mcp-apicat", name: "Internal API catalogue", transport: "http", url: "https://mcp.apis.acme.dev", auth: "mTLS", authMask: "cert gantry-01", health: "healthy", sensitivity: "internal", writeGate: true,
        tools: [T("search_apis"), T("get_openapi"), T("register_api", true)], projects: "all", repos: "all", agents: ["ag-design", "ag-build"], stations: ["design", "build"] },
      { id: "mcp-flags", name: "Feature flags (custom)", transport: "stdio", url: "runner://flagctl", auth: "Token", authMask: "ff_••••311", health: "healthy", sensitivity: "internal", writeGate: true,
        tools: [T("get_flag"), T("list_flags"), T("toggle_flag", true)], projects: ["storefront"], repos: ["web-storefront"], agents: ["ag-close"], stations: ["close"] }
    ];
    mcp.find(function (m) { return m.id === "mcp-observe"; }).tools[3].allowed = false;
    var mcpUsage = [];
    for (var u = 0; u < 26; u++) {
      var srv = pick(mcp), ag = pick(srv.agents.length ? srv.agents : ["ag-build"]), tool = pick(srv.tools);
      mcpUsage.push({ at: now - between(2, 2000) * MIN, server: srv.id, tool: tool.name, agent: ag, project: pick(["payments", "storefront", "risk"]), outcome: tool.write ? "gated" : (r() < 0.93 ? "ok" : "error"), ms: Math.round(between(40, 1200)) });
    }
    mcpUsage.sort(function (a, b) { return a.at - b.at; });

    /* ---------- integrations, notifications, deliveries ---------- */
    var integrations = {
      github: { connected: true, app: "Gantry Factory", org: "acme", lastSync: now - 4 * MIN, status: "healthy",
        available: [{ repo: "acme/docs-site", lang: "MDX" }, { repo: "acme/search-api", lang: "Go" }, { repo: "acme/billing-ui", lang: "TypeScript" }] },
      slack: { connected: true, workspace: "acme-eng", lastSync: now - 2 * MIN, status: "healthy", approveFromSlack: true },
      teams: { connected: true, tenant: "acme.onmicrosoft.com", lastSync: now - 9 * MIN, status: "healthy", approveFromTeams: false },
      email: { connected: true, from: "gantry@acme.dev", lastSync: now - 38 * MIN, status: "healthy", digest: "daily", digestTime: "09:00" },
      webhook: { connected: true, endpoints: [{ id: "siem", url: "https://siem.acme.dev/hooks/gantry", secretMask: "whsec_••••91a", status: "healthy" }, { id: "jira-sync", url: "https://jira-bridge.acme.dev/gantry", secretMask: "whsec_••••c03", status: "failing" }], lastSync: now - 6 * MIN, status: "degraded" },
      paging: { connected: true, service: "On-call paging", lastSync: now - 15 * MIN, status: "healthy", schedules: ["payments-oncall", "platform-oncall", "factory-oncall"] }
    };
    var deliveries = [];
    var evs = ["gate.waiting", "question", "released", "onboarding.pr", "submitted", "andon"];
    for (var dI = 0; dI < 22; dI++) {
      var ev = pick(evs);
      var ch = ev === "submitted" ? "webhook" : pick(["slack", "slack", "email", "teams"]);
      var failed = ch === "webhook" && r() < 0.6;
      deliveries.push({ id: "DLV-" + (5100 + dI), at: now - between(3, 1400) * MIN, project: pick(["payments", "storefront", "risk"]), event: ev, channel: ch, target: ch === "webhook" ? "jira-sync" : ch === "slack" ? "#factory-gates" : ch === "teams" ? "Releases" : "submitter", status: failed ? "failed" : "delivered", attempts: failed ? 3 : 1, error: failed ? "HTTP 502 from jira-bridge.acme.dev" : "" });
    }
    deliveries.sort(function (a, b) { return a.at - b.at; });

    /* ---------- API keys and triggers ---------- */
    var apiKeys = [
      { id: "key-1", name: "Jira bridge", prefix: "gk_live_7Hq2", project: "payments", actions: ["wo.submit", "wo.read"], created: now - 40 * DAY, lastUsed: now - 14 * MIN, revoked: false, by: "p-daniel" },
      { id: "key-2", name: "Ops runbook bot", prefix: "gk_live_c91X", project: "storefront", actions: ["wo.submit", "wo.read"], created: now - 12 * DAY, lastUsed: now - 3 * HOUR, revoked: false, by: "p-chloe" },
      { id: "key-3", name: "Old CI hook", prefix: "gk_live_00aa", project: "payments", actions: ["wo.read"], created: now - 200 * DAY, lastUsed: now - 61 * DAY, revoked: true, by: "p-asha" }
    ];
    var apiConfig = { rateLimit: 60, burst: 20, idempotencyHours: 24, webhookSigning: "HMAC-SHA256" };
    var requestLog = [];
    for (var q = 0; q < 14; q++) {
      var k = pick(apiKeys.slice(0, 2));
      var post = r() < 0.4;
      requestLog.push({ at: now - between(5, 1800) * MIN, key: k.id, method: post ? "POST" : "GET", path: post ? "/v1/projects/" + k.project + "/work-orders" : "/v1/work-orders/WO-24" + Math.floor(between(0, 30)), status: r() < 0.9 ? (post ? 201 : 200) : 429, ms: Math.round(between(30, 400)) });
    }
    requestLog.sort(function (a, b) { return a.at - b.at; });
    var triggers = [
      { id: "TR-1", project: "payments", type: "issue", name: "Issues labelled factory", enabled: true, label: "factory", labelMap: { bug: "bug", security: "security", docs: "docs", enhancement: "feature" }, who: "org", reply: "Thanks. Gantry opened {wo} and will ask any questions here.", dedupe: true, repos: "ready", runs: [] },
      { id: "TR-2", project: "payments", type: "comment", name: "/factory fix on PRs", enabled: true, command: "/factory fix", who: "org", reply: "On it: {wo}.", dedupe: true, repos: "ready", runs: [] },
      { id: "TR-3", project: "storefront", type: "schedule", name: "Weekly dependency chores", enabled: true, schedule: "Mon 06:00 IST", cls: "chore", who: "system", reply: "", dedupe: true, repos: "ready", runs: [] },
      { id: "TR-4", project: "payments", type: "ci", name: "Failing CI on main", enabled: true, cls: "hotfix", who: "system", reply: "Main is red. Proposed hotfix {wo} needs a person to confirm.", dedupe: true, repos: "ready", runs: [] },
      { id: "TR-5", project: "risk", type: "issue", name: "Compliance issues", enabled: false, label: "factory", labelMap: { bug: "bug", security: "security" }, who: "org", reply: "Logged as {wo}.", dedupe: true, repos: "ready", runs: [] }
    ];
    triggers.forEach(function (t) { for (var i = 0; i < 3; i++) t.runs.push({ at: now - between(60, 9000) * MIN, outcome: r() < 0.75 ? "created" : "deduped", wo: "WO-23" + Math.floor(between(10, 99)), source: t.type === "issue" ? "acme/payments-api#" + Math.floor(between(800, 999)) : t.type }); t.runs.sort(function (a, b) { return a.at - b.at; }); });

    /* ---------- policies, freezes ---------- */
    var policies = [
      { id: "POL-101", name: "Payments release window", effect: "allow", enabled: true, roles: ["release_manager"], actions: ["release"], where: { projects: ["payments"] }, when: { days: [2, 3, 4], from: "10:00", to: "16:00" }, oncallOnly: false },
      { id: "POL-102", name: "Standard release window", effect: "allow", enabled: true, roles: ["release_manager", "project_admin"], actions: ["release"], where: { projects: ["storefront", "risk"] }, when: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, oncallOnly: false },
      { id: "POL-103", name: "Identity on-call release", effect: "allow", enabled: true, roles: ["release_manager", "project_admin"], actions: ["release"], where: { projects: ["identity"] }, when: { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "24:00" }, oncallOnly: true },
      { id: "POL-105", name: "Factory Admin break-glass", effect: "allow", enabled: true, roles: ["factory_admin"], actions: ["release"], where: { projects: [] }, when: { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "24:00" }, oncallOnly: false },
      { id: "POL-106", name: "On-call may kill a project out of hours", effect: "allow", enabled: true, roles: ["project_admin", "release_manager", "line_lead"], actions: ["kill.project"], where: { projects: [] }, when: { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "24:00" }, oncallOnly: true, extend: true },
      { id: "POL-110", name: "Freezes block release", effect: "deny", enabled: true, roles: ["*"], actions: ["release"], where: { freeze: true }, when: null, oncallOnly: false },
      { id: "POL-112", name: "No autonomous agents on regulated projects", effect: "deny", enabled: true, roles: ["agents"], actions: ["agent.autonomous"], where: { regulated: true }, when: null, oncallOnly: false }
    ];
    var freezes = [
      { id: "FRZ-07", name: "Payout batch cutover", repos: ["payouts-worker"], from: now - 20 * HOUR, to: now + 3 * DAY, by: "p-meera" },
      { id: "FRZ-08", name: "Year-end change freeze", repos: "all", from: new Date("2026-12-19T00:00:00+05:30").getTime(), to: new Date("2027-01-05T09:00:00+05:30").getTime(), by: "p-asha" }
    ];

    /* ---------- security, sessions ---------- */
    var security = { sso: { provider: "Okta", domain: "acme.dev", enforced: true, entity: "https://acme.okta.com/app/gantry" }, mfa: { policy: "admins", methods: ["totp", "webauthn"] },
      sessionHours: 12, idleMin: 30, domains: ["acme.dev"], ipAllow: ["10.0.0.0/8", "203.0.113.0/24"], restoreFactoryNeedsTwo: true, githubLogin: true };
    var devices = ["Chrome on macOS", "Firefox on Ubuntu", "Safari on iOS", "Edge on Windows", "Chrome on Windows"];
    var sessions = people.slice(0, 11).map(function (p, i) {
      return { id: "ses-" + (700 + i), person: p.id, method: i % 3 === 2 ? "github" : "sso", device: devices[i % devices.length], ip: "10.4." + (10 + i) + "." + (20 + i * 3), started: now - between(1, 10) * HOUR, lastSeen: now - between(1, 50) * MIN, revoked: false };
    });
    var signins = [];
    for (var s2 = 0; s2 < 24; s2++) {
      var pp = pick(people), fail = r() < 0.15;
      signins.push({ at: now - between(30, 4000) * MIN, person: fail && r() < 0.5 ? null : pp.id, email: fail && r() < 0.5 ? "unknown@gmail.com" : pp.email, method: pick(["sso", "sso", "github", "demo"]), outcome: fail ? "failure" : "success", reason: fail ? pick(["Domain not allowed", "MFA code rejected", "IdP returned access_denied"]) : "", ip: "10.4." + Math.floor(between(1, 90)) + "." + Math.floor(between(1, 250)), device: pick(devices) });
    }
    signins.sort(function (a, b) { return a.at - b.at; });

    var guidelines = {
      version: 3, by: "p-daniel", at: now - 8 * DAY,
      items: [
        { id: "gl-1", text: "CI runs on every PR and on main.", required: true },
        { id: "gl-2", text: "A single test command is documented in AGENTS.md.", required: true },
        { id: "gl-3", text: "main is protected: 1 review, status checks required.", required: true },
        { id: "gl-4", text: "CODEOWNERS covers every top-level directory.", required: false },
        { id: "gl-5", text: "Lint config is committed.", required: false },
        { id: "gl-6", text: "No secrets in history (secrets scan clean).", required: true },
        { id: "gl-7", text: "Build is reproducible from a clean checkout.", required: true },
        { id: "gl-8", text: "Dependency manifest with a lockfile.", required: true },
        { id: "gl-9", text: "MCP servers the repo needs are declared in .gantry/factory.yml.", required: false }
      ],
      may: "The onboarding PR may add or edit: AGENTS.md, .gantry/factory.yml, CODEOWNERS, CI workflow files, lint config.",
      mayNot: "It may never change application code, dependency versions or branch protection settings.",
      history: [{ v: 1, at: now - 80 * DAY, by: "p-asha", note: "First version" }, { v: 2, at: now - 40 * DAY, by: "p-daniel", note: "Added reproducible build" }, { v: 3, at: now - 8 * DAY, by: "p-daniel", note: "MCP declaration in factory.yml" }]
    };

    var instructions = { base: "You work inside Gantry, Acme's software factory. Follow the work order brief exactly. Ask instead of guessing. Never push to main. Every change goes through a PR and the gates configured for the project.", baseVersion: 4 };

    var state = {
      org: { id: "acme", name: "Acme Payments", plant: "Plant 1 · Bengaluru", tz: "IST" },
      factory: { killed: null },
      teams: teams, people: people, projects: projects, repos: repos, agents: agents, skills: skills, mcp: mcp, mcpUsage: mcpUsage,
      vendors: vendors, routing: routing, templates: JSON.parse(JSON.stringify(G.TEMPLATES_SEED)),
      workOrders: [], nextWO: 2398, nextPR: 1830, integrations: integrations, deliveries: deliveries, nextDelivery: 5200,
      apiKeys: apiKeys, apiConfig: apiConfig, requestLog: requestLog, triggers: triggers,
      matrix: matrix(), policies: policies, freezes: freezes, security: security, sessions: sessions, signins: signins,
      guidelines: guidelines, instructions: instructions,
      suites: [], evalRuns: [], nextRun: 900, scorecards: {}, evalExtra: {},
      audit: [], nextAudit: 1,
      console: { messages: [], pinned: ["WO-2417"] },
      session: null,
      prefs: { project: "payments", theme: "system", paused: false, floorView: "belt", boardSwim: "none", boardFilters: { cls: "all", repo: "all", assignee: "all", prio: "all" }, collapsedBays: false, activeClass: null,
        navCollapsed: {}, navRail: false, palettePinned: ["floor", "work-orders"], paletteRecent: [], record: null, replay: null }
    };

    G._projects = projects;
    G._seedState = state;
    G.seedWorkOrders(state, r, now);
    G.seedEvals(state, r, now);
    G.seedAudit(state, now);
    if (G.seedRound3) G.seedRound3(state, r, now);
    /* timestamps are whole milliseconds (the generators work in fractional minutes) */
    (function round(x) {
      if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) { if (typeof x[i] === "number" && x[i] > 1e12 && x[i] % 1) x[i] = Math.round(x[i]); else if (x[i] && typeof x[i] === "object") round(x[i]); } return; }
      Object.keys(x).forEach(function (k) { var v = x[k]; if (typeof v === "number" && v > 1e12 && v % 1) x[k] = Math.round(v); else if (v && typeof v === "object") round(v); });
    })(state);
    return state;
  };

  G.ONBOARD_STAGES = [
    { id: "connected", name: "Connected" }, { id: "assessed", name: "Assessed" }, { id: "pr_opened", name: "PR opened" },
    { id: "pr_checks", name: "PR checks" }, { id: "pr_merged", name: "PR merged" }, { id: "verified", name: "Verified" }, { id: "ready", name: "Ready" }
  ];

  /* deterministic-ish assessment for a repo */
  G.assessRepo = function (rp, rand) {
    rand = rand || Math.random;
    var lang = rp.lang;
    var f = [
      { id: "ci", check: "CI present", ok: lang !== "MDX", sev: "high", fix: "Add .github/workflows/gantry-ci.yml", file: ".github/workflows/gantry-ci.yml" },
      { id: "test", check: "Test command", ok: lang !== "Terraform", sev: "high", fix: "Document the test command in AGENTS.md", file: null },
      { id: "protect", check: "Branch protection", ok: rp.id !== "search-indexer", sev: "high", fix: "Org owner must enable protection on main", file: null, manual: true },
      { id: "owners", check: "CODEOWNERS", ok: rand() < 0.4, sev: "medium", fix: "Add CODEOWNERS for top-level directories", file: "CODEOWNERS" },
      { id: "lint", check: "Lint config", ok: rand() < 0.6, sev: "low", fix: "Commit lint config", file: lang === "Go" ? ".golangci.yml" : lang === "Python" ? "ruff.toml" : ".eslintrc.json" },
      { id: "secrets", check: "Secrets scan", ok: true, sev: "high", fix: "", file: null },
      { id: "agents", check: "Agent instructions file", ok: false, sev: "medium", fix: "Add AGENTS.md with conventions and test command", file: "AGENTS.md" },
      { id: "repro", check: "Build reproducibility", ok: rand() < 0.8, sev: "medium", fix: "Pin toolchain version", file: lang === "Go" ? ".tool-versions" : "Dockerfile.build" },
      { id: "deps", check: "Dependency manifest", ok: true, sev: "high", fix: "", file: null },
      { id: "mcp", check: "MCP needs declared", ok: false, sev: "low", fix: "Declare MCP servers in .gantry/factory.yml", file: ".gantry/factory.yml" }
    ];
    rp.onboarding.findings = f;
    return f;
  };
  G.makeOnboardingPR = function (rp, number) {
    var files = rp.onboarding.findings.filter(function (x) { return !x.ok && x.file; }).map(function (x) {
      var plus = { "AGENTS.md": 42, "CODEOWNERS": 9, ".gantry/factory.yml": 18, ".github/workflows/gantry-ci.yml": 37 }[x.file] || 12;
      return { path: x.file, plus: plus, minus: 0, finding: x.id };
    });
    if (!files.some(function (x) { return x.path === ".gantry/factory.yml"; })) files.push({ path: ".gantry/factory.yml", plus: 18, minus: 0, finding: "mcp" });
    rp.onboarding.pr = { number: number, title: "Prepare " + rp.name + " for Gantry", branch: "gantry/onboarding", files: files, checks: "pending", state: "open", reviewers: [], mergedBy: null };
    return rp.onboarding.pr;
  };
})(window.G);
