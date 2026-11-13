/* Flow model: routes per work class, gates between stations, classification,
   the scripted intake conversation and brief, plus seeding of work orders, evals and audit. */
(function (G) {
  "use strict";
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;

  G.stationIndex = function (id) { return G.STATIONS.findIndex(function (s) { return s.id === id; }); };
  G.gateAfter = function (stationId) { return G.GATES.find(function (g) { return g.after === stationId; }) || null; };
  G.gateDef = function (id) { return G.GATES.find(function (g) { return g.id === id; }); };
  G.bayDef = function (id) { return G.BAYS.find(function (b) { return b.id === id; }); };
  G.classOf = function (project, clsId) {
    var list = (project && project.flow && project.flow.classes) || G.CLASSES;
    return list.find(function (c) { return c.id === clsId; }) || G.CLASSES.find(function (c) { return c.id === clsId; }) || G.CLASSES[0];
  };

  /* ---------- flow definition API (use these instead of iterating the fixed catalogue) ---------- */
  G.stationDef = function (id) { return G.STATIONS.find(function (s) { return s.id === id; }) || null; };
  G.stationOf = function (wo) { return G.STATIONS[wo.station]; };
  /* project flow as ordered definitions: { stations: [def + {enabled, wip, index}], active: [...enabled], gates: [def + {enabled, mode, kind}], bays: [def], classes: [...] } */
  G.flowOf = function (project) {
    var f = project && project.flow;
    var order = (f && f.order) || G.STATIONS.filter(function (s) { return !s.custom; }).map(function (s) { return s.id; });
    var stations = order.map(function (id) {
      var d = G.stationDef(id); if (!d) return null;
      var cfg = (f && f.stations[id]) || { enabled: true, wip: 5 };
      return Object.assign({}, d, { enabled: id === "intake" ? true : !!cfg.enabled, wip: cfg.wip, index: G.stationIndex(id) });
    }).filter(Boolean);
    var gates = [];
    stations.forEach(function (st) {
      var g = G.gateAfter(st.id); if (!g) return;
      var cfg = (f && f.gates[g.id]) || { enabled: true, mode: g.kind };
      gates.push(Object.assign({}, g, { enabled: g.id === "G0G1" ? true : !!cfg.enabled && st.enabled, mode: cfg.mode || g.kind }));
    });
    var bayIds = (f && f.bays) || G.BAYS.filter(function (b) { return !b.custom; }).map(function (b) { return b.id; });
    var bays = bayIds.map(function (id) { return G.bayDef(id); }).filter(Boolean);
    return { stations: stations, active: stations.filter(function (s) { return s.enabled; }), gates: gates, bays: bays, classes: G.classesOf(project) };
  };
  G.classesOf = function (project) {
    var list = (project && project.flow && project.flow.classes) || G.CLASSES.filter(function (c) { return !c.custom; });
    return list.filter(function (c) { return c.enabled !== false; });
  };

  /* Ordered station ids a class travels in a project (follows project.flow.order and station toggles). */
  G.route = function (project, clsId) {
    var c = G.classOf(project, clsId);
    var order = (project && project.flow && project.flow.order) || G.STATIONS.filter(function (s) { return !s.custom; }).map(function (s) { return s.id; });
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var sid = order[i];
      var cfg = project && project.flow && project.flow.stations[sid];
      var on = sid === "intake" || !project || !project.flow || (cfg && cfg.enabled && !cfg.absent);
      if (on && c.skips.indexOf(sid) < 0) out.push(sid);
      if (c.endsAfter && sid === c.endsAfter) break;
    }
    return out;
  };
  /* Gates a class must pass, in order. */
  G.routeGates = function (project, clsId) {
    var c = G.classOf(project, clsId);
    return G.route(project, clsId).map(function (sid) {
      var g = G.gateAfter(sid);
      if (!g) return null;
      var cfg = project && project.flow && project.flow.gates[g.id];
      if (project && project.flow && (!cfg || cfg.absent || (!cfg.enabled && g.id !== "G0G1"))) return null;
      if (g.id === "G6" && c.endsAfter) return null;
      if (c.gates && c.gates.length && g.id !== "G0G1" && c.gates.indexOf(g.id) < 0 && g.kind !== "auto") return null;
      return g.id;
    }).filter(Boolean);
  };
  G.nextStationId = function (project, wo) {
    var r = G.route(project, wo.cls);
    var cur = G.STATIONS[wo.station].id;
    var i = r.indexOf(cur);
    return i >= 0 && i < r.length - 1 ? r[i + 1] : null;
  };
  G.gateForWO = function (project, wo) {
    var cur = G.STATIONS[wo.station].id;
    var g = G.gateAfter(cur);
    if (!g) return null;
    return G.routeGates(project, wo.cls).indexOf(g.id) >= 0 ? g : null;
  };

  /* ---------- classification (local keyword model) ---------- */
  var KW = [
    ["hotfix", /\b(outage|prod(uction)? (is )?down|sev ?1|hotfix|main is red|urgent|p0)\b/i, "mentions an outage or urgent production fix"],
    ["security", /\b(cve|vulnerab|xss|injection|secret|auth(z|orization)? (gap|bypass)|patch .* parser)\b/i, "mentions a vulnerability or security fix"],
    ["spike", /\b(investigate|spike|explore|evaluate|research|feasibility)\b/i, "asks a question rather than a change"],
    ["epic", /\b(epic|centre|center|redesign|overhaul|migrate all|new service|multi-)\b/i, "is large enough to split into several work orders"],
    ["docs", /\b(docs?|readme|runbook|documentation)\b/i, "only changes documentation"],
    ["chore", /\b(bump|upgrade|dependency|dependencies|renovate|pin|tag all)\b/i, "is routine maintenance or a dependency change"],
    ["refactor", /\b(refactor|clean ?up|extract|rename|restructure)\b/i, "restructures code without changing behaviour"],
    ["bug", /\b(fix|bug|error|crash|broken|wrong|regression|incorrect|fails?)\b/i, "describes broken behaviour"],
    ["feature", /\b(add|support|new|expose|show|enable|allow)\b/i, "adds new behaviour"]
  ];
  G.classify = function (text, requested, project) {
    /* project classes with classifier hints win when a hint word matches */
    var custom = project ? G.classesOf(project).filter(function (c) { return c.hints && c.hints.length; }) : [];
    var ch = custom.find(function (c) { return c.hints.some(function (w) { return new RegExp("\\b" + String(w).replace(/[^a-z0-9 -]/gi, "") + "\\b", "i").test(text); }); });
    if (ch) return { cls: ch.id, confidence: 0.88, rationale: "The request matches classifier hints for " + ch.name + " (" + ch.hints.join(", ") + ").", alternatives: [] };
    var hits = KW.filter(function (k) { return k[1].test(text); });
    var top = hits[0] || ["feature", null, "has no strong signal; defaulting to Feature"];
    var conf = hits.length === 0 ? 0.52 : hits.length === 1 ? 0.91 : Math.max(0.6, 0.86 - (hits.length - 2) * 0.07);
    var rationale = "The request " + top[2] + ".";
    if (hits.length > 1) rationale += " Also matched " + hits.slice(1, 3).map(function (h) { return G.CLASSES.find(function (c) { return c.id === h[0]; }).name; }).join(", ") + ".";
    var out = { cls: top[0], confidence: +conf.toFixed(2), rationale: rationale, alternatives: hits.slice(1, 3).map(function (h) { return h[0]; }) };
    if (requested && requested !== top[0]) out.rationale += " Submitter requested " + ((G.CLASSES.find(function (c) { return c.id === requested; }) || { name: requested }).name) + ".";
    return out;
  };

  /* ---------- intake conversation ---------- */
  function misses(wo) {
    var d = (wo.title + " " + wo.description).toLowerCase(), out = [];
    if (["hotfix", "feature", "refactor", "epic", "security"].indexOf(wo.cls) >= 0 && !/rollback|revert|flag/.test(d)) out.push({ id: "rollback", text: "No rollback plan", resolved: false });
    if (["feature", "epic"].indexOf(wo.cls) >= 0 && !/v\d|version|release/.test(d)) out.push({ id: "version", text: "Unclear target version", resolved: false });
    if (["spike", "docs"].indexOf(wo.cls) < 0 && !/test/.test(d)) out.push({ id: "testdata", text: "Missing test data or test strategy", resolved: false });
    if (wo.cls === "bug" && !/repro|steps/.test(d)) out.push({ id: "repro", text: "No reproduction steps", resolved: false });
    return out;
  }
  var AC = {
    feature: ["New behaviour covered by tests", "Metric and alert added", "Both of those"],
    bug: ["Regression test fails before and passes after", "Error rate back to baseline", "Both of those"],
    hotfix: ["Error rate back to baseline within 30 min", "Regression test added", "Both of those"],
    security: ["Vulnerability no longer reproducible", "Scanner shows clean", "Both of those"],
    epic: ["Each child has its own acceptance criteria", "Feature flag controls rollout"],
    chore: ["Build and tests green on the new version", "No API changes"],
    refactor: ["Behaviour identical, all tests green", "Benchmark within 5%"],
    docs: ["Reviewed by the owning team", "Linked from the README"],
    spike: ["A one-page report answers the question", "Report includes a recommendation"]
  };
  G.convQuestions = function (wo) {
    var repo = wo.repo;
    var qs = [];
    if (wo.cls === "spike") qs.push({ id: "question", field: "scope", text: "What question should the report answer?", chips: ["Is it feasible on our stack?", "What would it cost to run?", "Which option should we pick?"] });
    else qs.push({ id: "scope", field: "scope", text: "I read this as: " + wo.title + ". What is in scope?", chips: ["Only " + repo, repo + " and its direct clients", "Suggest a scope for me"] });
    qs.push({ id: "ac", field: "ac", text: "How will we know it is done?", chips: AC[wo.cls] || AC.feature });
    wo.conv.misses.forEach(function (m) {
      if (m.id === "rollback") qs.push({ id: "rollback", field: "rollback", text: "I could not find a rollback plan. How do we undo this if it goes wrong?", chips: ["Revert the PR", "Turn the feature flag off", "Needs a migration rollback"] });
      if (m.id === "version") qs.push({ id: "version", field: "version", text: "Which release should this land in?", chips: ["Next patch release", "Next minor release", "Internal only, no release"] });
      if (m.id === "testdata") qs.push({ id: "testdata", field: "testdata", text: "What test data can the agents use?", chips: ["Fixtures already in the repo", "Generate synthetic data", "I will attach a sample"] });
      if (m.id === "repro") qs.push({ id: "repro", field: "repro", text: "How do we reproduce it?", chips: ["Steps are in the linked issue", "Happens on every request with JPY", "I will describe them"] });
    });
    if (wo.cls === "epic") qs.push({ id: "children", field: "children", text: "I propose splitting this into 3 child work orders: data model, API, and UI. Create them after Plan?", chips: ["Yes, create all 3", "Only data model and API", "Do not split"] });
    qs.push({ id: "extra", field: "extra", text: "Anything else the factory should know?", chips: ["No, that is everything"] });
    return qs;
  };
  G.startConversation = function (wo, awaiting) {
    wo.conv = { messages: [], qi: 0, answers: {}, misses: [], decisions: [], awaiting: awaiting || "submitter", done: false, raised: [] };
    wo.conv.misses = misses(wo);
    var c = G.CLASSES.find(function (x) { return x.id === wo.cls; });
    wo.conv.messages.push({ from: "ag-classifier", at: wo.createdAt, text: "Classified as " + c.name + " (confidence " + Math.round(wo.clsConfidence * 100) + "%). " + wo.clsRationale });
    var qs = G.convQuestions(wo);
    wo.conv.questions = qs;
    wo.conv.messages.push({ from: "ag-intake", at: wo.createdAt + 1000, text: "Hi, I am the Intake Clerk. A few questions so the brief is complete." + (wo.conv.misses.length ? " I noticed: " + wo.conv.misses.map(function (m) { return m.text.toLowerCase(); }).join("; ") + "." : "") });
    wo.conv.messages.push({ from: "ag-intake", at: wo.createdAt + 2000, text: qs[0].text, qid: qs[0].id, chips: qs[0].chips });
    G.buildBrief(wo);
  };
  G.answerConversation = function (wo, text, by, at) {
    var conv = wo.conv; at = at || Date.now();
    if (conv.raised && conv.raised.length && conv.raised.some(function (x) { return !x.answered; })) {
      var rq = conv.raised.find(function (x) { return !x.answered; });
      rq.answered = true; rq.answer = text;
      conv.messages.push({ from: by, at: at, text: text });
      conv.decisions.push({ text: rq.station + " question: " + text, by: by, at: at });
      conv.messages.push({ from: G.find ? (G.find.station(rq.station) || {}).agent || "ag-intake" : "ag-intake", at: at + 500, text: "Thanks. Returning the work order to " + (G.find && G.find.station(rq.station) ? G.find.station(rq.station).name : rq.station) + "." });
      G.buildBrief(wo);
      return { returned: true };
    }
    if (conv.done) { conv.messages.push({ from: by, at: at, text: text }); return { note: true }; }
    var q = conv.questions[conv.qi];
    conv.messages.push({ from: by, at: at, text: text });
    conv.answers[q.id] = text;
    var m = conv.misses.find(function (x) { return x.id === q.id; });
    if (m) m.resolved = true;
    if (q.id !== "extra" || !/^no\b/i.test(text)) conv.decisions.push({ text: label(q.field) + ": " + text, by: by, at: at });
    conv.qi++;
    if (conv.qi < conv.questions.length) {
      var n = conv.questions[conv.qi];
      conv.messages.push({ from: "ag-intake", at: at + 600, text: n.text, qid: n.id, chips: n.chips });
    } else {
      conv.done = true;
      conv.messages.push({ from: "ag-intake", at: at + 600, text: "The brief is ready. Confirm it to pass G0+G1 and start the route, or decline it to the Declined bay." });
    }
    G.buildBrief(wo);
    return { next: !conv.done };
  };
  function label(f) { return { scope: "Scope", ac: "Acceptance", rollback: "Rollback", version: "Target release", testdata: "Test data", repro: "Reproduction", children: "Split", extra: "Note" }[f] || f; }

  G.buildBrief = function (wo) {
    var a = wo.conv.answers;
    var plist = (G.store && G.store.get) ? G.store.get("projects") : G._projects;
    var project = (plist || []).find(function (p) { return p.id === wo.project; }) || null;
    var route = project ? G.route(project, wo.cls) : [];
    var cls = G.CLASSES.find(function (c) { return c.id === wo.cls; });
    var b = {
      goal: wo.title,
      scopeIn: a.scope ? [a.scope] : a.question ? [a.question] : [],
      scopeOut: wo.cls === "spike" ? ["Code changes"] : ["UI changes unless stated", "Data backfills unless stated"],
      ac: a.ac ? [a.ac] : [],
      risks: wo.conv.misses.filter(function (m) { return !m.resolved; }).map(function (m) { return m.text; }),
      open: wo.conv.done ? [] : wo.conv.questions.slice(wo.conv.qi).map(function (q) { return q.text; }),
      decisions: wo.conv.decisions.map(function (d) { return d.text; }),
      estimate: cls.est + (wo.cls === "epic" ? " (split)" : ""),
      route: route,
      children: wo.cls === "epic" && a.children && !/do not/i.test(a.children) ? (/only/i.test(a.children) ? ["Data model", "API"] : ["Data model", "API", "UI"]) : []
    };
    if (a.rollback) b.risks.push("Rollback: " + a.rollback);
    wo.brief = b;
    return b;
  };

  /* ---------- work order construction (pure on state) ---------- */
  G.buildWO = function (state, o) {
    var project = state.projects.find(function (p) { return p.id === o.project; });
    var id = o.id || "WO-" + (state.nextWO++);
    var c = G.classify(o.title + " " + (o.description || ""), o.requestedCls, project);
    var cls = o.forceCls || (o.requestedCls && c.confidence < 0.8 ? o.requestedCls : c.cls);
    var created = o.createdAt || Date.now();
    var classDef = G.classOf(project, cls);
    var wo = {
      id: id, project: o.project, repo: o.repo, title: o.title, description: o.description || "", attachments: o.attachments || [],
      cls: cls, clsConfidence: c.confidence, clsRationale: c.rationale, clsSuggested: c.cls, clsOverridden: null, requestedCls: o.requestedCls || null,
      priority: o.priority || classDef.priority, source: o.source || "console", requestedBy: o.requestedBy, createdAt: created,
      station: 0, state: "waiting", bay: null, bayReason: "", bayFrom: null, progress: 100, slot: null,
      history: [{ station: "intake", agent: "ag-intake", model: "claude-haiku-5-5", startedAt: created, endedAt: null, tokens: 4200, cost: 0.02, outcome: null, note: "" }],
      gates: {}, log: [{ at: created, who: o.requestedBy, text: "Submitted from " + (o.source || "console") + "." }],
      diff: { plus: 0, minus: 0, files: 0 }, tests: { passed: 0, failed: 0, added: 0 }, pr: null,
      blockReason: null, failReason: null, doneAt: null, killed: null, parent: o.parent || null, children: [], risk: o.risk || (project && project.regulated ? "high" : "normal"),
      paths: o.paths || [], slaDue: created + classDef.slaH * HOUR
    };
    G.routeGates(project, cls).forEach(function (g) { wo.gates[g] = { status: "pending", approvals: [], rejections: [], checks: [] }; });
    wo.gates.G0G1.status = "waiting";
    G.startConversation(wo, o.awaiting);
    return wo;
  };

  /* ---------- seeding ---------- */
  var SEEDS = [
    ["payments", "payments-api", "feature", 0, "waiting", "Add idempotency keys to refund endpoint", "p-tomas", { answers: 2 }],
    ["payments", "payments-api", "bug", 2, "running", "Fix rounding on JPY partial captures", "p-meera"],
    ["payments", "payments-api", "feature", 4, "waiting", "Expose settlement status in /v2/charges", "p-tomas", { paths: ["/payments/settlement"] }],
    ["payments", "ledger-service", "feature", 5, "running", "Emit ledger events for failed payouts", "p-meera"],
    ["payments", "payments-api", "security", 5, "running", "Rate limit card verification attempts", "p-grace"],
    ["payments", "ledger-service", "refactor", 5, "parked", "Extract posting rules into a package", "p-tomas", { bay: "queue" }],
    ["payments", "payouts-worker", "bug", 6, "blocked", "Split payout batches over 10k rows", "p-meera", { id: "WO-2417" }],
    ["payments", "payouts-worker", "hotfix", 7, "waiting", "Retry SEPA timeouts with backoff", "p-tomas"],
    ["payments", "payments-api", "feature", 8, "waiting", "Webhooks for dispute updates", "p-meera"],
    ["payments", "payments-api", "chore", 8, "done", "Bump Go toolchain to 1.25", "p-tomas"],
    ["payments", "payments-api", "feature", 1, "running", "Support partial refunds on Amex", "p-meera"],
    ["payments", "ledger-service", "feature", 3, "waiting", "Ledger export API for finance", "p-meera"],
    ["payments", "payments-api", "feature", 2, "parked", "Multi-currency payout preview", "p-tomas", { bay: "person", question: "Spec Writer: should FX rates come from the treasury service or the card network?" }],
    ["payments", "payouts-worker", "chore", 4, "parked", "Upgrade SEPA client to v4", "p-tomas", { bay: "sechold", reason: "G3s dependency scan: sepa-client 4.0.1 has CVE-2026-1182 (high). Pin 4.0.3 or later." }],
    ["payments", "payments-api", "docs", 8, "done", "Runbook for refund reconciliation", "p-meera"],
    ["storefront", "web-storefront", "feature", 0, "waiting", "Show delivery estimate on product page", "p-arjun", { answers: 0 }],
    ["storefront", "web-storefront", "bug", 5, "running", "Fix cart badge count after logout", "p-arjun"],
    ["storefront", "notifications", "feature", 7, "waiting", "Unsubscribe link in digest emails", "p-chloe"],
    ["storefront", "notifications", "epic", 4, "waiting", "Notification preferences centre", "p-chloe"],
    ["storefront", "web-storefront", "spike", 1, "running", "Evaluate edge rendering for product pages", "p-fatima"],
    ["storefront", "web-storefront", "feature", 0, "parked", "Add crypto checkout", "p-arjun", { bay: "declined", reason: "Out of policy: payments methods are owned by the Payments project and need a compliance review first." }],
    ["storefront", "notifications", "chore", 8, "done", "Batch push sends per tenant", "p-chloe"],
    ["risk", "risk-models", "feature", 2, "waiting", "Add drift alert on chargeback model", "p-priya"],
    ["risk", "kyc-service", "security", 7, "waiting", "Patch XML parser CVE in document upload", "p-grace"],
    ["risk", "risk-models", "feature", 6, "failed", "Backfill merchant risk features for Q3", "p-priya"],
    ["risk", "kyc-service", "bug", 8, "done", "Fix timezone in KYC expiry check", "p-grace"],
    ["risk", "risk-models", "feature", 0, "waiting", "Expose score explanations to analysts", "p-nikhil", { answers: 1, source: "api", awaiting: "api" }]
  ];
  var MODELS = { intake: "claude-haiku-5-5", research: "claude-opus-5-5", spec: "claude-opus-5-5", design: "claude-opus-5-5", plan: "claude-opus-5-5", build: "claude-opus-5-5", verify: "claude-sonnet-5-5", review: "claude-opus-5-5", close: "claude-haiku-5-5" };
  G.seedWorkOrders = function (state, r, now, seeds) {
    function between(a, b) { return a + r() * (b - a); }
    var slotUse = {};
    (seeds || SEEDS).forEach(function (sd, n) {
      var project = state.projects.find(function (p) { return p.id === sd[0]; });
      var extra = sd[7] || {};
      var desc = sd[5] + ". Keep behaviour backwards compatible" + (n % 3 === 0 ? " and add tests" : "") + ".";
      var created = extra.agoH ? now - (extra.agoH + between(0, 2)) * HOUR : now - (sd[4] === "done" ? between(20, 40) : between(2, 30)) * HOUR;
      var id = extra.id || "WO-" + (state.nextWO++);
      if (!extra.id && id === "WO-2417") id = "WO-" + (state.nextWO++);
      var wo = G.buildWO(state, { id: id, project: sd[0], repo: sd[1], title: sd[5], description: desc, forceCls: sd[2], requestedBy: sd[6], source: extra.source || ["console", "slack", "github", "api"][n % 4], createdAt: created, awaiting: extra.awaiting, paths: extra.paths });
      wo.clsConfidence = Math.max(wo.clsConfidence, 0.7);
      var answers = extra.answers != null ? extra.answers : 99;
      var t = created + 3 * MIN;
      for (var i = 0; i < answers && !wo.conv.done; i++) {
        var q = wo.conv.questions[wo.conv.qi];
        G.answerConversation(wo, q.chips[0], sd[6], t); t += 2 * MIN;
      }
      var route = G.route(project, wo.cls);
      var target = G.STATIONS[sd[3]].id;
      if (route.indexOf(target) < 0) target = route[route.length - 1];
      wo.history = [];
      t = created;
      for (var j = 0; j < route.length; j++) {
        var sid = route[j];
        var st = G.STATIONS[G.stationIndex(sid)];
        var dur = (extra.agoH ? between(25, 160) : between(6, 70)) * MIN;
        var open = sid === target && sd[4] !== "done";
        var tokens = Math.round(between(8, 120) * 1000 * (sid === "build" ? 3 : 1));
        var model = MODELS[sid];
        if (project.regulated && sid !== "intake") model = "bedrock-claude-sonnet-5-5";
        wo.history.push({ station: sid, agent: st.agent, model: model, startedAt: t, endedAt: open ? null : t + dur, tokens: tokens, cost: +(tokens / 1e6 * (model.indexOf("haiku") >= 0 ? 2.2 : model.indexOf("sonnet") >= 0 ? 6.6 : 11)).toFixed(2), outcome: open ? null : "passed", note: "" });
        var g = G.gateAfter(sid);
        var waitG = 0;
        if (g && wo.gates[g.id] && !open) {
          wo.gates[g.id].status = "passed";
          wo.gates[g.id].waitingSince = t + dur;
          if (g.kind !== "auto") { waitG = (g.id === "G0G1" ? between(3, 40) : extra.agoH ? between(10, 260) : between(6, 200)) * MIN; wo.gates[g.id].approvals.push({ by: G.seedApprover(state, project, g.id, wo), at: t + dur + waitG, via: ["web", "slack", "web", "teams"][j % 4] }); }
          wo.gates[g.id].checks = g.checks.map(function (c) { return { name: c, ok: true }; });
          if (g.id === "G0G1") wo.gates[g.id].approvals[0].by = sd[6];
          var ap0 = wo.gates[g.id].approvals[0];
          wo.gates[g.id].decision = ap0 ? { mode: "human", by: ap0.by, at: ap0.at, via: ap0.via, trust: null } : { mode: "auto", at: t + dur, trust: null };
        }
        t += open ? 0 : dur + waitG + between(3, 25) * MIN;
        if (sid === target) break;
      }
      wo.station = G.stationIndex(target);
      var cur = wo.history[wo.history.length - 1];
      wo.state = sd[4] === "parked" ? "parked" : sd[4];
      if (sd[4] === "running") { cur.startedAt = now - between(3, 50) * MIN; wo.progress = Math.round(between(10, 85)); }
      if (sd[4] === "waiting") { cur.startedAt = now - between(10, 200) * MIN; wo.progress = 100; var gw = G.gateAfter(target); if (gw && wo.gates[gw.id]) { wo.gates[gw.id].status = "waiting"; wo.gates[gw.id].waitingSince = cur.startedAt + between(3, 9) * MIN; if (target !== "intake") { cur.endedAt = wo.gates[gw.id].waitingSince; cur.outcome = "passed"; } } }
      if (target !== "intake" && wo.gates.G0G1) { wo.gates.G0G1.status = "passed"; if (!wo.gates.G0G1.approvals.length) wo.gates.G0G1.approvals.push({ by: sd[6], at: created + 20 * MIN, via: "web" }); }
      if (sd[4] === "done") { wo.doneAt = t; Object.keys(wo.gates).forEach(function (k) { wo.gates[k].status = "passed"; if (G.gateDef(k).kind !== "auto" && !wo.gates[k].approvals.length) { wo.gates[k].approvals.push({ by: G.seedApprover(state, project, k, wo), at: t - 10 * MIN, via: "web" }); wo.gates[k].waitingSince = t - 40 * MIN; } if (!wo.gates[k].decision) { var a1 = wo.gates[k].approvals[0]; wo.gates[k].decision = a1 ? { mode: "human", by: a1.by, at: a1.at, via: a1.via, trust: null } : { mode: "auto", at: t - 15 * MIN, trust: null }; } }); }
      if (G.stationIndex(target) >= 5 || sd[4] === "done") {
        var plus = Math.round(between(20, 380)), minus = Math.round(between(2, 120));
        wo.diff = { plus: plus, minus: minus, files: Math.max(1, Math.round(plus / 60)) };
        wo.pr = { number: state.nextPR++, branch: "gantry/" + wo.id.toLowerCase(), checks: G.stationIndex(target) >= 7 || sd[4] === "done" ? "green" : "pending", state: sd[4] === "done" || target === "close" ? "merged" : "open", tag: sd[4] === "done" ? "v1." + Math.floor(between(2, 20)) + "." + Math.floor(between(0, 9)) : null };
        wo.tests = { passed: Math.round(between(80, 420)), failed: 0, added: Math.round(between(1, 12)) };
      }
      if (target === "build" && sd[4] === "running") { slotUse[sd[0]] = (slotUse[sd[0]] || 0) + 1; wo.slot = slotUse[sd[0]]; }
      if (extra.bay) {
        wo.bay = extra.bay; wo.bayFrom = target; wo.bayAt = now - between(20, 300) * MIN;
        wo.bayReason = extra.reason || (extra.bay === "queue" ? "Both coding slots are busy." : extra.question ? "Question raised at " + G.STATIONS[wo.station].name : "");
        if (extra.question) {
          wo.conv.raised.push({ station: target, text: extra.question, at: wo.bayAt, answered: false });
          wo.conv.messages.push({ from: G.STATIONS[wo.station].agent, at: wo.bayAt, text: extra.question, chips: ["Treasury service", "Card network rates", "Let's discuss"] });
        }
        if (extra.bay === "sechold") wo.gates.G3G3s.status = "failed", wo.gates.G3G3s.checks = [{ name: "Threat model present", ok: true }, { name: "Dependency scan", ok: false }, { name: "Protected paths untouched", ok: true }];
      }
      if (sd[4] === "blocked") { wo.blockReason = "Verify needs secret SEPA_SANDBOX_KEY; the Test Engineer has no secrets access on payouts-worker."; if (wo.pr) wo.pr.checks = "pending"; }
      if (sd[4] === "failed") { wo.failReason = "Required check 'ci/test' failed: test_backfill_window timed out after 600 s."; wo.tests.failed = 1; if (wo.pr) wo.pr.checks = "red"; }
      wo.log = [{ at: created, who: sd[6], text: "Submitted from " + wo.source + "." }];
      wo.history.forEach(function (h) {
        wo.log.push({ at: h.startedAt, who: h.agent, text: "Entered " + G.STATIONS[G.stationIndex(h.station)].name + "." });
        var gg = G.gateAfter(h.station);
        if (gg && wo.gates[gg.id] && wo.gates[gg.id].approvals.length) wo.log.push({ at: wo.gates[gg.id].approvals[0].at, who: wo.gates[gg.id].approvals[0].by, text: "Approved " + gg.label + " (" + gg.name + ")." });
      });
      if (wo.bay) wo.log.push({ at: wo.bayAt, who: wo.bay === "sechold" ? "ag-sec" : wo.bay === "queue" ? "ag-build" : wo.requestedBy, text: "Moved to " + G.bayDef(wo.bay).name + ": " + wo.bayReason });
      if (wo.cls === "epic") wo.brief.children = ["Data model", "API", "UI"];
      if (sd[4] === "done" && wo.doneAt > now - 20 * MIN) G.shiftWO(wo, wo.doneAt - (now - 20 * MIN) + between(0, 3) * HOUR);
      if (extra.outcome) wo.outcomeOverride = extra.outcome;
      if (extra.sendback) wo.sendbacks = [{ from: extra.sendback[0], to: extra.sendback[1], note: extra.sendback[2], at: created + 3 * HOUR, by: wo.requestedBy }];
      if (extra.rejectAt && wo.gates[extra.rejectAt]) wo.gates[extra.rejectAt].rejections.push({ by: G.seedApprover(state, project, extra.rejectAt, wo), at: created + 2 * HOUR, reason: extra.rejectReason || "Acceptance criteria missing" });
      state.workOrders.push(wo);
    });
  };
  /* move every timestamp of a seeded work order back by ms (keeps history in the past) */
  G.shiftWO = function (wo, ms) {
    wo.createdAt -= ms; if (wo.doneAt) wo.doneAt -= ms; if (wo.bayAt) wo.bayAt -= ms; if (wo.slaDue) wo.slaDue -= ms;
    wo.history.forEach(function (e) { e.startedAt -= ms; if (e.endedAt) e.endedAt -= ms; });
    Object.keys(wo.gates).forEach(function (k) { var g = wo.gates[k]; if (g.waitingSince) g.waitingSince -= ms; g.approvals.forEach(function (a) { a.at -= ms; }); g.rejections.forEach(function (a) { a.at -= ms; }); if (g.decision) g.decision.at -= ms; });
    wo.log.forEach(function (l) { l.at -= ms; });
    if (wo.conv) { wo.conv.messages.forEach(function (m) { m.at -= ms; }); wo.conv.decisions.forEach(function (d) { d.at -= ms; }); }
  };
  G.seedApprover = function (state, project, gateId, wo) {
    var rule = project.approvers[gateId];
    if (!rule || !rule.roles.length) return wo.requestedBy;
    var cands = state.people.filter(function (p) {
      return p.id !== wo.requestedBy && p.roles.some(function (g) { return g.scope === project.id && rule.roles.indexOf(g.role) >= 0; });
    });
    if (!cands.length) return "p-asha";
    var hx = 0, key = wo.id + gateId; for (var i = 0; i < key.length; i++) hx = (hx * 31 + key.charCodeAt(i)) >>> 0;
    return cands[hx % cands.length].id;
  };

  G.seedEvals = function (state, r, now) {
    function between(a, b) { return a + r() * (b - a); }
    var fails = ["Missed an acceptance criterion", "Touched a forbidden path", "Diff exceeded size limit", "Test did not fail on the bug", "Wrong file edited", "Timed out after 15 min", "Hallucinated an API", "Missed the expected finding"];
    var caseBank = {
      "ag-intake": ["Vague one-liner", "Request with no acceptance criteria", "Duplicate of open issue", "Customer escalation", "Hotfix with no rollback", "Epic needing split"],
      "ag-classifier": ["Outage report", "Dependency bump", "Docs typo", "CVE report", "Refactor request", "Ambiguous feature/bug", "Spike question", "Epic"],
      "ag-onboard": ["Go service, no CODEOWNERS", "Monorepo with two CI systems", "Repo with secret in history", "Terraform repo", "Library with no tests", "Repo already ready"]
    };
    var generic = ["Golden task A", "Golden task B", "Edge case: empty input", "Edge case: large diff", "Respects guardrails", "Follows repo conventions", "Cites sources", "Handles failure", "Regression case", "Policy compliance"];
    state.agents.forEach(function (a, idx) {
      var names = caseBank[a.id] || generic;
      var station = a.station || "intake";
      var suite = { id: a.suite, name: a.name + " golden set", station: station, threshold: a.id === "ag-close" ? 0.95 : a.id === "ag-build" ? 0.8 : 0.85, agent: a.id,
        cases: names.map(function (n, i) { return { id: a.suite.replace("SUITE-", "").slice(0, 3) + "-" + String(i + 1).padStart(2, "0"), name: n }; }) };
      state.suites.push(suite);
      var bases = [0.92, 0.9, 0.86, 0.88, 0.82, 0.88, 0.86, 0.9, 0.9, 0.97, 0.9, 0.93];
      a.versions.forEach(function (ver, vi) {
        var reps = vi === a.versions.length - 1 ? 2 : 1;
        var target = ver.rc ? 0.74 : bases[idx] - (a.versions.length - 1 - vi) * 0.03;
        for (var k = 0; k < reps; k++) {
          var results = suite.cases.map(function (c) { var pass = r() < target; return { caseId: c.id, pass: pass, reason: pass ? "" : fails[Math.floor(r() * fails.length)], ms: Math.round(between(20, 600)) * 100 }; });
          /* keep the sample story stable: floor versions pass their suite, candidates (rc) fall short */
          var thr = suite.threshold, nPass = function () { return results.filter(function (x) { return x.pass; }).length / results.length; };
          if (ver.live) for (var q = 0; q < results.length && nPass() < thr + 0.01; q++) { if (!results[q].pass) { results[q].pass = true; results[q].reason = ""; } }
          if (ver.rc) for (var q2 = 0; q2 < results.length && nPass() >= thr - 0.04; q2++) { if (results[q2].pass) { results[q2].pass = false; results[q2].reason = fails[q2 % fails.length]; } }
          var score = results.filter(function (x) { return x.pass; }).length / results.length;
          state.evalRuns.push({ id: "RUN-" + (state.nextRun++), suite: suite.id, agent: a.id, version: ver.v, model: ver.rc ? "claude-sonnet-5-5" : a.model, at: ver.at + k * DAY + between(0, 8) * HOUR, score: score, results: results, by: "p-daniel", cost: +between(2, 30).toFixed(2) });
          ver.suiteScore = score;
        }
      });
      var live = a.versions.find(function (v) { return v.live; });
      a.evalScore = live ? live.suiteScore : 0.85;
      var success = [], cost = [];
      for (var w = 0; w < 8; w++) { success.push(Math.min(0.99, Math.max(0.55, a.evalScore - 0.08 + w * 0.012 + between(-0.025, 0.025)))); cost.push(+((a.budget / 3 + 0.1) * (1.15 - w * 0.02 + between(-0.05, 0.05))).toFixed(2)); }
      if (a.id === "ag-build") success[7] = 0.76;
      state.scorecards[a.id] = { taskSuccess: success[7], firstPass: Math.min(0.98, a.evalScore - between(0.02, 0.12)), testPass: Math.min(0.99, a.evalScore + between(-0.03, 0.06)), rework: between(0.04, 0.2), costPerWO: cost[7], minutesPerStation: Math.round(between(4, 46)), gateRejections: Math.round(between(0, 9)), overrideRate: between(0.02, 0.18), trend: { success: success, cost: cost } };
    });
    state.evalRuns.sort(function (a, b) { return a.at - b.at; });
    var heat = {};
    state.agents.forEach(function (a) { heat[a.id] = {}; state.projects.forEach(function (p) { heat[a.id][p.id] = p.id === "identity" ? null : Math.min(0.99, Math.max(0.55, a.evalScore + between(-0.12, 0.06) - (p.regulated ? 0.04 : 0))); }); });
    var classes = G.CLASSES.map(function (c) { return c.id; });
    var confusion = {};
    classes.forEach(function (t) { confusion[t] = {}; classes.forEach(function (p) { confusion[t][p] = 0; }); });
    classes.forEach(function (t, i) {
      var n = [60, 44, 12, 8, 30, 14, 10, 18, 9][i];
      confusion[t][t] = Math.round(n * between(0.78, 0.95));
      var rest = n - confusion[t][t];
      var alt = { feature: "epic", bug: "hotfix", hotfix: "bug", epic: "feature", chore: "refactor", refactor: "chore", security: "bug", docs: "chore", spike: "feature" }[t];
      confusion[t][alt] += Math.ceil(rest * 0.7); confusion[t][classes[(i + 3) % classes.length]] += Math.floor(rest * 0.3);
    });
    var perClass = {};
    classes.forEach(function (c, i) { perClass[c] = { count: [41, 37, 9, 5, 26, 11, 8, 15, 7][i], success: [0.86, 0.9, 0.83, 0.7, 0.95, 0.88, 0.85, 0.97, 0.92][i], cycleH: [52, 20, 3.5, 210, 9, 30, 11, 6, 18][i], rework: [0.14, 0.09, 0.2, 0.31, 0.04, 0.12, 0.16, 0.03, 0.05][i] }; });
    state.evalExtra = {
      heat: heat, confusion: confusion, perClass: perClass, overrideRate: 0.07,
      onboarding: { attempts: 14, ready: 11, successRate: 11 / 14, medianDays: 2.6, p90Days: 6.1, failedReasons: [["Branch protection needs an org owner", 2], ["CI could not run tests", 1]] },
      gateRejections: [["Acceptance criteria missing", 14], ["Diff touches protected path", 9], ["Missing rollback note", 8], ["Tests do not cover the change", 7], ["Security finding unresolved", 5], ["Out of scope for the brief", 3]],
      humanOverride: { G2: 0.06, G3d: 0.09, G3G3s: 0.11, G5: 0.07, G6: 0.02 }
    };
  };

  G.seedAudit = function (state, now) {
    function a(mins, actor, action, target, project, category, outcome, via, extra) {
      state.audit.push(Object.assign({ id: state.nextAudit++, at: now - mins * MIN, actor: actor, action: action, target: target, where: project || "factory", project: project || null, category: category, outcome: outcome || "ok", via: via || "web", before: null, after: null, entity: null }, extra || {}));
    }
    a(60 * 40, "p-asha", "policy.edit", "POL-103 Identity on-call release", null, "access", "ok", "web", { before: "disabled", after: "enabled" });
    a(60 * 30, "p-asha", "auth.signin", "SSO (Okta) with MFA", null, "auth");
    a(60 * 26, "p-daniel", "agent.promote", "Builder 2.6.1 promoted to floor", null, "agents");
    a(60 * 20, "p-meera", "freeze.create", "FRZ-07 Payout batch cutover", "payments", "access");
    a(60 * 12, "p-daniel", "project.create", "Identity from template Backend service", "identity", "config");
    a(60 * 11, "p-lena", "repo.connect", "acme/auth-gateway", "identity", "onboarding");
    a(60 * 10, "ag-onboard", "onboarding.assess", "acme/auth-gateway: 6 findings", "identity", "onboarding", "ok", "agent");
    a(60 * 9, "p-kenji", "gate.approve", "G6 release confirmed for WO-2407", "payments", "approvals");
    a(60 * 8, "p-tomas", "gate.approve", "G5 on WO-2405", "payments", "approvals", "denied");
    a(60 * 6, "ag-onboard", "onboarding.pr", "acme/mobile-app#412 opened", "storefront", "onboarding", "ok", "agent");
    a(60 * 5, "ag-sec", "gate.check", "G3s failed on Upgrade SEPA client to v4", "payments", "approvals", "failed", "agent");
    a(60 * 4, "p-priya", "gate.approve", "G5 on WO-2406 from Slack", "payments", "approvals", "ok", "slack");
    a(60 * 3, "p-chloe", "approvers.edit", "Storefront G5: required 1", "storefront", "config", "ok", "web", { before: "required 2", after: "required 1" });
    a(150, "p-daniel", "eval.run", "SUITE-BUILD on Builder 2.7.0-rc1", null, "agents", "regression");
    a(95, "ag-test", "check.fail", "Backfill merchant risk features: ci/test", "risk", "flow", "failed", "agent");
    a(60, "unknown@gmail.com", "auth.signin", "SSO: domain not allowed", null, "auth", "denied");
    a(41, "p-meera", "gate.approve", "G3+G3s on Expose settlement status", "payments", "approvals");
    a(30, "key-1", "api.submit", "POST /v1/projects/payments/work-orders", "payments", "api", "ok", "api");
    a(22, "ag-test", "wo.block", "WO-2417 missing secret", "payments", "flow", "blocked", "agent");
    a(12, "TR-1", "trigger.run", "Issue acme/payments-api#951 deduped", "payments", "integrations", "ok", "github");
    a(6, "p-chloe", "notify.edit", "Storefront route NR-1 → #web-gates", "storefront", "integrations", "ok", "web", { before: "#factory-gates", after: "#web-gates" });
    state.audit.sort(function (x, y) { return x.at - y.at; });
    state.audit.forEach(function (e, i) { e.id = i + 1; });
    state.nextAudit = state.audit.length + 1;
  };
})(window.G);
