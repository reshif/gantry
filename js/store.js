/* Store: one state tree, keyed slices, batched change events.
   store.get(key) / store.set(key, valueOrUpdater) / store.update(key, mutator) / store.subscribe(fn(changedKeys)).
   A backend adapter can call store.set with server data and everything re-renders. */
(function (G) {
  "use strict";
  var state = null; /* assigned by G.seed() below, after the lookups exist so seeding can use G.find */
  var subs = [];
  var pending = null;

  function restorePrefs() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem("gantry.prefs") || "null"); } catch (e) { saved = null; }
  if (saved && typeof saved === "object") {
    ["theme", "project", "floorView", "boardSwim"].forEach(function (k) { if (saved[k]) state.prefs[k] = saved[k]; });
    if (saved.session && state.people.some(function (p) { return p.id === saved.session.person; })) {
      state.session = { id: saved.session.id, person: saved.session.person, method: saved.session.method, at: saved.session.at, restored: true };
      if (!state.sessions.some(function (x) { return x.id === saved.session.id; })) {
        state.sessions.push({ id: saved.session.id, person: saved.session.person, method: saved.session.method, device: "This browser", ip: "10.4.0.12", started: saved.session.at, lastSeen: Date.now(), revoked: false, current: true });
      }
    }
    ["navCollapsed", "navRail", "palettePinned", "paletteRecent", "portfolio"].forEach(function (k) { if (saved[k] != null) state.prefs[k] = saved[k]; });
  }
  }
  function persist() {
    try {
      localStorage.setItem("gantry.prefs", JSON.stringify({ theme: state.prefs.theme, project: state.prefs.project, floorView: state.prefs.floorView, boardSwim: state.prefs.boardSwim,
        navCollapsed: state.prefs.navCollapsed, navRail: state.prefs.navRail, palettePinned: state.prefs.palettePinned, paletteRecent: state.prefs.paletteRecent, portfolio: state.prefs.portfolio,
        session: state.session ? { id: state.session.id, person: state.session.person, method: state.session.method, at: state.session.at } : null }));
    } catch (e) { /* storage unavailable: ignore */ }
  }

  function flush() {
    var keys = pending; pending = null;
    subs.slice().forEach(function (fn) { try { fn(keys); } catch (e) { console.error(e); } });
  }

  G.store = {
    get: function (key) { var st = state || G._seedState; return key ? (st ? st[key] : undefined) : st; },
    set: function (key, value) {
      state[key] = typeof value === "function" ? value(state[key]) : value;
      /* every work-order change passes here: record bay stays and state changes in the event log for replay */
      if (key === "workOrders" && G.trackStates && state.woTrack) G.trackStates();
      if (!pending) { pending = {}; Promise.resolve().then(flush); }
      pending[key] = true;
      if (key === "prefs" || key === "session") persist();
    },
    update: function (key, fn) { fn(state[key]); G.store.set(key, state[key]); },
    /* write remembered prefs to localStorage without a change event (view state such as saved portfolio views) */
    persist: function () { persist(); },
    subscribe: function (fn) { subs.push(fn); return function () { subs = subs.filter(function (f) { return f !== fn; }); }; }
  };

  /* ---------- lookups ---------- */
  function cur() { return state || G._seedState || {}; }
  function by(list, id) { return (cur()[list] || []).find(function (x) { return x.id === id; }); }
  G.find = {
    person: function (id) { return by("people", id); },
    agent: function (id) { return by("agents", id); },
    project: function (id) { return by("projects", id); },
    repo: function (id) { return (cur().repos || []).find(function (r) { return r.id === id || r.name === id; }); },
    team: function (id) { return by("teams", id); },
    skill: function (id) { return by("skills", id); },
    mcp: function (id) { return by("mcp", id); },
    trigger: function (id) { return by("triggers", id); },
    template: function (id) { return by("templates", id); },
    wo: function (id) { var up = String(id || "").toUpperCase(); return (cur().workOrders || []).find(function (w) { return w.id === up; }); },
    model: function (id) {
      var vs = cur().vendors || [];
      for (var i = 0; i < vs.length; i++) {
        var m = vs[i].models.find(function (x) { return x.id === id; });
        if (m) return Object.assign({ vendor: vs[i].id, vendorName: vs[i].name }, m);
      }
      return null;
    },
    vendor: function (id) { return by("vendors", id); },
    suite: function (id) { return by("suites", id); },
    station: function (id) { return G.STATIONS.find(function (s) { return s.id === id; }); },
    role: function (id) { return G.ROLES.find(function (r) { return r.id === id; }); },
    action: function (id) { return G.ACTIONS.find(function (a) { return a.id === id; }); },
    cls: function (id) { return G.CLASSES.find(function (c) { return c.id === id; }); }
  };
  G.find.line = G.find.repo;

  G.find.integrationType = function (id) { return (cur().integrationTypes || []).find(function (t) { return t.id === id; }); };
  G.find.integration = function (id) { return (cur().integrationInstances || []).find(function (t) { return t.id === id; }); };
  G.find.event = function (id) { return (cur().events || []).find(function (e) { return e.id === id; }); };
  G.find.trustCell = function (id) { return ((cur().trust || {}).cells || []).find(function (c) { return c.id === id; }); };
  G.find.finding = function (id) { return ((cur().learning || {}).findings || []).find(function (c) { return c.id === id; }); };
  G.find.proposal = function (id) { return ((cur().learning || {}).proposals || []).find(function (c) { return c.id === id; }); };

  G.viewer = function () { return state.session ? G.find.person(state.session.person) : null; };
  G.viewerId = function () { return state.session ? state.session.person : null; };
  G.currentProject = function () { return G.find.project(state.prefs.project); };

  G.actorName = function (id) {
    var p = G.find.person(id); if (p) return p.name;
    var a = G.find.agent(id); if (a) return a.name + " (agent)";
    var k = (cur().apiKeys || []).find(function (x) { return x.id === id; }); if (k) return "API key " + k.name;
    var t = (cur().triggers || []).find(function (x) { return x.id === id; }); if (t) return "Trigger " + t.name;
    if (id === "system") return "Gantry";
    return id || "system";
  };

  /* seed now that lookups exist, then restore light preferences */
  state = G.seed();
  restorePrefs();

  /* ---------- audit ledger ---------- */
  var CAT = { auth: "auth", session: "auth", policy: "access", role: "access", people: "access", freeze: "access", security: "auth", kill: "kill", restore: "kill",
    wo: "flow", line: "flow", check: "flow", brief: "flow", gate: "approvals", approvers: "config", project: "config", flow: "config", template: "config",
    repo: "onboarding", onboarding: "onboarding", guidelines: "onboarding", integration: "integrations", notify: "integrations", trigger: "integrations", delivery: "integrations",
    api: "api", trust: "agents", learning: "agents", class: "config", station: "config", role: "access", card: "config", record: "flow", outcome: "flow", agent: "agents", skill: "agents", eval: "agents", model: "agents", vendor: "agents", routing: "agents", mcp: "integrations" };
  G.AUDIT_CATEGORIES = ["auth", "access", "flow", "onboarding", "approvals", "config", "integrations", "api", "agents", "kill"];
  /* G.audit(action, target, where, outcome, opts{ project, category, before, after, entity:{type,id}, actor, via }) */
  G.audit = function (action, target, where, outcome, opts) {
    opts = opts || {};
    var project = opts.project || (G.find.project(where) ? where : (G.find.repo(where) ? G.find.repo(where).project : null));
    G.store.update("audit", function (list) {
      list.push({ id: state.nextAudit++, at: Date.now(), actor: opts.actor || G.viewerId() || "system", action: action, target: target, where: where || "factory", project: project,
        category: opts.category || CAT[action.split(".")[0]] || "flow", outcome: outcome || "ok", via: opts.via || "web",
        before: opts.before == null ? null : String(opts.before), after: opts.after == null ? null : String(opts.after), entity: opts.entity || null });
    });
  };

  /* ---------- event log: append-only, drives replay (G.replay, G.stateAt) ----------
     G.logEvent(type, { project, wo, station, gate, bay, repo, scope, by, mode, trust, from, to, cell, text }) */
  G.logEvent = function (type, o) {
    var st = state || G._seedState; if (!st || !st.events) return null;
    var e = Object.assign({ id: st.nextEvent++, at: Date.now(), type: type }, o || {});
    st.events.push(e);
    if (state) G.store.set("events", st.events);
    return e;
  };

  /* integration instance for a destination { channel, target, integration? } in a project */
  G.integrationFor = function (d, projectId) {
    var list = cur().integrationInstances || [];
    if (d.integration) return list.find(function (i) { return i.id === d.integration; }) || null;
    function open(i) { return i.projects === "all" || !projectId || (i.projects || []).indexOf(projectId) >= 0; }
    if (d.channel === "webhook") { var w = list.find(function (i) { return i.type === "webhook" && i.targetId === d.target; }); if (w) return w; }
    var mine = list.filter(function (i) { return i.type === d.channel && open(i); });
    return mine.find(function (i) { return i.connected && i.status !== "failing"; }) || mine[0] || null;
  };
  G.integrationsFor = function (projectId, type) {
    return (cur().integrationInstances || []).filter(function (i) { return (!type || i.type === type) && (i.projects === "all" || (i.projects || []).indexOf(projectId) >= 0); });
  };

  /* source-control instances open to a project (GitHub cloud and Enterprise, GitLab, Bitbucket, custom sources) */
  G.sourceInstances = function (projectId) {
    return (cur().integrationInstances || []).filter(function (i) {
      var t = G.find.integrationType(i.type);
      return t && t.category === "source" && (i.projects === "all" || !projectId || (i.projects || []).indexOf(projectId) >= 0);
    });
  };
  /* the source instance for a repo (the one it was connected through) or, for a project id, the instance its repos use:
     a project-scoped instance wins over an all-projects one, connected over disconnected */
  G.sourceIntegrationFor = function (projectOrRepo) {
    var rp = typeof projectOrRepo === "object" && projectOrRepo ? projectOrRepo : G.find.project(projectOrRepo) ? null : G.find.repo(projectOrRepo);
    if (rp && rp.source && G.find.integration(rp.source)) return G.find.integration(rp.source);
    var pid = rp ? rp.project : projectOrRepo;
    var list = G.sourceInstances(pid).slice();
    list.sort(function (a, b) { return (a.projects === "all" ? 1 : 0) - (b.projects === "all" ? 1 : 0) || (b.connected ? 1 : 0) - (a.connected ? 1 : 0); });
    return list[0] || null;
  };
  /* repos a source instance offers that are not connected yet: [{ repo, lang }] */
  G.availableRepos = function (instId) {
    var i = G.find.integration(instId); if (!i) return [];
    return (i.available || []).filter(function (a) { return !(cur().repos || []).some(function (r) { return r.name === a.repo; }); });
  };
  /* known targets of a destination instance (paging schedules, the webhook endpoint id); [] when targets are free text */
  G.integrationTargets = function (inst) {
    if (!inst) return [];
    if (inst.type === "webhook") return [inst.targetId || inst.id];
    var c = inst.config || {};
    if (inst.type === "paging") return String(c.schedules || "").split(/[,\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    return [];
  };
  /* does a destination instance take this event? Built-in chat, email and webhook types take any event; a type that lists
     Gantry events (custom types such as Status page) takes only those */
  G.integrationAccepts = function (inst, event) {
    var t = inst && G.find.integrationType(inst.type); if (!t) return true;
    var gantry = (t.events || []).filter(function (e) { return (G.INTEGRATION_EVENTS_ALL || []).indexOf(e) >= 0; });
    return !gantry.length || gantry.indexOf(event) >= 0 || event === "test";
  };
  /* state of a delivery target: healthy | failing | offline | disabled | missing, plus the error a send would get */
  G.integrationState = function (inst, d) {
    if (inst) {
      var st = !inst.connected ? "disabled" : inst.status === "failing" ? "failing" : inst.status === "offline" ? "offline" : "healthy";
      return { state: st, error: st === "healthy" ? "" : st === "failing" ? "HTTP 502 from " + inst.name : inst.name + " is " + (st === "disabled" ? "disabled" : "offline") };
    }
    var conn = d && (cur().integrations || {})[d.channel];
    if (!conn) return { state: "missing", error: "no connection for " + (d ? d.channel : "this destination") };
    var bad = !conn.connected || (d.channel === "webhook" && (conn.endpoints || []).some(function (e) { return e.id === d.target && e.status === "failing"; }));
    return { state: bad ? (conn.connected ? "failing" : "offline") : "healthy", error: bad ? (conn.connected ? "HTTP 502 from endpoint" : d.channel + " is not connected") : "" };
  };
  /* readable name of a work order source (ui, console, slack, api, schedule, an integration type or instance id) */
  G.sourceLabel = function (src) {
    var fixed = { ui: "the web app", web: "the web app", console: "the console", slack: "Slack", teams: "Microsoft Teams", github: "GitHub", gitlab: "GitLab", api: "the API", schedule: "a schedule", epic: "an epic split", trigger: "a trigger", email: "email" };
    if (fixed[src]) return fixed[src];
    var inst = G.find.integration(src); if (inst) return inst.name;
    var t = G.find.integrationType(src); if (t) return t.name;
    return src || "the web app";
  };

  /* ---------- notifications: route an event to destinations and log deliveries ---------- */
  G.notify = function (projectId, event, payload) {
    var p = G.find.project(projectId);
    var routes = p ? p.notifications : state.projects.reduce(function (all, x) { return all.concat(x.notifications.filter(function (r) { return r.event === event; })); }, []);
    var out = [];
    (routes || []).filter(function (r) { return r.enabled && r.event === event; }).forEach(function (r) {
      if (payload && payload.cls && r.cond.classes.length && r.cond.classes.indexOf(payload.cls) < 0) return;
      if (payload && payload.priority && r.cond.priority.length && r.cond.priority.indexOf(payload.priority) < 0) return;
      if (r.cond.hours === "business") { var h = new Date(Date.now() + 330 * 60000).getUTCHours(); if (h < 9 || h >= 19) return; }
      var dests = r.dest.slice();
      var repo = payload && payload.repo ? G.find.repo(payload.repo) : (payload && payload.wo ? G.find.repo((G.find.wo(payload.wo) || {}).repo) : null);
      if (repo && repo.notifyOverrides) {
        var ov = repo.notifyOverrides.filter(function (o) { return o.event === event; });
        if (ov.some(function (o) { return o.mode === "instead"; })) dests = [];
        ov.forEach(function (o) { (o.dest || []).forEach(function (d) { dests.push({ channel: d.channel, target: d.target, integration: d.integration || null, override: o.id }); }); });
      }
      dests.forEach(function (d) {
        /* resolve the integration instance: explicit d.integration, else a webhook instance with this targetId, else any instance of that type open to the project */
        var inst = G.integrationFor(d, projectId);
        if (inst && !G.integrationAccepts(inst, event)) return;
        var st = G.integrationState(inst, d), failing = st.state !== "healthy";
        out.push({ id: "DLV-" + (state.nextDelivery++), at: Date.now(), project: projectId, event: event, channel: inst ? inst.type : d.channel, target: d.target, integration: inst ? inst.id : null, status: failing ? "failed" : "delivered", attempts: 1, error: st.error, wo: payload && payload.wo, route: r.id, override: d.override || null, repo: repo ? repo.id : null });
      });
    });
    if (out.length) G.store.update("deliveries", function (l) { out.forEach(function (x) { l.push(x); }); });
    return out;
  };

  /* ---------- formatting ---------- */
  var MIN = 60000, HOUR = 3600000;
  G.fmt = {
    money: function (n) { return "$" + (n >= 1000 ? Math.round(n).toLocaleString("en-US") : (+n).toFixed(2)); },
    money0: function (n) { return "$" + Math.round(n).toLocaleString("en-US"); },
    num: function (n) { return Math.round(n).toLocaleString("en-US"); },
    k: function (n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(Math.round(n)); },
    pct: function (n, d) { return (n * 100).toFixed(d == null ? 0 : d) + "%"; },
    dur: function (ms) {
      if (ms < 0) ms = 0;
      var m = Math.floor(ms / MIN);
      if (m < 1) return "<1m";
      if (m < 60) return m + "m";
      var h = Math.floor(m / 60);
      if (h < 48) return h + "h " + String(m % 60).padStart(2, "0") + "m";
      return Math.floor(h / 24) + "d " + (h % 24) + "h";
    },
    ago: function (t) { var d = Date.now() - t; return d < 45000 ? "just now" : G.fmt.dur(d) + " ago"; },
    ist: function (t) { var d = new Date(t + 330 * MIN); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); },
    istDate: function (t) {
      var d = new Date(t + 330 * MIN);
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] + " " + d.getUTCDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    },
    stamp: function (t) { return G.fmt.istDate(t) + " " + G.fmt.ist(t) + " IST"; },
    iso: function (t) { return new Date(t + 330 * MIN).toISOString().slice(0, 19).replace("T", " "); }
  };
  G.HOUR = HOUR; G.MIN = MIN; G.DAY = 24 * HOUR;
})(window.G);
