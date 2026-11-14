/* Catalogues and round-three seed data.
   - G.INTEGRATION_TYPES: built-in integration types with field schemas (custom types are added at runtime).
   - G.catalog: pure helpers that add custom stations, gates, bays, classes and roles to a state tree.
     G.ops (sim.js) wraps them with permissions and audit; seeding uses them directly.
   - G.seedRound3(state, rng, now): portfolio projects, people, custom flow entries, integration instances,
     historical work orders for 7-day replay, lifecycle records, trust ladder, learning loop and the event log. */
(function (G) {
  "use strict";
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;

  function F(key, label, type, o) { return Object.assign({ key: key, label: label, type: type || "text", required: true }, o || {}); }
  G.INTEGRATION_CATEGORIES = [
    { id: "source", name: "Source control" }, { id: "chat", name: "Chat" }, { id: "email", name: "Email" }, { id: "issues", name: "Issue trackers" },
    { id: "ci", name: "CI" }, { id: "paging", name: "Paging" }, { id: "webhook", name: "Webhooks" }, { id: "custom", name: "Custom" }
  ];
  /* the one list of notification events (routes, card defaults, integration type events, onboarding overrides) */
  G.NOTIFY_EVENTS = [
    { id: "submitted", name: "Work order submitted" }, { id: "question", name: "Question for a person" }, { id: "gate.waiting", name: "Gate waiting" },
    { id: "gate.decided", name: "Gate approved or rejected" }, { id: "blocked", name: "Work order blocked" }, { id: "security.hold", name: "Security hold" },
    { id: "andon", name: "Andon halt" }, { id: "kill", name: "Kill switch pulled" }, { id: "restore", name: "Restored after kill" },
    { id: "onboarding.pr", name: "Onboarding PR opened, merged or failed" }, { id: "released", name: "Released" },
    { id: "eval.regression", name: "Eval regression" }, { id: "budget", name: "Budget threshold" },
    { id: "trust.changed", name: "Trust level changed or proposed" }, { id: "learning.proposed", name: "Learning finding or proposal" },
    { id: "outcome.recorded", name: "Post-release outcome recorded" }
  ];
  G.notifyEventName = function (id) { var e = G.NOTIFY_EVENTS.find(function (x) { return x.id === id; }); return e ? e.name : id; };
  var EV_ALL = G.NOTIFY_EVENTS.map(function (e) { return e.id; });
  G.INTEGRATION_TYPES = [
    { id: "github", name: "GitHub", category: "source", icon: "github", auth: "app", payload: "json", builtIn: true, source: true, destination: false,
      fields: [F("org", "Organisation"), F("host", "Host", "url", { required: false, placeholder: "https://github.com (cloud) or your Enterprise URL" }), F("appId", "App ID"), F("privateKey", "App private key", "secret")],
      events: ["issue.opened", "issue.labeled", "pr.comment", "check.failed", "push"], actions: ["open_pr", "merge_pr", "comment", "tag_release", "read_repo"] },
    { id: "gitlab", name: "GitLab", category: "source", icon: "branch", auth: "token", payload: "json", builtIn: true, source: true, destination: false,
      fields: [F("host", "Host", "url", { placeholder: "https://gitlab.com" }), F("group", "Group"), F("token", "Access token", "secret")],
      events: ["issue.opened", "mr.comment", "pipeline.failed"], actions: ["open_mr", "merge_mr", "comment", "read_repo"] },
    { id: "bitbucket", name: "Bitbucket", category: "source", icon: "branch", auth: "oauth", payload: "json", builtIn: true, source: true, destination: false,
      fields: [F("workspace", "Workspace"), F("clientId", "OAuth client id"), F("clientSecret", "OAuth client secret", "secret")],
      events: ["issue.created", "pr.comment"], actions: ["open_pr", "merge_pr", "comment"] },
    { id: "slack", name: "Slack", category: "chat", icon: "slack", auth: "oauth", payload: "blocks", builtIn: true, destination: true, targetLabel: "Channel or @person",
      fields: [F("workspace", "Workspace"), F("botToken", "Bot token", "secret"), F("approve", "Allow approvals from Slack", "bool", { required: false })],
      events: ["message.posted", "button.clicked"], actions: ["post_card", "update_card", "dm"] },
    { id: "teams", name: "Microsoft Teams", category: "chat", icon: "teams", auth: "oauth", payload: "adaptive", builtIn: true, destination: true, targetLabel: "Team / channel",
      fields: [F("tenant", "Tenant"), F("clientId", "App client id"), F("clientSecret", "App secret", "secret")], events: ["message.posted", "card.action"], actions: ["post_card", "update_card"] },
    { id: "gchat", name: "Google Chat", category: "chat", icon: "chat", auth: "token", payload: "json", builtIn: true, destination: true, targetLabel: "Space",
      fields: [F("domain", "Workspace domain"), F("serviceAccount", "Service account key", "secret")], events: ["message.posted"], actions: ["post_card"] },
    { id: "discord", name: "Discord", category: "chat", icon: "chat", auth: "token", payload: "json", builtIn: true, destination: true, targetLabel: "Channel",
      fields: [F("guild", "Server"), F("botToken", "Bot token", "secret")], events: ["message.posted"], actions: ["post_message"] },
    { id: "email", name: "Email (SMTP)", category: "email", icon: "mail", auth: "smtp", payload: "html", builtIn: true, destination: true, targetLabel: "Address or role (submitter, approvers, project admins)",
      fields: [F("from", "From address"), F("smtpHost", "SMTP host"), F("smtpUser", "SMTP user"), F("smtpPassword", "SMTP password", "secret")], events: [], actions: ["send_email", "send_digest"] },
    { id: "jira", name: "Jira-style tracker", category: "issues", icon: "list", auth: "token", payload: "json", builtIn: true, source: true, destination: true, targetLabel: "Project key",
      fields: [F("site", "Site URL", "url"), F("email", "Service account email"), F("token", "API token", "secret")], events: ["issue.created", "issue.labeled", "issue.transitioned"], actions: ["create_issue", "comment", "transition"] },
    { id: "linear", name: "Linear-style tracker", category: "issues", icon: "list", auth: "token", payload: "json", builtIn: true, source: true, destination: true, targetLabel: "Team",
      fields: [F("workspace", "Workspace"), F("apiKey", "API key", "secret")], events: ["issue.created", "issue.labeled"], actions: ["create_issue", "comment"] },
    { id: "ci", name: "CI runner (generic)", category: "ci", icon: "refresh", auth: "token", payload: "json", builtIn: true, source: true, destination: false,
      fields: [F("url", "Server URL", "url"), F("token", "API token", "secret")], events: ["build.failed", "build.passed"], actions: ["trigger_build", "read_logs"] },
    { id: "paging", name: "On-call paging", category: "paging", icon: "page", auth: "token", payload: "json", builtIn: true, destination: true, targetLabel: "Schedule",
      fields: [F("service", "Service"), F("routingKey", "Routing key", "secret"), F("schedules", "On-call schedules", "text", { required: false, placeholder: "Comma-separated, e.g. payments-oncall, platform-oncall" })], events: ["incident.ack"], actions: ["page", "resolve"] },
    { id: "webhook", name: "Signed webhook", category: "webhook", icon: "webhook", auth: "hmac", payload: "json", builtIn: true, destination: true, targetLabel: "Endpoint",
      fields: [F("url", "Endpoint URL", "url"), F("secret", "Signing secret", "secret"), F("format", "Payload format", "select", { options: ["json", "cloudevents"] })], events: [], actions: ["post_json"] }
  ];
  G.INTEGRATION_EVENTS_ALL = EV_ALL;

  /* ---------- catalogue helpers (pure; ops add permission checks and audit) ---------- */
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  G.catalog = {
    addStation: function (state, def, projectId, afterId) {
      var p = state.projects.find(function (x) { return x.id === projectId; });
      if (!G.STATIONS.some(function (s) { return s.id === def.id; })) {
        var after = G.STATIONS.find(function (s) { return s.id === afterId; });
        G.STATIONS.push({ id: def.id, no: (after ? after.no : "S") + "·" + (G.STATIONS.filter(function (s) { return s.custom; }).length + 1), name: def.name, agent: def.agent, purpose: def.purpose || "", custom: true, project: projectId });
      }
      state.projects.forEach(function (x) { if (!x.flow.stations[def.id]) x.flow.stations[def.id] = { enabled: false, wip: 5, absent: true }; });
      if (p) {
        p.flow.stations[def.id] = { enabled: true, wip: def.wip || 5 };
        var at = p.flow.order.indexOf(afterId);
        p.flow.order = p.flow.order.filter(function (x) { return x !== def.id; });
        p.flow.order.splice(at < 0 ? p.flow.order.length - 1 : at + 1, 0, def.id);
      }
      return G.STATIONS.find(function (s) { return s.id === def.id; });
    },
    addGate: function (state, def, projectId) {
      if (!G.GATES.some(function (g) { return g.id === def.id; })) G.GATES.push({ id: def.id, label: def.label || def.id, name: def.name, after: def.after, kind: def.kind || "human", purpose: def.purpose || "", checks: def.checks || [], custom: true, project: projectId });
      state.projects.forEach(function (x) {
        if (!x.flow.gates[def.id]) x.flow.gates[def.id] = { enabled: false, mode: def.kind || "human", absent: true };
        if (!x.approvers[def.id]) x.approvers[def.id] = { roles: def.roles || ["line_lead", "project_admin"], people: [], required: def.required || 1, sod: true, conditions: [], escalateH: 24, fallback: null };
      });
      var p = state.projects.find(function (x) { return x.id === projectId; });
      if (p) { p.flow.gates[def.id] = { enabled: true, mode: def.kind || "human" }; if (def.roles) p.approvers[def.id].roles = def.roles.slice(); }
      return G.GATES.find(function (g) { return g.id === def.id; });
    },
    addBay: function (state, def, projectId) {
      if (!G.BAYS.some(function (b) { return b.id === def.id; })) G.BAYS.push({ id: def.id, name: def.name, desc: def.desc || "", custom: true, project: projectId });
      var p = state.projects.find(function (x) { return x.id === projectId; });
      if (p && p.flow.bays.indexOf(def.id) < 0) p.flow.bays.push(def.id);
      return G.BAYS.find(function (b) { return b.id === def.id; });
    },
    /* def: { id, name, skips[], priority, slaH, est, token (e.g. "cls-security"), shape ("bar"|"arrow"|"wide"), hints[], gates[] } */
    addClass: function (state, def, projectId) {
      var c = Object.assign({ skips: [], priority: "P2", slaH: 72, est: "M", token: "cls-chore", shape: "bar", hints: [], gates: [], enabled: true }, clone(def), { custom: true, project: projectId });
      if (!G.CLASSES.some(function (x) { return x.id === c.id; })) G.CLASSES.push(c);
      var p = state.projects.find(function (x) { return x.id === projectId; });
      if (p) { p.flow.classes = p.flow.classes.filter(function (x) { return x.id !== c.id; }); p.flow.classes.push(clone(c)); }
      return c;
    },
    /* def: { id, name, level: "factory"|"project", base: roleId } */
    addRole: function (state, def) {
      if (!G.ROLES.some(function (r) { return r.id === def.id; })) G.ROLES.push({ id: def.id, name: def.name, level: def.level || "project", custom: true, base: def.base || null, desc: def.desc || "" });
      if (!state.matrix[def.id]) state.matrix[def.id] = clone(state.matrix[def.base] || state.matrix.viewer);
      return G.ROLES.find(function (r) { return r.id === def.id; });
    },
    addAction: function (state, def) {
      if (!G.ACTIONS.some(function (a) { return a.id === def.id; })) G.ACTIONS.push(def);
      Object.keys(state.matrix).forEach(function (r) { if (state.matrix[r][def.id] == null) state.matrix[r][def.id] = r === "factory_admin"; });
    }
  };

  /* ---------- round-three seed ---------- */
  G.seedRound3 = function (state, r, now) {
    G._seedState = state;
    function between(a, b) { return a + r() * (b - a); }
    function person(id) { return state.people.find(function (p) { return p.id === id; }); }

    /* people and teams */
    [["mobile", "Mobile", "Android, iOS and shared mobile code."], ["partners", "Partners", "Partner-facing APIs and integrations."], ["internal", "Internal Tools", "Back-office and admin tooling."]].forEach(function (t) { state.teams.push({ id: t[0], name: t[1], desc: t[2] }); });
    function P(id, name, title, teams, roles, extra) { state.people.push(Object.assign({ id: id, name: name, title: title, email: id.slice(2) + "@acme.dev", teams: teams, roles: roles, status: "active", oncall: false, github: id.slice(2) + "-acme", away: null }, extra || {})); }
    P("p-hana", "Hana Sato", "Engineering Lead, Mobile", ["mobile"], [{ role: "project_admin", scope: "mobile" }, { role: "line_lead", scope: "mobile" }]);
    P("p-diego", "Diego Alvarez", "Engineering Manager, Data", ["data"], [{ role: "project_admin", scope: "data-platform" }]);
    P("p-ines", "Ines Moreau", "Engineering Lead, Internal Tools", ["internal"], [{ role: "project_admin", scope: "internal-tools" }, { role: "line_lead", scope: "internal-tools" }]);
    P("p-kwame", "Kwame Mensah", "Engineering Lead, Partners", ["partners"], [{ role: "project_admin", scope: "partner-api" }, { role: "line_lead", scope: "partner-api" }], { oncall: true });
    P("p-sofia", "Sofia Rossi", "Senior Engineer, Search", ["platform", "growth"], [{ role: "project_admin", scope: "search" }, { role: "line_lead", scope: "growth-experiments" }, { role: "reviewer", scope: "search" }]);
    function grant(pid, role, scope) { var p = person(pid); if (p && !p.roles.some(function (g) { return g.role === role && g.scope === scope; })) p.roles.push({ role: role, scope: scope }); }
    ["mobile", "data-platform", "partner-api", "growth-experiments", "internal-tools"].forEach(function (pr) { grant("p-kenji", "release_manager", pr); });
    grant("p-priya", "reviewer", "data-platform"); grant("p-fatima", "reviewer", "growth-experiments"); grant("p-arjun", "engineer", "growth-experiments");
    grant("p-chloe", "reviewer", "mobile"); grant("p-rui", "engineer", "internal-tools"); grant("p-grace", "approver", "partner-api"); grant("p-nikhil", "reviewer", "data-platform");
    grant("p-lena", "reviewer", "search"); grant("p-meera", "reviewer", "partner-api"); grant("p-diego", "line_lead", "data-platform"); grant("p-hana", "reviewer", "internal-tools");

    /* projects */
    var T = {}; state.templates.forEach(function (t) { T[t.id] = t; });
    function mkProject(id, name, key, status, teams, owner, tpl, opts) {
      opts = opts || {};
      var t = T[tpl];
      state.projects.push(Object.assign({ id: id, name: name, key: key, status: status, teams: teams, owner: owner, template: tpl, regulated: t.approverPreset === "strict", desc: opts.desc || "",
        flow: G.flowFrom(t), approvers: G.approversPreset(t.approverPreset), notifications: G.routesPreset(t.notify), mcp: t.mcp.slice(),
        budget: { monthly: opts.budget || 2000, mtd: opts.mtd || 600, alertAt: 0.8 }, created: now - (opts.ageD || 60) * DAY, halted: null, killed: null, overlay: opts.overlay || "" }, opts.extra || {}));
    }
    mkProject("mobile", "Mobile Apps", "MOB", "active", ["mobile"], "p-hana", "tpl-web", { desc: "Android app and shared mobile modules.", budget: 3500, mtd: 1980, ageD: 110 });
    mkProject("data-platform", "Data Platform", "DAT", "active", ["data"], "p-diego", "tpl-data", { desc: "Ingestion pipelines and warehouse models.", budget: 3000, mtd: 2710, ageD: 95 });
    mkProject("search", "Search", "SRC", "onboarding", ["platform"], "p-sofia", "tpl-backend", { desc: "Query service and ranking. One repo still onboarding.", budget: 1800, mtd: 340, ageD: 12 });
    mkProject("internal-tools", "Internal Tools", "INT", "active", ["internal"], "p-ines", "tpl-web", { desc: "Admin console and support tooling.", budget: 1200, mtd: 410, ageD: 200 });
    mkProject("partner-api", "Partner API", "PAR", "active", ["partners"], "p-kwame", "tpl-lib", { desc: "Public partner gateway and SDK surface.", budget: 2500, mtd: 1460, ageD: 150 });
    mkProject("growth-experiments", "Growth Experiments", "GRX", "active", ["growth"], "p-sofia", "tpl-web", { desc: "A/B tests and the experiments SDK.", budget: 1500, mtd: 920, ageD: 70 });
    mkProject("legacy-checkout", "Legacy Checkout", "LCK", "archived", ["payments"], "p-daniel", "tpl-backend", { desc: "Old checkout service; archived after migration to Payments Platform.", budget: 0, mtd: 0, ageD: 400 });
    mkProject("docs-portal", "Docs Portal", "DOC", "archived", ["platform"], "p-lena", "tpl-blank", { desc: "Previous docs portal; replaced by the wiki.", budget: 0, mtd: 0, ageD: 300 });

    /* repos */
    function repo(id, project, team, tags, lang, stage) {
      var rp = { id: id, name: "acme/" + id, project: project, team: team, tags: tags, lang: lang, halted: null,
        config: { defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", tagging: "semver-patch", requiredChecks: ["ci/test", "ci/lint"], protectedPaths: ["infra/prod/**", ".github/workflows/**"] },
        mcp: [], notifyOverrides: [], triggers: true, guidelines: "# AGENTS.md\n- Run the test command before opening a PR.",
        onboarding: { stage: stage, findings: [], pr: null, timeline: [{ at: now - 30 * DAY, who: "p-asha", text: "Connected through the GitHub app." }], exception: null, startedAt: now - 30 * DAY } };
      G.assessRepo(rp, r);
      if (stage !== "connected") rp.onboarding.timeline.push({ at: now - 29 * DAY, who: "ag-onboard", text: "Assessment finished." });
      if (["pr_opened", "pr_checks", "pr_merged", "verified", "ready"].indexOf(stage) >= 0) { G.makeOnboardingPR(rp, 200 + Math.floor(r() * 300)); rp.onboarding.timeline.push({ at: now - 28 * DAY, who: "ag-onboard", text: "Opened PR #" + rp.onboarding.pr.number + "." }); }
      if (stage === "ready") { rp.onboarding.pr.state = "merged"; rp.onboarding.pr.checks = "green"; rp.onboarding.readyAt = now - 25 * DAY; rp.onboarding.timeline.push({ at: now - 25 * DAY, who: "ag-onboard", text: "Ready." }); }
      if (stage === "pr_opened") rp.onboarding.pr.checks = "pending";
      state.repos.push(rp);
    }
    repo("mobile-android", "mobile", "mobile", [], "Kotlin", "ready"); repo("mobile-shared", "mobile", "mobile", [], "TypeScript", "ready");
    repo("ingest-pipeline", "data-platform", "data", [], "Python", "ready"); repo("warehouse-models", "data-platform", "data", [], "Python", "ready");
    repo("search-api", "search", "platform", [], "Go", "ready"); repo("query-service", "search", "platform", [], "Go", "pr_opened");
    repo("admin-console", "internal-tools", "internal", [], "TypeScript", "ready");
    repo("partner-gateway", "partner-api", "partners", ["critical"], "Go", "ready"); repo("partner-sdk", "partner-api", "partners", [], "TypeScript", "ready");
    repo("experiments-sdk", "growth-experiments", "growth", [], "TypeScript", "ready");
    repo("checkout-legacy", "legacy-checkout", "payments", [], "Go", "ready"); repo("docs-portal-web", "docs-portal", "platform", [], "TypeScript", "ready");

    /* custom catalogue entries on Risk & Compliance */
    var risk = state.projects.find(function (p) { return p.id === "risk"; });
    state.agents.push({ id: "ag-compliance", name: "Compliance reviewer", station: "compliance", model: "bedrock-claude-sonnet-5-5", fallbacks: [], version: "1.0.0", status: "active", autonomy: "suggest",
      tools: { readRepo: true, writeBranch: false, runTests: false, openPR: false, merge: false, postSlack: true, sendEmail: true, readSecrets: false }, skills: ["sk-security"], mcp: ["mcp-issues"], stations: ["compliance"], projects: ["risk"],
      budget: 1.5, guardrails: { paths: [], maxDiff: 0 }, suite: "SUITE-COMPLIANCE", instructions: "Check the change against the model risk policy and the KYC retention rules. Write a compliance note and flag anything that needs the compliance officer.", overrides: {},
      versions: [{ v: "1.0.0", at: now - 20 * DAY, note: "First release", diff: "First release", suiteScore: 0.9, live: true, rc: false, snapshot: null }], spark: [0.88, 0.9, 0.86, 0.91, 0.9, 0.92, 0.9], spend7d: 22, evalScore: 0.9, initials: "CR" });
    state.suites.push({ id: "SUITE-COMPLIANCE", name: "Compliance reviewer golden set", station: "compliance", threshold: 0.85, agent: "ag-compliance", cases: [{ id: "COM-01", name: "Model threshold change" }, { id: "COM-02", name: "PII retention" }, { id: "COM-03", name: "Benign refactor" }] });
    state.scorecards["ag-compliance"] = { taskSuccess: 0.9, firstPass: 0.86, testPass: 0.95, rework: 0.06, costPerWO: 0.6, minutesPerStation: 14, gateRejections: 1, overrideRate: 0.04, trend: { success: [0.84, 0.86, 0.85, 0.88, 0.87, 0.89, 0.9, 0.9], cost: [0.7, 0.7, 0.66, 0.65, 0.64, 0.62, 0.6, 0.6] } };
    G.catalog.addRole(state, { id: "compliance_officer", name: "Compliance Officer", level: "project", base: "approver", desc: "Signs off compliance gates on regulated projects." });
    grant("p-grace", "compliance_officer", "risk");
    G.catalog.addStation(state, { id: "compliance", name: "Compliance review", agent: "ag-compliance", purpose: "Check the change against model risk and data retention policy before close." }, "risk", "review");
    G.catalog.addGate(state, { id: "GC", label: "GC", name: "Compliance sign-off", after: "compliance", kind: "human", purpose: "A Compliance Officer signs off before release.", roles: ["compliance_officer"] }, "risk");
    G.catalog.addBay(state, { id: "legal", name: "Legal hold", desc: "Waiting for legal review" }, "risk");
    G.catalog.addClass(state, { id: "model-change", name: "Model change", skips: ["research", "design"], priority: "P2", slaH: 96, est: "M", token: "cls-epic", shape: "wide", hints: ["model", "retrain", "threshold", "drift"] }, "risk");

    /* integration catalogue and instances (mirrors round-two integrations) */
    state.integrationTypes = G.INTEGRATION_TYPES;
    state.integrationTypes.push({ id: "statuspage", name: "Status page (custom)", category: "custom", icon: "page", auth: "token", payload: "json", builtIn: false, custom: true, destination: true, source: false, targetLabel: "Component",
      fields: [F("url", "API base URL", "url"), F("pageId", "Page id"), F("token", "API token", "secret")], events: ["kill", "restore", "andon", "released"], actions: ["post_incident", "resolve_incident"], createdBy: "p-asha", createdAt: now - 9 * DAY });
    function I(id, type, name, config, mask, status, projects, extra) { return Object.assign({ id: id, type: type, name: name, config: config, secretMask: mask, status: status, connected: status !== "offline", projects: projects || "all", lastSync: now - between(2, 60) * MIN, createdBy: "p-asha", createdAt: now - between(10, 200) * DAY }, extra || {}); }
    state.integrationInstances = [
      I("int-gh-cloud", "github", "GitHub (acme)", { org: "acme", host: "https://github.com", appId: "214773" }, "-----BEGIN ••••", "healthy"),
      I("int-gh-ent", "github", "GitHub Enterprise (internal)", { org: "acme-internal", host: "https://ghe.acme.internal", appId: "18" }, "-----BEGIN ••••", "healthy", ["internal-tools", "partner-api"]),
      I("int-gl", "gitlab", "GitLab (mobile)", { host: "https://gitlab.com", group: "acme-mobile" }, "glpat-••••7a1", "healthy", ["mobile"]),
      I("int-slack-eng", "slack", "Slack · acme-eng", { workspace: "acme-eng", approve: true }, "xoxb-••••9f2", "healthy"),
      I("int-slack-partners", "slack", "Slack · acme-partners", { workspace: "acme-partners", approve: false }, "xoxb-••••c11", "healthy", ["partner-api"]),
      I("int-teams", "teams", "Microsoft Teams", { tenant: "acme.onmicrosoft.com", clientId: "c0ffee-11" }, "••••b2", "healthy"),
      I("int-email", "email", "Email · gantry@acme.dev", { from: "gantry@acme.dev", smtpHost: "smtp.acme.dev", smtpUser: "gantry" }, "••••", "healthy"),
      I("int-hook-siem", "webhook", "SIEM webhook", { url: "https://siem.acme.dev/hooks/gantry", format: "json" }, "whsec_••••91a", "healthy", "all", { targetId: "siem" }),
      I("int-hook-jira", "webhook", "Jira bridge webhook", { url: "https://jira-bridge.acme.dev/gantry", format: "json" }, "whsec_••••c03", "failing", "all", { targetId: "jira-sync" }),
      I("int-paging", "paging", "On-call paging", { service: "gantry", schedules: "payments-oncall, platform-oncall, factory-oncall" }, "rk_••••44", "healthy"),
      I("int-jira", "jira", "Jira · acme.atlassian.net", { site: "https://acme.atlassian.net", email: "gantry@acme.dev" }, "ATATT••••e9", "healthy"),
      I("int-linear", "linear", "Linear · growth", { workspace: "acme-growth" }, "lin_api_••••", "offline", ["growth-experiments"]),
      I("int-ci", "ci", "CI runners", { url: "https://ci.acme.dev" }, "ci_••••3d", "healthy"),
      I("int-status", "statuspage", "Status page", { url: "https://api.status.acme.dev", pageId: "acme" }, "sp_••••8e", "healthy", "all")
    ];
    /* repos each source-control instance can still offer for connection (the old github.available list moves to the cloud app) */
    var legacyAvail = ((state.integrations.github || {}).available || []).slice();
    var inst = function (id) { return state.integrationInstances.find(function (x) { return x.id === id; }); };
    inst("int-gh-cloud").available = legacyAvail.filter(function (a) { return !state.repos.some(function (rp) { return rp.name === a.repo; }); });
    inst("int-gh-ent").available = [{ repo: "acme-internal/support-macros", lang: "TypeScript" }, { repo: "acme-internal/partner-reports", lang: "Python" }];
    inst("int-gl").available = [{ repo: "acme-mobile/ios-app", lang: "Swift" }, { repo: "acme-mobile/design-tokens", lang: "TypeScript" }];
    /* every repo records the source instance it was connected through */
    state.repos.forEach(function (rp) {
      var own = state.integrationInstances.filter(function (i) { return ["github", "gitlab", "bitbucket"].indexOf(i.type) >= 0 && (i.projects === "all" || i.projects.indexOf(rp.project) >= 0); });
      own.sort(function (a, b) { return (a.projects === "all" ? 1 : 0) - (b.projects === "all" ? 1 : 0); });
      rp.source = own[0] ? own[0].id : "int-gh-cloud";
    });
    state.triggers.forEach(function (t) { t.source = t.type === "schedule" ? "schedule" : t.type === "ci" ? "int-ci" : "int-gh-cloud"; });
    state.triggers.push({ id: "TR-6", project: "mobile", type: "issue", name: "Jira issues labelled gantry", enabled: true, source: "int-jira", label: "gantry", labelMap: { bug: "bug", story: "feature" }, who: "org", reply: "Gantry picked this up as {wo}.", dedupe: true, repos: "ready", runs: [] });
    state.cardTemplates = [];

    /* live work orders on the new projects plus 7 days of finished history everywhere */
    var live = [
      ["mobile", "mobile-android", "feature", 5, "running", "Offline mode for the order history screen", "p-hana"],
      ["mobile", "mobile-shared", "bug", 6, "running", "Fix duplicate push token registration", "p-hana"],
      ["mobile", "mobile-android", "chore", 2, "running", "Upgrade Kotlin to 2.1", "p-hana"],
      ["data-platform", "ingest-pipeline", "feature", 4, "waiting", "Late-arriving events window for card ingest", "p-diego"],
      ["data-platform", "warehouse-models", "refactor", 5, "parked", "Split the merchant dimension model", "p-diego", { bay: "queue" }],
      ["data-platform", "warehouse-models", "bug", 7, "waiting", "Fix double counting in daily GMV", "p-priya"],
      ["search", "search-api", "feature", 2, "running", "Synonym support for product search", "p-sofia"],
      ["internal-tools", "admin-console", "feature", 7, "waiting", "Bulk refund tool for support", "p-ines"],
      ["internal-tools", "admin-console", "docs", 1, "running", "Runbook for the support console", "p-rui"],
      ["partner-api", "partner-gateway", "security", 7, "waiting", "Rotate partner HMAC secrets without downtime", "p-kwame"],
      ["partner-api", "partner-sdk", "feature", 1, "running", "Webhook retry headers in the SDK", "p-kwame"],
      ["growth-experiments", "experiments-sdk", "feature", 3, "waiting", "Holdout groups for experiments", "p-sofia"],
      ["growth-experiments", "experiments-sdk", "bug", 5, "running", "Fix sticky bucketing across devices", "p-arjun"],
      ["risk", "risk-models", "model-change", 9, "waiting", "Retrain chargeback model with October data", "p-priya"]
    ];
    var histTitles = {
      payments: ["Refund webhook signature check", "Add currency to payout CSV", "Fix flaky settlement test", "Bump grpc to 1.66", "Document refund states", "Retry card network timeouts"],
      storefront: ["Fix PDP image layout shift", "Add wishlist count badge", "Bump React Router", "Fix coupon rounding in cart", "Copy update on shipping page"],
      risk: ["Add feature for merchant age", "Fix KYC expiry timezone", "Bump pandas to 2.2", "Drift alert threshold tweak"],
      mobile: ["Fix dark mode contrast on receipts", "Add biometric login toggle", "Bump Compose BOM", "Fix crash on empty cart"],
      "data-platform": ["Backfill refunds table", "Fix null merchant ids in ingest", "Add partition pruning to GMV model", "Bump dbt to 1.8"],
      "internal-tools": ["Add audit link to refund screen", "Fix pagination in user search", "Docs for console roles"],
      "partner-api": ["Fix 429 header casing", "Add idempotency to partner refunds", "Bump Go to 1.25", "Document webhook retries"],
      "growth-experiments": ["Fix exposure logging batch", "Add experiment owner field", "Bump TypeScript to 5.6"],
      "legacy-checkout": ["Disable legacy checkout route", "Final data export"],
      search: ["Bootstrap search-api CI"]
    };
    var clsByTitle = function (t) { return /^fix|flaky|crash|double|null/i.test(t) ? "bug" : /^bump/i.test(t) ? "chore" : /^doc|copy|runbook|final/i.test(t) ? "docs" : /retry|idempot|signature|rotate/i.test(t) ? "security" : "feature"; };
    var hist = [];
    Object.keys(histTitles).forEach(function (pid) {
      var reposOf = state.repos.filter(function (x) { return x.project === pid && x.onboarding.stage === "ready"; });
      histTitles[pid].forEach(function (title, i) {
        var cls = clsByTitle(title);
        if (cls === "security" && pid !== "payments" && pid !== "partner-api") cls = "feature";
        var ago = pid === "legacy-checkout" ? 160 + i * 4 : 10 + ((i * 29 + pid.length * 7) % 150);
        var extra = { agoH: ago };
        if (pid === "payments" && i === 0) extra.rejectAt = "G2", extra.rejectReason = "Missing rollback note";
        if (pid === "payments" && i === 5) extra.rejectAt = "G2", extra.rejectReason = "Missing rollback note";
        if (pid === "storefront" && i === 3) extra.outcome = { kind: "revert", at: now - (ago - 14) * HOUR, text: "Reverted: coupon rounding broke totals for 3-decimal currencies. Follow-up opened.", severity: "medium" };
        if (pid === "payments" && i === 3) extra.sendback = ["build", "plan", "Builder edited .github/workflows/ci.yml outside the plan"];
        if (pid === "data-platform" && i === 1) extra.outcome = { kind: "incident", at: now - (ago - 10) * HOUR, text: "Incident: ingest lag of 40 minutes after release; resolved by scaling the consumer.", severity: "low" };
        if (pid === "mobile" && i === 3) extra.sendback = ["review", "build", "Missing test for the empty-cart branch"];
        hist.push([pid, reposOf[i % reposOf.length].id, cls, 8, "done", title, (state.people.find(function (p) { return p.roles.some(function (g) { return g.scope === pid && (g.role === "engineer" || g.role === "line_lead" || g.role === "project_admin"); }); }) || { id: "p-meera" }).id, extra]);
      });
    });
    G.seedWorkOrders(state, r, now, live.concat(hist));
    /* classification overrides as learning evidence */
    ["WO-2402", "WO-2412"].forEach(function (id, i) { var w = state.workOrders.find(function (x) { return x.id === id; }); if (w) w.clsOverridden = { by: i ? "p-chloe" : "p-meera", at: w.createdAt + 30 * MIN, from: "feature", reason: i ? "It is a regression, not new work" : "Broken behaviour, should be a bug" }; });
    /* one brief changed after confirmation */
    var bv = state.workOrders.find(function (w) { return w.title === "Expose settlement status in /v2/charges"; });

    state.workOrders.forEach(function (w) {
      G.lc.sync(w);
      if (w.state === "done" && w.pr && !w.pr.mergedAt) { w.pr.mergedAt = w.doneAt - 50 * MIN; w.pr.state = "merged"; w.pr.mergeStrategy = w.pr.mergeStrategy || "squash"; }
    });
    if (bv && bv.briefVersions.length) {
      var b2 = JSON.parse(JSON.stringify(bv.briefVersions[0].brief));
      b2.ac = (b2.ac || []).concat(["Settlement status is cached for at most 60 seconds"]);
      b2.scopeOut = (b2.scopeOut || []).concat(["Historical settlements before 2024"]);
      bv.briefVersions.push({ v: 2, at: bv.briefVersions[0].at + 3 * HOUR, by: "p-meera", note: "Added a caching criterion after the spec review", brief: b2 });
      bv.brief = b2;
    }

    /* ---------- trust ladder ---------- */
    state.trust = {
      sampleRate: 5,
      criteria: { 2: { cleanRuns: 6, evalMin: 0.85, reworkMax: 0.15, incidentsMax: 0, windowD: 14 }, 3: { cleanRuns: 15, evalMin: 0.9, reworkMax: 0.1, incidentsMax: 0, windowD: 30 }, 4: { cleanRuns: 40, evalMin: 0.93, reworkMax: 0.06, incidentsMax: 0, windowD: 60 } },
      ceilings: [
        { id: "CEIL-1", text: "Regulated projects are capped at L2", when: { regulated: true }, max: 2, enabled: true },
        { id: "CEIL-2", text: "Security fixes never run above L1", when: { cls: "security" }, max: 1, enabled: true },
        { id: "CEIL-3", text: "Hotfixes are capped at L2", when: { cls: "hotfix" }, max: 2, enabled: true },
        { id: "CEIL-4", text: "Release confirmation (G6) is capped at L3 on Payments Platform", when: { project: "payments", gate: "G6" }, max: 3, enabled: true }
      ],
      cells: [], proposals: [], nextProposal: 1, seededAt: now
    };
    var gateAgents = ["ag-spec", "ag-design", "ag-plan", "ag-review", "ag-close"];
    var seedLevels = { chore: 3, docs: 3, bug: 2, refactor: 2, feature: 1, hotfix: 1, security: 1, epic: 1, spike: 2, "model-change": 1 };
    state.projects.forEach(function (p) {
      if (p.status === "archived" || p.status === "new") return;
      G.classesOf(p).forEach(function (c) {
        gateAgents.forEach(function (ag, gi) {
          var lvl = seedLevels[c.id] != null ? seedLevels[c.id] : 1;
          if (p.id === "storefront" && c.id === "feature") lvl = 2;
          if (p.id === "search") lvl = 1;
          if (ag === "ag-close" && lvl > 2) lvl = 2;
          if (p.regulated) lvl = Math.min(lvl, 2);
          var cell = { id: G.trustCellId(ag, c.id, p.id), agent: ag, cls: c.id, project: p.id, repo: null, level: lvl, since: now - (10 + gi * 3) * DAY, cleanRuns: lvl * 6 + Math.floor(r() * 6), history: [{ at: now - 60 * DAY, from: null, to: 1, by: "system", kind: "seed", reason: "Default for new cells" }] };
          if (lvl > 1) cell.history.push({ at: cell.since, from: lvl - 1, to: lvl, by: p.owner, kind: "grant", reason: "Promotion proposal approved: criteria met for L" + lvl });
          state.trust.cells.push(cell);
        });
      });
    });
    var repoCell = { id: G.trustCellId("ag-review", "chore", "payments", "payments-api"), agent: "ag-review", cls: "chore", project: "payments", repo: "payments-api", level: 2, since: now - 4 * DAY, cleanRuns: 9,
      history: [{ at: now - 30 * DAY, from: null, to: 3, by: "p-daniel", kind: "grant", reason: "Repo cell split from project" }, { at: now - 4 * DAY, from: 3, to: 2, by: "system", kind: "demote", reason: "Guardrail breach: dependency bump touched .github/workflows/ci.yml", cause: { type: "guardrail" } }] };
    state.trust.cells.push(repoCell);
    var sfFeat = state.trust.cells.find(function (c) { return c.id === G.trustCellId("ag-review", "feature", "storefront"); });
    if (sfFeat) { sfFeat.level = 1; sfFeat.history.push({ at: now - 2 * DAY, from: 2, to: 1, by: "system", kind: "demote", reason: "Post-release revert on a storefront change", cause: { type: "revert" } }); }
    function propose(cellId, to, ago, status, by, reason) {
      var c = state.trust.cells.find(function (x) { return x.id === cellId; }); if (!c) return;
      state.trust.proposals.push({ id: "TP-" + (state.trust.nextProposal++), cell: cellId, from: c.level, to: to, at: now - ago * HOUR, status: status, by: by || null, decidedAt: status === "pending" ? null : now - (ago - 3) * HOUR, reason: reason || "", evidence: { cleanRuns: c.cleanRuns, evalScore: (state.agents.find(function (a) { return a.id === c.agent; }) || {}).evalScore, note: "Met the L" + to + " criteria with no incidents in the window." }, savedPerWeek: +(between(1.5, 6)).toFixed(1) });
    }
    propose(G.trustCellId("ag-review", "bug", "payments"), 3, 20, "pending");
    propose(G.trustCellId("ag-spec", "chore", "storefront"), 4, 8, "pending");
    propose(G.trustCellId("ag-plan", "bug", "mobile"), 3, 30, "pending");
    propose(G.trustCellId("ag-review", "feature", "data-platform"), 2, 70, "declined", "p-diego", "Wait until the GMV double counting is fixed.");
    /* trust annotations on gate decisions: recent decisions in L3 cells passed under trust */
    state.workOrders.forEach(function (w) {
      Object.keys(w.gates).forEach(function (k) {
        var gs = w.gates[k]; if (!gs.decision || k === "G0G1") return;
        var lv = G.trust.levelFor(w, k, state);
        gs.decision.trust = lv.effective;
        var g = G.gateDef(k);
        var guard = w.guardrail && (w.guardrail.over || (w.guardrail.protectedTouched || []).length);
        if (gs.decision.mode === "human" && g.kind !== "auto" && w.state === "done" && lv.effective >= 3 && k !== "G6" && !gs.rejections.length && !guard) {
          var was = gs.approvals[0];
          gs.decision = { mode: "trust", trust: lv.effective, at: Math.round(gs.waitingSince + 2000), reason: "L" + lv.effective + " " + G.trust.level(lv.effective).name + ": passed within guardrails" };
          gs.approvals = [];
          /* the traveler log must agree with the decision record */
          (w.log || []).forEach(function (l) { if (was && l.who === was.by && l.text.indexOf("Approved " + g.label + " ") === 0) { l.who = "system"; l.at = gs.decision.at; l.text = g.label + " " + g.name + " passed under trust: " + gs.decision.reason + "."; } });
        }
      });
    });

    /* the G3+G3s "Protected paths untouched" check must agree with the plan: a planned touch shows as a flagged
       check that a person approved (trust never passes it; see the guardrail rule) */
    state.workOrders.forEach(function (w) {
      var prot = (w.files || []).filter(function (f) { return f.protected; }).map(function (f) { return f.path; });
      var gs = w.gates.G3G3s; if (!prot.length || !gs || !gs.checks) return;
      gs.checks.forEach(function (c) { if (/Protected paths/.test(c.name)) { c.ok = false; c.warn = true; c.note = "Plan touches " + prot.join(", ") + (gs.status === "passed" ? "; " + (gs.approvals[0] ? G.actorName ? (state.people.find(function (p) { return p.id === gs.approvals[0].by; }) || { name: gs.approvals[0].by }).name : gs.approvals[0].by : "a person") + " approved the exception" : "; needs a person") + "."; } });
    });
    /* a seeded killed work order (cancelled by a work-order kill switch; its PR is a draft) */
    (function () {
      var w = state.workOrders.find(function (x) { return x.project === "growth-experiments" && x.title === "Fix sticky bucketing across devices"; });
      if (!w) return;
      var at = Math.round(now - 5 * HOUR), cur = w.history[w.history.length - 1];
      if (cur.startedAt > at) cur.startedAt = at - 30 * MIN;
      cur.endedAt = at; cur.outcome = "killed";
      w.killed = { by: "p-sofia", at: at, reason: "Duplicate of the SDK rewrite; stop before it burns more build time", scope: "workorder", prev: { state: w.state, station: w.station, bay: null, bayFrom: null } };
      w.state = "killed"; w.slot = null; w.progress = 0;
      if (w.pr && w.pr.state === "open") { w.pr.state = "draft"; w.log.push({ at: at, who: "p-sofia", text: "PR #" + w.pr.number + " converted to draft by the kill switch." }); }
      w.log.push({ at: at, who: "p-sofia", text: "Killed (workorder): " + w.killed.reason });
      state.audit.push({ id: 0, at: at, actor: "p-sofia", action: "kill.workorder", target: w.id + " · cancel · 1 work orders, 1 running agents: " + w.killed.reason, where: w.project, project: w.project, category: "kill", outcome: "ok", via: "web", before: null, after: null, entity: { type: "wo", id: w.id } });
    })();

    /* ---------- learning loop ---------- */
    var sg = G.learning.signals(state);
    function ev(sig, pred) { return sg.filter(function (x) { return x.signal === sig && (!pred || pred(x)); }).map(function (x) { return x.wo; }).filter(function (v, i, a) { return a.indexOf(v) === i; }); }
    var spec = state.skills.find(function (s) { return s.id === "sk-spec"; });
    state.learning = {
      findings: [
        { id: "F-1", title: "Specs keep missing a rollback note", signal: "rejection", agent: "ag-spec", project: "payments", evidence: ev("rejection", function (x) { return /rollback/i.test(x.text); }), count: 0, firstAt: now - 6 * DAY, lastAt: now - 1 * DAY, status: "open" },
        { id: "F-2", title: "Classifier calls regressions features", signal: "override", agent: "ag-classifier", project: null, evidence: ev("override"), count: 0, firstAt: now - 5 * DAY, lastAt: now - 2 * DAY, status: "open" },
        { id: "F-3", title: "Rounding changes get reverted after release", signal: "revert", agent: "ag-build", project: "storefront", evidence: ev("revert"), count: 0, firstAt: now - 4 * DAY, lastAt: now - 3 * DAY, status: "open" },
        { id: "F-4", title: "Intake rarely gets test data up front", signal: "miss", agent: "ag-intake", project: null, evidence: ev("miss", function (x) { return /test data/i.test(x.text); }).slice(0, 12), count: 0, firstAt: now - 7 * DAY, lastAt: now - 3 * HOUR, status: "open" },
        { id: "F-5", title: "Builder edits workflow files outside the plan", signal: "sendback", agent: "ag-build", project: "payments", evidence: ev("sendback", function (x) { return /workflow/i.test(x.text); }), count: 0, firstAt: now - 5 * DAY, lastAt: now - 5 * DAY, status: "addressed" },
        { id: "F-6", title: "Ingest changes cause consumer lag", signal: "incident", agent: "ag-plan", project: "data-platform", evidence: ev("incident"), count: 0, firstAt: now - 6 * DAY, lastAt: now - 6 * DAY, status: "open" }
      ],
      proposals: [
        { id: "LP-1", finding: "F-1", kind: "skill", title: "Spec writing: always include a rollback section", owner: "p-meera", status: "proposed", at: now - 20 * HOUR, expected: "Fewer G2 rejections for missing rollback notes (2 in the last 7 days).",
          change: { skill: "sk-spec", before: spec ? spec.body : "", after: (spec ? spec.body : "") + " Always add a Rollback section: how to undo the change and what data it leaves behind." }, history: [{ at: now - 20 * HOUR, by: "system", text: "Drafted from finding F-1" }] },
        { id: "LP-2", finding: "F-2", kind: "eval", title: "Add classifier eval case: regression reported as new work", owner: "p-meera", status: "proposed", at: now - 30 * HOUR, expected: "Catches feature/bug confusion before promotion.",
          change: { suite: "SUITE-CLASSIFIER", case: { name: "Regression described as a new feature" } }, history: [{ at: now - 30 * HOUR, by: "system", text: "Drafted from finding F-2" }] },
        { id: "LP-3", finding: "F-3", kind: "guideline", title: "Onboarding guideline: currency rounding needs property tests", owner: "p-chloe", status: "accepted", at: now - 50 * HOUR, expected: "Rounding regressions caught at Verify.",
          change: { project: "storefront", item: { text: "Money and rounding code needs property-based tests across currencies.", required: true } }, history: [{ at: now - 50 * HOUR, by: "system", text: "Drafted from finding F-3" }, { at: now - 40 * HOUR, by: "p-chloe", text: "Accepted" }] },
        { id: "LP-4", finding: "F-5", kind: "guardrail", title: "Builder guardrail: never touch .github/workflows/**", owner: "p-daniel", status: "verified", at: now - 5 * DAY, expected: "No more workflow edits outside the plan.",
          change: { agent: "ag-build", path: ".github/workflows/**" }, history: [{ at: now - 5 * DAY, by: "system", text: "Drafted from finding F-5" }, { at: now - 5 * DAY + 2 * HOUR, by: "p-daniel", text: "Accepted and applied" }, { at: now - 2 * DAY, by: "system", text: "Verified: SUITE-BUILD case 'Respects forbidden paths' passes" }] },
        { id: "LP-5", finding: "F-6", kind: "approver", title: "Data Platform G3+G3s: ingest changes need a second approver", owner: "p-diego", status: "declined", at: now - 4 * DAY, expected: "Slower plans, fewer lag incidents.", reason: "One incident is not enough; revisit if it repeats.",
          change: { project: "data-platform", gate: "G3G3s", condition: { when: { type: "path", value: "ingest/" }, needs: { roles: ["reviewer"], people: [], oncall: false }, text: "Ingest changes need a Reviewer" } }, history: [{ at: now - 4 * DAY, by: "system", text: "Drafted from finding F-6" }, { at: now - 3 * DAY, by: "p-diego", text: "Declined: one incident is not enough" }] },
        { id: "LP-6", finding: "F-4", kind: "route", title: "Docs on Storefront skip Plan", owner: "p-chloe", status: "proposed", at: now - 10 * HOUR, expected: "Docs work reaches Build a station earlier.",
          change: { project: "storefront", cls: "docs", addSkip: "plan" }, history: [{ at: now - 10 * HOUR, by: "system", text: "Drafted from finding F-4" }] }
      ],
      next: { finding: 7, proposal: 7 }
    };
    state.learning.findings.forEach(function (f) { f.count = f.evidence.length; });

    /* ---------- event log: derived from history plus seeded halts and kills ---------- */
    var events = [];
    function E(at, type, o) { events.push(Object.assign({ at: at, type: type }, o)); }
    state.workOrders.forEach(function (w) {
      E(w.createdAt, "wo.submit", { project: w.project, wo: w.id, repo: w.repo, by: w.requestedBy, text: w.title });
      w.history.forEach(function (e) { E(e.startedAt, "wo.enter", { project: w.project, wo: w.id, station: e.station, by: e.agent }); });
      Object.keys(w.gates).forEach(function (k) { var d = w.gates[k].decision; if (d && w.gates[k].status === "passed") E(d.at, d.mode === "trust" ? "trust.auto" : "gate.decision", { project: w.project, wo: w.id, gate: k, by: d.by || null, mode: d.mode, trust: d.trust }); });
      if (w.bay && w.bayAt) E(w.bayAt, "wo.bay", { project: w.project, wo: w.id, bay: w.bay, text: w.bayReason });
      if (w.doneAt) E(w.doneAt, w.pr && w.pr.tag ? "release" : "wo.done", { project: w.project, wo: w.id, text: w.pr && w.pr.tag ? w.pr.tag : "" });
    });
    E(now - 3 * DAY, "halt", { scope: "repo", project: "payments", repo: "payouts-worker", by: "p-meera", text: "Payout batches duplicated in staging" });
    E(now - 3 * DAY + 40 * MIN, "resume", { scope: "repo", project: "payments", repo: "payouts-worker", by: "p-meera" });
    E(now - 5 * DAY, "kill", { scope: "project", project: "storefront", by: "p-daniel", text: "Runaway Builder loop on web-storefront", mode: "hold" });
    E(now - 5 * DAY + 55 * MIN, "restore", { scope: "project", project: "storefront", by: "p-daniel", text: "Loop fixed by Builder 2.6.1" });
    E(now - 2 * DAY, "halt", { scope: "project", project: "data-platform", by: "p-diego", text: "Warehouse load paused for maintenance" });
    E(now - 2 * DAY + 90 * MIN, "resume", { scope: "project", project: "data-platform", by: "p-diego" });
    state.trust.cells.forEach(function (c) { c.history.forEach(function (h) { if (h.kind !== "seed" && h.at > now - 7 * DAY) E(h.at, "trust.change", { project: c.project, cell: c.id, from: h.from, to: h.to, by: h.by, text: h.reason }); }); });
    state.workOrders.forEach(function (w) {
      var last = w.history[w.history.length - 1];
      if ((w.state === "failed" || w.state === "blocked") && last) E(Math.round(Math.min(now - 2 * MIN, last.startedAt + 12 * MIN)), "wo.state", { project: w.project, wo: w.id, from: "running", to: w.state, station: last.station, text: w.failReason || w.blockReason || "" });
      if (w.killed && w.killed.scope === "workorder") { E(w.killed.at, "wo.state", { project: w.project, wo: w.id, from: w.killed.prev.state, to: "killed", station: last && last.station }); E(w.killed.at, "kill", { scope: "workorder", project: w.project, wo: w.id, by: w.killed.by, text: w.killed.reason, mode: "cancel" }); }
      if (w.bay && w.bayAt) { var be = events.find(function (e) { return e.type === "wo.bay" && e.wo === w.id; }); if (be) { be.from = null; be.station = (G.STATIONS[w.station] || {}).id; } }
    });
    events.sort(function (a, b) { return a.at - b.at; });
    events.forEach(function (e, i) { e.id = i + 1; });
    state.events = events;
    state.nextEvent = events.length + 1;
    G.trackStates(state);

    /* audit entries for the round-three catalogue, trust and learning history (so those topic filters have content) */
    function A(at, actor, action, target, project, category, outcome, extra) { state.audit.push(Object.assign({ id: 0, at: Math.round(at), actor: actor, action: action, target: target, where: project || "factory", project: project || null, category: category, outcome: outcome || "ok", via: actor === "system" ? "agent" : "web", before: null, after: null, entity: null }, extra || {})); }
    A(now - 21 * DAY, "p-asha", "role.add", "Compliance Officer (from Approver)", null, "access", "ok", { entity: { type: "role", id: "compliance_officer" } });
    A(now - 20 * DAY, "p-asha", "station.add", "Risk & Compliance: Compliance review after Review and merge", "risk", "config", "ok", { entity: { type: "station", id: "compliance" } });
    A(now - 20 * DAY + 5 * MIN, "p-asha", "gate.add", "Risk & Compliance: GC Compliance sign-off after Compliance review", "risk", "config", "ok", { entity: { type: "gate", id: "GC" } });
    A(now - 20 * DAY + 9 * MIN, "p-asha", "bay.add", "Risk & Compliance: Legal hold", "risk", "config", "ok", { entity: { type: "bay", id: "legal" } });
    A(now - 19 * DAY, "p-asha", "class.add", "Risk & Compliance: Model change", "risk", "config", "ok", { entity: { type: "class", id: "model-change" } });
    A(now - 9 * DAY, "p-asha", "integration.type", "Status page (custom) (custom)", null, "integrations", "ok", { entity: { type: "integrationType", id: "statuspage" } });
    A(now - 9 * DAY + 20 * MIN, "p-asha", "integration.add", "Status page (Status page (custom))", null, "integrations", "ok", { entity: { type: "integration", id: "int-status" } });
    A(now - 6 * DAY, "p-asha", "integration.add", "Slack · acme-partners (Slack)", null, "integrations", "ok", { entity: { type: "integration", id: "int-slack-partners" } });
    A(now - 4 * DAY, "system", "trust.demote", repoCell.id + " L3 → L2: Guardrail breach: dependency bump touched .github/workflows/ci.yml", "payments", "agents", "warn", { before: "L3", after: "L2", entity: { type: "trust", id: repoCell.id } });
    if (sfFeat) A(now - 2 * DAY, "system", "trust.demote", sfFeat.id + " L2 → L1: Post-release revert on a storefront change", "storefront", "agents", "warn", { before: "L2", after: "L1", entity: { type: "trust", id: sfFeat.id } });
    state.trust.proposals.forEach(function (x) {
      var c = state.trust.cells.find(function (y) { return y.id === x.cell; }); if (!c) return;
      A(x.at, "system", "trust.propose", x.cell + " L" + x.from + " → L" + x.to, c.project, "agents", "ok", { entity: { type: "trust", id: x.cell } });
      if (x.status === "declined") A(x.decidedAt, x.by, "trust.proposal", x.id + " declined: " + x.reason, c.project, "agents", "ok", { before: "L" + x.from, after: "L" + x.from, entity: { type: "trust", id: x.cell } });
    });
    state.trust.cells.filter(function (c) { return c.history.some(function (h) { return h.kind === "grant" && h.at > now - 14 * DAY; }); }).slice(0, 4).forEach(function (c) {
      var g = c.history.filter(function (h) { return h.kind === "grant"; }).pop();
      A(g.at, g.by, "trust.grant", c.id + ": L" + g.from + " → L" + g.to + " (" + g.reason + ")", c.project, "agents", "ok", { before: "L" + g.from, after: "L" + g.to, entity: { type: "trust", id: c.id } });
    });
    A(now - 12 * DAY, "p-asha", "trust.ceiling", "CEIL-4: Release confirmation (G6) is capped at L3 on Payments Platform", null, "agents", "ok", { entity: { type: "ceiling", id: "CEIL-4" } });
    state.learning.proposals.forEach(function (lp) {
      lp.history.forEach(function (hh) {
        if (hh.by === "system" && /^Drafted/.test(hh.text)) A(hh.at, "system", "learning.draft", lp.id + " " + lp.title, lp.change && lp.change.project, "agents", "ok", { entity: { type: "learning", id: lp.id } });
        else if (/^Accepted/.test(hh.text)) A(hh.at, hh.by, "learning.apply", lp.id + " " + lp.title, lp.change && lp.change.project, "agents", "ok", { entity: { type: "learning", id: lp.id } });
        else if (/^Declined/.test(hh.text)) A(hh.at, hh.by, "learning.decline", lp.id + " " + lp.title + ": " + (lp.reason || ""), lp.change && lp.change.project, "agents", "ok", { entity: { type: "learning", id: lp.id } });
        else if (/^Verified/.test(hh.text)) A(hh.at, hh.by, "learning.verify", lp.id + " " + lp.title, lp.change && lp.change.project, "agents", "ok", { entity: { type: "learning", id: lp.id } });
      });
    });
    state.audit.sort(function (x, y) { return x.at - y.at; });
    state.audit.forEach(function (e, i) { e.id = i + 1; });
    state.nextAudit = state.audit.length + 1;
    delete G._seedState;
  };
})(window.G);
