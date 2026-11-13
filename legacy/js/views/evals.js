/* Evals: per-agent scorecards with hand-drawn trend charts, suites with run history and
   case results, simulated "Run suite", head-to-head of two runs (models or versions),
   regressions, promotion eligibility, and factory-wide views: agents x metrics, agents x
   projects heat grid, per-skill coverage, per-class performance, intake confusion table,
   onboarding success and time to ready, gate rejection reasons, human override rate. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "agents", agent: null, suite: null, run: null, a: null, b: null, running: null, runVersion: null, runModel: null };

  /* other views (agents) open a suite here */
  G.evalsFocus = function (o) { ui.tab = "suites"; if (o.agent) ui.agent = o.agent; if (o.suite) { ui.suite = o.suite; ui.run = null; ui.a = ui.b = null; } if (o.version) ui.runVersion = o.version; };

  function runsOf(suiteId) { return G.store.get("evalRuns").filter(function (r) { return r.suite === suiteId; }); }
  function weekLabels(n) { var out = []; for (var i = n - 1; i >= 0; i--) { var d = new Date(Date.now() - i * 7 * G.DAY + 330 * G.MIN); out.push(d.getUTCDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]); } return out; }
  function rowKeys(el, fn) { el.addEventListener("click", fn); el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } }); return el; }
  function passMark(p) { return p ? h("span", { class: "state state-done compact" }, G.icon("st-done"), h("span", { class: "sr" }, "Pass")) : h("span", { class: "state state-failed compact" }, G.icon("st-fail"), h("span", { class: "sr" }, "Fail")); }
  function connectedModels() { var out = []; G.store.get("vendors").forEach(function (v) { v.models.forEach(function (m) { if (v.connected && m.enabled) out.push({ value: m.id, label: m.name }); }); }); return out; }

  function regressions() {
    var s = G.store.get(), out = [];
    s.suites.forEach(function (su) {
      var ag = G.find.agent(su.agent); if (!ag) return;
      var live = ag.versions.find(function (v) { return v.live; }); if (!live) return;
      var runs = runsOf(su.id);
      var liveRuns = runs.filter(function (r) { return r.version === live.v; });
      var base = liveRuns[liveRuns.length - 1]; if (!base) return;
      var seen = {};
      runs.slice().reverse().forEach(function (r) {
        if (r.id === base.id || r.at < Date.now() - 14 * G.DAY) return;
        var key = r.version + "|" + r.model; if (seen[key]) return; seen[key] = true;
        if (r.score < base.score - 0.03 || (r.version === live.v && r.score < su.threshold)) out.push({ suite: su, run: r, base: base, delta: r.score - base.score, agent: ag });
      });
    });
    return out;
  }

  /* ---------- links to trust demotions and learning findings for an agent ---------- */
  function trustLearningFor(agentId) {
    var tr = G.store.get("trust"), L = G.store.get("learning");
    var vis = G.viewer() ? G.visibleProjects(G.viewerId()).map(function (p) { return p.id; }) : [];
    var since = Date.now() - 14 * G.DAY, dem = [];
    (tr ? tr.cells : []).forEach(function (c) { if (c.agent !== agentId || vis.indexOf(c.project) < 0) return; c.history.forEach(function (e) { if (e.kind === "demote" && e.at >= since) dem.push({ cell: c, e: e }); }); });
    var findings = (L ? L.findings : []).filter(function (f) { return f.agent === agentId && (!f.project || vis.indexOf(f.project) >= 0); });
    return { demotions: dem.sort(function (a, b) { return b.e.at - a.e.at; }), findings: findings };
  }
  function goTrust(cell) { if (G.trustFocus) G.trustFocus(cell ? { cell: cell.id } : { tab: "demotions" }); location.hash = "trust"; }
  function goFinding(f) { if (G.learningFocus) G.learningFocus({ finding: f.id }); location.hash = "learning"; }
  function linkedOutcomes(agentId, idp) {
    var x = trustLearningFor(agentId), out = [];
    if (x.demotions.length) out.push(h("button", { type: "button", class: "linkish", id: idp + "-dem", onclick: function () { goTrust(x.demotions.length === 1 ? x.demotions[0].cell : null); } }, x.demotions.length + " trust demotion" + (x.demotions.length > 1 ? "s" : "") + " in 14 days"));
    x.findings.filter(function (f) { return f.status === "open"; }).slice(0, 2).forEach(function (f) { out.push(h("button", { type: "button", class: "linkish", id: idp + "-f-" + f.id, onclick: function () { goFinding(f); } }, "Finding " + f.id + ": " + f.title)); });
    return out;
  }
  function outcomesPanel(a) {
    var x = trustLearningFor(a.id);
    return G.panel("Trust and learning", h("div", { class: "ev-tl" },
      h("h3", { class: "sub-h" }, "Trust demotions, 14 days"),
      x.demotions.length ? h("ul", { class: "plain-list small" }, x.demotions.map(function (d, i) { return h("li", null, h("span", { class: "mono" }, G.fmt.istDate(d.e.at) + " "), h("button", { type: "button", class: "linkish", id: "ev-tl-dem-" + i, onclick: function () { goTrust(d.cell); } }, G.trustCellLabel(d.cell)), " L" + d.e.from + " ▼ L" + d.e.to + ": " + d.e.reason); }))
        : h("p", { class: "small muted" }, "None. A suite regression does not demote by itself; post-release reverts, incidents and guardrail breaches do."),
      h("h3", { class: "sub-h" }, "Learning findings"),
      x.findings.length ? h("ul", { class: "plain-list small" }, x.findings.map(function (f) { return h("li", null, h("button", { type: "button", class: "linkish", id: "ev-tl-f-" + f.id, onclick: function () { goFinding(f); } }, f.id + " " + f.title), " · " + f.count + " signals · " + f.status); }))
        : h("p", { class: "small muted" }, "No findings point at this agent.")));
  }

  /* ---------- hand-drawn horizontal bars (labelled axes, faint grid, emphasised extreme) ----------
     o: { title, rows: [{ label, value, note? }], min, max, fmt, xLabel, threshold?, threshLabel?, emphasis: "min"|"max", ticks } */
  var hbars = G.barChart; /* shared horizontal bar chart (ui.js) */

  /* ---------- scorecards tab ---------- */
  var METRICS = [
    ["taskSuccess", "Task success", "pct", true], ["firstPass", "First-pass approval", "pct", true], ["testPass", "Test pass", "pct", true], ["rework", "Rework", "pct", false],
    ["costPerWO", "Cost / WO", "money", false], ["minutesPerStation", "Min / station", "min", false], ["gateRejections", "Gate rejections", "n", false], ["overrideRate", "Human override", "pct", false]
  ];
  function fmtMetric(kind, v) { return kind === "pct" ? G.fmt.pct(v) : kind === "money" ? G.fmt.money(v) : kind === "min" ? v + "m" : String(v); }

  function agentList(s) {
    return h("ul", { class: "ev-aglist", role: "listbox", "aria-label": "Agents" }, s.agents.map(function (a) {
      var su = G.find.suite(a.suite), c = s.scorecards[a.id];
      var below = su && a.evalScore < su.threshold;
      var b = h("li", { role: "option", tabindex: "0", id: "ev-ag-" + a.id, class: "ev-agitem" + (ui.agent === a.id ? " is-on" : ""), "aria-selected": ui.agent === a.id ? "true" : "false" },
        h("span", { class: "who" }, G.avatar(a.id, "sm"), h("span", { class: "ev-agname" }, a.name)),
        c ? G.spark(c.trend.success, { min: 0.5, max: 1, w: 60, h: 18, label: a.name + " success trend" }) : null,
        h("span", { class: "mono small" + (below ? " neg" : "") }, below ? "▼ " : "", G.fmt.pct(a.evalScore)));
      return rowKeys(b, function () { ui.agent = a.id; G.rerender(); });
    }));
  }

  function promoteRow(a, v, perm) {
    var el = G.agentEligibility(a, v);
    var g = !perm.allowed ? perm : !el.ok ? { allowed: false, needs: "Needs a passing run", reason: el.text + "." } : null;
    return h("li", { class: "ev-promo " + (el.ok ? "is-ok" : "is-blocked") },
      h("span", { class: "ev-promo-mark", "aria-hidden": "true" }, G.icon(el.ok ? "check" : "lock")),
      h("span", null, h("strong", null, a.name + " "), h("span", { class: "mono" }, v.v), v.live ? G.chip("on the floor", "chip-accent") : v.rc ? G.chip("candidate") : null, h("div", { class: "small " + (el.ok ? "pos" : "neg") }, el.text)),
      v.live ? h("span", { class: "muted small" }, "live") : G.btn("Promote", { small: true, kind: el.ok ? "primary" : null, icon: "rocket", id: "ev-promote-" + a.id + "-" + v.v.replace(/\W/g, ""), guard: g, onClick: function () { var r = G.ops.promoteAgent(a.id, v.v); G.toast(r.msg, r.ok ? "ok" : "error"); } }));
  }

  function agentsTab(s) {
    var a = G.find.agent(ui.agent) || s.agents[0]; ui.agent = a.id;
    var c = s.scorecards[a.id], su = G.find.suite(a.suite);
    var labels = weekLabels(8);
    var perm = G.me("agent.edit");
    var tiles = h("dl", { class: "ev-tiles" }, METRICS.map(function (m) {
      return h("div", { class: "ev-tile" }, h("dt", null, m[1]), h("dd", { class: "ev-big" }, c ? fmtMetric(m[2], m[0] === "costPerWO" ? c[m[0]] : m[2] === "pct" ? c[m[0]] : c[m[0]]) : "–"), h("dd", { class: "ev-dir small muted" }, m[3] ? "higher is better" : "lower is better"));
    }));
    var charts = c ? h("div", { class: "chart-pair" },
      G.areaChart({ title: a.name + ": task success by week", values: c.trend.success, labels: labels, fmt: function (v) { return G.fmt.pct(v); }, yLabel: "success rate", min: 0.5, max: 1, threshold: su ? su.threshold : null, threshLabel: su ? "gate " + G.fmt.pct(su.threshold) : null }),
      G.areaChart({ title: a.name + ": cost per work order by week", values: c.trend.cost, labels: labels, fmt: function (v) { return "$" + v.toFixed(2); }, yLabel: "USD per work order" })) : null;
    var runs = s.evalRuns.filter(function (r) { return r.agent === a.id; }).slice(-8);
    var suiteTrend = runs.length > 1 ? G.areaChart({ title: (su ? su.id : "Suite") + " score by run", values: runs.map(function (r) { return r.score; }), labels: runs.map(function (r) { return r.version; }), fmt: function (v) { return G.fmt.pct(v); }, yLabel: "suite score", min: 0.4, max: 1, threshold: su ? su.threshold : null, threshLabel: "gate" }) : null;
    var candidates = [];
    s.agents.forEach(function (x) { x.versions.forEach(function (v) { if (v.rc) candidates.push([x, v]); }); });
    return h("div", { class: "ev-agents" },
      G.panel("Agents", agentList(s), { flush: true, cls: "ev-aglist-panel" }),
      h("div", { class: "ev-agmain" },
        G.panel(a.name + " scorecard", h("div", null,
          h("p", { class: "small muted ev-p" }, "Live work over the last 7 days, version " + a.version + " on " + a.model + ". Suite " + (su ? su.id + ", gate " + G.fmt.pct(su.threshold) : "none") + "."),
          tiles), { tools: G.btn("Open suite", { small: true, icon: "eval", id: "ev-open-suite", onClick: function () { ui.tab = "suites"; ui.suite = a.suite; ui.run = null; ui.a = ui.b = null; G.rerender(); } }) }),
        charts,
        h("div", { class: "two-col" },
          suiteTrend ? G.panel("Suite history", suiteTrend) : G.panel("Suite history", G.emptyState({ icon: "eval", title: "Not enough runs", text: "Run the suite twice to see a trend." })),
          G.panel("Promotion eligibility", h("ul", { class: "ev-promos" }, a.versions.slice().reverse().map(function (v) { return promoteRow(a, v, perm); })))),
        outcomesPanel(a),
        G.panel("Candidates across the factory", candidates.length ? h("ul", { class: "ev-promos" }, candidates.map(function (p) { return promoteRow(p[0], p[1], perm); })) : G.emptyState({ icon: "agent", title: "No candidates", text: "Create a candidate version on an agent to see it here." }))));
  }

  /* ---------- suites tab ---------- */
  function suitesTable(s) {
    return h("div", { class: "table-scroll", "data-keep-scroll": "ev-suites" }, h("table", { class: "table table-compact" },
      h("thead", null, h("tr", null, ["Suite", "Cases", "Gate", "Last", "Runs"].map(function (x, i) { return h("th", { scope: "col", class: i >= 1 ? "num" : "" }, x); }))),
      h("tbody", null, s.suites.map(function (su) {
        var runs = runsOf(su.id), last = runs[runs.length - 1];
        var ag = G.find.agent(su.agent);
        var tr = h("tr", { class: "row-link" + (ui.suite === su.id ? " is-selected" : ""), tabindex: "0", id: "ev-su-" + su.id },
          h("td", null, h("div", { class: "mono strong ev-suid" }, su.id), h("div", { class: "small muted" }, ag ? ag.name : su.name)),
          h("td", { class: "num mono" }, String(su.cases.length)),
          h("td", { class: "num mono" }, G.fmt.pct(su.threshold)),
          h("td", { class: "num mono " + (last ? (last.score >= su.threshold ? "pos" : "neg") : "muted") }, last ? (last.score >= su.threshold ? "" : "▼ ") + G.fmt.pct(last.score) : "–"),
          h("td", { class: "num mono" }, String(runs.length)));
        return rowKeys(tr, function () { ui.suite = su.id; ui.run = null; ui.a = ui.b = null; G.rerender(); });
      }))));
  }

  function startRun(su, version, model) {
    var perm = G.me("eval.run");
    if (!perm.allowed || ui.running) return;
    var ag = G.find.agent(su.agent);
    var ver = ag.versions.find(function (v) { return v.v === version; }) || ag.versions[ag.versions.length - 1];
    ui.running = { suite: su.id, done: 0, total: su.cases.length, results: [] };
    G.rerender();
    var base = Math.min(0.97, Math.max(0.55, (ver.suiteScore || 0.8) + (model !== ag.model ? -0.05 : 0.02)));
    var reasons = ["Missed an acceptance criterion", "Touched a forbidden path", "Test did not fail on the bug", "Timed out after 15 min", "Missed the expected finding", "Diff exceeded size limit"];
    var iv = setInterval(function () {
      var c = su.cases[ui.running.done];
      var pass = Math.random() < base;
      ui.running.results.push({ caseId: c.id, pass: pass, reason: pass ? "" : reasons[Math.floor(Math.random() * reasons.length)], ms: Math.round(2000 + Math.random() * 50000) });
      ui.running.done++;
      if (ui.running.done < su.cases.length) { G.rerender(); return; }
      clearInterval(iv);
      var res = ui.running.results;
      var score = res.filter(function (x) { return x.pass; }).length / res.length;
      var prev = runsOf(su.id).filter(function (r) { return r.version === ver.v; }).pop();
      ui.running = null;
      var r = G.ops.runSuite(ag.id, su.id, ver.v, model, res);
      var ok = r.ok && r.pass;
      if (r.ok) { ui.run = r.run.id; ui.a = r.run.id; ui.b = prev ? prev.id : null; }
      G.toast(r.msg, r.ok ? (ok ? "ok" : "warn") : "error");
      G.rerender();
    }, G.reducedMotion() ? 30 : 150);
  }

  function suiteDetail(s) {
    var su = G.find.suite(ui.suite), ag = G.find.agent(su.agent);
    var runs = runsOf(su.id).slice().reverse();
    var perm = G.me("eval.run");
    if (!ui.runVersion || !ag.versions.some(function (v) { return v.v === ui.runVersion; })) ui.runVersion = (ag.versions.find(function (v) { return v.rc; }) || ag.versions[ag.versions.length - 1]).v;
    var models = connectedModels();
    if (!ui.runModel || !models.some(function (m) { return m.value === ui.runModel; })) ui.runModel = models.some(function (m) { return m.value === ag.model; }) ? ag.model : models[0].value;
    var verSel = G.select("ev-run-ver", ag.versions.map(function (v) { return { value: v.v, label: ag.name + " " + v.v + (v.live ? " (floor)" : v.rc ? " (candidate)" : " (retired)") }; }), ui.runVersion, function (v) { ui.runVersion = v; }, { disabled: !perm.allowed });
    var modelSel = G.select("ev-run-model", models, ui.runModel, function (v) { ui.runModel = v; }, { disabled: !perm.allowed });
    var running = ui.running && ui.running.suite === su.id;
    var progress = running ? h("div", { class: "run-progress", role: "status" },
      h("div", { class: "meter" }, h("span", { class: "meter-fill", style: "width:" + (ui.running.done / ui.running.total * 100).toFixed(0) + "%" })),
      h("span", { class: "mono small" }, ui.running.done + " / " + ui.running.total + " cases · " + ui.running.results.filter(function (x) { return x.pass; }).length + " passed")) : null;
    var runGuard = !perm.allowed ? perm : ui.running ? { allowed: false, needs: "", reason: "A run is already in progress on " + ui.running.suite + "." } : null;

    var hist = runs.length ? h("ul", { class: "run-list", "data-keep-scroll": "ev-runs" }, runs.map(function (r) {
      var b = h("button", { type: "button", class: "run-item" + (ui.run === r.id ? " is-on" : ""), id: "ev-run-" + r.id, onClick: function () { ui.run = r.id; G.rerender(); } },
        h("span", { class: "mono strong" }, r.id), h("span", { class: "mono" }, r.version), h("span", { class: "mono muted small ev-run-model" }, r.model),
        h("span", { class: "mono " + (r.score >= su.threshold ? "pos" : "neg") }, (r.score >= su.threshold ? "✓ " : "▼ ") + G.fmt.pct(r.score)), h("span", { class: "muted small" }, G.fmt.istDate(r.at)));
      return h("li", null, b);
    })) : G.emptyState({ icon: "eval", title: "No runs yet", text: "Run the suite to get a first score." });

    var sel = runs.find(function (r) { return r.id === ui.run; }) || runs[0];
    var caseName = function (id) { var c = su.cases.find(function (x) { return x.id === id; }); return c ? c.name : id; };
    var detail = sel ? h("div", null,
      h("div", { class: "run-head" }, h("span", { class: "mono strong" }, sel.id), h("span", null, (G.find.agent(sel.agent) || { name: sel.agent }).name + " " + sel.version + " on"), h("span", { class: "mono" }, sel.model),
        h("span", { class: "muted small" }, G.fmt.stamp(sel.at) + " · by " + G.actorName(sel.by) + " · " + G.fmt.money(sel.cost) + (sel.simulated ? " · simulated" : "")),
        h("span", { class: "decision-inline " + (sel.score >= su.threshold ? "pos" : "neg") }, G.icon(sel.score >= su.threshold ? "check" : "x"), G.fmt.pct(sel.score) + (sel.score >= su.threshold ? " passes " : " below ") + G.fmt.pct(su.threshold))),
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
        h("thead", null, h("tr", null, ["Case", "Result", "Reason", "Time"].map(function (x, i) { return h("th", { scope: "col", class: i === 3 ? "num" : "" }, x); }))),
        h("tbody", null, sel.results.map(function (r) {
          return h("tr", { class: r.pass ? "" : "ev-fail-row" }, h("td", null, h("span", { class: "mono muted" }, r.caseId + " "), caseName(r.caseId)),
            h("td", null, r.pass ? h("span", { class: "state state-done" }, G.icon("st-done"), h("span", null, "Pass")) : h("span", { class: "state state-failed" }, G.icon("st-fail"), h("span", null, "Fail"))),
            h("td", { class: "small" }, r.reason || h("span", { class: "muted" }, "–")),
            h("td", { class: "num mono" }, (r.ms / 1000).toFixed(1) + "s"));
        }))))) : null;

    return G.panel(su.id + " · " + su.name, h("div", null,
      G.lockNote(perm, "Running suites"),
      h("div", { class: "run-bar" },
        G.field("Version", verSel), G.field("Model", modelSel),
        G.btn(running ? "Running…" : "Run suite", { kind: "primary", icon: "play", id: "ev-run-btn", guard: runGuard, onClick: function () { startRun(su, ui.runVersion, ui.runModel); } }),
        progress || h("span", { class: "small muted" }, "Runs are simulated locally: " + su.cases.length + " golden cases, gate " + G.fmt.pct(su.threshold) + "."),
        G.btn("Add case", { icon: "plus", id: "ev-add-case", guard: perm, onClick: function () { addCaseDialog(su); } })),
      casesList(su),
      h("div", { class: "suite-split" }, h("div", null, h("h3", { class: "sub-h" }, "Run history"), hist), h("div", { class: "ev-run-detail" }, h("h3", { class: "sub-h" }, "Case results"), detail))), { cls: "ev-suite" });
  }

  function addCaseDialog(su) {
    var perm = G.me("eval.run");
    var name = h("input", { id: "ev-case-name", class: "input", placeholder: "e.g. Spec without a rollback section" });
    var checks = h("textarea", { id: "ev-case-checks", class: "input", rows: "3", placeholder: "What a passing answer must do" });
    var err = h("div", { class: "form-err", role: "alert" });
    if (!perm.allowed) { name.disabled = true; checks.disabled = true; }
    G.dialog({ title: "Add a case to " + su.id, kicker: "Evals · " + su.name, sub: "The case runs from the next suite run on. Existing runs keep their score. Audited.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Eval suites"), G.field("Case name", name, null, "ev-case-name"), G.field("What it checks", checks, null, "ev-case-checks"), err),
      actions: [{ label: "Cancel" }, { label: "Add case", kind: "primary", submit: true, id: "ev-case-ok", guard: perm, onClick: function (close) {
        var r = G.ops.addEvalCase(su.id, { name: name.value, checks: checks.value.trim() });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }
  function casesList(su) {
    return h("details", { class: "ev-cases", id: "ev-cases-" + su.id }, h("summary", null, su.cases.length + " cases in " + su.id),
      h("ol", { class: "plain-list small ev-case-list" }, su.cases.map(function (c) { return h("li", null, h("span", { class: "mono muted" }, c.id + " "), c.name, c.by ? h("span", { class: "muted" }, " · added " + G.fmt.istDate(c.added) + " by " + G.actorName(c.by)) : null); })));
  }

  function headToHead(s) {
    var su = G.find.suite(ui.suite);
    var runs = runsOf(su.id).slice().reverse();
    if (runs.length < 2) return G.panel("Head-to-head", G.emptyState({ icon: "swap", title: "Need two runs", text: "Run " + su.id + " with another version or model to compare." }));
    if (!ui.a || !runs.some(function (r) { return r.id === ui.a; })) ui.a = runs[0].id;
    var A0 = runs.find(function (r) { return r.id === ui.a; });
    if (!ui.b || !runs.some(function (r) { return r.id === ui.b; }) || ui.b === ui.a) ui.b = (runs.find(function (r) { return r.id !== ui.a && (r.model !== A0.model || r.version !== A0.version); }) || runs.find(function (r) { return r.id !== ui.a; })).id;
    var A = A0, B = runs.find(function (r) { return r.id === ui.b; });
    var opt = runs.map(function (r) { return { value: r.id, label: r.id + " · " + r.version + " · " + r.model + " · " + G.fmt.pct(r.score) }; });
    var onlyA = 0, onlyB = 0, both = 0, neither = 0;
    var rows = su.cases.map(function (c) {
      var ra = A.results.find(function (x) { return x.caseId === c.id; }) || { pass: false }, rb = B.results.find(function (x) { return x.caseId === c.id; }) || { pass: false };
      if (ra.pass && !rb.pass) onlyA++; else if (!ra.pass && rb.pass) onlyB++; else if (ra.pass) both++; else neither++;
      var diff = ra.pass !== rb.pass;
      return h("tr", { class: diff ? "row-diff" : "" }, h("td", null, h("span", { class: "mono muted" }, c.id + " "), c.name),
        h("td", null, passMark(ra.pass)), h("td", null, passMark(rb.pass)), h("td", { class: "small" }, diff ? (ra.pass ? "Only A passes" : "Only B passes") : neither && !ra.pass ? "Both fail" : ""));
    });
    var avg = function (r) { return r.results.reduce(function (t, x) { return t + x.ms; }, 0) / r.results.length / 1000; };
    function side(label, r) {
      return h("div", { class: "h2h-side" }, h("div", { class: "kicker" }, label + " · " + r.version), h("div", { class: "mono small" }, r.model), h("div", { class: "big-num" + (r.score >= su.threshold ? " pos" : " neg") }, G.fmt.pct(r.score)),
        h("div", { class: "small muted" }, avg(r).toFixed(1) + "s per case · " + G.fmt.money(r.cost)));
    }
    var delta = B.score - A.score;
    return G.panel("Head-to-head on " + su.id, h("div", null,
      h("div", { class: "form-row" }, G.field("A", G.select("h2h-a", opt, ui.a, function (v) { ui.a = v; G.rerender(); })), G.field("B", G.select("h2h-b", opt.map(function (o) { return { value: o.value, label: o.label, disabled: o.value === ui.a }; }), ui.b, function (v) { ui.b = v; G.rerender(); }))),
      h("div", { class: "h2h-sum" }, side("A", A),
        h("div", { class: "h2h-mid mono small" }, h("div", { class: "ev-delta " + (delta >= 0 ? "pos" : "neg") }, (delta >= 0 ? "+" : "") + G.fmt.pct(delta) + " B vs A"), both + " both pass", h("br"), onlyA + " only A", h("br"), onlyB + " only B", h("br"), neither + " both fail"),
        side("B", B)),
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" }, h("thead", null, h("tr", null, h("th", { scope: "col" }, "Case"), h("th", { scope: "col" }, "A"), h("th", { scope: "col" }, "B"), h("th", { scope: "col" }, "Difference"))), h("tbody", null, rows)))), { cls: "ev-h2h" });
  }

  function suitesTab(s) {
    if (!ui.suite || !G.find.suite(ui.suite)) ui.suite = (G.find.agent(ui.agent) || s.agents[0]).suite;
    return h("div", { class: "ev-suites" },
      G.panel("Eval suites", suitesTable(s), { flush: true, cls: "ev-suites-list" }),
      h("div", { class: "ev-suites-main" }, suiteDetail(s), headToHead(s)));
  }

  /* ---------- factory tab ---------- */
  function matrix(s) {
    var agents = s.agents.filter(function (a) { var c = s.scorecards[a.id]; return c && c.taskSuccess > 0; });
    var ranges = METRICS.map(function (m) { var vals = agents.map(function (a) { return s.scorecards[a.id][m[0]]; }); return [Math.min.apply(null, vals), Math.max.apply(null, vals)]; });
    return h("div", { class: "table-scroll", "data-keep-scroll": "ev-matrix" }, h("table", { class: "table table-compact ev-matrix" },
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Agent"), METRICS.map(function (m) { return h("th", { scope: "col", class: "num" }, m[1], h("span", { class: "ev-dir-h", "aria-label": m[3] ? "higher is better" : "lower is better" }, m[3] ? " ↑" : " ↓")); }))),
      h("tbody", null, s.agents.map(function (a) {
        var c = s.scorecards[a.id];
        var tr = h("tr", { class: "row-link", tabindex: "0", id: "ev-mx-" + a.id },
          h("th", { scope: "row" }, a.name),
          METRICS.map(function (m, i) {
            if (!c || !c.taskSuccess) return h("td", { class: "num muted" }, "–");
            var v = c[m[0]], r = ranges[i], g = r[1] === r[0] ? 0.5 : (v - r[0]) / (r[1] - r[0]);
            if (!m[3]) g = 1 - g;
            return h("td", { class: "num mono ev-cell" + (g >= 0.999 ? " is-best" : g <= 0.001 ? " is-worst" : ""), style: "--g:" + g.toFixed(2), title: m[1] + ": " + fmtMetric(m[2], v) + (g >= 0.999 ? " (best)" : g <= 0.001 ? " (worst)" : "") }, fmtMetric(m[2], v));
          }));
        return rowKeys(tr, function () { ui.tab = "agents"; ui.agent = a.id; G.rerender(); });
      }))));
  }

  function heatGrid(s) {
    var heat = s.evalExtra.heat || {};
    var projects = s.projects.filter(function (p) { return p.status !== "archived"; });
    return h("div", { class: "table-scroll", "data-keep-scroll": "ev-heat" }, h("table", { class: "table table-compact ev-heat" },
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Agent"), projects.map(function (p) { return h("th", { scope: "col", class: "num" }, p.name, p.regulated ? h("span", { class: "tag" }, "reg") : null); }))),
      h("tbody", null, s.agents.map(function (a) {
        var su = G.find.suite(a.suite), th = su ? su.threshold : 0.85;
        return h("tr", null, h("th", { scope: "row" }, a.name), projects.map(function (p) {
          var v = heat[a.id] ? heat[a.id][p.id] : null;
          if (v == null) return h("td", { class: "num ev-hcell is-none", title: a.name + " has no work on " + p.name }, "–");
          var below = v < th;
          return h("td", { class: "num mono ev-hcell" + (below ? " is-below" : ""), style: "--v:" + Math.max(0, (v - 0.5) / 0.5).toFixed(2), title: a.name + " on " + p.name + ": " + G.fmt.pct(v) + (below ? ", below gate " + G.fmt.pct(th) : "") }, below ? "▼ " : "", G.fmt.pct(v));
        }));
      }))));
  }

  function confusion(s) {
    var cf = s.evalExtra.confusion || {};
    var ids = Object.keys(cf);
    var colTot = {}, total = 0, diag = 0, maxOff = 1, maxDiag = 1;
    ids.forEach(function (p) { colTot[p] = 0; });
    ids.forEach(function (t) { ids.forEach(function (p) { var n = cf[t][p]; colTot[p] += n; total += n; if (t === p) { diag += n; maxDiag = Math.max(maxDiag, n); } else maxOff = Math.max(maxOff, n); }); });
    var table = h("div", { class: "table-scroll", "data-keep-scroll": "ev-conf" }, h("table", { class: "table table-compact ev-conf" },
      h("thead", null, h("tr", null, h("th", { scope: "col", class: "ev-conf-corner" }, h("span", null, "Actual ↓"), h("span", null, "Predicted →")),
        ids.map(function (p) { return h("th", { scope: "col", class: "num" }, G.classChip(p, { small: true })); }), h("th", { scope: "col", class: "num" }, "Recall"))),
      h("tbody", null, ids.map(function (t) {
        var rowTot = ids.reduce(function (n, p) { return n + cf[t][p]; }, 0);
        return h("tr", null, h("th", { scope: "row" }, G.classChip(t, { small: true })),
          ids.map(function (p) {
            var n = cf[t][p], isD = t === p;
            var v = isD ? n / maxDiag : n / maxOff;
            return h("td", { class: "num mono ev-cf" + (isD ? " is-diag" : n ? " is-off" : " is-zero"), style: "--v:" + v.toFixed(2), title: G.find.cls(t).name + " classified as " + G.find.cls(p).name + ": " + n }, n ? String(n) : "·");
          }),
          h("td", { class: "num mono" + (rowTot && cf[t][t] / rowTot < 0.85 ? " neg" : "") }, rowTot ? G.fmt.pct(cf[t][t] / rowTot) : "–"));
      }),
        h("tr", { class: "ev-conf-foot" }, h("th", { scope: "row" }, "Precision"), ids.map(function (p) { var pr = colTot[p] ? cf[p][p] / colTot[p] : 0; return h("td", { class: "num mono" + (pr < 0.85 ? " neg" : "") }, colTot[p] ? G.fmt.pct(pr) : "–"); }), h("td", { class: "num mono strong" }, G.fmt.pct(diag / total))))));
    var worst = null;
    ids.forEach(function (t) { ids.forEach(function (p) { if (t !== p && (!worst || cf[t][p] > worst[2])) worst = [t, p, cf[t][p]]; }); });
    return h("div", null,
      h("p", { class: "small ev-p" }, "Labelled sample of " + total + " requests. Accuracy ", h("strong", { class: "mono" }, G.fmt.pct(diag / total)), ". Most common mistake: " + G.find.cls(worst[0]).name + " read as " + G.find.cls(worst[1]).name + " (" + worst[2] + "). Overrides by submitters: ", h("strong", { class: "mono" }, G.fmt.pct(s.evalExtra.overrideRate || 0)), "."),
      table);
  }

  function perClass(s) {
    var pc = s.evalExtra.perClass || {};
    var ids = Object.keys(pc);
    var chart = hbars({ title: "Success rate by work class", rows: ids.map(function (c) { return { label: G.find.cls(c).name, value: pc[c].success, note: "n=" + pc[c].count }; }), min: 0.5, max: 1, fmt: function (v) { return G.fmt.pct(v); }, xLabel: "work orders shipped without rework, last 30 days", threshold: 0.85, threshLabel: "target 85%", emphasis: "min", ticks: 5 });
    var table = h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
      h("thead", null, h("tr", null, ["Class", "Work orders", "Success", "Median cycle", "Rework"].map(function (x, i) { return h("th", { scope: "col", class: i ? "num" : "" }, x); }))),
      h("tbody", null, ids.map(function (c) {
        var x = pc[c];
        return h("tr", null, h("td", null, G.classChip(c, { small: true })), h("td", { class: "num mono" }, String(x.count)), h("td", { class: "num mono" + (x.success < 0.85 ? " neg" : "") }, G.fmt.pct(x.success)),
          h("td", { class: "num mono" }, x.cycleH >= 48 ? (x.cycleH / 24).toFixed(1) + "d" : x.cycleH + "h"), h("td", { class: "num mono" + (x.rework > 0.2 ? " neg" : "") }, G.fmt.pct(x.rework)));
      }))));
    return h("div", { class: "ev-pc" }, chart, table);
  }

  function onboarding(s) {
    var o = s.evalExtra.onboarding || { attempts: 0, ready: 0, successRate: 0, medianDays: 0, p90Days: 0, failedReasons: [] };
    var stages = G.ONBOARD_STAGES.map(function (x) { return x.id; }).concat(["failed", "person"]);
    var counts = {}; stages.forEach(function (x) { counts[x] = 0; });
    s.repos.forEach(function (r) { if (counts[r.onboarding.stage] != null) counts[r.onboarding.stage]++; });
    var total = s.repos.length || 1;
    var LBL = { connected: "Connected", assessed: "Assessed", pr_opened: "PR opened", pr_checks: "PR checks", pr_merged: "PR merged", verified: "Verified", ready: "Ready", failed: "Failed", person: "Needs a person" };
    return h("div", { class: "ev-onb" },
      h("dl", { class: "ev-tiles ev-tiles-4" },
        h("div", { class: "ev-tile" }, h("dt", null, "Success rate"), h("dd", { class: "ev-big" }, G.fmt.pct(o.successRate)), h("dd", { class: "small muted" }, o.ready + " of " + o.attempts + " attempts reached Ready")),
        h("div", { class: "ev-tile" }, h("dt", null, "Median time to ready"), h("dd", { class: "ev-big" }, o.medianDays + "d"), h("dd", { class: "small muted" }, "connect to Ready")),
        h("div", { class: "ev-tile" }, h("dt", null, "p90 time to ready"), h("dd", { class: "ev-big" }, o.p90Days + "d"), h("dd", { class: "small muted" }, "slowest tenth")),
        h("div", { class: "ev-tile" }, h("dt", null, "In the pipeline now"), h("dd", { class: "ev-big" }, String(s.repos.length - counts.ready)), h("dd", { class: "small muted" }, "of " + s.repos.length + " repos"))),
      h("div", { class: "ev-stack", role: "img", "aria-label": "Repos by onboarding stage: " + stages.filter(function (x) { return counts[x]; }).map(function (x) { return LBL[x] + " " + counts[x]; }).join(", ") },
        stages.filter(function (x) { return counts[x]; }).map(function (x) { return h("span", { class: "ev-stk ev-stk-" + x, style: "flex:" + counts[x] + " 1 0", title: LBL[x] + ": " + counts[x] }, h("span", { class: "ev-stk-l" }, LBL[x] + " " + counts[x])); })),
      h("p", { class: "small mono ev-stk-legend" }, stages.filter(function (x) { return counts[x]; }).map(function (x) { return LBL[x] + " " + counts[x]; }).join(" · ")),
      h("p", { class: "small muted" }, Math.round(counts.ready / total * 100) + "% of connected repos are Ready. ", h("a", { href: "#onboarding", class: "linkish", id: "ev-goto-onb" }, "Open onboarding")),
      o.failedReasons.length ? h("div", null, h("h3", { class: "sub-h" }, "Why onboarding failed"), h("ul", { class: "plain-list small" }, o.failedReasons.map(function (r) { return h("li", null, h("span", { class: "mono" }, r[1] + "× "), r[0]); }))) : null);
  }

  function skillCoverage(s) {
    return h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
      h("thead", null, h("tr", null, ["Skill", "Version", "Used by", "Cases", "Pass", "Coverage"].map(function (x, i) { return h("th", { scope: "col", class: i >= 2 ? "num" : "" }, x); }))),
      h("tbody", null, s.skills.map(function (sk) {
        var n = s.agents.filter(function (a) { return a.skills.indexOf(sk.id) >= 0; }).length;
        var p = sk.coverage.cases ? sk.coverage.pass / sk.coverage.cases : 0;
        var low = !sk.coverage.cases || p < 0.85;
        return h("tr", null, h("td", null, h("a", { href: "#skills", class: "linkish", id: "ev-sk-" + sk.id }, sk.name)), h("td", { class: "mono small" }, "v" + sk.version), h("td", { class: "num mono" }, String(n)),
          h("td", { class: "num mono" }, String(sk.coverage.cases)), h("td", { class: "num mono" }, String(sk.coverage.pass)),
          h("td", { class: "num" }, h("span", { class: "ev-cov" + (low ? " is-low" : "") }, h("span", { class: "ev-cov-bar", "aria-hidden": "true" }, h("span", { style: "width:" + (p * 100).toFixed(0) + "%" })), h("span", { class: "mono small" }, (low ? "▼ " : "") + (sk.coverage.cases ? G.fmt.pct(p) : "none")))));
      }))));
  }

  function factoryTab(s) {
    var ex = s.evalExtra;
    var live = s.agents.filter(function (a) { var c = s.scorecards[a.id]; return c && c.taskSuccess > 0; });
    var avg = [], avgCost = [];
    for (var w = 0; w < 8; w++) {
      avg.push(live.reduce(function (t, a) { return t + s.scorecards[a.id].trend.success[w]; }, 0) / live.length);
      avgCost.push(live.reduce(function (t, a) { return t + s.scorecards[a.id].trend.cost[w]; }, 0));
    }
    var labels = weekLabels(8);
    var gr = (ex.gateRejections || []).map(function (r) { return { label: r[0], value: r[1] }; });
    var ho = Object.keys(ex.humanOverride || {}).map(function (g) { var d = G.gateDef(g); return { label: (d ? d.label + " " + d.name : g), value: ex.humanOverride[g] }; });
    return h("div", { class: "ev-factory" },
      h("div", { class: "chart-pair" },
        G.areaChart({ title: "Factory task success, all agents", values: avg, labels: labels, fmt: function (v) { return G.fmt.pct(v); }, yLabel: "mean success rate", min: 0.5, max: 1, threshold: 0.85, threshLabel: "target 85%" }),
        G.areaChart({ title: "Cost per work order, summed across stations", values: avgCost, labels: labels, fmt: function (v) { return "$" + v.toFixed(2); }, yLabel: "USD per work order" })),
      G.panel("Agents × metrics", h("div", null, h("p", { class: "small muted ev-p" }, "Shading runs from worst to best in each column. Best is marked ▲, worst ▼. Select a row for the agent's scorecard."), matrix(s)), { cls: "ev-mx-panel" }),
      G.panel("Agents × projects", h("div", null, h("p", { class: "small muted ev-p" }, "Task success per agent on each project, last 30 days. ▼ marks a score below the agent's gate."), heatGrid(s))),
      h("div", { class: "two-col ev-two" },
        G.panel("Per-class performance", perClass(s)),
        G.panel("Onboarding", onboarding(s))),
      G.panel("Intake classification", confusion(s)),
      G.panel("Per-skill eval coverage", skillCoverage(s), { flush: true }),
      h("div", { class: "two-col ev-two" },
        G.panel("Gate rejection reasons", hbars({ title: "Rejections by reason, last 30 days", rows: gr, min: 0, fmt: function (v) { return String(Math.round(v)); }, xLabel: "rejections", emphasis: "max", ticks: 4 })),
        G.panel("Human override rate", h("div", null, hbars({ title: "Agent recommendation overridden at each human gate", rows: ho, min: 0, max: 0.15, fmt: function (v) { return G.fmt.pct(v); }, xLabel: "share of decisions where the human went against the agent", threshold: 0.1, threshLabel: "review at 10%", emphasis: "max", ticks: 3 }),
          h("p", { class: "small muted" }, "High override at a gate means the agent before it is often wrong, or the approvers want something it was never told.")))));
  }

  function render() {
    var s = G.store.get();
    if (!ui.agent || !G.find.agent(ui.agent)) ui.agent = "ag-build";
    if (!G.find.agent(ui.agent)) ui.agent = s.agents[0].id;
    var regs = regressions();
    var eligible = 0; s.agents.forEach(function (a) { a.versions.forEach(function (v) { if (v.rc && G.agentEligibility(a, v).ok) eligible++; }); });
    var body = ui.tab === "suites" ? suitesTab(s) : ui.tab === "factory" ? factoryTab(s) : agentsTab(s);
    return h("div", { class: "view view-evals" },
      G.pageHeader({ id: "ev-head", kicker: "Agents · Sheet 16", title: "Evals", sub: "How well each agent does its job, on golden suites and on live work. Suite runs here are simulated locally.",
        meta: [["Suites", String(s.suites.length)], ["Runs", String(s.evalRuns.length)], ["Regressions", String(regs.length)], ["Candidates eligible", String(eligible)], ["Override rate", G.fmt.pct(s.evalExtra.overrideRate || 0)]] }),
      regs.length ? h("div", { class: "callout callout-fail ev-regs", role: "note" }, G.icon("st-fail"), h("div", null, h("strong", null, regs.length + " regression" + (regs.length > 1 ? "s" : "") + " in the last 14 days. "),
        h("ul", { class: "plain-list" }, regs.map(function (r, i) {
          return h("li", null, h("button", { type: "button", class: "linkish", id: "ev-reg-" + i, onClick: function () { ui.tab = "suites"; ui.suite = r.suite.id; ui.run = r.run.id; ui.a = r.run.id; ui.b = r.base.id; G.rerender(); } },
            r.suite.id + ": " + r.agent.name + " " + r.run.version + " on " + r.run.model + " scored " + G.fmt.pct(r.run.score) + " vs " + G.fmt.pct(r.base.score) + " for the floor version (" + (r.delta >= 0 ? "+" : "") + G.fmt.pct(r.delta) + "). Compare"),
            linkedOutcomes(r.agent.id, "ev-reg-" + i).map(function (n) { return h("span", { class: "ev-reg-link" }, " · ", n); }));
        })))) : null,
      G.tabBar({ id: "ev-tab", items: [{ id: "agents", label: "Scorecards" }, { id: "suites", label: "Suites and runs", count: s.suites.length }, { id: "factory", label: "Factory-wide" }], active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      body);
  }

  G.views.evals = { title: "Evals", render: render, keys: ["evalRuns", "suites", "agents", "scorecards", "vendors", "skills", "evalExtra", "repos", "projects", "trust", "learning"] };
})(window.G);
