/* Trust ladder (#trust): earned autonomy per agent x work class x project (optionally repo).
   Ladder matrix with level, evidence count and ceiling marker per cell; cell detail with evidence,
   history, criteria for the next level and the distance to it; promotion proposals with approve and
   decline; demotions with cause; ceilings, promotion criteria and the L2 sample rate; projection of
   human approvals saved per week. Reads G.trust (insight.js); every change goes through G.ops. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var MIN_RUNS = 5; /* below this many finished runs a rate is shown as insufficient data */
  var ui = { tab: "ladder", project: null, repo: "", sel: null, propFilter: "pending", demoFilter: "all", hiProposal: null };

  /* other views deep-link here: G.trustFocus({ cell, proposal, project, cls, agent, tab }) */
  G.trustFocus = function (o) {
    o = o || {};
    var cell = o.cell ? G.find.trustCell(o.cell) : null;
    var prop = o.proposal ? G.store.get("trust").proposals.find(function (x) { return x.id === o.proposal; }) : null;
    if (prop && !cell) cell = G.find.trustCell(prop.cell);
    if (cell) { ui.project = cell.project; ui.repo = cell.repo || ""; ui.sel = { agent: cell.agent, cls: cell.cls }; }
    else if (o.project) { ui.project = o.project; ui.repo = ""; if (o.cls) ui.sel = { agent: o.agent || null, cls: o.cls }; }
    if (prop) { ui.tab = "proposals"; ui.propFilter = prop.status === "pending" ? "pending" : "all"; ui.hiProposal = prop.id; }
    else ui.tab = o.tab || "ladder";
  };

  function S() { return G.store.get(); }
  function projName(id) { return (G.find.project(id) || { name: id }).name; }
  function agName(id) { return (G.find.agent(id) || { name: id }).name; }
  function clsName(id) { return (G.find.cls(id) || { name: id }).name; }
  function visProjects() { return G.viewer() ? G.visibleProjects(G.viewerId()).filter(function (p) { return p.status !== "archived"; }) : []; }
  function visIds() { return visProjects().map(function (p) { return p.id; }); }
  function gateForAgent(agent) { return G.GATES.find(function (g) { return g.id !== "G0G1" && G.trustAgentFor(g.id) === agent; }); }
  function lv(n) { return G.trust.level(n); }
  function code(n) { return "L" + n; }
  function pct(x) { return Math.round(x * 100) + "%"; }

  /* level glyph: four rungs filled up to the level, so the level reads by shape as well as colour */
  function rungs(level, cls) {
    return h("span", { class: "tr-rungs lvl-" + level + (cls ? " " + cls : ""), "aria-hidden": "true" }, [1, 2, 3, 4].map(function (i) { return h("span", { class: "tr-rung" + (i <= level ? " is-on" : "") }); }));
  }
  function levelTag(level, extra) {
    return h("span", { class: "tr-lvl lvl-" + level + (extra ? " " + extra : ""), title: code(level) + " " + lv(level).name }, rungs(level), h("span", { class: "mono" }, code(level)), h("span", { class: "tr-lvl-name" }, lv(level).name));
  }
  /* a rate with its sample size; "insufficient data" for small counts */
  function rate(value, n, opts) {
    opts = opts || {};
    if (!n || n < (opts.min || MIN_RUNS)) return h("span", { class: "tr-rate is-thin" }, h("span", { class: "muted" }, "insufficient data"), h("span", { class: "mono small muted" }, " n=" + (n || 0)));
    return h("span", { class: "tr-rate" }, h("span", { class: "mono" }, opts.fmt ? opts.fmt(value) : pct(value)), h("span", { class: "mono small muted" }, " n=" + n));
  }

  /* rows of the ladder for a project: one per agent judged at a human or mixed gate in its flow */
  function ladderRows(p) {
    var flow = G.flowOf(p), rows = [], seen = {};
    flow.gates.forEach(function (g) {
      if (g.id === "G0G1" || !g.enabled || g.mode === "auto") return;
      var ag = G.trustAgentFor(g.id); if (!ag || seen[ag]) return;
      seen[ag] = 1; rows.push({ agent: ag, gate: g });
    });
    S().trust.cells.forEach(function (c) { if (c.project === p.id && !seen[c.agent]) { seen[c.agent] = 1; var g = gateForAgent(c.agent); rows.push({ agent: c.agent, gate: g ? Object.assign({ mode: "off" }, g) : null, off: true }); } });
    return rows;
  }
  /* the cell in force for (agent, cls) in the current filter, or a virtual default cell */
  function cellFor(agent, cls, projectId, repo) {
    var c = G.trust.cell(agent, cls, projectId, repo || null);
    if (c) return { cell: c, virtual: false, inherited: !!(repo && !c.repo) };
    return { cell: { id: G.trustCellId(agent, cls, projectId, repo || null), agent: agent, cls: cls, project: projectId, repo: repo || null, level: 1, cleanRuns: 0, history: [] }, virtual: true, inherited: false };
  }
  function pendingFor(cellId) { return S().trust.proposals.find(function (x) { return x.cell === cellId && x.status === "pending"; }); }
  function recentDemotion(c) { var d = Date.now() - 7 * G.DAY; return (c.history || []).slice().reverse().find(function (e) { return e.kind === "demote" && e.at >= d; }); }
  function targetOf(info) { return info.virtual ? { agent: info.cell.agent, cls: info.cell.cls, project: info.cell.project, repo: info.cell.repo } : info.cell.id; }

  /* ---------------- ladder ---------------- */
  function matrix(p) {
    var flow = G.flowOf(p), rows = ladderRows(p);
    var classes = flow.classes;
    if (!rows.length) return G.emptyState({ id: "tr-matrix-empty", icon: "trust", title: "No human gates in this flow", text: "Every gate in " + p.name + " is automatic, so there is nothing for trust to replace." });
    var table = h("table", { class: "tr-matrix", id: "tr-matrix" },
      h("caption", { class: "sr-only" }, "Trust level per agent and work class on " + p.name),
      h("thead", null, h("tr", null, h("th", { scope: "col", class: "tr-corner" }, h("span", null, "Agent · gate judged"), h("span", null, "Class →")),
        classes.map(function (c) { return h("th", { scope: "col" }, G.classChip(c.id, { small: true })); }))),
      h("tbody", null, rows.map(function (r) {
        return h("tr", { class: r.off ? "is-off" : "" },
          h("th", { scope: "row", class: "tr-rowh" }, h("span", { class: "who" }, G.avatar(r.agent, "xs"), h("strong", null, agName(r.agent))),
            h("span", { class: "mono small muted" }, r.gate ? r.gate.label + (r.off ? " (not in this flow)" : r.gate.mode === "mixed" ? " · checks + person" : "") : "")),
          classes.map(function (c) { return h("td", null, cellButton(p, r, c)); }));
      })));
    return h("div", { class: "tr-matrix-scroll", "data-keep-scroll": "tr-matrix" }, table);
  }
  function cellButton(p, r, c) {
    var info = cellFor(r.agent, c.id, p.id, ui.repo), cell = info.cell;
    var ceil = G.trust.cellCeiling(cell);
    var eff = Math.min(cell.level, ceil.max);
    var ev = G.trust.evidence(cell);
    var prop = info.virtual ? null : pendingFor(cell.id);
    var dem = info.virtual ? null : recentDemotion(cell);
    var on = ui.sel && ui.sel.agent === r.agent && ui.sel.cls === c.id;
    var label = agName(r.agent) + ", " + c.name + ": " + code(cell.level) + " " + lv(cell.level).name + (eff < cell.level ? ", capped at " + code(eff) : "") + ", " + ev.runs + " finished runs" + (ceil.max < 4 ? ", ceiling " + code(ceil.max) : "") + (prop ? ", promotion to " + code(prop.to) + " proposed" : "") + (dem ? ", demoted recently" : "") + (info.virtual ? ", no cell yet" : "");
    return h("button", { type: "button", class: "tr-cell lvl-" + eff + (on ? " is-on" : "") + (info.virtual ? " is-virtual" : "") + (info.inherited ? " is-inherited" : ""), id: "tr-cell-" + r.agent + "-" + c.id, "aria-pressed": on ? "true" : "false", "aria-label": label, title: label,
      onclick: function () { ui.sel = { agent: r.agent, cls: c.id }; G.rerender(); setTimeout(function () { var d = document.getElementById("tr-detail"); if (d && d.getBoundingClientRect().top > window.innerHeight * 0.75) d.scrollIntoView({ block: "start", behavior: G.reducedMotion() ? "auto" : "smooth" }); }, 30); } },
      h("span", { class: "tr-cell-top" }, rungs(eff), h("span", { class: "tr-cell-l mono" }, code(cell.level)), eff < cell.level ? h("span", { class: "tr-cap-eff mono" }, "→" + code(eff)) : null),
      h("span", { class: "tr-cell-n mono" }, ev.runs + " run" + (ev.runs === 1 ? "" : "s")),
      h("span", { class: "tr-cell-marks" },
        ceil.max < 4 ? h("span", { class: "tr-mark tr-mark-cap", title: "Ceiling " + code(ceil.max) }, "≤" + code(ceil.max)) : null,
        prop ? h("span", { class: "tr-mark tr-mark-up", title: "Promotion to " + code(prop.to) + " proposed" }, "▲" + code(prop.to)) : null,
        dem ? h("span", { class: "tr-mark tr-mark-down", title: "Demoted " + G.fmt.ago(dem.at) }, "▼") : null,
        info.inherited ? h("span", { class: "tr-mark", title: "Project cell; no repo override" }, "proj") : null));
  }

  function legend() {
    return h("ul", { class: "tr-legend", "aria-label": "Trust levels" }, G.TRUST_LEVELS.map(function (l) {
      return h("li", { title: l.desc }, levelTag(l.level));
    }).concat([h("li", { class: "tr-legend-marks small" }, h("span", { class: "tr-mark tr-mark-cap" }, "≤L2"), " ceiling ", h("span", { class: "tr-mark tr-mark-up" }, "▲L3"), " proposal pending ", h("span", { class: "tr-mark tr-mark-down" }, "▼"), " demoted in the last 7 days")]));
  }

  function evidenceWos(cell) {
    var g = gateForAgent(cell.agent);
    return S().workOrders.filter(function (w) { return w.project === cell.project && w.cls === cell.cls && (!cell.repo || w.repo === cell.repo) && g && w.gates[g.id] && (w.gates[g.id].decision || w.state === "done"); })
      .sort(function (a, b) { return (b.doneAt || b.createdAt) - (a.doneAt || a.createdAt); });
  }
  function decisionText(d) {
    if (!d) return h("span", { class: "muted" }, "no decision yet");
    if (d.mode === "trust") return h("span", { class: "tr-dec is-trust" }, G.icon("sparkle"), "passed under trust " + (d.trust != null ? code(d.trust) : ""));
    if (d.mode === "auto") return h("span", { class: "tr-dec" }, G.icon("check"), "automatic checks");
    return h("span", { class: "tr-dec is-human" }, G.icon("human"), G.actorName(d.by) + (d.trust != null ? " at " + code(d.trust) : ""));
  }

  function detail(p) {
    if (!ui.sel) return h("section", { class: "panel tr-detail", id: "tr-detail" }, G.emptyState({ icon: "trust", title: "Select a cell", text: "Pick an agent and class in the ladder to see its evidence, history and what it needs for the next level." }));
    var rows = ladderRows(p);
    if (!ui.sel.agent) { var first = rows[0]; if (first) ui.sel.agent = first.agent; else return h("div"); }
    var info = cellFor(ui.sel.agent, ui.sel.cls, p.id, ui.repo), cell = info.cell;
    var g = gateForAgent(cell.agent);
    var ceil = G.trust.cellCeiling(cell);
    var eff = Math.min(cell.level, ceil.max);
    var m = G.trust.meets(cell), ev = m.evidence || G.trust.evidence(cell);
    var crit = m.next ? S().trust.criteria[m.next] : null;
    var perm = G.me("trust.grant", { project: p.id });
    var prop = info.virtual ? null : pendingFor(cell.id);
    var wos = evidenceWos(cell);

    var head = h("div", { class: "tr-dhead" },
      h("div", { class: "tr-dmain" }, h("div", { class: "kicker" }, "Trust cell" + (cell.repo ? " · repo override" : info.inherited ? " · project cell (no repo override)" : "")),
        h("h2", { class: "tr-dtitle" }, G.trustCellLabel(cell)),
        h("div", { class: "tr-dmeta small" }, "Judged at ", h("strong", null, g ? g.label + " " + g.name : "no gate"), " · ", info.virtual ? "no cell yet, default L1" : "since " + G.fmt.istDate(cell.since))),
      h("div", { class: "tr-dlevel" }, levelTag(cell.level, "is-big"), eff < cell.level ? h("div", { class: "small warn-text" }, G.icon("lock"), " Runs at " + code(eff) + ": capped by " + ceil.ceilings.map(function (c) { return c.id; }).join(", ")) : null),
      h("div", { class: "tr-dact" },
        G.btn(info.virtual ? "Set level" : "Change level", { icon: "trust", id: "tr-change", guard: perm, onClick: function () { levelDialog(info); } })));

    /* evidence */
    var evid = h("section", { class: "tr-sec" }, h("h3", { class: "sub-h" }, "Evidence"),
      h("dl", { class: "tr-kv" },
        kv("Finished on record", h("span", { class: "mono" }, String(ev.runs))),
        kv("Clean streak", h("span", { class: "mono" }, String(ev.cleanRuns))),
        kv("Clean share", rate(ev.runs ? Math.min(1, ev.cleanRuns / ev.runs) : 0, ev.runs)),
        kv("Agent eval score", h("span", { class: "mono" }, pct(ev.evalScore))),
        kv("Agent rework rate", h("span", { class: "mono" }, pct(ev.rework))),
        kv("Reverts and incidents", h("span", { class: "mono" + (ev.incidents ? " neg" : "") }, String(ev.incidents)), ev.incidentWos.length ? h("span", { class: "tr-chips" }, ev.incidentWos.map(function (id) { return G.entityChip({ type: "wo", id: id }); })) : null)),
      wos.length ? h("div", { class: "tr-wolist" }, h("div", { class: "small muted" }, "Latest work orders through " + (g ? g.label : "the gate") + " (" + wos.length + ")"),
        h("ul", { class: "plain-list" }, wos.slice(0, 6).map(function (w) {
          var d = g && w.gates[g.id] ? w.gates[g.id].decision : null;
          var bad = (w.outcomes || []).find(function (o) { return o.kind === "revert" || o.kind === "incident"; });
          return h("li", { class: "tr-woline" }, G.entityChip({ type: "wo", id: w.id }), h("span", { class: "small tr-wotitle" }, w.title), h("span", { class: "small" }, decisionText(d)), bad ? h("span", { class: "chip chip-block" }, bad.kind) : w.state === "done" ? h("span", { class: "chip" }, "shipped") : null);
        }))) : h("p", { class: "small muted" }, "No work orders of this class have reached " + (g ? g.label : "this gate") + " here yet."));

    /* next level */
    var next;
    if (!m.next) next = h("p", { class: "small" }, "Already at the top of the ladder.");
    else {
      var lines = crit ? [
        ["Clean runs", ev.cleanRuns + " of " + crit.cleanRuns, ev.cleanRuns >= crit.cleanRuns, ev.cleanRuns >= crit.cleanRuns ? null : (crit.cleanRuns - ev.cleanRuns) + " more"],
        ["Eval score", pct(ev.evalScore) + " vs ≥ " + pct(crit.evalMin), ev.evalScore >= crit.evalMin, ev.evalScore >= crit.evalMin ? null : pct(crit.evalMin - ev.evalScore) + " short"],
        ["Rework", pct(ev.rework) + " vs ≤ " + pct(crit.reworkMax), ev.rework <= crit.reworkMax, ev.rework <= crit.reworkMax ? null : pct(ev.rework - crit.reworkMax) + " over"],
        ["Incidents in " + crit.windowD + " days", ev.incidents + " vs ≤ " + crit.incidentsMax, ev.incidents <= crit.incidentsMax, ev.incidents <= crit.incidentsMax ? null : "wait out the window"],
        ["Ceiling", "≤ " + code(ceil.max), m.next <= ceil.max, m.next <= ceil.max ? null : "blocked by " + ceil.ceilings.map(function (c) { return c.id; }).join(", ")]
      ] : [];
      if (m.next === 4 && (!g || g.id !== "G6")) lines.push(["Release gate", "L4 applies to G6 only", false, "this agent does not staff the station before G6"]);
      var metN = lines.filter(function (l) { return l[2]; }).length;
      next = h("div", null,
        h("div", { class: "tr-next-head" }, h("span", null, "To reach "), levelTag(m.next), h("span", { class: "small muted" }, metN + " of " + lines.length + " criteria met")),
        h("div", { class: "meter tr-meter", role: "img", "aria-label": metN + " of " + lines.length + " criteria met" }, h("span", { class: "meter-fill", style: "width:" + Math.round(metN / (lines.length || 1) * 100) + "%" })),
        h("ul", { class: "checklist tr-crit" }, lines.map(function (l) { return h("li", { class: l[2] ? "ok" : "bad" }, h("span", null, l[0]), h("span", { class: "mono small" }, l[1]), l[3] ? h("span", { class: "small muted" }, l[3]) : null); })),
        h("p", { class: "small" }, "Projection: moving to " + code(m.next) + " saves about ", h("strong", { class: "mono" }, String(G.trust.projection(cell, m.next))), " human approvals a week (from " + wosThisWeek(cell) + " work orders of this class in the last 7 days)."));
    }
    var nextSec = h("section", { class: "tr-sec" }, h("h3", { class: "sub-h" }, "Next level"), next,
      prop ? h("div", { class: "callout tr-prop-inline" }, G.icon("trust"), h("div", null, h("strong", null, prop.id + ": promotion to " + code(prop.to) + " proposed " + G.fmt.ago(prop.at) + ". "), h("span", { class: "small" }, prop.evidence.note || ""),
        h("div", { class: "tr-prop-acts" }, propButtons(prop, cell)))) : null);

    /* history */
    var hist = (cell.history || []).slice().reverse();
    var histSec = h("section", { class: "tr-sec" }, h("h3", { class: "sub-h" }, "History"),
      hist.length ? h("ol", { class: "tr-hist" }, hist.map(function (e) {
        return h("li", { class: "tr-hist-" + e.kind }, h("span", { class: "mono small" }, G.fmt.stamp(e.at)),
          h("span", { class: "tr-hist-move mono" }, e.from == null ? "start " + code(e.to) : code(e.from) + (e.to > e.from ? " ▲ " : " ▼ ") + code(e.to)),
          h("span", { class: "chip" }, e.kind), h("span", { class: "small" }, e.reason, e.cause && e.cause.wo ? h("span", null, " ", G.entityChip({ type: "wo", id: e.cause.wo })) : null), h("span", { class: "small muted" }, G.actorName(e.by)));
      })) : h("p", { class: "small muted" }, "No changes yet. A person sets the first level, or the system proposes one when the criteria are met."),
      ceil.ceilings.length ? h("div", { class: "small" }, h("strong", null, "Ceilings in force: "), ceil.ceilings.map(function (c) { return c.id + " " + c.text + " (≤ " + code(c.max) + ")"; }).join("; ")) : h("div", { class: "small muted" }, "No ceiling applies to this cell."));

    return h("section", { class: "panel tr-detail", id: "tr-detail", "aria-label": "Trust cell " + G.trustCellLabel(cell) }, head, G.lockNote(perm, "Trust levels on " + p.name), h("div", { class: "tr-dgrid" }, evid, nextSec, histSec));
  }
  function kv(k, v, extra) { return h("div", { class: "tr-kvrow" }, h("dt", null, k), h("dd", null, v, extra || null)); }
  function wosThisWeek(cell) { var since = Date.now() - 7 * G.DAY; return S().workOrders.filter(function (w) { return w.project === cell.project && w.cls === cell.cls && w.createdAt >= since; }).length; }

  function levelDialog(info) {
    var cell = info.cell, perm = G.me("trust.grant", { project: cell.project });
    var ceil = G.trust.cellCeiling(cell), g = gateForAgent(cell.agent);
    var pickL = cell.level, err = h("div", { class: "form-err", role: "alert" });
    var ta = h("textarea", { id: "tr-lvl-reason", class: "input", rows: "3", placeholder: "Why this level, in one or two sentences" });
    var cards = h("div", { class: "radio-cards tr-lvl-cards", role: "radiogroup", "aria-label": "Trust level" }, G.TRUST_LEVELS.map(function (l) {
      var why = l.level > ceil.max ? "Above the ceiling: " + ceil.ceilings.map(function (c) { return c.id + " " + c.text; }).join("; ") + "."
        : l.level === 4 && (!g || g.id !== "G6") ? "L4 only changes release confirmation; this agent does not staff the station before G6." : null;
      var r = h("input", { type: "radio", name: "tr-lvl", id: "tr-lvl-" + l.level, value: String(l.level), checked: l.level === cell.level, disabled: !!why || !perm.allowed });
      r.addEventListener("change", function () { pickL = l.level; });
      return h("label", { class: "radio-card" + (why ? " is-locked" : ""), for: "tr-lvl-" + l.level, "data-reason": why }, r, h("span", { class: "rc-t" }, levelTag(l.level), l.level === cell.level ? h("span", { class: "chip" }, "current") : null), h("span", { class: "rc-d small muted" }, l.desc), why ? h("span", { class: "rc-why small neg" }, G.icon("lock"), " " + why) : null);
    }));
    if (!perm.allowed) ta.disabled = true;
    G.dialog({ title: "Trust level for " + G.trustCellLabel(cell), kicker: "Trust · " + (info.virtual ? "new cell" : code(cell.level) + " now"), wide: true,
      sub: "Raising a level lets " + (g ? g.label : "its gate") + " pass without a person for this class; lowering it brings people back in. Pending proposals for this cell are withdrawn. Audited.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Trust levels"), cards, G.field("Reason (required)", ta, null, "tr-lvl-reason"), err),
      actions: [{ label: "Cancel" }, { label: "Save level", kind: "primary", submit: true, id: "tr-lvl-ok", guard: perm, onClick: function (close) {
        var reason = ta.value.trim();
        if (reason.length < 4) { err.textContent = "Give a reason of at least 4 characters."; return; }
        if (pickL === cell.level) { err.textContent = "Pick a different level."; return; }
        var r = G.ops.grantTrust(targetOf(info), pickL, reason);
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }

  function propButtons(prop, cell) {
    var perm = G.me("trust.grant", { project: cell.project });
    var ceil = G.trust.cellCeiling(cell);
    var g = gateForAgent(cell.agent);
    var accGuard = !perm.allowed ? perm : prop.to === 4 && (!g || g.id !== "G6") ? { allowed: false, needs: "", reason: "L4 only changes release confirmation (G6); " + agName(cell.agent) + " is judged at " + (g ? g.label : "no gate") + ". Decline it." } : prop.to > ceil.max ? { allowed: false, needs: "", reason: "Capped at " + code(ceil.max) + " by " + ceil.ceilings.map(function (c) { return c.id; }).join(", ") + ". Decline it or change the ceiling." } : null;
    return [
      G.btn("Approve " + code(prop.to), { small: true, kind: "primary", icon: "check", id: "tr-prop-ok-" + prop.id, guard: accGuard, onClick: function () {
        G.reasonDialog({ title: "Approve " + prop.id, kicker: "Trust · promotion", sub: G.trustCellLabel(cell) + " moves from " + code(prop.from) + " to " + code(prop.to) + ". About " + (prop.savedPerWeek || 0) + " approvals a week stop needing a person.", label: "Reason (required)", placeholder: "e.g. Clean streak reviewed, no open incidents", ok: "Approve", min: 4, guard: accGuard,
          onOk: function (t) { var r = G.ops.decideTrustProposal(prop.id, true, t); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      } }),
      G.btn("Decline", { small: true, icon: "x", id: "tr-prop-no-" + prop.id, guard: perm, onClick: function () {
        G.reasonDialog({ title: "Decline " + prop.id, kicker: "Trust · promotion", sub: G.trustCellLabel(cell) + " stays at " + code(prop.from) + ". The system will not propose this cell again for 3 days.", label: "Reason (required)", ok: "Decline", kind: "danger", min: 4, guard: perm,
          onOk: function (t) { var r = G.ops.decideTrustProposal(prop.id, false, t); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      } })
    ];
  }

  function projectionPanel(p) {
    var rows = ladderRows(p), classes = G.flowOf(p).classes, eligible = [], total = 0, cells = 0, sumPending = 0;
    rows.forEach(function (r) { classes.forEach(function (c) {
      var info = cellFor(r.agent, c.id, p.id, ui.repo); if (info.virtual) return; cells++;
      var m = G.trust.meets(info.cell);
      if (m.ok) { var sv = G.trust.projection(info.cell, m.next); total += sv; eligible.push({ cell: info.cell, to: m.next, saved: sv }); }
      var pr = pendingFor(info.cell.id); if (pr) sumPending += pr.savedPerWeek || 0;
    }); });
    var cov = G.trust.coverage(p.id);
    return G.panel("Projection", h("div", { class: "tr-proj" },
      h("dl", { class: "tr-kv" },
        kv("Gate decisions under trust, 7d", rate(cov.share, cov.total, { min: 10 })),
        kv("Saved by pending proposals", h("span", { class: "mono" }, Math.round(sumPending * 10) / 10 + " / week")),
        kv("Saved if every eligible cell moves up", h("span", { class: "mono" }, Math.round(total * 10) / 10 + " / week"), h("span", { class: "small muted" }, " " + eligible.length + " of " + cells + " cells eligible"))),
      eligible.length ? h("ul", { class: "plain-list small tr-elig" }, eligible.sort(function (a, b) { return b.saved - a.saved; }).slice(0, 5).map(function (e) {
        return h("li", null, h("button", { type: "button", class: "linkish", id: "tr-elig-" + e.cell.agent + "-" + e.cell.cls, onclick: function () { ui.sel = { agent: e.cell.agent, cls: e.cell.cls }; G.rerender(); } }, agName(e.cell.agent) + " · " + clsName(e.cell.cls)), " " + code(e.cell.level) + " → " + code(e.to) + ", saves " + e.saved + "/week");
      })) : h("p", { class: "small muted" }, "No cell on " + p.name + " meets the criteria for its next level right now."),
      h("p", { class: "small muted" }, "Estimated from this week's work orders per class: L0 and L1 need a person at every gate, L2 one in " + S().trust.sampleRate + ", L3 and up none (release still needs L4).")), { cls: "tr-proj-panel" });
  }

  function ladderTab(projects) {
    var p = G.find.project(ui.project);
    var repos = S().repos.filter(function (r) { return r.project === p.id; });
    if (ui.repo && !repos.some(function (r) { return r.id === ui.repo; })) ui.repo = "";
    var bar = h("div", { class: "toolbar tr-toolbar" },
      G.field("Project", G.select("tr-project", projects.map(function (x) { return { value: x.id, label: x.name + (x.regulated ? " (regulated)" : "") }; }), p.id, function (v) { ui.project = v; ui.repo = ""; ui.sel = null; G.rerender(); }), null, "tr-project"),
      G.field("Repo", G.select("tr-repo", [{ value: "", label: "All repos (project cells)" }].concat(repos.map(function (r) { return { value: r.id, label: r.name }; })), ui.repo, function (v) { ui.repo = v; G.rerender(); }), null, "tr-repo"),
      h("p", { class: "small muted tr-toolbar-note" }, ui.repo ? "Showing repo cells where they exist; other cells fall back to the project cell (marked proj)." : "Cells are agent × class on this project. A repo cell overrides the project cell."));
    return h("div", { class: "tr-ladder" }, bar,
      G.panel("Ladder · " + p.name, h("div", null, matrix(p), legend()), { flush: true, cls: "tr-matrix-panel" }),
      h("div", { class: "tr-ladder-grid" }, detail(p), projectionPanel(p)));
  }

  /* ---------------- proposals ---------------- */
  function proposalsTab() {
    var vis = visIds();
    var all = S().trust.proposals.filter(function (x) { var c = G.find.trustCell(x.cell); return c && vis.indexOf(c.project) >= 0; }).slice().reverse();
    var pending = all.filter(function (x) { return x.status === "pending"; });
    var list = ui.propFilter === "pending" ? pending : all;
    var seg = G.segmented("tr-propf", [{ id: "pending", label: "Pending (" + pending.length + ")" }, { id: "all", label: "All (" + all.length + ")" }], ui.propFilter, function (v) { ui.propFilter = v; G.rerender(); }, "Show proposals");
    return h("div", { class: "tr-props" }, h("div", { class: "toolbar" }, seg, h("span", { class: "small muted" }, "The system proposes a promotion when a cell meets the criteria for its next level. A permitted person approves or declines; both need a reason.")),
      list.length ? h("ul", { class: "tr-prop-list" }, list.map(propCard)) : G.emptyState({ id: "tr-props-empty", icon: "trust", title: ui.propFilter === "pending" ? "No promotions waiting" : "No proposals yet", text: "Proposals appear when a cell's clean streak, eval score and incident record meet the next level's criteria." }));
  }
  function propCard(prop) {
    var cell = G.find.trustCell(prop.cell);
    var m = G.trust.meets(cell), ceil = G.trust.cellCeiling(cell);
    var ev = G.trust.evidence(cell);
    var st = { pending: "Pending", accepted: "Approved", declined: "Declined", withdrawn: "Withdrawn" }[prop.status] || prop.status;
    return h("li", { class: "panel tr-prop is-" + prop.status + (ui.hiProposal === prop.id ? " is-hi" : ""), id: "tr-prop-" + prop.id },
      h("div", { class: "tr-prop-top" }, h("span", { class: "mono strong" }, prop.id), h("span", { class: "chip tr-pst tr-pst-" + prop.status }, st),
        h("button", { type: "button", class: "linkish strong", id: "tr-prop-cell-" + prop.id, onclick: function () { G.trustFocus({ cell: cell.id }); G.rerender(); } }, G.trustCellLabel(cell)),
        h("span", { class: "tr-prop-move" }, levelTag(prop.from), h("span", { "aria-hidden": "true" }, " → "), h("span", { class: "sr-only" }, " to "), levelTag(prop.to)),
        h("span", { class: "small muted" }, "proposed " + G.fmt.ago(prop.at))),
      h("dl", { class: "tr-kv tr-prop-kv" },
        kv("Clean streak", h("span", { class: "mono" }, String(prop.evidence.cleanRuns))),
        kv("Finished on record", h("span", { class: "mono" }, String(ev.runs)), ev.runs < MIN_RUNS ? h("span", { class: "small muted" }, " small sample") : null),
        kv("Eval score", h("span", { class: "mono" }, pct(prop.evidence.evalScore))),
        kv("Saves", h("span", { class: "mono" }, (prop.savedPerWeek || 0) + " approvals / week")),
        kv("Ceiling", h("span", { class: "mono" + (prop.to > ceil.max ? " neg" : "") }, "≤ " + code(ceil.max)), prop.to > ceil.max ? h("span", { class: "small neg" }, " blocks this promotion") : null)),
      h("p", { class: "small" }, prop.evidence.note || "", prop.status === "pending" && !m.ok && m.next === prop.to ? h("span", { class: "warn-text" }, " Since proposed: " + m.missing.join(", ") + ".") : null),
      prop.status === "pending" ? h("div", { class: "tr-prop-acts" }, propButtons(prop, cell))
        : h("p", { class: "small muted" }, st + (prop.by ? " by " + G.actorName(prop.by) : "") + (prop.decidedAt ? " " + G.fmt.ago(prop.decidedAt) : "") + (prop.reason ? ": " + prop.reason : "")));
  }

  /* ---------------- demotions ---------------- */
  function demotions() {
    var vis = visIds(), out = [];
    S().trust.cells.forEach(function (c) { if (vis.indexOf(c.project) < 0) return; (c.history || []).forEach(function (e) { if (e.kind === "demote" || (e.kind === "grant" && e.to < e.from)) out.push({ cell: c, e: e }); }); });
    return out.sort(function (a, b) { return b.e.at - a.e.at; });
  }
  function demotionsTab() {
    var list = demotions();
    var types = { all: "All", revert: "Revert", incident: "Incident", guardrail: "Guardrail", manual: "By a person" };
    var shown = list.filter(function (d) { var t = d.e.cause ? d.e.cause.type : d.e.by === "system" ? "system" : "manual"; return ui.demoFilter === "all" || t === ui.demoFilter; });
    var table = G.dataTable({ id: "tr-demo-table", caption: "Trust demotions", rows: shown, rowKey: function (d) { return d.cell.id + "@" + d.e.at; }, pageSize: 20, sort: { key: "at", dir: -1 },
      empty: { title: "No demotions", text: "Cells drop a level automatically after a post-release revert or incident, or a guardrail breach at L3." },
      columns: [
        { key: "at", label: "When", sort: function (d) { return d.e.at; }, render: function (d) { return h("span", { class: "mono small" }, G.fmt.stamp(d.e.at)); } },
        { key: "cell", label: "Cell", sort: function (d) { return G.trustCellLabel(d.cell); }, render: function (d) { return h("button", { type: "button", class: "linkish", id: "tr-demo-" + d.cell.id.replace(/\W/g, "-") + "-" + d.e.at, onclick: function () { G.trustFocus({ cell: d.cell.id }); G.rerender(); } }, G.trustCellLabel(d.cell)); } },
        { key: "move", label: "Change", render: function (d) { return h("span", { class: "mono" }, code(d.e.from) + " ▼ " + code(d.e.to)); } },
        { key: "cause", label: "Cause", sort: function (d) { return d.e.cause ? d.e.cause.type : "manual"; }, render: function (d) { var t = d.e.cause ? d.e.cause.type : "manual"; return h("span", { class: "tr-cause tr-cause-" + t }, G.icon(t === "guardrail" ? "shield" : t === "manual" ? "human" : "alert"), types[t] || t, d.e.cause && d.e.cause.wo ? h("span", null, " ", G.entityChip({ type: "wo", id: d.e.cause.wo })) : null); } },
        { key: "reason", label: "Reason", render: function (d) { return h("span", { class: "small" }, d.e.reason); } },
        { key: "by", label: "By", hideSmall: true, render: function (d) { return h("span", { class: "small" }, G.actorName(d.e.by)); } }
      ] });
    var anyOutcome = visProjects().some(function (p) { return G.me("outcome.record", { project: p.id }).allowed; });
    return h("div", { class: "tr-demos" },
      h("div", { class: "toolbar" }, G.segmented("tr-demof", Object.keys(types).map(function (k) { return { id: k, label: types[k] }; }), ui.demoFilter, function (v) { ui.demoFilter = v; G.rerender(); }, "Filter demotions by cause"),
        G.btn("Simulate an incoming outcome", { icon: "alert", id: "tr-sim-incident", guard: anyOutcome ? null : G.me("outcome.record", { project: ui.project }), onClick: incidentDialog })),
      h("p", { class: "small muted" }, "Automatic rules: a post-release revert or incident lowers every L2 and higher cell for that class in that project by one level; a guardrail breach at L3 drops the cell to L2 and waits for a person; a failed check resets the clean-run streak."),
      table);
  }

  /* a simulated incoming post-release outcome goes through the real op (G.ops.recordOutcome): it records the
     outcome with attribution, applies the automatic demotion, feeds the learning loop and is audited */
  function incidentDialog() {
    var vis = visIds();
    var shipped = S().workOrders.filter(function (w) { return w.state === "done" && !w.split && vis.indexOf(w.project) >= 0 && G.me("outcome.record", { project: w.project }).allowed; }).sort(function (a, b) { return b.doneAt - a.doneAt; }).slice(0, 40);
    var pick = shipped[0] ? shipped[0].id : "", kind = "incident", err = h("div", { class: "form-err", role: "alert" }), impact = h("p", { class: "small", id: "tr-inc-impact" });
    function paint() {
      var w = G.find.wo(pick); if (!w) { impact.textContent = ""; return; }
      var n = S().trust.cells.filter(function (c) { return c.project === w.project && c.cls === w.cls && c.level >= 2; });
      impact.textContent = n.length ? "Would drop " + n.length + " cell" + (n.length === 1 ? "" : "s") + " for " + clsName(w.cls) + " on " + projName(w.project) + ": " + n.map(function (c) { return agName(c.agent) + " " + code(c.level) + " → " + code(c.level - 1); }).join(", ") + "." : "No cell for " + clsName(w.cls) + " on " + projName(w.project) + " is at L2 or above, so nothing drops.";
    }
    var sel = G.select("tr-inc-wo", shipped.map(function (w) { return { value: w.id, label: w.id + " · " + clsName(w.cls) + " · " + projName(w.project) + " · " + w.title.slice(0, 50) }; }), pick, function (v) { pick = v; paint(); });
    var kindSel = G.select("tr-inc-kind", [{ value: "incident", label: "Incident" }, { value: "revert", label: "Revert" }], kind, function (v) { kind = v; });
    var ta = h("textarea", { id: "tr-inc-text", class: "input", rows: "2" }); ta.value = "Error rate rose after release; rolled forward with a fix.";
    paint();
    G.dialog({ title: "Simulate an incoming post-release outcome", kicker: "Trust · simulation", sub: "Plays the part of a monitoring alert or revert arriving after release. It is recorded on the work order (marked simulated) like a real outcome: the automatic demotion rule runs, the learning loop gets the signal, and it is audited. Nothing outside this page is contacted.",
      body: shipped.length ? h("div", { class: "form-grid" }, G.field("Shipped work order", sel, null, "tr-inc-wo"), G.field("Kind", kindSel, null, "tr-inc-kind"), G.field("What happened", ta, null, "tr-inc-text"), impact, err)
        : G.emptyState({ title: "No shipped work you can act on", text: "You need 'Record post-release outcomes' on a project with shipped work." }),
      actions: [{ label: "Cancel" }, { label: "Record and demote", kind: "danger", submit: true, id: "tr-inc-ok", guard: shipped.length ? null : { allowed: false, needs: "", reason: "No shipped work order to use." }, onClick: function (close) {
        var r = G.ops.recordOutcome(pick, { kind: kind, text: ta.value, simulated: true, source: "simulation" });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "warn"); ui.demoFilter = "all"; close();
      } }] });
  }

  /* ---------------- policy: ceilings, criteria, sampling ---------------- */
  function policyTab() {
    var tr = S().trust, perm = G.me("trust.criteria");
    var ceilRows = tr.ceilings.map(function (c) {
      return h("tr", { class: c.enabled === false ? "is-off" : "" },
        h("td", { class: "mono" }, c.id), h("td", null, c.text), h("td", { class: "small" }, whenText(c.when)), h("td", null, levelTag(c.max)),
        h("td", { class: "small" }, String(affected(c)) + " cells"),
        h("td", null, G.toggle("tr-ceil-on-" + c.id, c.enabled !== false, function (v) { var r = G.ops.saveCeiling(Object.assign({}, c, { enabled: v })); G.toast(r.msg, r.ok ? "ok" : "error"); }, perm, "Enforce " + c.id)),
        h("td", { class: "tr-acts" }, G.btn("Edit", { small: true, id: "tr-ceil-edit-" + c.id, guard: perm, onClick: function () { ceilingDialog(c); } }),
          G.btn("Remove", { small: true, kind: "ghost", id: "tr-ceil-rm-" + c.id, guard: perm, onClick: function () {
            G.reasonDialog({ title: "Remove " + c.id, sub: c.text + ". Cells it capped may run at their granted level again.", label: "Reason", ok: "Remove", kind: "danger", min: 4, guard: perm, onOk: function () { var r = G.ops.removeCeiling(c.id); if (r.ok) G.toast(r.msg, "ok"); return r; } });
          } })));
    });
    var ceilings = G.panel("Ceilings", h("div", null, h("p", { class: "small muted" }, "A ceiling caps the level a cell can run at, whatever was granted. The lowest matching ceiling wins."),
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact tr-ceil" }, h("thead", null, h("tr", null, ["Id", "Rule", "Applies when", "Maximum", "Reach", "On", ""].map(function (x) { return h("th", { scope: "col" }, x); }))), h("tbody", null, ceilRows)))),
      { tools: G.btn("Add ceiling", { small: true, icon: "plus", id: "tr-ceil-add", guard: perm, onClick: function () { ceilingDialog(null); } }) });

    var critRows = [2, 3, 4].map(function (L) {
      var c = tr.criteria[L], d = {};
      function inp(k, val, step, pctMode) {
        var el = h("input", { id: "tr-crit-" + L + "-" + k, class: "input mono tr-num", type: "number", min: "0", step: step, value: String(pctMode ? Math.round(val * 100) : val), disabled: !perm.allowed, "aria-label": code(L) + " " + k });
        el.addEventListener("input", function () { d[k] = pctMode ? (+el.value) / 100 : +el.value; });
        return el;
      }
      return h("tr", null, h("th", { scope: "row" }, levelTag(L)), h("td", null, inp("cleanRuns", c.cleanRuns, "1")), h("td", null, inp("evalMin", c.evalMin, "1", true)), h("td", null, inp("reworkMax", c.reworkMax, "1", true)), h("td", null, inp("incidentsMax", c.incidentsMax, "1")), h("td", null, inp("windowD", c.windowD, "1")),
        h("td", null, G.btn("Save " + code(L), { small: true, id: "tr-crit-save-" + L, guard: perm, onClick: function () { if (!Object.keys(d).length) { G.toast("Nothing changed.", "info"); return; } var r = G.ops.setTrustCriteria(L, d); G.toast(r.msg, r.ok ? "ok" : "error"); } })));
    });
    var criteria = G.panel("Promotion criteria", h("div", null, h("p", { class: "small muted" }, "What a cell must show before the system proposes the level. Eval minimum and rework maximum are percentages."),
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact tr-crit-t" }, h("thead", null, h("tr", null, ["Level", "Clean runs", "Eval min %", "Rework max %", "Incidents max", "Window (days)", ""].map(function (x) { return h("th", { scope: "col" }, x); }))), h("tbody", null, critRows)))));

    var sr = h("input", { id: "tr-sample", class: "input mono tr-num", type: "number", min: "2", max: "50", value: String(tr.sampleRate), disabled: !perm.allowed, "aria-label": "Spot-check one in" });
    var sampling = G.panel("L2 spot checks", h("div", { class: "tr-sample" }, h("label", { for: "tr-sample", class: "small" }, "A person reviews one in"), sr, h("span", { class: "small" }, "gate decisions at L2. The pick is deterministic per work order and gate."),
      G.btn("Save", { small: true, id: "tr-sample-save", guard: perm, onClick: function () { var r = G.ops.setSampleRate(+sr.value); G.toast(r.msg, r.ok ? "ok" : "error"); } })));
    return h("div", { class: "tr-policy" }, G.lockNote(perm, "Trust policy"), ceilings, h("div", { class: "two-col" }, criteria, sampling));
  }
  function whenText(w) {
    var parts = [];
    if (w.regulated) parts.push("regulated projects");
    if (w.cls) parts.push(clsName(w.cls));
    if (w.project) parts.push(projName(w.project));
    if (w.gate) parts.push("gate " + ((G.gateDef(w.gate) || {}).label || w.gate));
    return parts.join(" · ") || "everywhere";
  }
  function affected(c) {
    var ps = S().projects;
    return S().trust.cells.filter(function (x) {
      var p = ps.find(function (y) { return y.id === x.project; });
      if (c.when.regulated && !(p && p.regulated)) return false;
      if (c.when.cls && c.when.cls !== x.cls) return false;
      if (c.when.project && c.when.project !== x.project) return false;
      if (c.when.gate) { var g = gateForAgent(x.agent); if (!g || g.id !== c.when.gate) return false; }
      return true;
    }).length;
  }
  function ceilingDialog(c) {
    var perm = G.me("trust.criteria");
    var d = c ? JSON.parse(JSON.stringify(c)) : { text: "", when: {}, max: 2, enabled: true };
    var err = h("div", { class: "form-err", role: "alert" });
    var text = h("input", { id: "tr-cd-text", class: "input", value: d.text, placeholder: "e.g. Data Platform hotfixes stay at L1" });
    var reg = h("input", { type: "checkbox", id: "tr-cd-reg", checked: !!d.when.regulated });
    var classes = G.CLASSES.filter(function (x) { return !x.custom; }).concat(G.CLASSES.filter(function (x) { return x.custom; }));
    var clsSel = G.select("tr-cd-cls", [{ value: "", label: "Any class" }].concat(classes.map(function (x) { return { value: x.id, label: x.name + (x.custom ? " (" + projName(x.project) + ")" : "") }; })), d.when.cls || "", null);
    var projSel = G.select("tr-cd-proj", [{ value: "", label: "Any project" }].concat(S().projects.filter(function (p) { return p.status !== "archived"; }).map(function (p) { return { value: p.id, label: p.name }; })), d.when.project || "", null);
    var gateSel = G.select("tr-cd-gate", [{ value: "", label: "Any gate" }].concat(G.GATES.filter(function (g) { return g.id !== "G0G1"; }).map(function (g) { return { value: g.id, label: g.label + " " + g.name + (g.custom ? " (" + projName(g.project) + ")" : "") }; })), d.when.gate || "", null);
    var maxSel = G.select("tr-cd-max", G.TRUST_LEVELS.map(function (l) { return { value: String(l.level), label: code(l.level) + " " + l.name }; }), String(d.max), null);
    if (!perm.allowed) [text, reg, clsSel, projSel, gateSel, maxSel].forEach(function (x) { x.disabled = true; });
    G.dialog({ title: c ? "Edit " + c.id : "Add ceiling", kicker: "Trust · policy", sub: "Cells that match every condition you set are capped at the maximum. Saved and audited.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Ceilings"), G.field("Rule in words", text, null, "tr-cd-text"),
        h("label", { class: "check", for: "tr-cd-reg" }, reg, "Only regulated projects"),
        h("div", { class: "form-row" }, G.field("Class", clsSel, null, "tr-cd-cls"), G.field("Project", projSel, null, "tr-cd-proj")),
        h("div", { class: "form-row" }, G.field("Gate", gateSel, null, "tr-cd-gate"), G.field("Maximum level", maxSel, null, "tr-cd-max")), err),
      actions: [{ label: "Cancel" }, { label: "Save ceiling", kind: "primary", submit: true, id: "tr-cd-ok", guard: perm, onClick: function (close) {
        var when = {}; if (reg.checked) when.regulated = true; if (clsSel.value) when.cls = clsSel.value; if (projSel.value) when.project = projSel.value; if (gateSel.value) when.gate = gateSel.value;
        var r = G.ops.saveCeiling({ id: c ? c.id : undefined, text: text.value, when: when, max: +maxSel.value, enabled: c ? c.enabled !== false : true });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }

  /* ---------------- render ---------------- */
  function render() {
    var s = S();
    if (ui.viewer !== G.viewerId()) { ui.viewer = G.viewerId(); ui.project = null; ui.repo = ""; ui.sel = null; ui.tab = "ladder"; ui.hiProposal = null; }
    if (s.prefs.trustFocus) { var f = s.prefs.trustFocus; G.trustFocus(f); setTimeout(function () { G.store.update("prefs", function (p) { p.trustFocus = null; }); }, 0); }
    var projects = visProjects();
    if (!projects.length) return h("div", { class: "view view-trust" }, G.pageHeader({ id: "tr-head", kicker: "Agents · Sheet 17", title: "Trust" }), G.emptyState({ icon: "trust", title: "No projects to show", text: "You have no role on an active project." }));
    if (!ui.project || !projects.some(function (p) { return p.id === ui.project; })) { var cp = G.currentProject(); ui.project = cp && projects.some(function (p) { return p.id === cp.id; }) ? cp.id : projects[0].id; }
    var vis = visIds();
    var cells = s.trust.cells.filter(function (c) { return vis.indexOf(c.project) >= 0; });
    var pending = s.trust.proposals.filter(function (x) { var c = G.find.trustCell(x.cell); return x.status === "pending" && c && vis.indexOf(c.project) >= 0; });
    var saved = pending.reduce(function (t, x) { return t + (x.savedPerWeek || 0); }, 0);
    var dem7 = demotions().filter(function (d) { return d.e.at >= Date.now() - 7 * G.DAY; }).length;
    var cov = { total: 0, auto: 0 }; vis.forEach(function (id) { var c = G.trust.coverage(id); cov.total += c.total; cov.auto += c.auto; });
    var unattended = cells.filter(function (c) { return c.level >= 3; }).length;
    var tabs = [{ id: "ladder", label: "Ladder" }, { id: "proposals", label: "Proposals", count: pending.length }, { id: "demotions", label: "Demotions", count: dem7 }, { id: "policy", label: "Ceilings and criteria" }];
    var body = ui.tab === "proposals" ? proposalsTab() : ui.tab === "demotions" ? demotionsTab() : ui.tab === "policy" ? policyTab() : ladderTab(projects);
    return h("div", { class: "view view-trust" },
      G.pageHeader({ id: "tr-head", kicker: "Agents · Sheet 17", title: "Trust", sub: "Earned autonomy. Each agent earns a level per work class and project from evidence; people grant it, and regressions take it away automatically.",
        meta: [["Cells", String(cells.length)], ["L3 and up", String(unattended)], ["Pending", String(pending.length)], ["Saves if approved", Math.round(saved * 10) / 10 + "/wk"], ["Under trust 7d", cov.total >= 10 ? Math.round(cov.auto / cov.total * 100) + "% n=" + cov.total : "n=" + cov.total]] }),
      G.tabBar({ id: "tr-tab", items: tabs, active: ui.tab, onChange: function (t) { ui.tab = t; ui.hiProposal = null; G.rerender(); } }),
      h("div", { id: "tr-tab-panel", role: "tabpanel", class: "tr-panel" }, body));
  }

  G.views.trust = { title: "Trust", render: render, keys: ["trust", "workOrders", "projects", "repos", "agents", "scorecards"] };
})(window.G);
