/* Home (#home). Factory Admins and the Auditor get the factory overview: what is happening where,
   summary first (status line, KPIs), then project grid, needs-attention queue, control panel with
   the factory kill switch, activity, onboarding pipeline and spend. Everyone else gets My work. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { mode: null };

  /* health and gate helpers live in shared.js (G.homeKit) */
  var K = G.homeKit, wosOf = K.wosOf, inFlight = K.inFlight, waitSince = K.waitSince, waitingGates = K.waitingGates, projectHealth = K.projectHealth, healthChip = K.healthChip, goProject = K.goProject, slotsText = K.slotsText, onboardingOf = K.onboardingOf;

  var STAGE_NAME = { connected: "Connected", assessed: "Assessed", pr_opened: "PR opened", pr_checks: "PR checks", pr_merged: "PR merged", verified: "Verified", ready: "Ready", failed: "Failed", person: "Needs a person" };

  function stat(k, v, sub, tone, id) {
    return h("div", { class: "stat hm-stat" + (tone ? " tone-" + tone : ""), id: id || null }, h("div", { class: "stat-k" }, k), h("div", { class: "stat-v" }, v), sub ? h("div", { class: "stat-sub" }, sub) : null);
  }

  /* ---------- needs attention ---------- */
  function attention() {
    var items = [];
    var f = G.store.get("factory").killed;
    function add(sev, icon, title, where, sub, act, actLabel, id) { items.push({ sev: sev, icon: icon, title: title, where: where, sub: sub, act: act, actLabel: actLabel, id: id }); }
    if (f) add(0, "st-kill", "Factory killed", "Factory", f.reason + " · " + G.fmt.ago(f.at), function () { var el = document.getElementById("hm-ctl"); if (el) el.scrollIntoView({ block: "start" }); }, "Control panel", "hm-att-factory");
    G.store.get("projects").forEach(function (p) {
      if (p.killed) add(0, "st-kill", p.name + " killed", p.name, p.killed.reason + " · " + G.fmt.ago(p.killed.at), function () { goProject(p.id, "project-config"); }, "Danger zone", "hm-att-kill-" + p.id);
      if (p.halted) add(1, "halt", p.name + " halted", p.name, p.halted.reason, function () { goProject(p.id); }, "Open floor", "hm-att-halt-" + p.id);
      if (p.status !== "archived" && p.budget.monthly && p.budget.mtd / p.budget.monthly >= p.budget.alertAt) add(p.budget.mtd >= p.budget.monthly ? 1 : 2, "alert", "Budget at " + G.fmt.pct(p.budget.mtd / p.budget.monthly), p.name, G.fmt.money0(p.budget.mtd) + " of " + G.fmt.money0(p.budget.monthly) + " this month", function () { G.homeKit.cfgTab = "budget"; goProject(p.id, "project-config"); }, "Budget", "hm-att-bud-" + p.id);
    });
    G.store.get("repos").forEach(function (r) {
      var p = G.find.project(r.project);
      if (r.halted) add(1, "halt", r.name + " halted", p.name, r.halted.reason, function () { goProject(p.id); }, "Open floor", "hm-att-rh-" + r.id);
      var o = r.onboarding;
      if (o.stage === "failed" || o.stage === "person" || (o.pr && o.pr.checks === "red" && o.pr.state === "open")) add(1, "rocket", "Onboarding PR " + (o.stage === "person" ? "needs a person" : "failing"), p.name + " · " + r.name, o.blocker || "PR checks are red.", function () { goProject(p.id, "onboarding"); }, "Onboarding", "hm-att-onb-" + r.id);
    });
    G.store.get("workOrders").forEach(function (w) {
      if (!inFlight(w)) return;
      var p = G.find.project(w.project);
      if (w.state === "blocked") add(1, "st-block", w.id + " blocked", p.name + " · " + G.stationOf(w).name, w.blockReason || w.title, function () { G.openTraveler(w.id); }, "Traveler", "hm-att-wo-" + w.id);
      else if (w.state === "failed") add(1, "st-fail", w.id + " check failed", p.name + " · " + G.stationOf(w).name, w.failReason || w.title, function () { G.openTraveler(w.id); }, "Traveler", "hm-att-wo-" + w.id);
      else if (w.bay === "sechold") add(0, "shield", w.id + " on security hold", p.name, w.bayReason || w.title, function () { G.openTraveler(w.id); }, "Traveler", "hm-att-wo-" + w.id);
      else if (w.bay === "person") add(2, "human", w.id + " needs a person", p.name, w.bayReason || w.title, function () { G.openTraveler(w.id); }, "Traveler", "hm-att-wo-" + w.id);
    });
    waitingGates().filter(function (g) { return g.late; }).forEach(function (g) {
      var d = G.gateDef(g.gate);
      add(1, "clock", d.label + " past SLA on " + g.wo.id, G.find.project(g.wo.project).name, "Waiting " + G.fmt.dur(g.age) + "; escalates after " + g.slaH + " h", function () { G.openTraveler(g.wo.id); }, "Traveler", "hm-att-sla-" + g.wo.id + "-" + g.gate);
    });
    var latest = {};
    G.store.get("evalRuns").forEach(function (r) { if (!latest[r.suite] || latest[r.suite].at < r.at) latest[r.suite] = r; });
    Object.keys(latest).forEach(function (sid) {
      var r = latest[sid], s = G.find.suite(sid); if (!s || r.score >= s.threshold) return;
      var a = G.find.agent(r.agent);
      add(2, "eval", "Eval below threshold: " + (a ? a.name : r.agent) + " " + r.version, "Factory", s.name + " " + G.fmt.pct(r.score) + " vs " + G.fmt.pct(s.threshold), function () { location.hash = "evals"; }, "Evals", "hm-att-ev-" + sid);
    });
    G.store.get("vendors").forEach(function (v) {
      if (v.health !== "healthy" && v.budget > 0) add(v.health === "offline" ? 1 : 2, "model", v.name + " " + v.health, "Vendor", "Latency " + v.latency + " ms; fallbacks take over", function () { location.hash = "models"; }, "Models", "hm-att-v-" + v.id);
      if (v.budget > 0 && v.mtd / v.budget >= 0.85) add(2, "alert", v.name + " spend at " + G.fmt.pct(v.mtd / v.budget), "Vendor", G.fmt.money0(v.mtd) + " of " + G.fmt.money0(v.budget), function () { location.hash = "models"; }, "Models", "hm-att-vb-" + v.id);
    });
    (G.store.get("integrationInstances") || []).forEach(function (i) {
      if (i.status === "healthy" || i.disabled) return;
      var t = G.find.integrationType(i.type) || { name: i.type };
      var scope = i.projects === "all" ? "all projects" : (i.projects || []).map(function (x) { return (G.find.project(x) || { name: x }).name; }).join(", ");
      add(i.status === "offline" ? 2 : 1, "plug", i.name + " " + i.status, t.name + " integration", (i.status === "offline" ? "Not connected" : "Deliveries failing") + " · used by " + scope, function () { location.hash = "integrations"; }, "Integrations", "hm-att-int-" + i.id);
    });
    return items.sort(function (a, b) { return a.sev - b.sev; });
  }
  var SEV = [{ id: "crit", label: "Critical" }, { id: "high", label: "High" }, { id: "watch", label: "Watch" }];
  function attentionPanel(items) {
    var limit = ui.attAll ? items.length : 8;
    var counts = SEV.map(function (s, i) { return items.filter(function (x) { return x.sev === i; }).length; });
    var body = items.length ? h("div", null,
      h("p", { class: "hm-att-sum small" }, SEV.map(function (s, i) { return h("span", { class: "hm-sev hm-sev-" + s.id }, h("span", { class: "hm-sev-mark", "aria-hidden": "true" }), counts[i] + " " + s.label.toLowerCase()); })),
      h("ol", { class: "hm-att" }, items.slice(0, limit).map(function (x) {
        var s = SEV[x.sev];
        return h("li", { class: "hm-att-item hm-sev-" + s.id },
          h("span", { class: "hm-att-ic", title: s.label }, G.icon(x.icon)),
          h("div", { class: "hm-att-main" }, h("div", { class: "hm-att-t" }, h("span", { class: "sr" }, s.label + ": "), x.title), h("div", { class: "muted small hm-att-w" }, x.where + " · " + x.sub)),
          G.btn(x.actLabel, { small: true, kind: "ghost", id: x.id, onClick: x.act, aria: x.actLabel + " for " + x.title }));
      })),
      items.length > 8 ? G.btn(ui.attAll ? "Show the top 8" : "Show all " + items.length, { small: true, kind: "ghost", id: "hm-att-more", onClick: function () { ui.attAll = !ui.attAll; G.rerender(); } }) : null)
      : G.empty("Nothing needs attention", "Blocked work, gates past SLA, failing onboarding, eval regressions, vendor incidents, budget overruns, security holds and kills appear here.");
    return G.panel("Needs attention", body, { cls: "hm-att-panel", tools: h("span", { class: "mono small muted" }, items.length + " open") });
  }

  /* ---------- factory control panel ---------- */
  function controlPanel() {
    var f = G.store.get("factory").killed;
    var sec = G.store.get("security");
    var admins = G.store.get("people").filter(function (p) { return G.isFactoryAdmin(p.id) && p.status === "active"; });
    var me = G.viewerId();
    var imp = G.ops.killImpact("factory");
    var paused = G.store.get("prefs").paused;
    var kids = [];
    kids.push(h("div", { class: "hm-ctl-state " + (f ? "is-killed" : "is-running") },
      G.icon(f ? "st-kill" : "st-run"),
      h("div", null, h("div", { class: "hm-ctl-big" }, f ? "Factory killed" : "Factory running"),
        h("div", { class: "small" }, f ? G.actorName(f.by) + ", " + G.fmt.stamp(f.at) + " · in-flight work " + (f.mode === "cancel" ? "cancelled" : "held in place") : imp.projects + " projects · " + imp.workOrders + " work orders in flight · " + imp.running + " agents running"))));
    if (f) {
      kids.push(h("p", { class: "hm-ctl-reason" }, h("span", { class: "kv-k" }, "Reason "), f.reason));
      var need = sec.restoreFactoryNeedsTwo ? 2 : 1;
      var already = f.restoreApprovals.some(function (a) { return a.by === me; });
      var others = admins.filter(function (a) { return !f.restoreApprovals.some(function (x) { return x.by === a.id; }); });
      kids.push(h("div", { class: "hm-restore" },
        h("div", { class: "sub-h" }, "Restore approvals " + f.restoreApprovals.length + " of " + need),
        h("ol", { class: "hm-restore-steps" }, Array.from({ length: need }, function (_, i) {
          var a = f.restoreApprovals[i];
          return h("li", { class: a ? "is-done" : "" }, h("span", { class: "hm-step-n mono" }, String(i + 1)), a ? h("span", null, G.actorName(a.by) + " · " + G.fmt.ago(a.at) + " · " + a.reason) : h("span", { class: "muted" }, i === 0 ? "First Factory Admin" : "A second, different Factory Admin"));
        })),
        sec.restoreFactoryNeedsTwo && f.restoreApprovals.length && !others.length ? h("div", { class: "callout callout-warn small" }, G.icon("alert"), h("span", null, "No other active Factory Admin exists. Grant the role to someone in People so they can approve the restore.")) : null,
        sec.restoreFactoryNeedsTwo && others.length ? h("p", { class: "small muted" }, "Can approve next: " + others.map(function (a) { return a.name; }).join(", ") + ".") : null));
      var rd = G.me("restore.factory");
      if (rd.allowed && already) rd = { allowed: false, reason: "You approved this restore already. A second Factory Admin must approve.", needs: "A different Factory Admin" };
      kids.push(h("div", { class: "hm-ctl-actions" }, G.btn(f.restoreApprovals.length ? "Approve restore (" + (f.restoreApprovals.length + 1) + " of " + need + ")" : "Restore the factory", { kind: "primary", icon: "power", id: "hm-restore", guard: rd, onClick: function () { G.restoreDialog("factory"); } })));
    } else {
      kids.push(h("dl", { class: "titleblock hm-ctl-impact" },
        h("div", null, h("dt", null, "Projects"), h("dd", null, String(imp.projects))),
        h("div", null, h("dt", null, "In flight"), h("dd", null, String(imp.workOrders))),
        h("div", null, h("dt", null, "Agents"), h("dd", null, String(imp.running))),
        h("div", null, h("dt", null, "Open PRs"), h("dd", null, String(imp.prs)))));
      kids.push(h("p", { class: "small muted" }, "The factory kill stops every agent in every project, frees coding slots and refuses new submissions. It needs a reason and the phrase KILL FACTORY. " + (sec.restoreFactoryNeedsTwo ? "Restoring needs two different Factory Admins." : "Restoring needs one Factory Admin.")));
      kids.push(h("div", { class: "hm-ctl-actions" }, G.btn("Kill the factory", { kind: "danger", icon: "st-kill", id: "hm-kill", guard: G.me("kill.factory"), onClick: function () { G.killDialog("factory"); } })));
    }
    kids.push(h("div", { class: "hm-ctl-row" },
      h("span", null, h("span", { class: "kv-k" }, "Simulation "), h("span", { class: "live" + (paused || f ? " is-paused" : "") }, h("span", { class: "live-dot", "aria-hidden": "true" }), f ? "stopped by kill" : paused ? "paused" : "running")),
      G.btn(paused ? "Resume simulation" : "Pause simulation", { small: true, kind: "ghost", icon: paused ? "play" : "pause", id: "hm-sim", onClick: function () { G.store.update("prefs", function (p) { p.paused = !p.paused; }); } })));
    kids.push(h("div", { class: "hm-ctl-row" }, h("span", { class: "small" }, h("span", { class: "kv-k" }, "Factory Admins "), admins.map(function (a) { return a.name; }).join(", ") || "none"),
      h("a", { href: "#security", class: "linkish small", id: "hm-sec-link" }, "Restore rule in Security")));
    return h("section", { class: "panel hm-ctl" + (f ? " is-killed" : ""), id: "hm-ctl", "aria-label": "Factory control panel" },
      h("div", { class: "panel-head" }, h("h2", { class: "panel-title" }, "Factory control"), G.icon("power", "hm-ctl-pw")),
      h("div", { class: "panel-body hm-ctl-body" }, G.lockNote(G.me(f ? "restore.factory" : "kill.factory"), f ? "Restoring the factory" : "The factory kill switch"), kids));
  }

  /* ---------- project grid ---------- */
  function projectCard(p, m) {
    m = m || pfMetrics(p);
    var wos = wosOf(p.id);
    var live = wos.filter(inFlight);
    var gates = waitingGates(p.id);
    var onb = onboardingOf(p.id);
    var hl = projectHealth(p);
    return h("article", { class: "hm-proj hk-card-" + hl.id, "aria-label": p.name },
      h("div", { class: "hm-proj-head" },
        h("div", { class: "hm-proj-name" }, h("span", { class: "mono hm-key" }, p.key), h("h3", null, p.name)),
        healthChip(p)),
      G.miniBelt({ project: p, wos: wos, onStation: function () { goProject(p.id, "floor"); } }),
      hl.detail ? h("p", { class: "small hm-proj-detail" }, hl.detail) : null,
      h("dl", { class: "hm-proj-facts" },
        h("div", null, h("dt", null, "WIP"), h("dd", null, String(live.filter(function (w) { return !w.bay; }).length), h("span", { class: "muted" }, live.filter(function (w) { return w.bay; }).length ? " +" + live.filter(function (w) { return w.bay; }).length + " in bays" : ""))),
        h("div", null, h("dt", null, "Slots"), h("dd", null, slotsText(p))),
        h("div", { class: gates.length ? "is-wait" : "" }, h("dt", null, "Approvals"), h("dd", null, String(gates.length), gates.length ? h("span", { class: "muted" }, " · oldest " + G.fmt.dur(gates[0].age)) : null)),
        h("div", { class: onb.length ? "is-onb" : "" }, h("dt", null, "Onboarding"), h("dd", null, onb.length ? onb.length + " repo" + (onb.length > 1 ? "s" : "") : "all ready"))),
      h("p", { class: "hm-proj-ins small" },
        h("span", { "data-tip": "Agent working time over lead time, " + m.effN + " shipped in 7 days", tabindex: "0" }, h("span", { class: "kv-k" }, "Flow eff. "), h("span", { class: "mono" }, effText(m))),
        h("span", { "data-tip": m.cov.auto + " of " + m.cov.total + " gate decisions passed under trust in 7 days", tabindex: "0" }, h("span", { class: "kv-k" }, "Trust "), h("span", { class: "mono" }, covText(m))),
        h("span", null, h("span", { class: "kv-k" }, "Spend "), h("span", { class: "mono" + (m.spend >= 1 ? " neg" : "") }, p.budget.monthly ? G.fmt.pct(m.spend) : "no budget"))),
      p.status === "archived" ? pfActions(p, "hm-card") : h("div", { class: "hm-proj-actions" },
        G.btn("Floor", { small: true, icon: "belt", id: "hm-floor-" + p.id, onClick: function () { goProject(p.id, "floor"); }, aria: "Open the floor for " + p.name }),
        G.btn("Config", { small: true, kind: "ghost", id: "hm-cfg-" + p.id, onClick: function () { goProject(p.id, "project-config"); }, aria: "Configure " + p.name }),
        onb.length ? G.btn("Onboarding", { small: true, kind: "ghost", id: "hm-onb-" + p.id, onClick: function () { goProject(p.id, "onboarding"); }, aria: "Onboarding for " + p.name }) : null));
  }

  /* ---------- portfolio (shared with projects.js through G.portfolio) ----------
     Layout (cards | rows), group, sort, filters and saved views are per signed-in person and remembered
     in prefs.portfolio (persisted with the other prefs; view state, not audited, like prefs.floorView). */
  var HEALTH_ORDER = { killed: 0, halted: 1, attention: 2, new: 3, onboarding: 4, ok: 5, archived: 6 };
  var HEALTH_LABEL = { killed: "Killed", halted: "Halted", attention: "Needs attention", new: "Setting up", onboarding: "Onboarding repos", ok: "Healthy", archived: "Archived" };
  var PF_DEFAULT = { layout: "cards", group: "none", sort: "health", dir: 1, q: "", health: "all", team: "all", tpl: "all", archived: false, view: "v-all" };
  var PF_BUILTIN = [
    { id: "v-all", name: "All active", builtIn: true, s: { group: "none", sort: "health", dir: 1, health: "all", team: "all", tpl: "all", archived: false } },
    { id: "v-att", name: "Needs attention", builtIn: true, s: { group: "none", sort: "gates", dir: -1, health: "attention", team: "all", tpl: "all", archived: false } },
    { id: "v-team", name: "By team", builtIn: true, s: { group: "team", sort: "name", dir: 1, health: "all", team: "all", tpl: "all", archived: false } },
    { id: "v-spend", name: "Spend first", builtIn: true, s: { group: "none", sort: "spend", dir: -1, health: "all", team: "all", tpl: "all", archived: false } }
  ];
  var VIEW_KEYS = ["group", "sort", "dir", "health", "team", "tpl", "archived"];
  var pfMem = null;
  function pfAll() {
    var prefs = G.store.get("prefs");
    if (!prefs.portfolio || typeof prefs.portfolio !== "object") prefs.portfolio = {};
    pfMem = prefs.portfolio;
    return pfMem;
  }
  function pfSave() { G.store.get("prefs").portfolio = pfMem; G.store.persist(); }
  function pfMine() {
    var all = pfAll(), who = G.viewerId() || "anon";
    if (!all[who]) all[who] = { views: [], ctx: {} };
    return all[who];
  }
  function pfState(ctx, layout) {
    var m = pfMine();
    if (!m.ctx[ctx]) m.ctx[ctx] = Object.assign({}, PF_DEFAULT, { layout: layout || "cards" });
    return m.ctx[ctx];
  }
  function pfViews() { return PF_BUILTIN.concat(pfMine().views); }
  function pfModified(st) {
    var v = pfViews().find(function (x) { return x.id === st.view; });
    if (!v) return false;
    return VIEW_KEYS.some(function (k) { return v.s[k] !== st[k]; });
  }

  /* per-project numbers for the portfolio */
  function pfMetrics(p) {
    var wos = wosOf(p.id), live = wos.filter(inFlight), since = Date.now() - 7 * G.DAY;
    var fin = wos.filter(function (w) { return w.state === "done" && w.doneAt && w.doneAt >= since && !w.split; });
    var act = 0, lead = 0;
    fin.forEach(function (w) { lead += w.doneAt - w.createdAt; w.history.forEach(function (e) { if (e.endedAt) act += e.endedAt - e.startedAt; }); });
    var gates = waitingGates(p.id);
    var cov = G.trust && G.trust.coverage ? G.trust.coverage(p.id) : { total: 0, auto: 0, share: 0 };
    var hl = projectHealth(p);
    return { p: p, health: hl, wip: live.filter(function (w) { return !w.bay; }).length, bays: live.filter(function (w) { return w.bay; }).length,
      eff: lead ? act / lead : null, effN: fin.length, gates: gates.length, oldest: gates.length ? gates[0].age : 0, late: gates.filter(function (g) { return g.late; }).length,
      cov: cov, spend: p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0, team: p.teams[0] || "none" };
  }
  var MIN_EFF = 3, MIN_COV = 10;
  function effText(m) { return m.effN < MIN_EFF ? "insufficient data" : G.fmt.pct(m.eff); }
  function covText(m) { return m.cov.total < MIN_COV ? "insufficient data" : G.fmt.pct(m.cov.share); }
  var SORTS = [
    { id: "health", label: "Health", v: function (m) { return HEALTH_ORDER[m.health.id] * 1000 - m.gates; } },
    { id: "name", label: "Name", v: function (m) { return m.p.name.toLowerCase(); } },
    { id: "wip", label: "Work in flight", v: function (m) { return m.wip + m.bays; } },
    { id: "gates", label: "Gates waiting", v: function (m) { return m.gates * 1e9 + m.oldest / 1000; } },
    { id: "eff", label: "Flow efficiency", v: function (m) { return m.effN < MIN_EFF ? -1 : m.eff; } },
    { id: "trust", label: "Trust coverage", v: function (m) { return m.cov.total < MIN_COV ? -1 : m.cov.share; } },
    { id: "spend", label: "Spend vs budget", v: function (m) { return m.spend; } }
  ];
  var GROUPS = [{ id: "none", label: "No grouping" }, { id: "health", label: "Health" }, { id: "team", label: "Owning team" }, { id: "template", label: "Template" }];

  function pfRowCols(ctx, opts) {
    var me = G.viewer();
    var cols = [
      { key: "name", label: "Project", render: function (m) {
        return h("div", { class: "pf-name" }, h("span", { class: "mono hm-key" }, m.p.key),
          h("button", { type: "button", class: "linkish pf-name-btn", id: ctx + "-open-" + m.p.id, onClick: function () { goProject(m.p.id, m.p.status === "archived" ? "project-config" : "floor"); } }, m.p.name),
          m.p.regulated ? h("span", { class: "tag pf-reg" }, "regulated") : null);
      } },
      { key: "health", label: "Health", render: function (m) { return h("div", null, healthChip(m.p), m.health.detail ? h("div", { class: "small muted pf-detail" }, m.health.detail) : null); } },
      { key: "belt", label: "Flow", hideSmall: false, render: function (m) { return h("div", { class: "pf-belt" }, G.miniBelt({ project: m.p, onStation: m.p.status === "archived" ? null : function () { goProject(m.p.id, "floor"); } })); } },
      { key: "wip", label: "WIP", align: "end", render: function (m) { return h("span", { class: "mono" }, String(m.wip), m.bays ? h("span", { class: "muted small" }, " +" + m.bays + " bays") : null); } },
      { key: "eff", label: "Flow eff.", align: "end", render: function (m) { return h("span", { class: "mono" + (m.effN < MIN_EFF ? " muted small" : ""), "data-tip": "Agent working time over lead time for " + m.effN + " work order" + (m.effN === 1 ? "" : "s") + " shipped in 7 days", tabindex: "0" }, effText(m), h("span", { class: "muted small" }, " n=" + m.effN)); } },
      { key: "gates", label: "Gates waiting", align: "end", render: function (m) { return h("span", { class: "mono" + (m.late ? " neg" : m.gates ? " warn-text" : "") }, String(m.gates), m.gates ? h("span", { class: "muted small" }, " · " + G.fmt.dur(m.oldest) + (m.late ? " · " + m.late + " late" : "")) : null); } },
      { key: "trust", label: "Trust cover", align: "end", render: function (m) { return h("span", { class: "mono" + (m.cov.total < MIN_COV ? " muted small" : ""), "data-tip": m.cov.auto + " of " + m.cov.total + " gate decisions in 7 days passed under trust", tabindex: "0" }, covText(m), h("span", { class: "muted small" }, " " + m.cov.auto + "/" + m.cov.total)); } },
      { key: "spend", label: "Spend", align: "end", render: function (m) {
        return m.p.budget.monthly ? h("div", { class: "pf-spend" }, h("span", { class: "mono" + (m.spend >= 1 ? " neg" : "") }, G.fmt.money0(m.p.budget.mtd), h("span", { class: "muted small" }, " / " + G.fmt.money0(m.p.budget.monthly))), G.meter(m.p.budget.mtd, m.p.budget.monthly, m.p.name + " spend", m.p.budget.alertAt)) : h("span", { class: "muted small" }, "no budget");
      } }
    ];
    if (opts && opts.roles) cols.push({ key: "roles", label: "Your roles", hideSmall: true, render: function (m) { var r = G.rolesIn(me, m.p.id).map(function (x) { var ro = G.find.role(x); return ro ? ro.name : x; }); return r.length ? h("span", { class: "small" }, r.join(", ")) : h("span", { class: "muted small" }, "none"); } });
    cols.push({ key: "acts", label: "", render: function (m) { return pfActions(m.p, ctx); } });
    return cols;
  }
  function pfActions(p, ctx) {
    if (p.status === "archived") return h("div", { class: "pf-acts" },
      G.btn("Unarchive", { small: true, icon: "undo", id: ctx + "-unarch-" + p.id, aria: "Unarchive " + p.name, guard: G.me("project.archive", { project: p.id }), onClick: function () { var r = G.ops.unarchiveProject(p.id); G.toast(r.msg, r.ok ? "ok" : "error"); } }),
      G.btn("Config", { small: true, kind: "ghost", id: ctx + "-cfg-" + p.id, aria: "Configure " + p.name, onClick: function () { goProject(p.id, "project-config"); } }));
    return h("div", { class: "pf-acts" },
      G.btn("Floor", { small: true, icon: "belt", id: ctx + "-floor-" + p.id, aria: "Open the floor for " + p.name, onClick: function () { goProject(p.id, "floor"); } }),
      G.btn("Config", { small: true, kind: "ghost", id: ctx + "-cfg-" + p.id, aria: "Configure " + p.name, onClick: function () { goProject(p.id, "project-config"); } }));
  }

  function viewDialog(st, mode) {
    var cur = pfViews().find(function (x) { return x.id === st.view; });
    var name = h("input", { id: "pf-view-name", class: "input", value: mode === "rename" && cur ? cur.name : "", placeholder: "Payments and partners, by spend", autocomplete: "off" });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: mode === "rename" ? "Rename view" : "Save this view", kicker: "Portfolio · saved views",
      sub: mode === "rename" ? null : "Saves the grouping, sort and filters. Only you see your saved views.",
      body: h("div", { class: "form-grid" }, G.field("View name", name), err),
      actions: [{ label: "Cancel" }, { label: mode === "rename" ? "Rename view" : "Save view", kind: "primary", submit: true, id: "pf-view-ok", onClick: function (close) {
        var n = name.value.trim();
        if (n.length < 2) { err.textContent = "Name the view (2+ characters)."; return; }
        var mine = pfMine();
        if (pfViews().some(function (x) { return x.name.toLowerCase() === n.toLowerCase() && !(mode === "rename" && x.id === st.view); })) { err.textContent = "You already have a view called " + n + "."; return; }
        if (mode === "rename") { var v = mine.views.find(function (x) { return x.id === st.view; }); if (v) v.name = n; }
        else {
          var s = {}; VIEW_KEYS.forEach(function (k) { s[k] = st[k]; });
          var id = "v-" + Date.now().toString(36);
          mine.views.push({ id: id, name: n, s: s }); st.view = id;
        }
        pfSave(); close(); G.toast(mode === "rename" ? "View renamed to " + n + "." : "View " + n + " saved.", "ok"); G.rerender();
      } }] });
  }

  /* o: { ctx: "hm-pf" | "prj-pf", projects: [...], card(p) -> node, roles: bool, defaultLayout } */
  function portfolio(o) {
    var ctx = o.ctx;
    var st = pfState(ctx, o.defaultLayout);
    var all = o.projects;
    var archivedN = all.filter(function (p) { return p.status === "archived"; }).length;
    var q = (st.q || "").trim().toLowerCase();
    var ms = all.filter(function (p) { return st.archived || p.status !== "archived"; }).map(pfMetrics);
    var shown = ms.filter(function (m) {
      if (st.health !== "all" && m.health.id !== st.health) return false;
      if (st.team !== "all" && m.p.teams.indexOf(st.team) < 0) return false;
      if (st.tpl !== "all" && m.p.template !== st.tpl) return false;
      return !q || (m.p.name + " " + m.p.key + " " + (m.p.desc || "") + " " + m.p.id).toLowerCase().indexOf(q) >= 0;
    });
    var sorter = SORTS.find(function (s) { return s.id === st.sort; }) || SORTS[0];
    shown.sort(function (a, b) { var x = sorter.v(a), y = sorter.v(b); return (x > y ? 1 : x < y ? -1 : a.p.name < b.p.name ? -1 : 1) * (x === y ? 1 : st.dir); });
    function set(k, v) { st[k] = v; pfSave(); G.rerender(); }
    function setFocus(k, v, id) { set(k, v); setTimeout(function () { var el = document.getElementById(id); if (el) el.focus(); }, 40); }

    /* groups */
    var groups;
    if (st.group === "none") groups = [{ key: "all", label: null, items: shown }];
    else {
      var keyOf = st.group === "health" ? function (m) { return m.health.id; } : st.group === "team" ? function (m) { return m.team; } : function (m) { return m.p.template; };
      var labelOf = st.group === "health" ? function (k) { return HEALTH_LABEL[k] || k; } : st.group === "team" ? function (k) { var t = G.find.team(k); return t ? t.name : k; } : function (k) { var t = G.find.template(k); return t ? t.name : k; };
      var map = {}, order = [];
      shown.forEach(function (m) { var k = keyOf(m); if (!map[k]) { map[k] = []; order.push(k); } map[k].push(m); });
      if (st.group === "health") order.sort(function (a, b) { return HEALTH_ORDER[a] - HEALTH_ORDER[b]; }); else order.sort(function (a, b) { return labelOf(a) < labelOf(b) ? -1 : 1; });
      groups = order.map(function (k) { return { key: k, label: labelOf(k), items: map[k] }; });
    }

    /* toolbar */
    var search = h("input", { id: ctx + "-q", class: "input", type: "search", placeholder: "Name, key or description", value: st.q || "", "aria-label": "Search projects" });
    search.addEventListener("input", function () { st.q = search.value; pfSave(); G.rerender(); });
    var teams = G.store.get("teams"), tpls = G.store.get("templates");
    var views = pfViews(), curView = views.find(function (x) { return x.id === st.view; });
    var modified = pfModified(st);
    var viewSel = G.select(ctx + "-view", views.map(function (v) { return { value: v.id, label: v.name + (v.builtIn ? "" : " (saved)") }; }).concat(curView ? [] : [{ value: "", label: "Custom" }]), curView ? st.view : "", function (id) {
      var v = views.find(function (x) { return x.id === id; }); if (!v) return;
      VIEW_KEYS.forEach(function (k) { st[k] = v.s[k]; }); st.view = id; pfSave(); G.rerender();
      setTimeout(function () { var el = document.getElementById(ctx + "-view"); if (el) el.focus(); }, 40);
    }, { "aria-label": "Saved view" });
    var builtInReason = curView && curView.builtIn ? "Built-in views can't be renamed or deleted. Save a copy first." : null;
    var tools = h("div", { class: "pf-toolbar" },
      h("div", { class: "pf-views" },
        h("div", { class: "field pf-layout" }, h("span", { class: "field-label" }, "Layout"), G.segmented(ctx + "-layout", [{ id: "cards", label: "Cards" }, { id: "rows", label: "Rows" }], st.layout, function (v) { setFocus("layout", v, ctx + "-layout-" + v); }, "Portfolio layout")),
        G.field("View", viewSel),
        modified ? h("span", { class: "chip chip-warn pf-mod" }, "changed") : null,
        G.btn("Save as view", { small: true, icon: "plus", id: ctx + "-vsave", onClick: function () { viewDialog(st, "new"); } }),
        curView && !curView.builtIn && modified ? G.btn("Update " + curView.name, { small: true, id: ctx + "-vupd", onClick: function () { VIEW_KEYS.forEach(function (k) { curView.s[k] = st[k]; }); pfSave(); G.toast("View " + curView.name + " updated.", "ok"); G.rerender(); } }) : null,
        G.btn("Rename", { small: true, kind: "ghost", id: ctx + "-vren", disabledReason: builtInReason || (!curView ? "Pick a saved view first." : null), onClick: function () { viewDialog(st, "rename"); } }),
        G.btn("Delete", { small: true, kind: "ghost", icon: "x", id: ctx + "-vdel", disabledReason: builtInReason || (!curView ? "Pick a saved view first." : null), onClick: function () {
          var mine = pfMine(), nm = curView.name; mine.views = mine.views.filter(function (x) { return x.id !== curView.id; }); st.view = "v-all"; VIEW_KEYS.forEach(function (k) { st[k] = PF_BUILTIN[0].s[k]; }); pfSave(); G.toast("View " + nm + " deleted.", "ok"); G.rerender();
        } })),
      h("div", { class: "pf-filters" },
        G.field("Search", search),
        G.field("Group by", G.select(ctx + "-group", GROUPS.map(function (g) { return { value: g.id, label: g.label }; }), st.group, function (v) { setFocus("group", v, ctx + "-group"); })),
        h("div", { class: "field pf-sort" }, h("label", { class: "field-label", for: ctx + "-sort" }, "Sort"),
          h("div", { class: "pf-sort-row" }, G.select(ctx + "-sort", SORTS.map(function (s) { return { value: s.id, label: s.label }; }), st.sort, function (v) { setFocus("sort", v, ctx + "-sort"); }),
            G.btn(st.dir > 0 ? "Ascending" : "Descending", { small: true, kind: "ghost", icon: st.dir > 0 ? "up" : "down", id: ctx + "-dir", aria: "Sort direction: " + (st.dir > 0 ? "ascending" : "descending") + ". Select to flip.", onClick: function () { setFocus("dir", -st.dir, ctx + "-dir"); } }))),
        G.field("Health", G.select(ctx + "-health", [{ value: "all", label: "Any health" }].concat(Object.keys(HEALTH_LABEL).filter(function (k) { return k !== "archived" || st.archived; }).map(function (k) { return { value: k, label: HEALTH_LABEL[k] }; })), st.health, function (v) { setFocus("health", v, ctx + "-health"); })),
        G.field("Team", G.select(ctx + "-team", [{ value: "all", label: "Any team" }].concat(teams.map(function (t) { return { value: t.id, label: t.name }; })), st.team, function (v) { setFocus("team", v, ctx + "-team"); })),
        G.field("Template", G.select(ctx + "-tpl", [{ value: "all", label: "Any template" }].concat(tpls.map(function (t) { return { value: t.id, label: t.name }; })), st.tpl, function (v) { setFocus("tpl", v, ctx + "-tpl"); })),
        archivedN ? h("div", { class: "field pf-arch" }, h("span", { class: "field-label" }, "Archived"), h("label", { class: "check", for: ctx + "-arch" }, h("input", { type: "checkbox", id: ctx + "-arch", checked: !!st.archived, onChange: function (e) { setFocus("archived", e.target.checked, ctx + "-arch"); } }), "Show " + archivedN + " archived")) : null));

    var summary = h("p", { class: "small muted pf-sum", "aria-live": "polite" }, shown.length + " of " + all.length + " projects" + (archivedN && !st.archived ? " · " + archivedN + " archived hidden" : "") + (st.group !== "none" ? " · " + groups.length + " groups" : "") + " · sorted by " + sorter.label.toLowerCase() + (st.dir > 0 ? "" : ", descending") + ".");
    var body;
    if (!shown.length) body = G.emptyState({ id: ctx + "-empty", icon: "filter", title: all.length ? "No projects match" : "No projects yet", text: all.length ? "Clear the search or the filters, or show archived projects." : "Create one from a template.",
      action: all.length ? G.btn("Clear filters", { small: true, id: ctx + "-clear", onClick: function () { st.q = ""; st.health = "all"; st.team = "all"; st.tpl = "all"; pfSave(); G.rerender(); } }) : null });
    else body = h("div", { class: "pf-groups" + (st.layout === "rows" ? " pf-rows" : "") }, groups.map(function (g) {
      var inner = st.layout === "rows"
        ? G.dataTable({ id: ctx + "-t-" + g.key, caption: (g.label || "Projects") + " portfolio", columns: pfRowCols(ctx, o), rows: g.items, rowKey: function (m) { return m.p.id; }, empty: { title: "No projects", text: "" } })
        : h("div", { class: "hm-proj-grid" }, g.items.map(function (m) { return o.card(m.p, m); }));
      if (!g.label) return inner;
      var gates = g.items.reduce(function (a, m) { return a + m.gates; }, 0), wip = g.items.reduce(function (a, m) { return a + m.wip; }, 0);
      return h("section", { class: "pf-group", "aria-label": g.label },
        h("h3", { class: "pf-group-h" }, h("span", null, g.label), h("span", { class: "mono small muted" }, g.items.length + " project" + (g.items.length > 1 ? "s" : "") + " · " + wip + " WIP · " + gates + " gate" + (gates === 1 ? "" : "s") + " waiting")), inner);
    }));
    return h("div", { class: "pf pf-" + st.layout, id: ctx }, tools, summary, body);
  }
  G.portfolio = { render: portfolio, metrics: pfMetrics, effText: effText, covText: covText, card: function (p, m) { return projectCard(p, m); } };

  /* ---------- human attention (admin home) ---------- */
  var attnCache = { at: 0, v: null };
  function attnData() {
    if (attnCache.v && Date.now() - attnCache.at < 4000) return attnCache.v;
    var ppl = G.workload ? G.workload.people({ days: 7 }) : [];
    var waiting = ppl.filter(function (r) { return r.waiting > 0; }).sort(function (a, b) { return b.waiting - a.waiting; });
    var gates = waitingGates();
    var people = G.store.get("people").filter(function (x) { return x.status === "active" && !(x.roles.length === 1 && x.roles[0].role === "factory_admin"); });
    var sole = gates.filter(function (g) { return people.filter(function (x) { return G.gateDecision(x.id, g.wo, g.gate).allowed; }).length <= 1; }).length;
    var tr = G.store.get("trust") || { proposals: [], cells: [] };
    var props = tr.proposals.filter(function (x) { return x.status === "pending"; });
    var since = Date.now() - 7 * G.DAY, dem = [];
    tr.cells.forEach(function (c) { c.history.forEach(function (e) { if (e.kind === "demote" && e.at >= since) dem.push({ cell: c, e: e }); }); });
    dem.sort(function (a, b) { return b.e.at - a.e.at; });
    var lr = G.store.get("learning") || { proposals: [] };
    var lps = lr.proposals.filter(function (x) { return x.status === "proposed"; });
    attnCache = { at: Date.now(), v: { waiting: waiting, gates: gates, sole: sole, solePeople: ppl.filter(function (r) { return r.sole > 0; }).sort(function (a, b) { return b.sole - a.sole; }), props: props, dem: dem, lps: lps } };
    return attnCache.v;
  }
  function humanPanel() {
    var d = attnData();
    function link(route, label, id) { return G.canSeeRoute(route) ? h("a", { href: "#" + route, class: "linkish small", id: id }, label) : h("span", { class: "muted small", "data-tip": "You can't open " + label + " with your role.", tabindex: "0" }, label); }
    var top = d.waiting.slice(0, 4);
    return G.panel("Human attention", h("div", { class: "hm-hu" },
      h("div", { class: "hm-hu-sec" },
        h("div", { class: "hm-hu-head" }, h("span", { class: "sub-h" }, "Approvals waiting"), link("workload", "Workload", "hm-hu-workload")),
        h("dl", { class: "hm-hu-kpis" },
          h("div", null, h("dt", null, "Waiting"), h("dd", null, String(d.gates.length))),
          h("div", null, h("dt", null, "Oldest"), h("dd", null, d.gates.length ? G.fmt.dur(d.gates[0].age) : "none")),
          h("div", { class: d.sole ? "is-warn" : "", "data-tip": "Waiting gates that only one person (besides Factory Admins) may approve", tabindex: "0" }, h("dt", null, "One approver"), h("dd", null, String(d.sole)))),
        top.length ? h("ul", { class: "hm-hu-list" }, top.map(function (r) {
          var p = G.find.person(r.person);
          return h("li", null, h("span", null, p ? p.name : r.person), h("span", { class: "mono small" }, r.waiting + " waiting" + (r.sole ? " · sole on " + r.sole : "")), h("span", { class: "muted small mono" }, r.medianResponseMin != null ? "median " + G.fmt.dur(r.medianResponseMin * G.MIN) : "no history"));
        })) : h("p", { class: "muted small" }, "Nobody has approvals waiting.")),
      h("div", { class: "hm-hu-sec" },
        h("div", { class: "hm-hu-head" }, h("span", { class: "sub-h" }, "Trust"), link("trust", "Trust ladder", "hm-hu-trust")),
        h("p", { class: "small" }, h("strong", null, String(d.props.length)), " promotion proposal" + (d.props.length === 1 ? "" : "s") + " pending · ", h("strong", null, String(d.dem.length)), " demotion" + (d.dem.length === 1 ? "" : "s") + " in 7 days"),
        d.props.length || d.dem.length ? h("ul", { class: "hm-hu-list" },
          d.props.slice(0, 2).map(function (x) { var c = G.find.trustCell ? G.find.trustCell(x.cell) : null; return h("li", null, h("span", { class: "hm-hu-up", "aria-hidden": "true" }, "▲"), h("span", null, (c && G.trustCellLabel ? G.trustCellLabel(c) : x.cell)), h("span", { class: "mono small" }, "L" + x.from + " → L" + x.to)); }),
          d.dem.slice(0, 2).map(function (x) { return h("li", { class: "is-dem" }, h("span", { class: "hm-hu-down", "aria-hidden": "true" }, "▼"), h("span", null, (G.trustCellLabel ? G.trustCellLabel(x.cell) : x.cell.id) ), h("span", { class: "mono small" }, "L" + x.e.from + " → L" + x.e.to + " · " + G.fmt.ago(x.e.at))); })) : null),
      h("div", { class: "hm-hu-sec" },
        h("div", { class: "hm-hu-head" }, h("span", { class: "sub-h" }, "Learning"), link("learning", "Learning loop", "hm-hu-learning")),
        d.lps.length ? h("ul", { class: "hm-hu-list" }, d.lps.slice(0, 3).map(function (x) { return h("li", null, h("span", { class: "mono small" }, x.id), h("span", null, x.title), h("span", { class: "muted small" }, G.actorName(x.owner))); }))
          : h("p", { class: "muted small" }, "No learning proposals waiting for review."))),
      { cls: "hm-hu-panel", tools: h("span", { class: "mono small muted" }, d.props.length + d.lps.length + " to review") });
  }

  function activityPanel() {
    var CAT = { kill: "st-kill", approvals: "diamond", flow: "belt", onboarding: "rocket", auth: "user", access: "lock", config: "filter", integrations: "plug", api: "api", agents: "agent" };
    var list = G.store.get("audit").slice(-14).reverse();
    return G.panel("Live activity", h("ol", { class: "hm-act", "data-keep-scroll": "hm-act", tabindex: "0", "aria-label": "Latest audit entries" }, list.map(function (e) {
      var p = e.project && G.find.project(e.project);
      return h("li", { class: "hm-act-item hm-act-" + e.category },
        h("span", { class: "hm-act-ic" }, G.icon(CAT[e.category] || "dots")),
        h("div", { class: "hm-act-main" },
          h("div", null, h("strong", null, G.actorName(e.actor).replace(" (agent)", "")), " ", h("span", { class: "mono small" }, e.action), " ", h("span", null, e.target)),
          h("div", { class: "small muted" }, G.fmt.ago(e.at) + (p ? " · " + p.name : "") + " · via " + (e.via || "web"))),
        e.outcome !== "ok" ? h("span", { class: "outcome o-" + e.outcome }, e.outcome) : null);
    })), { tools: G.canSeeRoute("audit") ? h("a", { href: "#audit", class: "linkish small", id: "hm-audit-link" }, "Audit ledger") : null, cls: "hm-act-panel" });
  }

  function onboardingPanel() {
    var repos = G.store.get("repos").filter(function (r) { var p = G.find.project(r.project); return p && p.status !== "archived"; });
    var stages = G.ONBOARD_STAGES.map(function (s) { return s.id; });
    var counts = stages.map(function (s) { return repos.filter(function (r) { return r.onboarding.stage === s; }).length; });
    var stuck = repos.filter(function (r) { return r.onboarding.stage === "failed" || r.onboarding.stage === "person"; });
    var open = repos.filter(function (r) { return r.onboarding.stage !== "ready"; });
    return G.panel("Onboarding pipeline", h("div", null,
      h("ol", { class: "hm-pipe", "aria-label": "Repos per onboarding stage" }, stages.map(function (s, i) {
        return h("li", { class: "hm-pipe-st" + (counts[i] ? " has" : "") + (s === "ready" ? " is-ready" : "") }, h("span", { class: "hm-pipe-n" }, String(counts[i])), h("span", { class: "hm-pipe-l" }, STAGE_NAME[s]));
      })),
      stuck.length ? h("p", { class: "hm-pipe-stuck small" }, G.icon("alert"), stuck.length + " stuck: " + stuck.map(function (r) { return r.name + " (" + STAGE_NAME[r.onboarding.stage] + ")"; }).join(", ")) : null,
      open.length ? h("ul", { class: "hm-pipe-list" }, open.map(function (r) {
        var p = G.find.project(r.project);
        return h("li", null, h("button", { type: "button", class: "linkish mono", id: "hm-pipe-" + r.id, onClick: function () { goProject(p.id, "onboarding"); } }, r.name), h("span", { class: "muted small" }, p.name + " · " + STAGE_NAME[r.onboarding.stage]));
      })) : h("p", { class: "muted small" }, "Every repo is Ready.")),
      { tools: h("span", { class: "mono small muted" }, (repos.length - open.length) + " of " + repos.length + " ready") });
  }

  function bars(rows, idp) {
    var max = Math.max.apply(null, rows.map(function (r) { return Math.max(r.v, r.b); })) || 1;
    return h("ul", { class: "hm-bars" }, rows.map(function (r) {
      var ratio = r.b ? r.v / r.b : 0;
      var tone = r.b && ratio >= 1 ? "over" : r.b && ratio >= (r.alert || 0.85) ? "warn" : "ok";
      var tip = r.label + ": " + G.fmt.money0(r.v) + (r.b ? " of " + G.fmt.money0(r.b) + " budget (" + G.fmt.pct(ratio) + ")" : ", no budget set");
      return h("li", { class: "hm-bar-row is-" + tone, id: idp + r.id, tabindex: "0", "data-tip": tip, "aria-label": tip },
        h("span", { class: "hm-bar-l" }, r.label),
        h("span", { class: "hm-bar-track", "aria-hidden": "true" },
          h("span", { class: "hm-bar-fill", style: "width:" + (r.v / max * 100).toFixed(1) + "%" }),
          r.b ? h("span", { class: "hm-bar-budget", style: "left:" + (r.b / max * 100).toFixed(1) + "%" }) : null),
        h("span", { class: "hm-bar-v mono" }, tone !== "ok" ? G.icon("alert") : null, G.fmt.money0(r.v), h("span", { class: "muted" }, r.b ? " / " + G.fmt.money0(r.b) : "")));
    }));
  }
  function spendPanel() {
    var ps = G.store.get("projects").filter(function (p) { return p.status !== "archived"; });
    var vs = G.store.get("vendors");
    return G.panel("Spend this month", h("div", { class: "hm-spend" },
      h("div", null, h("div", { class: "sub-h" }, "By project · " + G.fmt.money0(ps.reduce(function (a, p) { return a + p.budget.mtd; }, 0)) + " of " + G.fmt.money0(ps.reduce(function (a, p) { return a + p.budget.monthly; }, 0))),
        bars(ps.map(function (p) { return { id: p.id, label: p.name, v: p.budget.mtd, b: p.budget.monthly, alert: p.budget.alertAt }; }), "hm-sp-")),
      h("div", null, h("div", { class: "sub-h" }, "By vendor · " + G.fmt.money0(vs.reduce(function (a, v) { return a + v.mtd; }, 0)) + " of " + G.fmt.money0(vs.reduce(function (a, v) { return a + v.budget; }, 0))),
        bars(vs.map(function (v) { return { id: v.id, label: v.name, v: v.mtd, b: v.budget }; }), "hm-sv-")),
      h("p", { class: "hm-bars-key small muted" }, h("span", { class: "hm-key-fill", "aria-hidden": "true" }), "spent  ", h("span", { class: "hm-key-budget", "aria-hidden": "true" }), "budget  ", G.icon("alert"), "at or over the alert line")),
      { cls: "hm-spend-panel" });
  }

  /* ---------- factory overview ---------- */
  function factoryView() {
    var all = G.store.get("workOrders");
    var live = all.filter(inFlight);
    var running = live.filter(function (w) { return w.state === "running"; }).length;
    var dayStart = G.istTime(G.istToday(0), "00:00");
    var shipped = all.filter(function (w) { return w.state === "done" && !w.split && w.doneAt; });
    var today = shipped.filter(function (w) { return w.doneAt >= dayStart; }).length;
    var week = shipped.filter(function (w) { return w.doneAt >= Date.now() - 7 * G.DAY; }).length;
    var gates = waitingGates();
    var lateN = gates.filter(function (g) { return g.late; }).length;
    var allP = G.store.get("projects");
    var projects = allP.filter(function (p) { return p.status !== "archived"; });
    var f = G.store.get("factory").killed;
    var stops = [];
    if (f) stops.push("factory");
    projects.forEach(function (p) { if (p.killed) stops.push(p.name + " killed"); if (p.halted) stops.push(p.name + " halted"); });
    G.store.get("repos").forEach(function (r) { if (r.halted) stops.push(r.name + " halted"); });
    var killedWO = all.filter(function (w) { return w.state === "killed"; }).length;
    var spent = projects.reduce(function (a, p) { return a + p.budget.mtd; }, 0), budget = projects.reduce(function (a, p) { return a + p.budget.monthly; }, 0);
    var cards = G.store.get("scorecards");
    var ids = Object.keys(cards);
    var success = ids.reduce(function (a, k) { return a + cards[k].taskSuccess; }, 0) / (ids.length || 1);
    var trend = ids.length ? cards[ids[0]].trend.success.map(function (_, i) { return ids.reduce(function (a, k) { return a + (cards[k].trend.success[i] || 0); }, 0) / ids.length; }) : [];
    var items = attention();
    var crit = items.filter(function (x) { return x.sev === 0; }).length;
    var sentence = (f ? "Factory killed. " : "Factory running. ") + projects.length + " projects, " + live.length + " work orders in flight, " + gates.length + " waiting on approvers" + (items.length ? ", " + items.length + " item" + (items.length > 1 ? "s" : "") + " need attention" : "") + ".";
    var org = G.store.get("org");
    return h("div", { class: "view hm" },
      G.pageHeader({ id: "hm-head", kicker: "Factory · " + org.plant, title: org.name + " factory", sub: sentence,
        meta: [["Signed in", G.viewer().name], ["Role", G.isFactoryAdmin(G.viewerId()) ? "Factory Admin" : "Auditor (read-only)"], ["Projects", projects.length + " active · " + (allP.length - projects.length) + " archived"]],
        actions: [G.btn("New project", { kind: "primary", icon: "plus", id: "hm-new-project", guard: G.me("project.create"), onClick: function () { G.homeKit.openWizard = true; location.hash = "projects"; } }),
          G.btn("My work", { kind: "ghost", icon: "user", id: "hm-to-mine", onClick: function () { ui.mode = "mine"; G.rerender(); } })] }),
      h("div", { class: "stats hm-kpis", role: "group", "aria-label": "Factory KPIs" },
        stat("In flight", String(live.length), running + " running · " + live.filter(function (w) { return w.bay; }).length + " in bays", null, "hm-kpi-flight"),
        stat("Shipped", today + " / " + week, "today / last 7 days", null, "hm-kpi-shipped"),
        stat("Gates waiting", String(gates.length), gates.length ? "oldest " + G.fmt.dur(gates[0].age) + (lateN ? " · " + lateN + " past SLA" : "") : "none", lateN ? "wait" : null, "hm-kpi-gates"),
        stat("Halted or killed", String(stops.length), stops.length ? stops.slice(0, 2).join(", ") + (stops.length > 2 ? " +" + (stops.length - 2) : "") : killedWO ? killedWO + " killed work orders" : "all running", stops.length ? "block" : null, "hm-kpi-stops"),
        h("div", { class: "stat hm-stat", id: "hm-kpi-spend" }, h("div", { class: "stat-k" }, "Spend vs budget"), h("div", { class: "stat-v" }, G.fmt.pct(spent / (budget || 1))), G.meter(spent, budget, "Factory spend this month", 0.8), h("div", { class: "stat-sub" }, G.fmt.money0(spent) + " of " + G.fmt.money0(budget))),
        h("div", { class: "stat hm-stat", id: "hm-kpi-success" }, h("div", { class: "stat-k" }, "Agent success"), h("div", { class: "stat-v" }, G.fmt.pct(success)), trend.length > 1 ? G.spark(trend, { w: 96, h: 20, label: "Agent success trend, latest " + G.fmt.pct(success) }) : null, h("div", { class: "stat-sub" }, "task success, " + ids.length + " agents"))),
      crit ? h("div", { class: "callout callout-block hm-crit", role: "status" }, G.icon("alert"), h("span", null, crit + " critical: " + items.filter(function (x) { return x.sev === 0; }).map(function (x) { return x.title; }).join(", ") + ".")) : null,
      h("div", { class: "hm-grid" + (pfState("hm-pf", "cards").layout === "rows" ? " hm-grid-wide" : "") },
        h("section", { class: "hm-projects", "aria-label": "Projects" },
          h("div", { class: "hm-sec-head" }, h("h2", { class: "panel-title" }, "Portfolio"), h("a", { href: "#projects", class: "linkish small", id: "hm-all-projects" }, "All projects and templates")),
          portfolio({ ctx: "hm-pf", projects: allP, card: projectCard, defaultLayout: "cards" }),
          h("p", { class: "hm-legend small muted" }, h("span", { class: "hm-lg-seg", "aria-hidden": "true" }), "station, darker = more WIP  ", h("span", { class: "hm-lg-gate", "aria-hidden": "true" }), "gate waiting  ", h("span", { class: "hm-lg-x", "aria-hidden": "true" }), "blocked work. Select a belt to open its floor."),
          spendPanel()),
        h("div", { class: "hm-side" }, controlPanel(), humanPanel(), attentionPanel(items))),
      h("div", { class: "hm-grid3" }, activityPanel(), onboardingPanel()));
  }

  /* ---------- My work ---------- */
  function myWork() {
    var me = G.viewer();
    var aps = G.myApprovals();
    var conv = G.awaitingMe();
    var mine = G.store.get("workOrders").filter(function (w) { return w.requestedBy === me.id && (inFlight(w) || (w.doneAt && w.doneAt > Date.now() - 7 * G.DAY) || w.state === "killed"); })
      .sort(function (a, b) { return (inFlight(b) ? 1 : 0) - (inFlight(a) ? 1 : 0) || b.createdAt - a.createdAt; });
    var projs = G.visibleProjects(me.id);
    var factoryRole = me.roles.some(function (g) { return g.scope === "factory"; });
    function approvalRow(a) {
      if (a.repo) {
        var pr = a.repo.onboarding.pr;
        return h("li", { class: "hm-my-row" }, G.icon("rocket", "hm-my-ic"), h("div", { class: "hm-my-main" }, h("div", null, "Merge onboarding PR " + a.repo.name + "#" + pr.number), h("div", { class: "muted small" }, G.find.project(a.repo.project).name + " · checks green")),
          G.btn("Open onboarding", { small: true, id: "hm-my-onb-" + a.repo.id, onClick: function () { goProject(a.repo.project, "onboarding"); } }));
      }
      var g = G.gateDef(a.gate);
      var p = G.find.project(a.wo.project);
      var prog = a.gate === "G0G1" ? null : G.gateProgress(p, a.wo, a.gate);
      return h("li", { class: "hm-my-row" }, G.gateDiamond({ gateId: a.gate, state: "waiting", count: prog ? prog.need - prog.have : 1, size: "sm" }),
        h("div", { class: "hm-my-main" }, h("div", null, h("span", { class: "mono" }, a.wo.id), " · ", g.label + " " + g.name), h("div", { class: "muted small" }, a.wo.title + " · " + p.name + (prog ? " · " + prog.have + " of " + prog.need + " approvals" : "") + " · waiting " + G.fmt.dur(Date.now() - waitSince(a.wo)))),
        h("div", { class: "hm-my-acts" },
          G.btn("Review", { small: true, kind: "ghost", id: "hm-my-open-" + a.wo.id + "-" + a.gate, onClick: function () { G.openTraveler(a.wo.id); } }),
          a.gate === "G0G1" ? null : G.btn(a.gate === "G6" ? "Confirm release" : "Approve", { small: true, kind: "primary", id: "hm-my-ok-" + a.wo.id + "-" + a.gate, guard: G.gateDecision(me.id, a.wo, a.gate), onClick: function () { var r = G.ops.approveGate(a.wo.id); G.toast(r.msg, r.ok ? "ok" : "error"); } })));
    }
    return h("div", { class: "view hm hm-mine" },
      G.pageHeader({ id: "hm-head", kicker: "Home · My work", title: "My work", sub: "What is waiting for " + me.name + " across " + projs.length + " project" + (projs.length === 1 ? "" : "s") + ".",
        meta: [["Signed in", me.name], ["On call", me.oncall ? "yes" : "no"], ["Away", me.away && me.away.to > Date.now() ? "until " + G.fmt.istDate(me.away.to) : "no"]],
        actions: [G.newWODialog ? G.btn("New work order", { kind: "primary", icon: "plus", id: "hm-my-new", guard: G.meAnyProject("wo.submit"), onClick: function () { G.newWODialog(); } }) : null,
          factoryRole ? G.btn("Factory overview", { kind: "ghost", icon: "home", id: "hm-to-factory", onClick: function () { ui.mode = "factory"; G.rerender(); } }) : null] }),
      h("div", { class: "stats hm-kpis hm-kpis-4", role: "group", "aria-label": "My work summary" },
        stat("My approvals", String(aps.length), aps.length ? "gates and PRs you may approve now" : "nothing waiting", aps.length ? "wait" : null, "hm-my-k1"),
        stat("My work orders", String(mine.filter(inFlight).length), "in flight · " + mine.filter(function (w) { return w.state === "done"; }).length + " shipped this week", null, "hm-my-k2"),
        stat("Questions for me", String(conv.length), "intake conversations and raised questions", conv.length ? "wait" : null, "hm-my-k3"),
        stat("My projects", String(projs.length), factoryRole ? "factory-wide role" : "where you hold a role", null, "hm-my-k4")),
      h("div", { class: "hm-my-grid" },
        G.panel("My approvals", aps.length ? h("ul", { class: "hm-my-list" }, aps.map(approvalRow)) : G.empty("No approvals waiting", "Gates you are allowed to approve, and onboarding PRs you may merge, appear here."), { tools: h("span", { class: "mono small muted" }, String(aps.length)) }),
        G.panel("Conversations awaiting my answers", conv.length ? h("ul", { class: "hm-my-list" }, conv.map(function (w) {
          var raised = w.conv.raised.filter(function (q) { return !q.answered; });
          var q = raised.length ? raised[0].text : (w.conv.questions[w.conv.qi] || {}).text;
          return h("li", { class: "hm-my-row" }, G.icon("chat", "hm-my-ic"), h("div", { class: "hm-my-main" }, h("div", null, h("span", { class: "mono" }, w.id), " · " + w.title), h("div", { class: "muted small" }, (q || "Confirm the brief") + " · " + G.find.project(w.project).name)),
            G.btn("Answer", { small: true, kind: "primary", id: "hm-my-conv-" + w.id, onClick: function () { G.store.update("prefs", function (p) { p.project = w.project; p.openConversation = w.id; }); location.hash = "conversations"; } }));
        })) : G.empty("No questions for you", "When the Intake agent or a later station needs your answer, it shows here.")),
        G.panel("My work orders", mine.length ? h("div", { class: "hm-my-toks" }, mine.map(function (w) {
          return h("div", { class: "hm-my-tok" }, G.woToken(w, { idPrefix: "hm-tok-" }), h("div", { class: "small muted" }, G.find.project(w.project).name + " · " + (w.bay ? (G.bayDef(w.bay) || { name: w.bay }).name : G.stationOf(w).no + " " + G.stationOf(w).name)));
        })) : G.empty("No work orders from you", "Work orders you submit appear here with their station and state.", G.newWODialog ? G.btn("New work order", { small: true, id: "hm-my-new2", guard: G.meAnyProject("wo.submit"), onClick: function () { G.newWODialog(); } }) : null), { cls: "hm-my-wos" }),
        G.panel("My projects", projs.length ? h("ul", { class: "hm-my-projs" }, projs.map(function (p) {
          var roles = G.rolesIn(me, p.id).map(function (r) { return G.find.role(r).name; });
          return h("li", { class: "hm-my-proj" },
            h("div", { class: "hm-proj-head" }, h("div", { class: "hm-proj-name" }, h("span", { class: "mono hm-key" }, p.key), h("h3", null, p.name)), healthChip(p)),
            h("div", { class: "small" }, h("span", { class: "kv-k" }, "Your roles here "), roles.map(function (r) { return G.chip(r, "chip-accent"); })),
            G.miniBelt({ project: p, onStation: function () { goProject(p.id, "floor"); } }),
            h("div", { class: "hm-proj-actions" }, G.btn("Floor", { small: true, icon: "belt", id: "hm-my-floor-" + p.id, onClick: function () { goProject(p.id, "floor"); }, aria: "Open the floor for " + p.name }),
              G.btn("Work orders", { small: true, kind: "ghost", id: "hm-my-wos-" + p.id, onClick: function () { goProject(p.id, "work-orders"); }, aria: "Work orders in " + p.name })));
        })) : G.empty("No projects yet", "Ask a Project Admin to add you to a project."))));
  }

  function render() {
    var me = G.viewer();
    var factoryRole = me && me.roles.some(function (g) { return g.scope === "factory"; });
    if (ui.who !== G.viewerId()) { ui.who = G.viewerId(); ui.mode = factoryRole ? "factory" : "mine"; }
    if (!factoryRole) ui.mode = "mine";
    return ui.mode === "factory" ? factoryView() : myWork();
  }

  G.views["home"] = {
    title: "Home",
    render: render,
    keys: ["workOrders", "projects", "repos", "audit", "vendors", "evalRuns", "integrations", "integrationInstances", "scorecards", "templates", "security", "trust", "learning", "teams"]
  };
})(window.G);
