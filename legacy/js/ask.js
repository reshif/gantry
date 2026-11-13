/* G.ask: one wrapper over the artifact runtime's `sample` capability, plus a shared tool set that
   reads the live store and proposes actions. Nothing executes from a tool: propose_* tools return
   proposal objects that a view renders as a confirm card (G.proposalCard) and runs only on click.

   G.ask(opts) -> Promise<{ ok, mode: "claude"|"local", text, proposals[], cited[], error? }>
     opts: { input | (instructions, data, turns, question), tools: true | [toolDefs], onText(full, delta),
             signal, modelTier, fallback(ctx) -> string | { text, proposals } }
   G.ask.available() -> "checking" | "ready" | "absent" | "not_granted" | "rate_limited"
   G.ask.subscribe(fn(state)) -> unsubscribe
   Call G.ask only from a user action: the first call asks the viewer's consent. */
(function (G) {
  "use strict";
  var h = G.h;
  var state = "checking", until = 0, subs = [], samplePromise = null, sampleFn = null, probes = 0;
  function setState(s) { if (s === state) return; state = s; subs.slice().forEach(function (f) { try { f(s); } catch (e) { console.error(e); } }); }
  function runtime() { var c = window.claude; return c && typeof c.use === "function" ? c : null; }

  /* resolve the sample function; null when the runtime is absent (file://, plain browser) */
  function getSample() {
    if (sampleFn) return Promise.resolve(sampleFn);
    var c = runtime();
    if (!c) return Promise.resolve(null);
    if (!samplePromise) {
      samplePromise = Promise.resolve().then(function () { return c.use("sample"); }).then(function (fn) {
        sampleFn = typeof fn === "function" ? fn : null;
        if (state === "checking" || state === "absent") setState(sampleFn ? "ready" : "absent");
        if (!sampleFn) samplePromise = null;
        return sampleFn;
      }, function () { samplePromise = null; if (state === "checking") setState("absent"); return null; });
    }
    return samplePromise;
  }
  /* availability probe: looks for the runtime without calling sample (no consent prompt) */
  function probe() {
    probes++;
    if (state === "not_granted") return;
    if (runtime()) { getSample(); return; }
    if (probes < 4) setTimeout(probe, probes * 500);
    else {
      if (state === "checking") setState("absent");
      /* the runtime can appear late: keep looking slowly for a minute so the mode indicator stays truthful */
      if (probes < 16) setTimeout(probe, 4000);
    }
  }
  setTimeout(probe, 300);

  function compose(o) {
    var parts = [];
    if (o.instructions) parts.push(o.instructions.trim());
    parts.push("You work inside Gantry, a software factory console. Today is " + G.fmt.stamp(Date.now()) + ". The person asking is " + (G.viewer() ? G.viewer().name + " (" + G.viewer().title + ")" : "signed out") + ".",
      "Use the tools to read live data instead of guessing. Only talk about projects the tools return. To change anything, call a propose_* tool: the person confirms it in the page. Never claim an action happened. Mention work orders by id (WO-1234). Plain sentences, short.");
    if (o.data) parts.push("Data:\n" + (typeof o.data === "string" ? o.data : JSON.stringify(o.data)));
    if (o.turns && o.turns.length) parts.push("Recent conversation:\n" + o.turns.slice(-8).map(function (t) { return (t.role === "user" ? "Person: " : "Gantry: ") + t.text; }).join("\n"));
    if (o.question) parts.push("Question: " + o.question);
    return parts.join("\n\n");
  }

  function localResult(o, ctx, error) {
    var fb = o.fallback ? o.fallback(ctx) : null;
    var text = typeof fb === "string" ? fb : fb && fb.text || "";
    var proposals = (fb && fb.proposals) || ctx.proposals;
    return { ok: !!text, mode: "local", text: text, proposals: proposals, cited: G.ask.entities(text).concat(ctx.cited), error: error || null };
  }

  var busy = 0;
  function ask(o) {
    o = o || {};
    var ctx = G.ask.context();
    if (state === "not_granted" || (state === "rate_limited" && Date.now() < until)) return Promise.resolve(localResult(o, ctx, state));
    if (state === "rate_limited") setState(sampleFn ? "ready" : "checking");
    return getSample().then(function (sample) {
      if (!sample) { if (state === "checking") setState("absent"); return localResult(o, ctx, "absent"); }
      var tools = o.tools === true ? G.askTools.all(ctx) : (o.tools || []).map(function (t) { return typeof t === "string" ? G.askTools.get(t, ctx) : t; }).filter(Boolean);
      var full = "";
      var opts = { cache: false, signal: o.signal, onText: function (ev) {
        var t = ev && typeof ev === "object" ? ev.text : ev; if (typeof t !== "string") return;
        var delta;
        if (t.length >= full.length && t.slice(0, full.length) === full) { delta = t.slice(full.length); full = t; } else { delta = t; full += t; }
        if (o.onText && delta) { try { o.onText(full, delta); } catch (e) { console.error(e); } }
      } };
      if (tools.length) opts.tools = tools;
      if (o.modelTier) opts.modelTier = o.modelTier;
      busy++; G.ask._notifyBusy();
      return Promise.resolve().then(function () { return sample(o.input || compose(o), opts); }).then(function (res) {
        var text = (res && typeof res.text === "string" ? res.text : "") || full;
        setState("ready");
        return { ok: true, mode: "claude", text: text, proposals: ctx.proposals, cited: G.ask.entities(text).concat(ctx.cited) };
      }, function (err) {
        var code = err && (err.code || err.name);
        if (code === "AbortError" || (o.signal && o.signal.aborted)) return { ok: false, mode: "claude", text: full, proposals: ctx.proposals, cited: ctx.cited, error: "aborted" };
        if (code === "not_granted") { setState("not_granted"); return localResult(o, ctx, "not_granted"); }
        if (code === "rate_limited") { until = Date.now() + 45000; setState("rate_limited"); return localResult(o, ctx, "rate_limited"); }
        console.warn("G.ask failed", err);
        return localResult(o, ctx, code || "error");
      }).then(function (r) { busy--; G.ask._notifyBusy(); return r; });
    });
  }
  G.ask = ask;
  G.ask.compose = compose;
  G.ask.available = function () {
    if (state === "absent" && runtime() && !samplePromise) getSample();
    return state === "rate_limited" && Date.now() >= until ? (sampleFn ? "ready" : "checking") : state;
  };
  G.ask.subscribe = function (fn) { subs.push(fn); return function () { subs = subs.filter(function (f) { return f !== fn; }); }; };
  G.ask.busy = function () { return busy > 0; };
  G.ask._notifyBusy = function () { subs.slice().forEach(function (f) { try { f(state); } catch (e) { /* ignore */ } }); };
  G.ask.label = function () { var s = G.ask.available(); return s === "ready" ? "Claude" : s === "checking" ? "Checking" : "Local logic"; };
  G.ask.reason = function () {
    return { ready: "Answers come from Claude using tools over the live factory.", checking: "Looking for the Claude runtime.", absent: "Claude is not available on this page (opened from a file or outside the artifact runtime). Answers use local logic.",
      not_granted: "Claude access was not granted. Answers use local logic.", rate_limited: "Claude is rate limited for a moment. Answers use local logic until it clears." }[G.ask.available()];
  };
  /* a small "Claude" / "Local logic" indicator that updates itself */
  G.ask.badge = function (id) {
    var el = h("span", { class: "ask-badge", id: id || null, role: "status" });
    function paint() { var s = G.ask.available(); el.className = "ask-badge ask-" + s + (G.ask.busy() ? " is-busy" : ""); el.textContent = G.ask.label(); el.title = G.ask.reason(); el.setAttribute("aria-label", "Answer mode: " + G.ask.label() + ". " + G.ask.reason()); }
    paint();
    var un = G.ask.subscribe(function () { if (!el.isConnected && el._seen) { un(); return; } el._seen = el._seen || el.isConnected; paint(); });
    return el;
  };

  /* ids and names mentioned in text -> [{ type, id, label }] */
  G.ask.entities = function (text) {
    var out = [], seen = {};
    function add(type, id, label) { var k = type + ":" + id; if (seen[k]) return; seen[k] = 1; out.push({ type: type, id: id, label: label || id }); }
    var vis = G.viewer() ? G.visibleProjects(G.viewerId()) : [];
    function sees(pid) { return vis.some(function (p) { return p.id === pid; }); }
    String(text || "").replace(/\bWO-\d{3,5}\b/g, function (m) { var w = G.find.wo(m); if (w && sees(w.project)) add("wo", w.id); return m; });
    vis.forEach(function (p) { if (text && text.indexOf(p.name) >= 0) add("project", p.id, p.name); });
    G.store.get("repos").forEach(function (r) { if (vis.some(function (p) { return p.id === r.project; }) && text && new RegExp("\\b" + r.name.replace(/[-]/g, "\\-") + "\\b").test(text)) add("repo", r.id, r.name); });
    return out;
  };
  /* clickable chip for an entity { type: wo|project|repo|agent|gate|person, id, label?, project? }:
     a work order opens its record, a project or gate its floor, a repo its onboarding drawer, an agent or a person
     their screen. Entities in projects the viewer cannot see render as plain text (work orders) or nothing. */
  G.entityChip = function (e) {
    if (!e) return null;
    var vid = G.viewerId();
    function sees(pid) { return !!vid && G.visibleProjects(vid).some(function (p) { return p.id === pid; }); }
    function go(pid, hash) { G.store.update("prefs", function (x) { x.project = pid; }); if (location.hash === "#" + hash && G.rerender) G.rerender(); else location.hash = hash; }
    var icon = { wo: "page", project: "project", repo: "branch", agent: "agent", gate: "gate", person: "people" }[e.type] || "dots";
    function link(href, label, fn) { return h("a", { class: "chip entity-chip entity-" + e.type, href: href, "data-entity": e.type + ":" + e.id, onclick: function (ev) { ev.preventDefault(); fn(); } }, G.icon(icon), h("span", null, label)); }
    function plain(label) { return h("span", { class: "chip entity-chip is-plain", "data-entity": e.type + ":" + e.id }, G.icon(icon), h("span", null, label)); }
    if (e.type === "wo") { var w = G.find.wo(e.id); if (!w || !sees(w.project)) return plain(e.id); return link("#record", e.label && e.label !== e.id ? e.id + " " + e.label : w.id, function () { G.openRecord(w.id); }); }
    if (e.type === "project") { var p = G.find.project(e.id); if (!p || !sees(p.id)) return null; return link("#floor", e.label || p.name, function () { go(p.id, "floor"); }); }
    if (e.type === "repo") { var r = G.find.repo(e.id); if (!r || !sees(r.project)) return null; return link("#onboarding", r.name, function () { G.store.update("prefs", function (x) { x.project = r.project; }); if (G.openOnboardingRepo) G.openOnboardingRepo(r.id); go(r.project, "onboarding"); }); }
    if (e.type === "agent") { var a = G.find.agent(e.id); if (!a) return null; return G.canSeeRoute && G.canSeeRoute("agents") ? link("#agents", a.name, function () { if (G.agentsSelect) G.agentsSelect(a.id); G.store.update("prefs", function (x) { x.agent = a.id; }); location.hash = "agents"; }) : plain(a.name); }
    if (e.type === "gate") { var gd = G.gateDef(e.id), gp = e.project || (G.currentProject() || {}).id; if (!gd || !gp || !sees(gp)) return gd ? plain(gd.label) : null; return link("#floor", e.label || gd.label + " " + gd.name, function () { go(gp, "floor"); setTimeout(function () { if (G.floorOpenGate) G.floorOpenGate(e.id); }, 120); }); }
    if (e.type === "person") { var pe = G.find.person(e.id); if (!pe) return null; return G.canSeeRoute && G.canSeeRoute("people") ? link("#people", pe.name, function () { if (G.peopleSelect) G.peopleSelect(pe.id); location.hash = "people"; }) : plain(pe.name); }
    return null;
  };

  /* per-call context: what the viewer may see, plus collected proposals and citations */
  G.ask.context = function () {
    var vid = G.viewerId();
    var projects = vid ? G.visibleProjects(vid) : [];
    var ids = projects.map(function (p) { return p.id; });
    var person = vid ? G.find.person(vid) : null;
    var factoryWide = !!(person && person.roles.some(function (g) { return g.scope === "factory"; }));
    return { viewer: vid, projects: projects, projectIds: ids, factoryWide: factoryWide, proposals: [], cited: [], nextProposal: 1,
      sees: function (pid) { return ids.indexOf(pid) >= 0; } };
  };

  /* ================= tools ================= */
  function J(x) { return JSON.stringify(x); }
  function gateOf(w) { var g = w.state === "waiting" ? G.gateForWO(G.find.project(w.project), w) : null; return g ? g.id : null; }
  function woBrief(w) { var s = G.stationOf(w); return { id: w.id, title: w.title, project: w.project, repo: (G.find.repo(w.repo) || {}).name, cls: w.cls, priority: w.priority, station: s ? s.name : "", state: w.state, bay: w.bay || null, gate: gateOf(w), createdAt: G.fmt.iso(w.createdAt), doneAt: w.doneAt ? G.fmt.iso(w.doneAt) : null }; }
  function cite(ctx, type, id, label) { if (!ctx.cited.some(function (c) { return c.type === type && c.id === id; })) ctx.cited.push({ type: type, id: id, label: label || id }); }
  function projArg(ctx, p) {
    if (!p) return null;
    var pr = G.find.project(p) || G.store.get("projects").find(function (x) { return x.name.toLowerCase() === String(p).toLowerCase(); });
    return pr && ctx.sees(pr.id) ? pr : false;
  }
  function S(k) { return G.store.get(k); }

  var DEFS = [
    { name: "list_projects", description: "List the projects the person can see with status, open work and halts.", inputSchema: { type: "object", properties: {} },
      run: function (ctx) { return ctx.projects.map(function (p) { var open = S("workOrders").filter(function (w) { return w.project === p.id && ["done", "killed"].indexOf(w.state) < 0; }); return { id: p.id, name: p.name, status: p.status, regulated: !!p.regulated, halted: !!p.halted, killed: !!p.killed, open: open.length, waiting: open.filter(function (w) { return w.state === "waiting"; }).length }; }); } },
    { name: "list_work_orders", description: "Find work orders. Filters: project, state (running|waiting|parked|done|failed|killed), cls, station, query (text in title), since_hours, limit.", inputSchema: { type: "object", properties: { project: { type: "string" }, state: { type: "string" }, cls: { type: "string" }, station: { type: "string" }, query: { type: "string" }, since_hours: { type: "number" }, limit: { type: "number" } } },
      run: function (ctx, i) {
        var p = projArg(ctx, i.project); if (p === false) return { error: "No such project, or not visible to this person." };
        var since = i.since_hours ? Date.now() - i.since_hours * 3600000 : 0;
        var list = S("workOrders").filter(function (w) { return ctx.sees(w.project) && (!p || w.project === p.id) && (!i.state || w.state === i.state) && (!i.cls || w.cls === i.cls) && (!i.station || G.stationOf(w).id === i.station) && (!i.query || w.title.toLowerCase().indexOf(String(i.query).toLowerCase()) >= 0) && (!since || (w.doneAt || w.createdAt) >= since); });
        list.sort(function (a, b) { return (b.doneAt || b.createdAt) - (a.doneAt || a.createdAt); });
        return { total: list.length, workOrders: list.slice(0, Math.min(40, i.limit || 20)).map(woBrief) };
      } },
    { name: "get_work_order", description: "Full record of one work order: request, brief, plan, files changed, tests, review, gate decisions with trust level, outcomes.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: function (ctx, i) {
        var w = G.find.wo(i.id); if (!w || !ctx.sees(w.project)) return { error: "No visible work order " + i.id };
        G.lc.ensure(w); cite(ctx, "wo", w.id);
        return Object.assign(woBrief(w), { summary: G.lc.summaryText(w), request: w.request, criteria: (w.criteria || []).map(function (c) { return { id: c.id, text: c.text, status: c.status }; }), plan: w.plan, files: (w.files || []).map(function (f) { return { path: f.path, status: f.status, plus: f.plus, minus: f.minus, state: f.state }; }),
          gates: Object.keys(w.gates).map(function (k) { var g = w.gates[k]; return { gate: k, status: g.status, decision: g.decision || null, approvals: g.approvals.map(function (a) { return { by: G.actorName(a.by), at: G.fmt.iso(a.at), trust: a.trust }; }), rejections: g.rejections.length }; }),
          pr: w.pr ? { number: w.pr.number, state: w.pr.state, checks: w.pr.checks, tag: w.pr.tag || null } : null, outcomes: w.outcomes || [], sendbacks: w.sendbacks || [], cost: G.woTotals(w).cost });
      } },
    { name: "project_status", description: "Status of one project: flow stations in order, WIP, waiting gates, halts, budget.", inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
      run: function (ctx, i) {
        var p = projArg(ctx, i.project); if (!p) return { error: "No such visible project." };
        cite(ctx, "project", p.id, p.name);
        var f = G.flowOf(p), open = S("workOrders").filter(function (w) { return w.project === p.id && ["done", "killed"].indexOf(w.state) < 0; });
        return { id: p.id, name: p.name, status: p.status, halted: p.halted ? p.halted.reason : null, killed: !!p.killed, budget: p.budget,
          stations: f.active.map(function (s) { return { id: s.id, name: s.name, wip: s.wip, here: open.filter(function (w) { return G.stationOf(w).id === s.id && !w.bay; }).length }; }),
          waiting: open.filter(function (w) { return w.state === "waiting"; }).map(function (w) { var gid = gateOf(w); return { id: w.id, gate: gid, since: gid && w.gates[gid] && w.gates[gid].waitingSince ? G.fmt.ago(w.gates[gid].waitingSince) : null }; }),
          bays: f.bays.map(function (b) { return { id: b.id, name: b.name, count: open.filter(function (w) { return w.bay === b.id; }).length }; }),
          repos: S("repos").filter(function (r) { return r.project === p.id; }).map(function (r) { return { name: r.name, onboarding: r.onboarding.stage, halted: !!r.halted }; }) };
      } },
    { name: "onboarding_state", description: "Onboarding stage and blockers for repos, optionally in one project.", inputSchema: { type: "object", properties: { project: { type: "string" } } },
      run: function (ctx, i) { var p = projArg(ctx, i.project); if (p === false) return { error: "No such visible project." }; return S("repos").filter(function (r) { return ctx.sees(r.project) && (!p || r.project === p.id); }).map(function (r) { return { repo: r.name, project: r.project, stage: r.onboarding.stage, blocker: r.onboarding.blocker || null, pr: r.onboarding.pr ? r.onboarding.pr.number : null }; }); } },
    { name: "who_can", description: "Who may do an action (e.g. gate.approve, kill.project, trust.grant, line.halt) in a project, and why, using the live policy engine.", inputSchema: { type: "object", properties: { action: { type: "string" }, project: { type: "string" }, person: { type: "string" } }, required: ["action"] },
      run: function (ctx, i) {
        var p = projArg(ctx, i.project); if (p === false) return { error: "No such visible project." };
        if (!G.find.action(i.action)) return { error: "Unknown action. Known: " + G.ACTIONS.map(function (a) { return a.id; }).join(", ") };
        /* people in the viewer's projects (or factory-wide roles); nobody known only from another project */
        var people = S("people").filter(function (x) { return x.status === "active" && (ctx.factoryWide || x.roles.some(function (g) { return g.scope === "factory" || ctx.sees(g.scope); })) && (!i.person || x.id === i.person || x.name.toLowerCase().indexOf(String(i.person).toLowerCase()) >= 0); });
        return people.map(function (x) { var d = G.can(x.id, i.action, { project: p ? p.id : undefined, time: Date.now() }); return { person: x.name, allowed: d.allowed, reason: d.reason, needs: d.needs || "" }; }).filter(function (r) { return i.person || r.allowed; }).slice(0, 25);
      } },
    { name: "evals", description: "Agents with live version, eval score, threshold and recent runs.", inputSchema: { type: "object", properties: { agent: { type: "string" } } },
      run: function (ctx, i) { return S("agents").filter(function (a) { return !i.agent || a.id === i.agent || a.name.toLowerCase().indexOf(String(i.agent).toLowerCase()) >= 0; }).map(function (a) { var su = G.find.suite(a.suite); var runs = S("evalRuns").filter(function (r) { return r.agent === a.id; }).slice(-3); return { id: a.id, name: a.name, version: a.version, evalScore: a.evalScore, suite: su ? su.id : null, threshold: su ? su.threshold : null, recent: runs.map(function (r) { return { id: r.id, version: r.version, score: r.score, at: G.fmt.iso(r.at) }; }) }; }); } },
    { name: "workload", description: "Human workload from real history (last 7 days) in the person's projects or one project: approval minutes per person and team, after-hours share, bottlenecks, suggestions.", inputSchema: { type: "object", properties: { project: { type: "string" } } },
      run: function (ctx, i) {
        var p = projArg(ctx, i.project); if (p === false) return { error: "No such visible project." };
        var o = { days: 7, projects: p ? [p.id] : ctx.projectIds };
        var ppl = G.workload.people(o).filter(function (r) { return r.approvals || r.waiting; }).sort(function (a, b) { return b.minutes - a.minutes; }).slice(0, 12).map(function (r) { return Object.assign({}, r, { person: G.actorName(r.person) }); });
        var teams = G.workload.teams(o).map(function (t) { return Object.assign({}, t, { team: (G.find.team(t.team) || { name: t.team }).name }); });
        return { scope: p ? p.name : "your projects", people: ppl, teams: teams, bottlenecks: G.workload.bottlenecks(o).slice(0, 8), suggestions: G.workload.suggestions(o).slice(0, 6).map(function (x) { return x.text; }) };
      } },
    { name: "trust", description: "Trust ladder cells (agent x class x project) with level, ceiling and pending proposals.", inputSchema: { type: "object", properties: { project: { type: "string" }, agent: { type: "string" }, cls: { type: "string" } } },
      run: function (ctx, i) {
        var p = projArg(ctx, i.project); if (p === false) return { error: "No such visible project." };
        var tr = S("trust");
        var cells = tr.cells.filter(function (c) { return ctx.sees(c.project) && (!p || c.project === p.id) && (!i.agent || c.agent === i.agent) && (!i.cls || c.cls === i.cls); });
        return { coverage: p ? G.trust.coverage(p.id) : null, cells: cells.slice(0, 40).map(function (c) { return { id: c.id, level: c.level, cleanRuns: c.cleanRuns, ceiling: G.trust.cellCeiling(c).max }; }),
          proposals: tr.proposals.filter(function (x) { return x.status === "pending" && cells.some(function (c) { return c.id === x.cell; }); }) };
      } },
    { name: "audit_search", description: "Search the audit ledger by text, optionally in one project.", inputSchema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" }, limit: { type: "number" } } },
      run: function (ctx, i) {
        if (!G.me("audit.view").allowed && !G.meAnyProject("audit.view").allowed) return { error: "This person may not read the audit ledger." };
        var p = projArg(ctx, i.project); if (p === false) return { error: "No such visible project." };
        var q = String(i.query || "").toLowerCase();
        var factoryAudit = G.me("audit.view").allowed;
        return S("audit").filter(function (a) { return (a.project ? ctx.sees(a.project) : factoryAudit) && (!p || a.project === p.id) && (!q || (a.action + " " + a.target + " " + G.actorName(a.actor)).toLowerCase().indexOf(q) >= 0); }).slice(-(i.limit || 20)).reverse().map(function (a) { return { id: a.id, at: G.fmt.iso(a.at), actor: G.actorName(a.actor), action: a.action, target: a.target, outcome: a.outcome }; });
      } },
    { name: "events", description: "Factory event log (submissions, station entries, gate decisions, trust auto-passes, releases, halts, kills) for the last N hours.", inputSchema: { type: "object", properties: { project: { type: "string" }, since_hours: { type: "number" }, types: { type: "array", items: { type: "string" } } } },
      run: function (ctx, i) { var p = projArg(ctx, i.project); if (p === false) return { error: "No such visible project." }; var list = G.replay.events({ project: p ? p.id : null, from: Date.now() - (i.since_hours || 24) * 3600000, types: i.types }).filter(function (e) { return e.project ? ctx.sees(e.project) : (ctx.factoryWide || e.scope === "factory"); }); return { total: list.length, events: list.slice(-60).map(function (e) { return { at: G.fmt.iso(e.at), type: e.type, wo: e.wo, project: e.project, gate: e.gate, station: e.station, by: e.by ? G.actorName(e.by) : null, text: e.text }; }) }; } },

    /* ---- propose tools: nothing runs until the person confirms ---- */
    { name: "propose_submit_work_order", description: "Propose a new work order. The person confirms in the page.", inputSchema: { type: "object", properties: { project: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" } }, required: ["project", "repo", "title"] },
      propose: function (ctx, i) { var p = projArg(ctx, i.project); if (!p) return { error: "No such visible project." }; var r = G.find.repo(i.repo); if (!r || r.project !== p.id) return { error: "Repo not in " + p.name };
        return { kind: "submit", title: "Submit work order", summary: i.title + " on " + r.name, op: "submitWO", args: [{ project: p.id, repo: r.id, title: i.title, description: i.description || "", priority: i.priority }], check: G.me("wo.submit", { project: p.id }), entities: [{ type: "project", id: p.id, label: p.name }] }; } },
    { name: "propose_approve_gate", description: "Propose approving the gate a work order is waiting at.", inputSchema: { type: "object", properties: { wo: { type: "string" } }, required: ["wo"] },
      propose: function (ctx, i) { var w = G.find.wo(i.wo); if (!w || !ctx.sees(w.project)) return { error: "No visible work order." }; var gid = gateOf(w); if (!gid) return { error: w.id + " is not waiting at a gate." }; var g = G.gateDef(gid);
        return { kind: "approve", title: "Approve " + g.label, summary: w.id + " " + w.title, op: "approveGate", args: [w.id, "console"], check: G.gateDecision(G.viewerId(), w, g.id), entities: [{ type: "wo", id: w.id }] }; } },
    { name: "propose_halt", description: "Propose halting a repo line or a whole project (stops new work; reversible).", inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["repo", "project"] }, id: { type: "string" }, reason: { type: "string" } }, required: ["scope", "id", "reason"] },
      propose: function (ctx, i) { var t = i.scope === "repo" ? G.find.repo(i.id) : projArg(ctx, i.id); if (!t || (i.scope === "repo" && !ctx.sees(t.project))) return { error: "Nothing visible to halt." }; var pid = i.scope === "repo" ? t.project : t.id;
        return { kind: "halt", title: "Halt " + t.name, summary: i.reason, op: i.scope === "repo" ? "haltRepo" : "haltProject", args: [t.id, i.reason, "console"], check: G.me("line.halt", { project: pid }), entities: [{ type: i.scope, id: t.id, label: t.name }] }; } },
    { name: "propose_kill", description: "Propose a kill switch (factory, project or one work order). Opens the kill dialog, which needs typed confirmation.", inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["factory", "project", "workorder"] }, id: { type: "string" }, reason: { type: "string" } }, required: ["scope", "reason"] },
      propose: function (ctx, i) { var pid = null, label = "the factory";
        if (i.scope === "project") { var p = projArg(ctx, i.id); if (!p) return { error: "No visible project." }; pid = p.id; label = p.name; }
        if (i.scope === "workorder") { var w = G.find.wo(i.id); if (!w || !ctx.sees(w.project)) return { error: "No visible work order." }; pid = w.project; label = w.id; }
        return { kind: "kill", title: "Kill " + label, summary: i.reason, dialog: { name: "killDialog", args: [i.scope, i.id || null] }, check: G.me("kill." + i.scope, { project: pid }), entities: pid ? [{ type: "project", id: pid, label: (G.find.project(pid) || {}).name }] : [] }; } },
    { name: "propose_park", description: "Propose moving a work order to a bay (queue, parked, waiting-on-info and so on) with a reason.", inputSchema: { type: "object", properties: { wo: { type: "string" }, bay: { type: "string" }, reason: { type: "string" } }, required: ["wo", "bay", "reason"] },
      propose: function (ctx, i) { var w = G.find.wo(i.wo); if (!w || !ctx.sees(w.project)) return { error: "No visible work order." }; var mc = G.moveCheck(w, i.bay);
        return { kind: "park", title: "Move " + w.id + " to " + ((G.bayDef(i.bay) || {}).name || i.bay), summary: i.reason, op: "park", args: [w.id, i.bay, i.reason, "console"], check: mc, entities: [{ type: "wo", id: w.id }] }; } },
    { name: "propose_trust_change", description: "Propose changing a trust cell's level (0-4) with a reason. Ceilings still apply.", inputSchema: { type: "object", properties: { cell: { type: "string" }, level: { type: "number" }, reason: { type: "string" } }, required: ["cell", "level", "reason"] },
      propose: function (ctx, i) { var c = G.find.trustCell(i.cell); if (!c || !ctx.sees(c.project)) return { error: "No visible trust cell " + i.cell }; var ceil = G.trust.cellCeiling(c); var d = G.me("trust.grant", { project: c.project });
        if (d.allowed && i.level > ceil.max) d = { allowed: false, reason: "Capped at L" + ceil.max + " by " + ceil.ceilings.map(function (x) { return x.id; }).join(", ") + "." };
        return { kind: "trust", title: "Set " + G.trustCellLabel(c) + " to L" + i.level, summary: i.reason, op: "grantTrust", args: [c.id, i.level, i.reason], check: d, entities: [{ type: "project", id: c.project, label: (G.find.project(c.project) || {}).name }] }; } },
    { name: "propose_onboard_repo", description: "Propose connecting a repo to a project for onboarding.", inputSchema: { type: "object", properties: { project: { type: "string" }, repo: { type: "string" } }, required: ["project", "repo"] },
      propose: function (ctx, i) { var p = projArg(ctx, i.project); if (!p) return { error: "No visible project." };
        return { kind: "onboard", title: "Connect " + i.repo, summary: "Onboard into " + p.name, op: "connectRepo", args: [p.id, i.repo], check: G.me("repo.onboard", { project: p.id }), entities: [{ type: "project", id: p.id, label: p.name }] }; } }
  ];

  function build(def, ctx) {
    return { name: def.name, description: def.description, inputSchema: def.inputSchema, execute: function (input) {
      input = input || {};
      try {
        if (def.run) return J(def.run(ctx, input));
        var p = def.propose(ctx, input);
        if (p.error) return J(p);
        p.id = "PROP-" + (ctx.nextProposal++); p.status = "pending";
        ctx.proposals.push(p);
        return J({ proposed: p.id, title: p.title, allowed: !!(p.check && p.check.allowed), reason: p.check ? p.check.reason : "", note: "Shown to the person as a confirm card. It has not run." });
      } catch (e) { console.error(e); return J({ error: "Tool failed: " + e.message }); }
    } };
  }
  G.askTools = {
    defs: DEFS,
    names: DEFS.map(function (d) { return d.name; }),
    all: function (ctx) { ctx = ctx || G.ask.context(); return DEFS.map(function (d) { return build(d, ctx); }); },
    get: function (name, ctx) { var d = DEFS.find(function (x) { return x.name === name; }); return d ? build(d, ctx || G.ask.context()) : null; },
    read: function (ctx) { ctx = ctx || G.ask.context(); return DEFS.filter(function (d) { return d.run; }).map(function (d) { return build(d, ctx); }); },
    /* run a tool locally (fallback logic can reuse the same data) */
    call: function (name, input, ctx) { var t = G.askTools.get(name, ctx); return t ? JSON.parse(t.execute(input || {})) : { error: "No such tool" }; },
    /* build a proposal object from local logic without the model */
    propose: function (name, input, ctx) { ctx = ctx || G.ask.context(); var t = G.askTools.get(name, ctx); if (!t) return null; t.execute(input || {}); return ctx.proposals[ctx.proposals.length - 1] || null; }
  };

  /* run a confirmed proposal: re-checks permission, then calls the op (or opens its dialog) */
  G.runProposal = function (p) {
    if (p.status !== "pending") return { ok: false, msg: "Already " + p.status + "." };
    if (p.dialog) { G[p.dialog.name].apply(null, p.dialog.args); p.status = "opened"; return { ok: true, msg: "" }; }
    var r = G.ops[p.op].apply(null, p.args);
    p.status = r.ok ? "done" : "failed"; p.result = r.msg;
    return r;
  };
  /* confirm card for a proposal; onDone(result) after it runs or is dismissed */
  G.proposalCard = function (p, onDone) {
    var allowed = !p.check || p.check.allowed;
    var status = h("div", { class: "prop-status", role: "status" }, p.status === "pending" ? "" : p.status === "done" ? "Done. " + (p.result || "") : p.status === "dismissed" ? "Dismissed." : p.result || "");
    var go = G.btn(p.dialog ? "Open dialog" : "Confirm", { kind: p.kind === "kill" ? "danger" : "primary", small: true, id: "prop-go-" + p.id });
    var no = G.btn("Dismiss", { small: true, id: "prop-no-" + p.id });
    if (!allowed) G.guard(go, p.check);
    if (p.status !== "pending") { go.disabled = true; no.disabled = true; }
    go.addEventListener("click", function () {
      if (!allowed || p.status !== "pending") return;
      var r = G.runProposal(p);
      if (r.msg) G.toast(r.msg, r.ok ? "ok" : "error");
      status.textContent = r.ok ? (p.dialog ? "Dialog opened." : "Done. " + (r.msg || "")) : r.msg; go.disabled = true; no.disabled = !r.ok ? false : true;
      if (onDone) onDone(r, p);
    });
    no.addEventListener("click", function () { if (p.status !== "pending") return; p.status = "dismissed"; status.textContent = "Dismissed."; go.disabled = true; no.disabled = true; if (onDone) onDone(null, p); });
    return h("div", { class: "prop-card" + (p.kind === "kill" ? " is-danger" : ""), id: "prop-" + p.id },
      h("div", { class: "prop-head" }, h("span", { class: "kicker" }, "Proposed action"), h("strong", null, p.title)),
      p.summary ? h("p", { class: "prop-sum" }, p.summary) : null,
      (p.entities || []).length ? h("div", { class: "chips" }, p.entities.map(G.entityChip)) : null,
      !allowed ? h("p", { class: "lock-note" }, (p.check.needs ? p.check.needs + ". " : "") + p.check.reason) : null,
      h("div", { class: "row gap-sm" }, go, no), status);
  };
  /* ---------- explain a policy decision: G.ask with the policy trace as fallback ----------
     G.explainDenial({ id, person, action, project, repo, time, decision }) -> node (button + answer area).
     Calls G.ask only on click; without Claude it shows the policy engine's own trace. */
  var explainCache = {};
  G.explainDenial = function (o) {
    var key = o.id || "explain", outId = key + "-out";
    var out = h("div", { class: "explain-out", id: outId, "aria-live": "polite" });
    function paint() {
      var c = explainCache[key], el = document.getElementById(outId) || out;
      G.clear(el); if (!c) return;
      el.appendChild(h("p", { class: "explain-text" + (c.pending && !c.text ? " is-thinking" : "") }, c.text || "Working it out…"));
      if (c.tag) el.appendChild(h("div", { class: "explain-mode small muted" }, c.tag));
      var st = document.getElementById(key + "-stop"); if (st) st.hidden = !c.pending;
    }
    var stop = G.btn("Stop", { small: true, kind: "ghost", id: key + "-stop", onClick: function () { var c = explainCache[key]; if (c && c.ac) c.ac.abort(); } });
    stop.hidden = !(explainCache[key] && explainCache[key].pending);
    var btn = G.btn("Explain", { small: true, kind: "ghost", icon: "chat", id: key, title: "Explain this decision in plain language", onClick: function () {
      if (explainCache[key] && explainCache[key].pending) return;
      var ctx = { project: o.project || undefined, repo: o.repo || undefined, time: o.time || Date.now() };
      var person = G.find.person(o.person), act = G.find.action(o.action);
      var lines = G.policyTrace(o.person, o.action, ctx);
      var d = o.decision || G.can(o.person, o.action, ctx);
      var c = explainCache[key] = { pending: true, text: "", tag: "", ac: typeof AbortController === "function" ? new AbortController() : null };
      paint();
      G.ask({
        instructions: "Explain to the person why the Gantry policy engine " + (d.allowed ? "allowed" : "denied") + " this action, in two to four plain sentences. Name the deciding rule and say concretely what would change the answer (a role, a policy window, on-call, the end of a freeze). Do not invent rules; the trace below is authoritative. You may call who_can to say who could do it instead.",
        data: { person: person ? person.name : o.person, action: act ? act.id + " (" + act.name + ")" : o.action, project: o.project ? (G.find.project(o.project) || {}).name : "factory-wide", repo: o.repo ? (G.find.repo(o.repo) || {}).name : null, when: G.fmt.stamp(ctx.time), decision: { allowed: d.allowed, reason: d.reason, rule: d.rule, needs: d.needs }, trace: lines },
        tools: ["who_can"], signal: c.ac ? c.ac.signal : undefined,
        onText: function (full) { c.text = full; paint(); },
        fallback: function () { return lines.join(" "); }
      }).then(function (r) {
        c.pending = false; c.ac = null;
        if (r.error === "aborted") { c.text = (r.text || "") + (r.text ? " " : "") + "(stopped)"; c.tag = "Claude · stopped"; paint(); return; }
        c.text = r.text || lines.join(" ");
        c.tag = r.mode === "claude" ? "Explained by Claude from the policy trace. The deciding rule above is authoritative." :
          "Local logic: the policy engine's own trace. " + (r.error === "not_granted" ? "Claude access was not granted." : r.error === "rate_limited" ? "Claude is rate limited for a moment." : r.error === "absent" ? "Claude is not available on this page." : r.error ? "Claude did not answer." : "");
        paint();
      });
    } });
    var node = h("div", { class: "explain" }, h("div", { class: "row gap-sm" }, btn, stop), out);
    if (explainCache[key]) setTimeout(paint, 0);
    return node;
  };
})(window.G);
