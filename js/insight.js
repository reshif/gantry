/* Insight engines derived from the store: trust ladder decisions (G.trust), workload metrics
   (G.workload), learning signals (G.learning) and replay over the event log (G.replay / G.stateAt).
   All functions read state; mutations live in G.ops (sim.js). They take an optional state argument so
   seeding can use them before the store exists. */
(function (G) {
  "use strict";
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  function S(st) { return st || (G.store && G.store.get && G.store.get()) || G._seedState; }
  function hash(str) { var x = 2166136261; for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; }
  function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }

  /* ================= trust ladder ================= */
  G.TRUST_LEVELS = [
    { level: 0, code: "L0", name: "Shadow", desc: "The agent suggests only; people do the work and approve every gate." },
    { level: 1, code: "L1", name: "Gated", desc: "The agent acts; a person approves every gate." },
    { level: 2, code: "L2", name: "Spot-checked", desc: "Gates pass automatically except a sampled share that a person reviews." },
    { level: 3, code: "L3", name: "Unattended", desc: "Gates pass automatically within guardrails. Release still needs a person." },
    { level: 4, code: "L4", name: "Unattended incl. release", desc: "Gates and release confirmation pass automatically within guardrails." }
  ];
  /* agent whose work a gate judges: the agent staffing the station before it */
  G.trustAgentFor = function (gateId) { var g = G.gateDef(gateId); var st = g && G.stationDef ? G.stationDef(g.after) : null; return st ? st.agent : null; };
  G.trustCellId = function (agent, cls, project, repo) { return agent + "|" + cls + "|" + project + (repo ? "|" + repo : ""); };

  G.trust = {
    level: function (n) { return G.TRUST_LEVELS[Math.max(0, Math.min(4, n))]; },
    cell: function (agent, cls, project, repo, st) {
      var cells = S(st).trust.cells;
      return (repo && cells.find(function (c) { return c.id === G.trustCellId(agent, cls, project, repo); })) || cells.find(function (c) { return c.id === G.trustCellId(agent, cls, project); }) || null;
    },
    /* ceilings that apply to (project, cls, gate): returns { max, ceilings[] } */
    ceiling: function (projectId, cls, gateId, st) {
      var state = S(st), p = state.projects.find(function (x) { return x.id === projectId; });
      var hits = state.trust.ceilings.filter(function (c) {
        if (c.enabled === false) return false;
        if (c.when.regulated && !(p && p.regulated)) return false;
        if (c.when.cls && c.when.cls !== cls) return false;
        if (c.when.project && c.when.project !== projectId) return false;
        if (c.when.gate && c.when.gate !== gateId) return false;
        return true;
      });
      var max = hits.reduce(function (m, c) { return Math.min(m, c.max); }, 4);
      return { max: max, ceilings: hits };
    },
    /* effective level for a work order at a gate */
    levelFor: function (wo, gateId, st) {
      var agent = G.trustAgentFor(gateId);
      var cell = agent ? G.trust.cell(agent, wo.cls, wo.project, wo.repo, st) : null;
      var granted = cell ? cell.level : 1;
      var ceil = G.trust.ceiling(wo.project, wo.cls, gateId, st);
      return { agent: agent, cell: cell, granted: granted, ceiling: ceil.max, ceilings: ceil.ceilings, effective: Math.min(granted, ceil.max) };
    },
    /* should this gate pass under trust? -> { auto, level, reason, sampled } */
    decide: function (wo, gateId, st) {
      var g = G.gateDef(gateId);
      if (!g || gateId === "G0G1") return { auto: false, level: null, reason: "The brief is always confirmed by a person." };
      var lv = G.trust.levelFor(wo, gateId, st);
      var L = lv.effective;
      var gr = wo.guardrail || {};
      var guardBad = gr.over || (gr.protectedTouched && gr.protectedTouched.length);
      if (gateId === "G6" && L < 4) return { auto: false, level: L, reason: "Release confirmation needs L4; this cell runs at " + G.trust.level(L).code + "." };
      if (L >= 3) {
        if (guardBad) return { auto: false, level: L, reason: "Guardrail: " + (gr.over ? "diff of " + gr.size + " lines is over the limit" : "touches protected paths") + "; a person must approve.", guardrail: true };
        return { auto: true, level: L, reason: G.trust.level(L).code + " " + G.trust.level(L).name + ": passes within guardrails." };
      }
      if (L === 2) {
        var rate = S(st).trust.sampleRate || 5;
        var sampled = hash(wo.id + ":" + gateId) % rate === 0;
        if (guardBad) return { auto: false, level: L, reason: "Guardrail breach; a person must approve.", guardrail: true };
        return sampled ? { auto: false, level: L, sampled: true, reason: "L2 spot check: sampled for human review (1 in " + rate + ")." } : { auto: true, level: L, sampled: false, reason: "L2 spot-checked: not sampled this time (1 in " + rate + " are reviewed)." };
      }
      return { auto: false, level: L, reason: G.trust.level(L).code + " " + G.trust.level(L).name + ": a person approves." + (lv.granted > L ? " Capped by " + lv.ceilings.map(function (c) { return c.id; }).join(", ") + "." : "") };
    },
    /* evidence for a cell, derived from finished work orders and agent evals */
    evidence: function (cell, st) {
      var state = S(st);
      var wos = state.workOrders.filter(function (w) { return w.project === cell.project && w.cls === cell.cls && (!cell.repo || w.repo === cell.repo); });
      var done = wos.filter(function (w) { return w.state === "done" && !w.split; });
      var clean = done.filter(function (w) { return !(w.sendbacks || []).length && !Object.keys(w.gates).some(function (k) { return w.gates[k].rejections.length; }) && !(w.outcomes || []).some(function (o) { return o.kind === "revert" || o.kind === "incident"; }); });
      var incidents = done.filter(function (w) { return (w.outcomes || []).some(function (o) { return o.kind === "revert" || o.kind === "incident"; }); });
      var ag = state.agents.find(function (a) { return a.id === cell.agent; });
      var sc = state.scorecards[cell.agent] || {};
      return { runs: done.length, cleanRuns: Math.max(cell.cleanRuns || 0, clean.length), evalScore: ag ? ag.evalScore : 0, rework: sc.rework || 0, incidents: incidents.length, incidentWos: incidents.map(function (w) { return w.id; }) };
    },
    /* does a cell meet the criteria for the next level? */
    meets: function (cell, st) {
      var state = S(st);
      var next = cell.level + 1; if (next > 4) return { ok: false, next: null, missing: ["Already at the top level."] };
      var crit = state.trust.criteria[next]; var ev = G.trust.evidence(cell, st);
      var miss = [];
      if (crit) {
        if (ev.cleanRuns < crit.cleanRuns) miss.push(ev.cleanRuns + " of " + crit.cleanRuns + " clean runs");
        if (ev.evalScore < crit.evalMin) miss.push("eval " + Math.round(ev.evalScore * 100) + "% under " + Math.round(crit.evalMin * 100) + "%");
        if (ev.rework > crit.reworkMax) miss.push("rework " + Math.round(ev.rework * 100) + "% over " + Math.round(crit.reworkMax * 100) + "%");
        if (ev.incidents > crit.incidentsMax) miss.push(ev.incidents + " incident" + (ev.incidents > 1 ? "s" : "") + " in the window");
      }
      var ceil = G.trust.ceiling(cell.project, cell.cls, null, st);
      if (next > ceil.max) miss.push("ceiling " + ceil.ceilings.map(function (c) { return c.id; }).join(", ") + " caps at L" + ceil.max);
      return { ok: !miss.length, next: next, missing: miss, evidence: ev };
    },
    /* human approvals per week saved by moving a cell from its level to `to` */
    projection: function (cell, to, st) {
      var state = S(st);
      var since = Date.now() - 7 * DAY;
      var weekly = state.workOrders.filter(function (w) { return w.project === cell.project && w.cls === cell.cls && w.createdAt >= since; }).length || 1;
      var share = function (L) { return L <= 1 ? 1 : L === 2 ? 1 / (state.trust.sampleRate || 5) : 0; };
      return Math.max(0, Math.round(weekly * (share(cell.level) - share(to)) * 10) / 10);
    },
    /* coverage for a project: share of gate decisions in the last 7 days that ran under trust */
    coverage: function (projectId, st) {
      var state = S(st), since = Date.now() - 7 * DAY, total = 0, auto = 0;
      state.workOrders.forEach(function (w) {
        if (projectId && w.project !== projectId) return;
        Object.keys(w.gates).forEach(function (k) { var d = w.gates[k].decision; if (d && d.at >= since) { total++; if (d.mode === "trust") auto++; } });
      });
      return { total: total, auto: auto, share: total ? auto / total : 0 };
    }
  };

  /* ================= workload ================= */
  var MINUTES = { approve: 6, confirm: 4, answer: 3 };
  /* opts.projects: optional list of project ids; every result is then limited to those projects (privacy scoping
     for people who see only some projects: other projects' work, people and teams never appear) */
  function inScope(opts, pid) { return !opts || !opts.projects || opts.projects.indexOf(pid) >= 0; }
  function inHours(t) { var d = new Date(t + 330 * MIN); var h = d.getUTCHours(), day = d.getUTCDay(); return day >= 1 && day <= 5 && h >= 9 && h < 19; }
  G.workload = {
    /* every human act derived from work orders: { kind, by, at, wo, project, cls, gate?, waitMin? } */
    acts: function (opts, st) {
      opts = opts || {}; var state = S(st), since = Date.now() - (opts.days || 7) * DAY, out = [];
      state.workOrders.forEach(function (w) {
        if (!inScope(opts, w.project)) return;
        Object.keys(w.gates).forEach(function (k) {
          var gs = w.gates[k];
          gs.approvals.forEach(function (a) {
            if (!state.people.some(function (p) { return p.id === a.by; }) || a.at < since) return;
            out.push({ kind: k === "G0G1" ? "confirm" : "approve", by: a.by, at: a.at, wo: w.id, project: w.project, cls: w.cls, gate: k, waitMin: gs.waitingSince ? Math.max(1, Math.round((a.at - gs.waitingSince) / MIN)) : null });
          });
        });
        (w.conv ? w.conv.messages : []).forEach(function (m) {
          if (m.at < since || !state.people.some(function (p) { return p.id === m.from; })) return;
          out.push({ kind: "answer", by: m.from, at: m.at, wo: w.id, project: w.project, cls: w.cls });
        });
      });
      return out;
    },
    people: function (opts, st) {
      var state = S(st), acts = G.workload.acts(opts, st), days = (opts && opts.days) || 7;
      var scoped = opts && opts.projects;
      return state.people.filter(function (p) {
        if (p.status !== "active") return false;
        if (!scoped) return true;
        return p.roles.some(function (g) { return scoped.indexOf(g.scope) >= 0; }) || acts.some(function (a) { return a.by === p.id; });
      }).map(function (p) {
        var mine = acts.filter(function (a) { return a.by === p.id; });
        var approvals = mine.filter(function (a) { return a.kind !== "answer"; });
        var waits = approvals.map(function (a) { return a.waitMin; }).filter(function (x) { return x != null; });
        var waiting = 0, sole = 0, eligibleGates = 0;
        state.workOrders.forEach(function (w) {
          if (w.bay || ["done", "killed"].indexOf(w.state) >= 0 || !inScope(opts, w.project)) return;
          Object.keys(w.gates).forEach(function (k) {
            if (w.gates[k].status !== "waiting" || !G.gateDecision || !G.store) return;
            var mineOk = G.gateDecision(p.id, w, k).allowed;
            if (!mineOk) return;
            waiting++; eligibleGates++;
            var others = state.people.filter(function (o) { return o.id !== p.id && o.status === "active" && G.gateDecision(o.id, w, k).allowed && !(o.roles.length === 1 && o.roles[0].role === "factory_admin"); }).length;
            if (!others) sole++;
          });
        });
        var minutes = mine.reduce(function (t, a) { return t + MINUTES[a.kind]; }, 0);
        return { person: p.id, team: p.teams[0], waiting: waiting, approvals: approvals.length, perDay: +(approvals.length / days).toFixed(1), answered: mine.filter(function (a) { return a.kind === "answer"; }).length,
          medianResponseMin: median(waits), afterHoursShare: mine.length ? mine.filter(function (a) { return !inHours(a.at); }).length / mine.length : 0, soleShare: eligibleGates ? sole / eligibleGates : 0, sole: sole, minutes: minutes };
      });
    },
    teams: function (opts, st) {
      var state = S(st), ppl = G.workload.people(opts, st);
      return state.teams.filter(function (t) { return !(opts && opts.projects) || ppl.some(function (r) { return r.team === t.id; }); }).map(function (t) {
        var rows = ppl.filter(function (r) { return r.team === t.id; });
        return { team: t.id, people: rows.length, waiting: rows.reduce(function (s, r) { return s + r.waiting; }, 0), approvals: rows.reduce(function (s, r) { return s + r.approvals; }, 0), minutes: rows.reduce(function (s, r) { return s + r.minutes; }, 0), medianResponseMin: median(rows.map(function (r) { return r.medianResponseMin; }).filter(Boolean)) };
      });
    },
    /* human minutes per work order by class and by project */
    minutesBy: function (key, opts, st) {
      var acts = G.workload.acts(opts, st), out = {};
      acts.forEach(function (a) { var k = a[key]; out[k] = out[k] || { minutes: 0, wos: {} }; out[k].minutes += MINUTES[a.kind]; out[k].wos[a.wo] = 1; });
      return Object.keys(out).map(function (k) { var n = Object.keys(out[k].wos).length; return { key: k, minutes: out[k].minutes, workOrders: n, perWO: n ? +(out[k].minutes / n).toFixed(1) : 0 }; }).sort(function (a, b) { return b.perWO - a.perWO; });
    },
    /* gates ranked by time work waited on people */
    bottlenecks: function (opts, st) {
      var acts = G.workload.acts(opts, st).filter(function (a) { return a.waitMin != null; }), out = {};
      acts.forEach(function (a) { var k = a.project + ":" + a.gate; out[k] = out[k] || { project: a.project, gate: a.gate, waits: [] }; out[k].waits.push(a.waitMin); });
      var state = S(st);
      state.workOrders.forEach(function (w) { if (w.bay || !inScope(opts, w.project)) return; Object.keys(w.gates).forEach(function (k) { var gs = w.gates[k]; if (gs.status === "waiting") { var key = w.project + ":" + k; out[key] = out[key] || { project: w.project, gate: k, waits: [] }; out[key].open = (out[key].open || 0) + 1; out[key].oldestMin = Math.max(out[key].oldestMin || 0, Math.round((Date.now() - (gs.waitingSince || w.createdAt)) / MIN)); } }); });
      return Object.keys(out).map(function (k) { var x = out[k]; return { project: x.project, gate: x.gate, decisions: x.waits.length, medianWaitMin: median(x.waits), open: x.open || 0, oldestMin: x.oldestMin || 0 }; }).sort(function (a, b) { return (b.medianWaitMin + b.oldestMin / 4) - (a.medianWaitMin + a.oldestMin / 4); });
    },
    /* suggestions: { kind: "approver"|"trust"|"delegate", text, project?, gate?, person?, cell? } */
    suggestions: function (opts, st) {
      var state = S(st), out = [];
      G.workload.people(opts, st).forEach(function (r) {
        var p = state.people.find(function (x) { return x.id === r.person; });
        if (r.sole >= 2) out.push({ kind: "approver", person: r.person, text: p.name + " is the only eligible approver on " + r.sole + " waiting gates. Add a second approver to those rules." });
        if (p.away && p.away.to > Date.now() && r.waiting && !p.away.delegate) out.push({ kind: "delegate", person: r.person, text: p.name + " is away with " + r.waiting + " approvals waiting. Set a delegate." });
        if (r.afterHoursShare > 0.3 && r.approvals > 3) out.push({ kind: "approver", person: r.person, text: p.name + " does " + Math.round(r.afterHoursShare * 100) + "% of approvals out of hours. Spread the on-call approvals." });
      });
      state.trust.proposals.filter(function (x) { return x.status === "pending"; }).filter(function (x) { var c = state.trust.cells.find(function (y) { return y.id === x.cell; }); return c && inScope(opts, c.project); }).slice(0, 3).forEach(function (x) {
        var c = state.trust.cells.find(function (y) { return y.id === x.cell; });
        if (c) out.push({ kind: "trust", cell: c.id, proposal: x.id, text: "Raise trust for " + (G.CLASSES.find(function (k) { return k.id === c.cls; }) || { name: c.cls }).name + " in " + (state.projects.find(function (p) { return p.id === c.project; }) || {}).name + " to L" + x.to + ": saves about " + (x.savedPerWeek || 0) + " approvals a week." });
      });
      G.workload.bottlenecks(opts, st).slice(0, 2).forEach(function (b) { if (b.medianWaitMin > 60) out.push({ kind: "approver", project: b.project, gate: b.gate, text: "Work waits a median " + Math.round(b.medianWaitMin) + " min at " + (G.gateDef(b.gate) || { label: b.gate }).label + " in " + (state.projects.find(function (p) { return p.id === b.project; }) || {}).name + ". Add an approver or raise trust." }); });
      return out;
    }
  };

  /* scoped workload detail for the workload view and the console: o = { ids: [projectId], days }.
     Rows per person with the waiting gates they may decide (eligible vs break-glass), teams, minutes by class
     and project, bottlenecks with their open items, and the Needs-a-person bay. */
  function medianN(xs) { if (!xs.length) return null; var s = xs.slice().sort(function (a, b) { return a - b; }); var m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  G.workload.summary = function (o) {
    o = o || {};
    var state = S(), days = o.days || 7;
    var ids = o.ids || [], inScope = function (pid) { return ids.indexOf(pid) >= 0; };
    var acts = G.workload.acts({ days: days }).filter(function (a) { return inScope(a.project); });
    var people = state.people.filter(function (p) { return p.status === "active"; });
    /* waiting gates in scope with who may decide them */
    var gates = [];
    state.workOrders.forEach(function (w) {
      if (!inScope(w.project) || w.bay || ["done", "killed"].indexOf(w.state) >= 0) return;
      Object.keys(w.gates).forEach(function (k) {
        var gs = w.gates[k]; if (gs.status !== "waiting") return;
        if (G.gateKind && G.gateKind(G.find.project(w.project), k) === "auto") return;
        var elig = [], glass = [];
        people.forEach(function (p) {
          var d = G.gateDecision(p.id, w, k); if (!d.allowed) return;
          if (/break-glass/.test(d.reason)) glass.push(p.id); else elig.push(p.id);
        });
        gates.push({ wo: w, gate: k, since: gs.waitingSince || w.createdAt, eligible: elig, glass: glass, trustNote: gs.trustNote || null });
      });
    });
    var rows = people.map(function (p) {
      var mine = acts.filter(function (a) { return a.by === p.id; });
      var appr = mine.filter(function (a) { return a.kind !== "answer"; });
      var waits = appr.map(function (a) { return a.waitMin; }).filter(function (x) { return x != null; });
      var waiting = gates.filter(function (g) { return g.eligible.indexOf(p.id) >= 0; });
      var sole = waiting.filter(function (g) { return g.eligible.length === 1; });
      var glass = gates.filter(function (g) { return g.glass.indexOf(p.id) >= 0; }).length;
      var inProj = p.roles.some(function (g) { return g.scope === "factory" || inScope(g.scope); });
      return { person: p.id, name: p.name, team: (p.teams || [])[0] || null, inProj: inProj, acts: mine, waiting: waiting.length, waitingGates: waiting, glass: glass,
        approvals: appr.length, perDay: appr.length / days, answered: mine.length - appr.length, waitN: waits.length, medianResponseMin: medianN(waits),
        afterHours: mine.filter(function (a) { return !inHours(a.at); }).length, n: mine.length, sole: sole.length, soleGates: sole,
        minutes: mine.reduce(function (t, a) { return t + MINUTES[a.kind]; }, 0), away: p.away && p.away.to > Date.now() ? p.away : null, oncall: !!p.oncall };
    }).filter(function (r) { return r.inProj && (r.n || r.waiting || r.glass); });
    var teams = state.teams.map(function (t) {
      var rs = rows.filter(function (r) { return r.team === t.id; });
      var waits = []; rs.forEach(function (r) { r.acts.forEach(function (a) { if (a.waitMin != null && a.kind !== "answer") waits.push(a.waitMin); }); });
      var n = rs.reduce(function (s, r) { return s + r.n; }, 0);
      return { team: t.id, name: t.name, people: rs.length, waiting: rs.reduce(function (s, r) { return s + r.waiting; }, 0), approvals: rs.reduce(function (s, r) { return s + r.approvals; }, 0),
        answered: rs.reduce(function (s, r) { return s + r.answered; }, 0), minutes: rs.reduce(function (s, r) { return s + r.minutes; }, 0), waitN: waits.length, medianResponseMin: medianN(waits),
        afterHours: rs.reduce(function (s, r) { return s + r.afterHours; }, 0), n: n, sole: rs.reduce(function (s, r) { return s + r.sole; }, 0) };
    }).filter(function (t) { return t.people; });
    function minutesBy(key) {
      var out = {};
      acts.forEach(function (a) { var k = a[key]; out[k] = out[k] || { key: k, minutes: 0, wos: {} }; out[k].minutes += MINUTES[a.kind]; out[k].wos[a.wo] = 1; });
      return Object.keys(out).map(function (k) { var n = Object.keys(out[k].wos).length; return { key: k, minutes: out[k].minutes, workOrders: n, perWO: n ? out[k].minutes / n : 0 }; }).sort(function (a, b) { return b.perWO - a.perWO; });
    }
    /* gates ranked by wait on people */
    var bn = {};
    acts.forEach(function (a) { if (a.waitMin == null || a.kind === "answer") return; var k = a.project + ":" + a.gate; bn[k] = bn[k] || { project: a.project, gate: a.gate, waits: [], open: 0, oldestMin: 0, items: [] }; bn[k].waits.push(a.waitMin); });
    gates.forEach(function (g) { var k = g.wo.project + ":" + g.gate; bn[k] = bn[k] || { project: g.wo.project, gate: g.gate, waits: [], open: 0, oldestMin: 0, items: [] }; bn[k].open++; bn[k].items.push(g); bn[k].oldestMin = Math.max(bn[k].oldestMin, Math.round((Date.now() - g.since) / MIN)); });
    var bottlenecks = Object.keys(bn).map(function (k) { var x = bn[k]; var st = G.gateDef(x.gate); return Object.assign(x, { decisions: x.waits.length, medianWaitMin: medianN(x.waits), station: st ? st.after : null, minEligible: x.items.length ? Math.min.apply(null, x.items.map(function (g) { return g.eligible.length; })) : null }); })
      .sort(function (a, b) { return ((b.medianWaitMin || 0) + b.oldestMin / 4) - ((a.medianWaitMin || 0) + a.oldestMin / 4); });
    /* bay "Needs a person": work waiting on an answer */
    var person = state.workOrders.filter(function (w) { return inScope(w.project) && w.bay === "person" && ["done", "killed"].indexOf(w.state) < 0; });
    return { ids: ids, acts: acts, gates: gates, rows: rows, teams: teams, byCls: minutesBy("cls"), byProject: minutesBy("project"), bottlenecks: bottlenecks, needsPerson: person };
  };
  /* scoped workload for any view (the console's local matcher): projectIds default to what the viewer sees and are
     always limited to it */
  G.workloadSummary = function (projectIds, days) {
    var vis = G.visibleProjects(G.viewerId()).filter(function (p) { return p.status !== "archived" || (projectIds || []).indexOf(p.id) >= 0; }).map(function (p) { return p.id; });
    var ids = (projectIds || vis).filter(function (id) { return vis.indexOf(id) >= 0; });
    return G.workload.summary({ ids: ids, days: days || 7 });
  };

  /* ================= learning signals ================= */
  G.learning = {
    /* raw signals from work orders: { signal, wo, project, agent?, text, at } */
    signals: function (st) {
      var state = S(st), out = [];
      state.workOrders.forEach(function (w) {
        Object.keys(w.gates).forEach(function (k) { w.gates[k].rejections.forEach(function (r) { out.push({ signal: "rejection", wo: w.id, project: w.project, agent: G.trustAgentFor(k), gate: k, text: r.reason, at: r.at }); }); });
        (w.sendbacks || []).forEach(function (s) { out.push({ signal: "sendback", wo: w.id, project: w.project, agent: (G.stationDef(s.from) || {}).agent, text: s.note || "sent back", at: s.at }); });
        (w.outcomes || []).forEach(function (o) { if (o.kind === "revert" || o.kind === "incident") out.push({ signal: o.kind, wo: w.id, project: w.project, agent: "ag-build", text: o.text, at: o.at }); });
        if (w.clsOverridden) out.push({ signal: "override", wo: w.id, project: w.project, agent: "ag-classifier", text: w.clsOverridden.from + " → " + w.cls + ": " + (w.clsOverridden.reason || ""), at: w.clsOverridden.at });
        (w.conv ? w.conv.misses : []).forEach(function (m) { out.push({ signal: "miss", wo: w.id, project: w.project, agent: "ag-intake", text: m.text, at: w.createdAt }); });
      });
      return out;
    }
  };

  /* ================= replay ================= */
  /* Bay stays and state changes are recorded as events so replay can show them truthfully:
     wo.bay { bay (null = back on the belt), from, text } and wo.state { from, to, text } for failed, blocked, killed
     and the way out of them. G.trackStates diffs each work order against the last snapshot (state.woTrack) and logs
     what changed; the store calls it on every workOrders change. Seeding takes the baseline without events. */
  var TRACKED = ["failed", "blocked", "killed"];
  G.trackStates = function (st) {
    var state = S(st); if (!state || !state.workOrders) return;
    var tr = state.woTrack || (state.woTrack = {}), baseline = !!st;
    state.workOrders.forEach(function (w) {
      var now = { state: w.state, bay: w.bay || null };
      var prev = tr[w.id]; tr[w.id] = now;
      if (!prev || baseline) return;
      if (prev.bay !== now.bay) G.logEvent("wo.bay", { project: w.project, wo: w.id, bay: now.bay, from: prev.bay, station: (G.STATIONS[w.station] || {}).id, text: now.bay ? w.bayReason || "" : "Back on the belt" });
      if (prev.state !== now.state && (TRACKED.indexOf(now.state) >= 0 || TRACKED.indexOf(prev.state) >= 0)) G.logEvent("wo.state", { project: w.project, wo: w.id, from: prev.state, to: now.state, station: (G.STATIONS[w.station] || {}).id, text: now.state === "failed" ? w.failReason || "" : now.state === "blocked" ? w.blockReason || "" : "" });
    });
  };

  /* Where was every work order of a project at time t? Station from traveler history; bay and failed / blocked /
     killed state from the event log (wo.bay, wo.state, work-order kills); waiting from the gate decision record.
     At t = now this equals the live floor. */
  G.stateAt = function (t, projectId, st) {
    var state = S(st);
    var byWo = {};
    state.events.forEach(function (e) { if (e.wo && e.at <= t && (e.type === "wo.bay" || e.type === "wo.state" || ((e.type === "kill" || e.type === "restore") && e.scope === "workorder"))) (byWo[e.wo] = byWo[e.wo] || []).push(e); });
    function last(list, pred) { for (var i = (list || []).length - 1; i >= 0; i--) if (pred(list[i])) return list[i]; return null; }
    var wos = [];
    state.workOrders.forEach(function (w) {
      if (projectId && w.project !== projectId) return;
      if (w.createdAt > t) return;
      if (w.doneAt && w.doneAt <= t) { wos.push({ id: w.id, station: "done", state: "done", bay: null, at: w.doneAt }); return; }
      var evs = byWo[w.id] || [];
      var cur = null;
      for (var i = 0; i < w.history.length; i++) { var e = w.history[i]; if (e.startedAt <= t) cur = e; }
      if (!cur) cur = w.history[0];
      var k = last(evs, function (e) { return e.type === "kill" || e.type === "restore" || (e.type === "wo.state" && (e.to === "killed" || e.from === "killed")); });
      var killedNow = k ? (k.type === "kill" || (k.type === "wo.state" && k.to === "killed")) : !!(w.killed && w.killed.at <= t && w.state === "killed");
      if (killedNow) { wos.push({ id: w.id, station: w.killed && w.killed.prev ? G.STATIONS[w.killed.prev.station].id : cur.station, state: "killed", bay: null, progress: 0 }); return; }
      var be = last(evs, function (e) { return e.type === "wo.bay"; });
      var parked = be ? be.bay : (w.bay && w.bayAt && w.bayAt <= t ? w.bay : null);
      var se = last(evs, function (e) { return e.type === "wo.state"; });
      var bad = se && (se.to === "failed" || se.to === "blocked") ? se.to : null;
      if (!se && (w.state === "failed" || w.state === "blocked") && cur === w.history[w.history.length - 1]) bad = w.state;
      var station = parked ? (be && be.station) || (w.bay && G.STATIONS[w.station] ? G.STATIONS[w.station].id : cur.station) : cur.station;
      var running = !cur.endedAt || cur.endedAt > t;
      var gate = !running ? G.gateAfter(cur.station) : null;
      var p = state.projects.find(function (x) { return x.id === w.project; });
      var waiting = !running && gate && w.gates[gate.id] && G.gateKind(p, gate.id) !== "auto" && !(w.gates[gate.id].decision && w.gates[gate.id].decision.at <= t);
      /* at Intake the work order waits on the conversation and the brief (G0+G1) until a person confirms it */
      if (cur.station === "intake" && w.gates.G0G1 && !(w.gates.G0G1.decision && w.gates.G0G1.decision.at <= t) && !(w.gates.G0G1.approvals[0] && w.gates.G0G1.approvals[0].at <= t)) { waiting = true; gate = G.gateDef("G0G1"); }
      if (!running && !gate && w.gates.G6 && !(w.gates.G6.decision && w.gates.G6.decision.at <= t)) { waiting = true; gate = G.gateDef("G6"); }
      var stateNow = parked ? "parked" : bad ? bad : waiting ? "waiting" : "running";
      wos.push({ id: w.id, station: station, state: stateNow, bay: parked, gate: waiting && gate ? gate.id : null,
        progress: stateNow !== "running" ? (running ? Math.min(95, Math.round((t - cur.startedAt) / (40 * MIN) * 100)) : 100) : cur.endedAt ? Math.min(100, Math.round((t - cur.startedAt) / (cur.endedAt - cur.startedAt) * 100)) : Math.min(95, Math.round((t - cur.startedAt) / (40 * MIN) * 100)) });
    });
    var ev = state.events.filter(function (e) { return (!projectId || e.project === projectId || !e.project) && e.at <= t; });
    function lastOf(types, pred) { for (var i = ev.length - 1; i >= 0; i--) if (types.indexOf(ev[i].type) >= 0 && (!pred || pred(ev[i]))) return ev[i]; return null; }
    var h = lastOf(["halt", "resume"], function (e) { return e.scope === "project"; });
    var k = lastOf(["kill", "restore"], function (e) { return e.scope === "project" || e.scope === "factory"; });
    var haltedRepos = {};
    ev.forEach(function (e) { if (e.scope === "repo" && e.type === "halt") haltedRepos[e.repo] = e; if (e.scope === "repo" && e.type === "resume") delete haltedRepos[e.repo]; });
    return { at: t, workOrders: wos, halted: h && h.type === "halt" ? h : null, killed: k && k.type === "kill" ? k : null, haltedRepos: haltedRepos };
  };
  G.replay = {
    /* events in a window, optionally for a project and types: newest last */
    events: function (o, st) {
      o = o || {}; var state = S(st);
      return state.events.filter(function (e) { return (!o.project || e.project === o.project || (!e.project && o.includeFactory !== false)) && (!o.from || e.at >= o.from) && (!o.to || e.at <= o.to) && (!o.types || o.types.indexOf(e.type) >= 0); });
    },
    /* the milestones of one work order for the record's journey scrubber */
    journey: function (woId, st) {
      var state = S(st);
      return state.events.filter(function (e) { return e.wo === woId; });
    },
    range: function (span) { var now = Date.now(); return { from: now - (span === "7d" ? 7 * DAY : DAY), to: now }; },
    MARK_TYPES: ["gate.decision", "halt", "resume", "kill", "restore", "release", "trust.auto", "outcome", "wo.state"]
  };
})(window.G);
