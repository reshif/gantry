/* Round-three operations, merged into G.ops: trust ladder, flow catalogue (stations, gates, bays,
   classes), custom roles, integration types and instances, vendors and models, card templates,
   learning proposals, eval cases and record notes. Same contract as sim.js: check G.me, mutate the
   store, audit, log events where replay cares, return { ok, msg, ... }. */
(function (G) {
  "use strict";
  function S(k) { return G.store.get(k); }
  function me() { return G.viewerId(); }
  function ok(msg, extra) { return Object.assign({ ok: true, msg: msg }, extra || {}); }
  function fail(msg, extra) { return Object.assign({ ok: false, msg: msg }, extra || {}); }
  function deny(action, target, where, d, category) {
    G.audit(action, target, where, "denied", { category: category });
    return fail((d.needs ? d.needs + ". " : "") + d.reason, { decision: d });
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24); }
  function pname(id) { return (G.find.project(id) || { name: id }).name; }
  function gateForAgent(agent) { return G.GATES.find(function (g) { return g.id !== "G0G1" && G.trustAgentFor(g.id) === agent; }); }
  function cellLabel(c) { return (G.find.agent(c.agent) || { name: c.agent }).name + " · " + (G.find.cls(c.cls) || { name: c.cls }).name + " · " + pname(c.project) + (c.repo ? " · " + c.repo : ""); }
  G.trustCellLabel = cellLabel;

  /* the gate a cell's agent is judged at, and the ceiling that applies there */
  G.trust.cellCeiling = function (c) { var g = gateForAgent(c.agent); return G.trust.ceiling(c.project, c.cls, g ? g.id : null); };

  function applyLevel(cell, to, kind, reason, by) {
    var from = cell.level;
    cell.level = to; cell.since = Date.now(); if (to < from) cell.cleanRuns = 0;
    cell.history.push({ at: Date.now(), from: from, to: to, by: by || me(), kind: kind, reason: reason });
    S("trust").proposals.forEach(function (x) { if (x.cell === cell.id && x.status === "pending" && kind !== "proposal") { x.status = "withdrawn"; x.decidedAt = Date.now(); x.reason = "Superseded by a direct change"; } });
    G.logEvent("trust.change", { project: cell.project, cell: cell.id, from: from, to: to, by: by || me(), text: reason });
    G.notify(cell.project, "trust.changed", { cell: cell.id });
  }

  var ops = {
    /* ===== trust ladder ===== */
    /* target: cell id or { agent, cls, project, repo } (creates the cell when missing) */
    grantTrust: function (target, level, reason) {
      var tr = S("trust");
      var cell = typeof target === "string" ? G.find.trustCell(target) : G.find.trustCell(G.trustCellId(target.agent, target.cls, target.project, target.repo));
      var spec = typeof target === "string" ? null : target;
      var projectId = cell ? cell.project : spec && spec.project;
      if (!projectId) return fail("Unknown trust cell.");
      var d = G.me("trust.grant", { project: projectId });
      if (!d.allowed) return deny("trust.grant", cell ? cell.id : JSON.stringify(spec), projectId, d, "agents");
      level = +level;
      if (!(level >= 0 && level <= 4)) return fail("Level is 0 to 4.");
      if (!reason || reason.trim().length < 4) return fail("Give a reason for the change.");
      if (!cell) {
        if (!G.find.agent(spec.agent) || !G.find.cls(spec.cls)) return fail("Pick an agent and a work class.");
        cell = { id: G.trustCellId(spec.agent, spec.cls, spec.project, spec.repo), agent: spec.agent, cls: spec.cls, project: spec.project, repo: spec.repo || null, level: 1, since: Date.now(), cleanRuns: 0, history: [{ at: Date.now(), from: null, to: 1, by: me(), kind: "seed", reason: "Cell created" }] };
        tr.cells.push(cell);
      }
      if (level === cell.level) return fail(cell.id + " is already L" + level + ".");
      var ceil = G.trust.cellCeiling(cell);
      if (level > ceil.max) return fail("Capped at L" + ceil.max + " by " + ceil.ceilings.map(function (c) { return c.id + " (" + c.text + ")"; }).join(", ") + ".");
      var g = gateForAgent(cell.agent);
      if (level === 4 && (!g || g.id !== "G6")) return fail("L4 only changes release confirmation; this agent does not staff the station before G6. Use L3.");
      var before = "L" + cell.level;
      G.store.update("trust", function () { applyLevel(cell, level, level > cell.level ? "grant" : "demote", reason.trim()); });
      G.audit("trust.grant", cellLabel(cell) + ": " + before + " → L" + level + " (" + reason.trim() + ")", projectId, "ok", { project: projectId, category: "agents", before: before, after: "L" + level, entity: { type: "trust", id: cell.id } });
      return ok(cellLabel(cell) + " is now L" + level + " " + G.trust.level(level).name + ".", { cell: cell });
    },
    decideTrustProposal: function (proposalId, accept, reason) {
      var tr = S("trust"), p = tr.proposals.find(function (x) { return x.id === proposalId; });
      if (!p) return fail("No such proposal.");
      if (p.status !== "pending") return fail(p.id + " is already " + p.status + ".");
      var cell = G.find.trustCell(p.cell); if (!cell) return fail("The cell is gone.");
      var d = G.me("trust.grant", { project: cell.project });
      if (!d.allowed) return deny("trust.proposal", p.id, cell.project, d, "agents");
      if (!accept && (!reason || reason.trim().length < 4)) return fail("Say why you are declining.");
      if (accept) {
        var ceil = G.trust.cellCeiling(cell);
        if (p.to > ceil.max) return fail("Capped at L" + ceil.max + " by " + ceil.ceilings.map(function (c) { return c.id; }).join(", ") + ". Decline it or change the ceiling.");
      }
      G.store.update("trust", function () {
        p.status = accept ? "accepted" : "declined"; p.by = me(); p.decidedAt = Date.now(); p.reason = (reason || "").trim();
        if (accept) applyLevel(cell, p.to, "proposal", "Proposal " + p.id + " approved" + (reason ? ": " + reason.trim() : ""));
      });
      G.audit("trust.proposal", p.id + " " + (accept ? "approved" : "declined") + ": " + cellLabel(cell) + " L" + p.from + " → L" + p.to, cell.project, "ok", { project: cell.project, category: "agents", before: "L" + p.from, after: accept ? "L" + p.to : "L" + p.from, entity: { type: "trust", id: cell.id } });
      return ok(p.id + (accept ? " approved. " + cellLabel(cell) + " is L" + p.to + "." : " declined."));
    },
    demoteTrust: function (cellId, to, reason) {
      var cell = G.find.trustCell(cellId); if (!cell) return fail("No such cell.");
      if (to >= cell.level) return fail("Demotion goes down a level.");
      return ops.grantTrust(cellId, to, reason);
    },
    /* level 2|3|4, patch { cleanRuns, evalMin, reworkMax, incidentsMax, windowD } */
    setTrustCriteria: function (level, patch) {
      var d = G.me("trust.criteria");
      if (!d.allowed) return deny("trust.criteria", "L" + level + " criteria", "factory", d, "agents");
      var tr = S("trust"), c = tr.criteria[level]; if (!c) return fail("Criteria exist for L2, L3 and L4.");
      var before = JSON.stringify(c);
      var bad = Object.keys(patch).filter(function (k) { return !(k in c) || isNaN(+patch[k]) || +patch[k] < 0; });
      if (bad.length) return fail("Check " + bad.join(", ") + ".");
      if (patch.evalMin != null && +patch.evalMin > 1) return fail("Eval minimum is a share between 0 and 1.");
      G.store.update("trust", function () { Object.keys(patch).forEach(function (k) { c[k] = +patch[k]; }); });
      G.audit("trust.criteria", "L" + level + " promotion criteria", "factory", "ok", { category: "agents", before: before, after: JSON.stringify(c), entity: { type: "trustcriteria", id: "L" + level } });
      return ok("L" + level + " criteria saved.");
    },
    /* c: { id?, text, when: { regulated?, cls?, project?, gate? }, max, enabled } */
    saveCeiling: function (c) {
      var d = G.me("trust.criteria");
      if (!d.allowed) return deny("trust.ceiling", c.id || c.text || "ceiling", "factory", d, "agents");
      if (!c.text || !c.text.trim()) return fail("Describe the ceiling.");
      if (!(c.max >= 0 && c.max <= 4)) return fail("Maximum level is 0 to 4.");
      var tr = S("trust"), ex = c.id ? tr.ceilings.find(function (x) { return x.id === c.id; }) : null;
      var before = ex ? JSON.stringify(ex) : null;
      var nextN = tr.ceilings.reduce(function (m, x) { var n = +String(x.id).replace("CEIL-", ""); return n > m ? n : m; }, 0) + 1;
      var rec = { id: ex ? ex.id : "CEIL-" + nextN, text: c.text.trim(), when: clone(c.when || {}), max: +c.max, enabled: c.enabled !== false };
      G.store.update("trust", function () { if (ex) Object.assign(ex, rec); else tr.ceilings.push(rec); });
      G.audit("trust.ceiling", rec.id + ": " + rec.text, "factory", "ok", { category: "agents", before: before, after: JSON.stringify(rec), entity: { type: "ceiling", id: rec.id } });
      return ok(rec.id + " saved.", { ceiling: rec });
    },
    removeCeiling: function (id) {
      var d = G.me("trust.criteria");
      if (!d.allowed) return deny("trust.ceiling", id, "factory", d, "agents");
      var tr = S("trust"), ex = tr.ceilings.find(function (x) { return x.id === id; }); if (!ex) return fail("No such ceiling.");
      G.store.update("trust", function () { tr.ceilings = tr.ceilings.filter(function (x) { return x.id !== id; }); });
      G.audit("trust.ceiling", id + " removed", "factory", "ok", { category: "agents", before: JSON.stringify(ex), after: null, entity: { type: "ceiling", id: id } });
      return ok(id + " removed.");
    },
    setSampleRate: function (n) {
      var d = G.me("trust.criteria");
      if (!d.allowed) return deny("trust.sample", "L2 sample rate", "factory", d, "agents");
      n = Math.round(+n); if (!(n >= 2 && n <= 50)) return fail("Sample 1 in 2 to 1 in 50.");
      var before = S("trust").sampleRate;
      G.store.update("trust", function (t) { t.sampleRate = n; });
      G.audit("trust.sample", "L2 spot-check rate 1 in " + n, "factory", "ok", { category: "agents", before: "1 in " + before, after: "1 in " + n });
      return ok("L2 cells now sample 1 in " + n + " for review.");
    },

    /* ===== flow catalogue ===== */
    /* def: { name, agent, purpose, wip, id? }, afterId: a station id in the project's order */
    addStation: function (projectId, def, afterId) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("flow.edit", { project: p.id });
      if (!d.allowed) return deny("station.add", def.name || "station", p.id, d, "config");
      if (!def.name || !def.name.trim()) return fail("Name the station.");
      if (!G.find.agent(def.agent)) return fail("Pick the agent that staffs it.");
      if (p.flow.order.indexOf(afterId) < 0) return fail("Pick where it goes in the flow.");
      if (afterId === "close") return fail("Close is always last.");
      var id = def.id || slug(def.name);
      if (G.STATIONS.some(function (s) { return s.id === id; }) && p.flow.order.indexOf(id) >= 0) return fail("This project already has a station called " + def.name + ".");
      if (G.STATIONS.some(function (s) { return s.id === id && !s.custom; })) id = id + "-" + p.id.slice(0, 4);
      var st;
      G.store.update("projects", function () { st = G.catalog.addStation(S(), { id: id, name: def.name.trim(), agent: def.agent, purpose: def.purpose || "", wip: +def.wip || 5 }, p.id, afterId); });
      G.audit("station.add", p.name + ": " + st.name + " after " + G.find.station(afterId).name, p.id, "ok", { project: p.id, category: "config", after: JSON.stringify(st), entity: { type: "station", id: st.id } });
      if (def.gate) ops.addGate(p.id, Object.assign({ after: st.id }, def.gate));
      return ok(st.name + " added to " + p.name + ".", { station: st });
    },
    removeStation: function (projectId, stationId) {
      var p = G.find.project(projectId), s = G.stationDef(stationId);
      if (!p || !s) return fail("Unknown project or station.");
      var d = G.me("flow.edit", { project: p.id });
      if (!d.allowed) return deny("station.remove", s.name, p.id, d, "config");
      if (!s.custom) return fail(s.name + " is built in. Turn it off in the flow instead.");
      var busy = S("workOrders").filter(function (w) { return w.project === p.id && G.stationOf(w).id === stationId && ["done", "killed"].indexOf(w.state) < 0; });
      if (busy.length) return fail(busy.length + " work order" + (busy.length > 1 ? "s are" : " is") + " at " + s.name + ". Move " + (busy.length > 1 ? "them" : "it") + " first.");
      G.store.update("projects", function () {
        p.flow.order = p.flow.order.filter(function (x) { return x !== stationId; });
        p.flow.stations[stationId] = { enabled: false, wip: 5, absent: true };
        G.GATES.filter(function (g) { return g.after === stationId; }).forEach(function (g) { p.flow.gates[g.id] = { enabled: false, mode: g.kind, absent: true }; });
      });
      G.audit("station.remove", p.name + ": " + s.name, p.id, "ok", { project: p.id, category: "config", before: s.name, after: null, entity: { type: "station", id: s.id } });
      return ok(s.name + " removed from " + p.name + ".");
    },
    /* move a station one place earlier (-1) or later (+1); intake and close stay put */
    moveStation: function (projectId, stationId, dir) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("flow.edit", { project: p.id });
      if (!d.allowed) return deny("station.move", stationId, p.id, d, "config");
      var o = p.flow.order, i = o.indexOf(stationId), j = i + (dir < 0 ? -1 : 1);
      if (i < 0) return fail("Not in this flow.");
      if (stationId === "intake" || stationId === "close" || o[j] === "intake" || o[j] === "close" || j < 0 || j >= o.length) return fail("Intake stays first and Close stays last.");
      var before = o.join(">");
      G.store.update("projects", function () { o[i] = o[j]; o[j] = stationId; });
      G.audit("station.move", p.name + ": " + G.find.station(stationId).name, p.id, "ok", { project: p.id, category: "config", before: before, after: o.join(">"), entity: { type: "flow", id: p.id } });
      return ok(G.find.station(stationId).name + " moved.");
    },
    /* def: { name, label?, after (station id), kind auto|human|mixed, roles[], required, purpose } */
    addGate: function (projectId, def) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("flow.edit", { project: p.id });
      if (!d.allowed) return deny("gate.add", def.name || "gate", p.id, d, "config");
      if (!def.name || !def.name.trim()) return fail("Name the gate.");
      if (p.flow.order.indexOf(def.after) < 0) return fail("Pick the station it follows.");
      if (G.GATES.some(function (g) { return g.after === def.after && !(p.flow.gates[g.id] || {}).absent; })) return fail(G.find.station(def.after).name + " already has a gate after it.");
      if ((def.kind || "human") !== "auto" && !(def.roles || []).length) return fail("Pick at least one approver role.");
      var id = def.id || def.label || ("G" + def.name.trim().split(/\s+/).map(function (w) { return w[0]; }).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3));
      while (G.GATES.some(function (g) { return g.id === id; }) && !(p.flow.gates[id] || {}).absent) id += "X";
      var g;
      G.store.update("projects", function () { g = G.catalog.addGate(S(), { id: id, label: def.label || id, name: def.name.trim(), after: def.after, kind: def.kind || "human", roles: def.roles, required: def.required, purpose: def.purpose }, p.id); });
      G.audit("gate.add", p.name + ": " + g.label + " " + g.name + " after " + G.find.station(def.after).name, p.id, "ok", { project: p.id, category: "config", after: JSON.stringify(g), entity: { type: "gate", id: g.id } });
      return ok(g.label + " " + g.name + " added to " + p.name + ".", { gate: g });
    },
    addBay: function (projectId, def) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("flow.edit", { project: p.id });
      if (!d.allowed) return deny("bay.add", def.name || "bay", p.id, d, "config");
      if (!def.name || !def.name.trim()) return fail("Name the bay.");
      var id = def.id || slug(def.name);
      if (p.flow.bays.indexOf(id) >= 0) return fail(p.name + " already has that bay.");
      var b;
      G.store.update("projects", function () { b = G.catalog.addBay(S(), { id: id, name: def.name.trim(), desc: def.desc || "" }, p.id); });
      G.audit("bay.add", p.name + ": " + b.name, p.id, "ok", { project: p.id, category: "config", entity: { type: "bay", id: b.id } });
      return ok(b.name + " bay added to " + p.name + ".", { bay: b });
    },
    /* def: { name, skips[], priority, slaH, est, token, shape, hints[], gates[] } */
    addClass: function (projectId, def) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("class.edit", { project: p.id });
      if (!d.allowed) return deny("class.add", def.name || "class", p.id, d, "config");
      if (!def.name || !def.name.trim()) return fail("Name the work class.");
      var id = def.id || slug(def.name);
      if (p.flow.classes.some(function (c) { return c.id === id; })) return fail(p.name + " already has " + def.name + ".");
      var bad = (def.skips || []).filter(function (s) { return s === "intake" || s === "close" || p.flow.order.indexOf(s) < 0; });
      if (bad.length) return fail("Can't skip " + bad.join(", ") + ".");
      var c;
      G.store.update("projects", function () { c = G.catalog.addClass(S(), Object.assign({}, def, { id: id, name: def.name.trim() }), p.id); });
      G.audit("class.add", p.name + ": " + c.name, p.id, "ok", { project: p.id, category: "config", after: JSON.stringify(c), entity: { type: "class", id: c.id } });
      return ok(c.name + " added to " + p.name + ".", { cls: c });
    },
    updateClass: function (projectId, clsId, patch) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("class.edit", { project: p.id });
      var c = p.flow.classes.find(function (x) { return x.id === clsId; }); if (!c) return fail("No such class in " + p.name + ".");
      if (!d.allowed) return deny("class.edit", c.name, p.id, d, "config");
      if (patch.enabled === false && S("workOrders").some(function (w) { return w.project === p.id && w.cls === clsId && ["done", "killed"].indexOf(w.state) < 0; })) return fail("Open work orders use " + c.name + ". Reclassify or finish them first.");
      if (patch.skips && patch.skips.some(function (s) { return s === "intake" || s === "close"; })) return fail("Intake and Close can't be skipped.");
      var before = JSON.stringify(c);
      G.store.update("projects", function () { Object.keys(patch).forEach(function (k) { c[k] = clone(patch[k]); }); var g = G.find.cls(clsId); if (g && g.custom && g.project === p.id) Object.keys(patch).forEach(function (k) { if (k !== "enabled") g[k] = clone(patch[k]); }); });
      G.audit("class.edit", p.name + ": " + c.name + " (" + Object.keys(patch).join(", ") + ")", p.id, "ok", { project: p.id, category: "config", before: before, after: JSON.stringify(c), entity: { type: "class", id: c.id } });
      return ok(c.name + " saved.");
    },

    /* ===== custom roles ===== */
    /* def: { name, level factory|project, base roleId, desc } */
    addRole: function (def) {
      var d = G.me("role.edit");
      if (!d.allowed) return deny("role.add", def.name || "role", "factory", d, "access");
      if (!def.name || !def.name.trim()) return fail("Name the role.");
      var id = def.id || slug(def.name).replace(/-/g, "_");
      if (G.ROLES.some(function (r) { return r.id === id; })) return fail("A role called " + def.name + " exists.");
      if (def.base && !G.find.role(def.base)) return fail("Unknown base role.");
      var role;
      G.store.update("matrix", function () { role = G.catalog.addRole(S(), { id: id, name: def.name.trim(), level: def.level || "project", base: def.base || "viewer", desc: def.desc || "" }); });
      G.audit("role.add", role.name + " (from " + G.find.role(role.base).name + ")", "factory", "ok", { category: "access", after: JSON.stringify(role), entity: { type: "role", id: role.id } });
      return ok(role.name + " created with the rights of " + G.find.role(role.base).name + ". Adjust them in the matrix.", { role: role });
    },
    updateRole: function (roleId, patch) {
      var r = G.find.role(roleId); if (!r) return fail("No such role.");
      var d = G.me("role.edit");
      if (!d.allowed) return deny("role.edit", r.name, "factory", d, "access");
      if (!r.custom) return fail(r.name + " is built in. Edit its rights in the matrix.");
      if (patch.name != null && !String(patch.name).trim()) return fail("Name the role.");
      var before = JSON.stringify(r);
      ["name", "desc", "level"].forEach(function (k) { if (patch[k] != null) r[k] = String(patch[k]).trim(); });
      G.store.set("matrix", S("matrix"));
      G.audit("role.edit", r.name, "factory", "ok", { category: "access", before: before, after: JSON.stringify(r), entity: { type: "role", id: r.id } });
      return ok(r.name + " saved.");
    },
    removeRole: function (roleId) {
      var r = G.find.role(roleId); if (!r) return fail("No such role.");
      var d = G.me("role.edit");
      if (!d.allowed) return deny("role.remove", r.name, "factory", d, "access");
      if (!r.custom) return fail(r.name + " is built in.");
      var holders = S("people").filter(function (p) { return p.roles.some(function (g) { return g.role === roleId; }); });
      if (holders.length) return fail(holders.length + " " + (holders.length > 1 ? "people hold" : "person holds") + " this role. Change their roles first.");
      var used = S("projects").filter(function (p) { return Object.keys(p.approvers).some(function (k) { return p.approvers[k].roles.indexOf(roleId) >= 0; }); });
      if (used.length) return fail("Approver rules in " + used.map(function (p) { return p.name; }).join(", ") + " use this role.");
      G.ROLES.splice(G.ROLES.indexOf(r), 1);
      G.store.update("matrix", function (m) { delete m[roleId]; });
      G.audit("role.remove", r.name, "factory", "ok", { category: "access", before: r.name, after: null, entity: { type: "role", id: r.id } });
      return ok(r.name + " removed.");
    },

    /* ===== integrations: types and instances ===== */
    /* def: { name, category, auth, payload, source, destination, targetLabel, fields[{key,label,type,required}], events[], actions[] } */
    addIntegrationType: function (def) {
      var d = G.me("integration.add");
      if (!d.allowed) return deny("integration.type", def.name || "type", "factory", d, "integrations");
      if (!def.name || !def.name.trim()) return fail("Name the integration.");
      if (!def.source && !def.destination) return fail("It must send events, receive them, or both.");
      var id = def.id || slug(def.name);
      if (S("integrationTypes").some(function (t) { return t.id === id; })) return fail("An integration type called " + def.name + " exists.");
      var keys = (def.fields || []).map(function (f) { return f.key; });
      if (keys.some(function (k, i) { return !k || keys.indexOf(k) !== i; })) return fail("Each field needs a unique key.");
      var t = Object.assign({ category: "custom", icon: "plug", auth: "token", payload: "json", builtIn: false, source: false, destination: true, targetLabel: "Target", fields: [], events: [], actions: [] }, clone(def), { id: id, name: def.name.trim(), custom: true, createdBy: me(), createdAt: Date.now() });
      G.store.update("integrationTypes", function (l) { l.push(t); });
      G.audit("integration.type", t.name + " (" + t.category + ")", "factory", "ok", { category: "integrations", after: JSON.stringify(t), entity: { type: "integrationType", id: t.id } });
      return ok(t.name + " added to the catalogue.", { type: t });
    },
    /* o: { type, name, config{}, secret, projects "all"|[ids], targetId? } */
    addIntegration: function (o) {
      var d = G.me("integration.add");
      var t = G.find.integrationType(o.type);
      if (!d.allowed) return deny("integration.add", o.name || o.type, "factory", d, "integrations");
      if (!t) return fail("Pick an integration type.");
      if (!o.name || !o.name.trim()) return fail("Name this connection.");
      var missing = t.fields.filter(function (f) { return f.required && f.type !== "secret" && !(o.config && String(o.config[f.key] || "").trim()); });
      if (missing.length) return fail("Fill in " + missing.map(function (f) { return f.label; }).join(", ") + ".");
      var secretField = t.fields.find(function (f) { return f.type === "secret"; });
      if (secretField && secretField.required !== false && !(o.secret && o.secret.trim())) return fail("Add the " + secretField.label.toLowerCase() + ".");
      var bad = t.fields.filter(function (f) { return f.type === "url" && o.config && o.config[f.key] && !/^https:\/\//.test(o.config[f.key]); });
      if (bad.length) return fail(bad[0].label + " must start with https://.");
      var inst = { id: "int-" + slug(o.name) + "-" + Date.now().toString(36).slice(-3), type: t.id, name: o.name.trim(), config: clone(o.config || {}), secretMask: o.secret ? o.secret.slice(0, 4) + "••••" + o.secret.slice(-2) : "", status: "healthy", connected: true,
        projects: o.projects === "all" || !o.projects ? "all" : o.projects.slice(), lastSync: Date.now(), createdBy: me(), createdAt: Date.now() };
      if (o.targetId) inst.targetId = o.targetId;
      G.store.update("integrationInstances", function (l) { l.push(inst); });
      syncLegacy(t.id);
      G.audit("integration.add", inst.name + " (" + t.name + ")", "factory", "ok", { category: "integrations", after: JSON.stringify(Object.assign({}, inst, { secretMask: "••••" })), entity: { type: "integration", id: inst.id } });
      return ok(inst.name + " connected (simulated).", { integration: inst });
    },
    updateIntegration: function (id, patch) {
      var inst = G.find.integration(id); if (!inst) return fail("No such integration.");
      var d = G.me("integration.edit");
      if (!d.allowed) return deny("integration.edit", inst.name, "factory", d, "integrations");
      var before = JSON.stringify({ name: inst.name, config: inst.config, projects: inst.projects, connected: inst.connected });
      G.store.update("integrationInstances", function () {
        if (patch.name != null) inst.name = String(patch.name).trim() || inst.name;
        if (patch.config) Object.assign(inst.config, clone(patch.config));
        if (patch.projects) inst.projects = patch.projects === "all" ? "all" : patch.projects.slice();
        if (patch.secret) inst.secretMask = patch.secret.slice(0, 4) + "••••" + patch.secret.slice(-2);
        if (patch.connected === true) { inst.connected = true; inst.status = "healthy"; }
        if (patch.connected === false) { inst.connected = false; inst.status = "offline"; }
        inst.lastSync = Date.now();
      });
      syncLegacy(inst.type);
      G.audit("integration.edit", inst.name + ": " + Object.keys(patch).join(", "), "factory", "ok", { category: "integrations", before: before, after: JSON.stringify({ name: inst.name, config: inst.config, projects: inst.projects, connected: inst.connected }), entity: { type: "integration", id: inst.id } });
      return ok(inst.name + " saved.");
    },
    testIntegrationInstance: function (id) {
      var inst = G.find.integration(id); if (!inst) return fail("No such integration.");
      var d = G.me("integration.edit");
      if (!d.allowed) return deny("integration.test", inst.name, "factory", d, "integrations");
      G.store.update("integrationInstances", function () { inst.lastSync = Date.now(); inst.lastTest = { at: Date.now(), ok: inst.connected && inst.status === "healthy", by: me() }; });
      G.audit("integration.test", inst.name + " test", "factory", inst.lastTest.ok ? "ok" : "warn", { category: "integrations", entity: { type: "integration", id: inst.id } });
      return inst.lastTest.ok ? ok(inst.name + " answered in " + (80 + (inst.id.length * 37) % 400) + " ms.") : fail(inst.name + (inst.connected ? " returned HTTP 502." : " is offline."));
    },
    removeIntegration: function (id) {
      var inst = G.find.integration(id); if (!inst) return fail("No such integration.");
      var d = G.me("integration.edit");
      if (!d.allowed) return deny("integration.remove", inst.name, "factory", d, "integrations");
      var trig = S("triggers").filter(function (t) { return t.source === id && t.enabled; });
      if (trig.length) return fail("Triggers use it: " + trig.map(function (t) { return t.name; }).join(", ") + ". Turn them off first.");
      var routes = S("projects").filter(function (p) { return p.notifications.some(function (r) { return r.dest.some(function (x) { return x.integration === id; }); }); });
      if (routes.length) return fail("Notification routes in " + routes.map(function (p) { return p.name; }).join(", ") + " send to it.");
      G.store.update("integrationInstances", function (l) { l.splice(l.indexOf(inst), 1); });
      syncLegacy(inst.type);
      G.audit("integration.remove", inst.name, "factory", "ok", { category: "integrations", before: inst.name, after: null, entity: { type: "integration", id: inst.id } });
      return ok(inst.name + " removed.");
    },

    /* ===== vendors and models ===== */
    addVendor: function (def) {
      var d = G.me("model.edit");
      if (!d.allowed) return deny("vendor.add", def.name || "vendor", "factory", d, "agents");
      if (!def.name || !def.name.trim()) return fail("Name the vendor.");
      if (def.endpoint && !/^https:\/\//.test(def.endpoint)) return fail("Endpoint must start with https://.");
      var id = def.id || slug(def.name);
      if (G.find.vendor(id)) return fail(def.name + " exists.");
      var v = { id: id, name: def.name.trim(), connected: !!def.key, keyMask: def.key ? def.key.slice(0, 3) + "••••" + def.key.slice(-2) : "", health: def.key ? "healthy" : "offline", latency: def.key ? 700 : 0, region: def.region || "", endpoint: def.endpoint || "", custom: true, models: [] };
      G.store.update("vendors", function (l) { l.push(v); });
      G.audit("vendor.add", v.name, "factory", "ok", { category: "agents", after: JSON.stringify(Object.assign({}, v, { keyMask: "••••" })), entity: { type: "vendor", id: v.id } });
      return ok(v.name + " added" + (v.connected ? " and connected (simulated)." : ". Add a key to connect it."), { vendor: v });
    },
    /* def: { id, name, inPrice, outPrice, context, tier } prices per million tokens */
    addModel: function (vendorId, def) {
      var v = G.find.vendor(vendorId); if (!v) return fail("No such vendor.");
      var d = G.me("model.edit");
      if (!d.allowed) return deny("model.add", def.name || "model", "factory", d, "agents");
      if (!def.name || !def.name.trim()) return fail("Name the model.");
      if (!(+def.inPrice >= 0) || !(+def.outPrice >= 0)) return fail("Prices are numbers per million tokens.");
      var id = def.id || slug(def.name);
      if (G.find.model(id)) return fail("A model with id " + id + " exists.");
      var m = { id: id, name: def.name.trim(), inPrice: +def.inPrice, outPrice: +def.outPrice, context: +def.context || 128000, tier: def.tier || "standard", enabled: true, custom: true };
      G.store.update("vendors", function () { v.models.push(m); });
      G.audit("model.add", v.name + ": " + m.name, "factory", "ok", { category: "agents", after: JSON.stringify(m), entity: { type: "model", id: m.id } });
      return ok(m.name + " added to " + v.name + ".", { model: m });
    },
    removeModel: function (modelId) {
      var m = G.find.model(modelId); if (!m) return fail("No such model.");
      var d = G.me("model.edit");
      if (!d.allowed) return deny("model.remove", m.name, "factory", d, "agents");
      var routing = S("routing");
      if (routing.defaultModel === modelId || (routing.fallback || []).indexOf(modelId) >= 0) return fail("Routing uses " + m.name + ". Change the routing policy first.");
      var ov = Object.keys(routing.overrides || {}).filter(function (k) { return routing.overrides[k] === modelId; });
      if (ov.length) return fail("Routing sends " + ov.map(function (k) { return (G.find.station(k) || { name: k }).name; }).join(", ") + " to " + m.name + ". Change those station overrides first.");
      var used = S("agents").filter(function (a) { return a.model === modelId || (a.fallbacks || []).indexOf(modelId) >= 0; });
      if (used.length) return fail("Used by " + used.map(function (a) { return a.name + (a.model === modelId ? "" : " (fallback)"); }).join(", ") + ".");
      var v = G.find.vendor(m.vendor);
      G.store.update("vendors", function () { v.models = v.models.filter(function (x) { return x.id !== modelId; }); });
      G.audit("model.remove", v.name + ": " + m.name, "factory", "ok", { category: "agents", before: m.name, after: null, entity: { type: "model", id: m.id } });
      return ok(m.name + " removed.");
    },

    /* ===== chat card templates (factory) ===== */
    /* tpl: { id?, name, kind (gate|question|incident|kill|release|onboarding), fields[], actions[], integration? } */
    saveCardTemplate: function (tpl) {
      var d = G.me("notify.edit", { project: tpl.project || S("prefs").project });
      if (!d.allowed) return deny("card.template", tpl.name || "card", "factory", d, "integrations");
      if (!tpl.name || !tpl.name.trim()) return fail("Name the card.");
      if (!G.CARD_TEMPLATES[tpl.kind]) return fail("Pick what the card is for.");
      var bad = (tpl.actions || []).filter(function (a) { return !G.CARD_ACTIONS[a]; });
      if (bad.length) return fail("Unknown actions: " + bad.join(", ") + ".");
      var list = S("cardTemplates"), ex = tpl.id ? list.find(function (x) { return x.id === tpl.id; }) : null;
      var rec = Object.assign({}, clone(tpl), { id: ex ? ex.id : "CT-" + (list.length + 1), name: tpl.name.trim(), by: me(), at: Date.now() });
      var before = ex ? JSON.stringify(ex) : null;
      G.store.update("cardTemplates", function (l) { if (ex) Object.assign(ex, rec); else l.push(rec); });
      G.audit("card.template", rec.name, "factory", "ok", { category: "integrations", before: before, after: JSON.stringify(rec), entity: { type: "cardTemplate", id: rec.id } });
      return ok(rec.name + " saved.", { template: rec });
    },

    removeCardTemplate: function (id) {
      var list = S("cardTemplates"), t = list.find(function (x) { return x.id === id; });
      if (!t) return fail(G.CARD_TEMPLATES[id] ? "Built-in card templates cannot be removed." : "No such card template.");
      var d = G.me("notify.edit", { project: S("prefs").project });
      if (!d.allowed) return deny("card.template", t.name + " remove", "factory", d, "integrations");
      var users = [];
      S("projects").forEach(function (p) { p.notifications.forEach(function (r) { if (r.template === id) users.push(p.key + " " + r.id); }); });
      S("repos").forEach(function (r) { (r.notifyOverrides || []).forEach(function (o) { if (o.template === id) users.push(r.name + " override"); }); });
      if (users.length) return fail("Used by " + users.join(", ") + ". Pick another card on those routes first.");
      G.store.update("cardTemplates", function (l) { l.splice(l.indexOf(t), 1); });
      G.audit("card.template", t.name + " removed", "factory", "ok", { category: "integrations", before: JSON.stringify(t), after: null, entity: { type: "cardTemplate", id: t.id } });
      return ok(t.name + " removed.");
    },
    removeIntegrationType: function (id) {
      var t = G.find.integrationType(id); if (!t) return fail("No such integration type.");
      var d = G.me("integration.add");
      if (!d.allowed) return deny("integration.type", t.name + " remove", "factory", d, "integrations");
      if (t.builtIn) return fail(t.name + " is built in.");
      var inst = S("integrationInstances").filter(function (i) { return i.type === id; });
      if (inst.length) return fail(inst.length + " connection" + (inst.length > 1 ? "s use" : " uses") + " this type: " + inst.map(function (i) { return i.name; }).join(", ") + ". Remove " + (inst.length > 1 ? "them" : "it") + " first.");
      G.store.update("integrationTypes", function (l) { l.splice(l.indexOf(t), 1); });
      G.audit("integration.type", t.name + " removed from the catalogue", "factory", "ok", { category: "integrations", before: JSON.stringify(t), after: null, entity: { type: "integrationType", id: t.id } });
      return ok(t.name + " removed from the catalogue.");
    },

    /* ===== learning loop ===== */
    acceptLearning: function (proposalId, note) {
      var lp = G.find.proposal(proposalId); if (!lp) return fail("No such proposal.");
      var scope = lp.change && lp.change.project ? { project: lp.change.project } : undefined;
      var d = G.me("learning.apply", scope);
      if (!d.allowed) return deny("learning.apply", lp.id + " " + lp.title, scope ? scope.project : "factory", d, "agents");
      if (lp.status !== "proposed") return fail(lp.id + " is already " + lp.status + ".");
      var r = applyChange(lp);
      if (!r.ok) return fail("Not applied: " + r.msg);
      G.store.update("learning", function () { lp.status = "accepted"; lp.appliedAt = Date.now(); lp.appliedBy = me(); lp.history.push({ at: Date.now(), by: me(), text: "Accepted and applied" + (note ? ": " + note : "") + ". " + r.msg }); var f = G.find.finding(lp.finding); if (f) f.status = "addressed"; });
      var fpid = scope ? scope.project : (G.find.finding(lp.finding) || {}).project || null;
      G.audit("learning.apply", lp.id + " " + lp.title, fpid || "factory", "ok", { project: fpid, category: "agents", after: r.msg, entity: { type: "learning", id: lp.id } });
      return ok(lp.id + " applied. " + r.msg);
    },
    declineLearning: function (proposalId, reason) {
      var lp = G.find.proposal(proposalId); if (!lp) return fail("No such proposal.");
      var scope = lp.change && lp.change.project ? { project: lp.change.project } : undefined;
      var d = G.me("learning.apply", scope);
      if (!d.allowed) return deny("learning.decline", lp.id, "factory", d, "agents");
      if (lp.status !== "proposed") return fail(lp.id + " is already " + lp.status + ".");
      if (!reason || reason.trim().length < 4) return fail("Say why.");
      G.store.update("learning", function () { lp.status = "declined"; lp.reason = reason.trim(); lp.history.push({ at: Date.now(), by: me(), text: "Declined: " + reason.trim() }); });
      G.audit("learning.decline", lp.id + " " + lp.title + ": " + reason.trim(), "factory", "ok", { category: "agents", entity: { type: "learning", id: lp.id } });
      return ok(lp.id + " declined.");
    },
    /* mark an accepted proposal verified once its expected effect shows (simulated check) */
    verifyLearning: function (proposalId) {
      var lp = G.find.proposal(proposalId); if (!lp) return fail("No such proposal.");
      var d = G.me("learning.apply");
      if (!d.allowed) return deny("learning.verify", lp.id, "factory", d, "agents");
      if (lp.status !== "accepted") return fail("Only accepted proposals can be verified.");
      G.store.update("learning", function () { lp.status = "verified"; lp.history.push({ at: Date.now(), by: me(), text: "Verified: " + lp.expected }); });
      G.audit("learning.verify", lp.id + " " + lp.title, "factory", "ok", { category: "agents", entity: { type: "learning", id: lp.id } });
      return ok(lp.id + " verified.");
    },
    /* draft a proposal from a finding: { kind, title, change, expected } */
    draftLearning: function (findingId, o) {
      var f = G.find.finding(findingId); if (!f) return fail("No such finding.");
      var d = G.me("learning.apply", f.project ? { project: f.project } : undefined);
      if (!d.allowed) return deny("learning.draft", f.id, "factory", d, "agents");
      if (["skill", "eval", "guideline", "guardrail", "approver", "route"].indexOf(o.kind) < 0) return fail("Unknown kind of change.");
      if (!o.title || !o.title.trim()) return fail("Give the proposal a title.");
      var L = S("learning");
      var lp = { id: "LP-" + (L.next.proposal++), finding: f.id, kind: o.kind, title: o.title.trim(), owner: me(), status: "proposed", at: Date.now(), expected: o.expected || "", change: clone(o.change || {}), history: [{ at: Date.now(), by: me(), text: "Drafted from finding " + f.id }] };
      G.store.update("learning", function (x) { x.proposals.push(lp); });
      G.audit("learning.draft", lp.id + " " + lp.title, f.project || "factory", "ok", { project: f.project, category: "agents", entity: { type: "learning", id: lp.id } });
      return ok(lp.id + " drafted.", { proposal: lp });
    },
    /* recount evidence for open findings from live signals */
    refreshFindings: function () {
      var sg = G.learning.signals();
      G.store.update("learning", function (L) {
        L.findings.forEach(function (f) {
          var ids = sg.filter(function (x) { return x.signal === f.signal && (!f.project || x.project === f.project); }).map(function (x) { return x.wo; });
          ids.forEach(function (id) { if (f.evidence.indexOf(id) < 0 && f.status === "open" && f.evidence.length < 20) f.evidence.push(id); });
          f.count = f.evidence.length;
        });
      });
      return ok("Findings refreshed.");
    },

    /* ===== evals ===== */
    addEvalCase: function (suiteId, c) {
      var su = G.find.suite(suiteId); if (!su) return fail("No such suite.");
      var d = G.me("eval.run");
      if (!d.allowed) return deny("eval.case", su.id, "factory", d, "agents");
      if (!c || !c.name || !c.name.trim()) return fail("Name the case.");
      var id = su.id.replace("SUITE-", "").slice(0, 3) + "-" + String(su.cases.length + 1).padStart(2, "0");
      while (su.cases.some(function (x) { return x.id === id; })) id += "b";
      var rec = Object.assign({}, clone(c), { id: id, name: c.name.trim(), added: Date.now(), by: me() });
      G.store.update("suites", function () { su.cases.push(rec); });
      G.audit("eval.case", su.id + ": " + rec.name, "factory", "ok", { category: "agents", after: JSON.stringify(rec), entity: { type: "suite", id: su.id } });
      return ok(rec.id + " added to " + su.id + ".", { case: rec });
    },

    /* ===== post-release outcomes =====
       o: { kind: "revert" | "incident" | "followup", text, severity?: "low"|"medium"|"high", attribution?: { station, agent }, followupTitle?, source?, simulated? }
       Records the outcome on a shipped work order with who reported it and which station and agent it is attributed to.
       A revert or incident demotes every L2+ trust cell for that class in that project by one level (automatic rule),
       feeds the learning loop (adds evidence to an open finding or opens one, and drafts an eval-case proposal), logs a
       replay event, notifies outcome.recorded routes and is audited. A follow-up opens a linked work order. */
    recordOutcome: function (woId, o) {
      o = o || {};
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var d = G.me("outcome.record", { project: wo.project });
      if (!d.allowed) return deny("outcome.record", wo.id + " " + (o.kind || ""), wo.repo, d, "flow");
      if (wo.state !== "done" || wo.split) return fail(wo.id + " has not shipped. Outcomes are recorded after release.");
      if (["revert", "incident", "followup"].indexOf(o.kind) < 0) return fail("Pick revert, incident or follow-up.");
      var text = String(o.text || "").trim();
      if (text.length < 8) return fail("Describe what happened in a sentence.");
      var att = o.attribution || {};
      var visited = (wo.history || []).map(function (e) { return e.station; });
      var station = att.station && visited.indexOf(att.station) >= 0 ? att.station : visited.indexOf("build") >= 0 ? "build" : visited[visited.length - 1];
      var sdef = G.stationDef(station) || {};
      var agent = att.agent && G.find.agent(att.agent) ? att.agent : sdef.agent || "ag-build";
      var p = G.find.project(wo.project);
      var rec = { id: "OUT-" + wo.id.slice(3) + "-" + ((wo.outcomes || []).length + 1), kind: o.kind, at: Date.now(), text: text + (o.simulated ? " (simulated)" : ""), severity: o.kind === "incident" ? (["low", "medium", "high"].indexOf(o.severity) >= 0 ? o.severity : "medium") : o.kind === "revert" ? "medium" : null,
        by: me(), via: o.source || "web", simulated: !!o.simulated, attribution: { station: station, agent: agent } };
      var result = { outcome: rec, demoted: [], finding: null, proposal: null, followup: null };
      G.store.update("workOrders", function () {
        wo.outcomes = wo.outcomes || [];
        wo.outcomes.forEach(function (x) { if (x.kind === "healthy") x.superseded = rec.id; });
        wo.outcomes.push(rec);
        wo.log.push({ at: rec.at, who: me(), text: "Post-release " + (o.kind === "followup" ? "follow-up" : o.kind) + " recorded: " + rec.text });
      });
      G.audit("outcome.record", wo.id + ": " + (o.kind === "followup" ? "follow-up" : o.kind) + (rec.severity ? " (" + rec.severity + ")" : "") + ", attributed to " + (G.find.agent(agent) || { name: agent }).name + " at " + (sdef.name || station) + ". " + rec.text, wo.repo, o.kind === "followup" ? "ok" : "warn", { project: wo.project, category: "flow", after: rec.text, entity: { type: "wo", id: wo.id } });
      G.logEvent("outcome", { project: wo.project, wo: wo.id, station: station, mode: o.kind, by: me(), text: rec.text });
      if (o.kind === "followup") {
        var fr = G.ops.submitWO({ project: wo.project, repo: wo.repo, title: (o.followupTitle || "Follow-up: " + wo.title).slice(0, 120), description: "Follow-up to " + wo.id + " after release. " + text, priority: wo.priority, source: "web" });
        if (fr.ok) { fr.wo.followupOf = wo.id; rec.followup = fr.wo.id; result.followup = fr.wo.id; }
        else rec.followupError = fr.msg;
      } else {
        /* automatic demotion: every L2+ cell for this class in this project drops one level */
        S("trust").cells.filter(function (c) { return c.project === wo.project && c.cls === wo.cls && c.level >= 2; }).forEach(function (c) {
          G._demoteCell(c, c.level - 1, (o.kind === "revert" ? "Post-release revert" : "Post-release incident") + " on " + wo.id + (o.simulated ? " (simulated)" : "") + ": " + text.slice(0, 80), { type: o.kind, wo: wo.id, outcome: rec.id });
          result.demoted.push(c.id);
        });
        /* learning signal: add evidence to an open finding with this signal for the project and agent, or open one */
        G.store.update("learning", function (L) {
          var f = L.findings.find(function (x) { return x.status === "open" && x.signal === o.kind && x.project === wo.project && x.agent === agent; });
          if (f) { if (f.evidence.indexOf(wo.id) < 0) f.evidence.push(wo.id); f.count = f.evidence.length; f.lastAt = rec.at; }
          else {
            f = { id: "F-" + (L.next.finding++), title: (G.find.agent(agent) || { name: agent }).name + " changes in " + p.name + " led to a post-release " + o.kind, signal: o.kind, agent: agent, project: wo.project, evidence: [wo.id], count: 1, firstAt: rec.at, lastAt: rec.at, status: "open" };
            L.findings.push(f);
          }
          result.finding = f.id;
          var ag = G.find.agent(agent), suite = ag && ag.suite && G.find.suite(ag.suite) ? ag.suite : null;
          if (suite && !L.proposals.some(function (x) { return x.finding === f.id && x.status === "proposed"; })) {
            var lp = { id: "LP-" + (L.next.proposal++), finding: f.id, kind: "eval", title: "Add a regression case to " + suite + ": " + wo.title.slice(0, 60), owner: p.owner, status: "proposed", at: rec.at,
              expected: "The " + (ag ? ag.name : agent) + " suite catches this " + o.kind + " before promotion.", change: { suite: suite, case: { name: "Regression: " + wo.title.slice(0, 70), from: wo.id } },
              evidence: [wo.id], history: [{ at: rec.at, by: "system", text: "Drafted from finding " + f.id + " after the " + o.kind + " on " + wo.id }] };
            L.proposals.push(lp); result.proposal = lp.id;
          }
        });
        G.audit("learning.signal", wo.id + " " + o.kind + " → " + result.finding + (result.proposal ? ", " + result.proposal + " drafted" : ""), wo.project, "ok", { actor: "system", via: "agent", project: wo.project, category: "agents", entity: { type: "learning", id: result.proposal || result.finding } });
        G.notify(wo.project, "learning.proposed", { wo: wo.id, cls: wo.cls, priority: wo.priority });
        rec.finding = result.finding; rec.proposal = result.proposal; rec.demoted = result.demoted.slice();
      }
      G.notify(wo.project, "outcome.recorded", { wo: wo.id, cls: wo.cls, priority: wo.priority });
      G.syncRecords();
      var what = o.kind === "followup" ? "Follow-up recorded on " + wo.id + (result.followup ? "; " + result.followup + " opened." : ". " + (rec.followupError || "")) :
        (o.kind === "revert" ? "Revert" : "Incident") + " recorded on " + wo.id + ". " + (result.demoted.length ? result.demoted.length + " trust cell" + (result.demoted.length === 1 ? "" : "s") + " dropped a level. " : "No cell for this class was at L2 or above. ") + "Learning: " + result.finding + (result.proposal ? ", " + result.proposal + " drafted." : ".");
      return ok(what, result);
    },

    /* ===== intake follow-up question =====
       q: { text, chips[], mode: "claude"|"local" }. Adds one clarifying question to an open intake conversation
       (at most 3 follow-ups). Permission as answering: wo.answer in the project, or the submitter. */
    addFollowup: function (woId, q) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var d = G.me("wo.answer", { project: wo.project });
      if (!d.allowed && wo.requestedBy !== me()) return deny("wo.followup", wo.id, wo.repo, d, "flow");
      var atIntake = wo.station === 0 && !wo.bay && wo.state !== "killed" && wo.gates.G0G1 && wo.gates.G0G1.status !== "passed";
      if (!atIntake) return fail("Follow-up questions can only be added while the work order is at Intake and the brief is not confirmed.");
      var text = String(q && q.text || "").trim();
      if (text.length < 8) return fail("Write the question in at least a few words.");
      var conv = wo.conv, MAX = 3;
      var n = conv.questions.filter(function (x) { return x.followup; }).length;
      if (n >= MAX) return fail("This conversation already has " + MAX + " follow-up questions.");
      if (conv.questions.some(function (x) { return x.text.toLowerCase() === text.toLowerCase(); })) return fail("That question is already in the conversation.");
      var chips = ((q && q.chips) || []).map(function (c) { return String(c).trim(); }).filter(Boolean).slice(0, 3);
      var nq = { id: "fu" + (n + 1), field: "extra", text: text, chips: chips, followup: true, by: me(), mode: (q && q.mode) || "local" };
      var now = Date.now();
      if (conv.done) {
        conv.questions.push(nq); conv.qi = conv.questions.length - 1; conv.done = false;
        conv.messages.push({ from: "ag-intake", at: now, text: nq.text, qid: nq.id, chips: nq.chips });
      } else {
        var at = conv.qi + 1;
        while (conv.questions[at] && conv.questions[at].followup) at++;
        conv.questions.splice(at, 0, nq);
      }
      G.buildBrief(wo);
      wo.log.push({ at: now, who: me(), text: "Follow-up question added to the intake conversation." });
      G.syncRecords();
      G.audit("wo.followup", wo.id + ": " + text.slice(0, 80), wo.repo, "ok", { project: wo.project, category: "flow", after: text, entity: { type: "wo", id: wo.id } });
      return ok(conv.qi === conv.questions.indexOf(nq) ? "Follow-up asked. Answer it to complete the brief." : "Follow-up added. The Intake agent asks it after the current question.", { question: nq });
    },

    /* ===== work order record ===== */
    setRecordSummary: function (woId, text) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var d = G.me("wo.answer", { project: wo.project, repo: wo.repo });
      if (!d.allowed) return deny("record.summary", wo.id, wo.repo, d, "flow");
      if (!text || text.trim().length < 10) return fail("Write at least a sentence.");
      var before = wo.recordSummary || null;
      wo.recordSummary = { text: text.trim(), by: me(), at: Date.now() };
      G.store.set("workOrders", S("workOrders"));
      G.audit("record.summary", wo.id + " summary", wo.repo, "ok", { project: wo.project, category: "flow", before: before && before.text, after: text.trim(), entity: { type: "wo", id: wo.id } });
      return ok("Summary saved on " + wo.id + ".");
    },
    /* view state (not audited): which record and replay window are open */
    openRecord: function (woId) { G.store.update("prefs", function (p) { p.record = woId; }); return ok(""); },
    setReplay: function (o) { G.store.update("prefs", function (p) { p.replay = o ? Object.assign({}, p.replay || {}, o) : null; }); return ok(""); }
  };

  /* ---------- templates carry custom flow entries ----------
     template.custom = { stations: [{ id, name, agent, purpose, wip, after }], gates: [{ id, label, name, after, kind, roles, required, purpose }],
                         bays: [{ id, name, desc }], classes: [classDef] }
     saveTemplate({ fromProject }) records them; createProject adds them to the new project through the flow ops. */
  var TK = G.templateKit = {
    fromProject: function (p) {
      var f = G.flowOf(p), order = p.flow.order || [];
      return {
        stations: f.stations.filter(function (s) { return s.custom; }).map(function (s) { var i = order.indexOf(s.id); return { id: s.id, name: s.name, agent: s.agent, purpose: s.purpose || "", wip: s.wip || 5, after: order[i - 1] || "review" }; }),
        gates: f.gates.filter(function (g) { return g.custom; }).map(function (g) { var r = p.approvers[g.id] || {}; return { id: g.id, label: g.label, name: g.name, after: g.after, kind: g.mode || g.kind, roles: (r.roles || []).slice(), required: r.required || 1, purpose: g.purpose || "" }; }),
        bays: f.bays.filter(function (b) { return b.custom; }).map(function (b) { return { id: b.id, name: b.name, desc: b.desc || "" }; }),
        classes: p.flow.classes.filter(function (c) { return c.custom; }).map(clone)
      };
    },
    custom: function (t) { var c = (t && t.custom) || {}; return { stations: c.stations || [], gates: c.gates || [], bays: c.bays || [], classes: c.classes || [] }; },
    count: function (t) { var c = TK.custom(t); return c.stations.length + c.gates.length + c.bays.length + c.classes.length; },
    text: function (t) {
      var c = TK.custom(t), out = [];
      c.stations.forEach(function (x) { out.push("station " + x.name); });
      c.gates.forEach(function (x) { out.push("gate " + x.label + " " + x.name); });
      c.bays.forEach(function (x) { out.push("bay " + x.name); });
      c.classes.forEach(function (x) { out.push("class " + x.name); });
      return out.join(", ");
    },
    /* a stand-in project whose flow is the template's, custom entries included (previews only) */
    flowProject: function (t) {
      var flow = G.flowFrom(t), c = TK.custom(t);
      c.stations.forEach(function (x) {
        if (!G.stationDef(x.id)) return;
        flow.stations[x.id] = { enabled: (t.stationsOff || []).indexOf(x.id) < 0, wip: x.wip || 5 };
        var at = flow.order.indexOf(x.after);
        flow.order = flow.order.filter(function (y) { return y !== x.id; });
        flow.order.splice(at < 0 ? flow.order.length - 1 : at + 1, 0, x.id);
      });
      c.gates.forEach(function (x) { if (G.gateDef(x.id)) flow.gates[x.id] = { enabled: true, mode: x.kind || "human" }; });
      c.bays.forEach(function (x) { if (G.bayDef(x.id) && flow.bays.indexOf(x.id) < 0) flow.bays.push(x.id); });
      c.classes.forEach(function (x) { flow.classes.push(Object.assign(clone(x), { enabled: true })); });
      return { id: "tpl:" + t.id, name: t.name, flow: flow, approvers: {}, teams: [], budget: { monthly: 0, mtd: 0 } };
    },
    /* add a template's custom entries to a project through the normal ops -> { done[], failed[] } */
    apply: function (projectId, t) {
      var c = TK.custom(t), done = [], failed = [];
      function run(label, r) { (r.ok ? done : failed).push(r.ok ? label : label + ": " + r.msg); }
      c.stations.forEach(function (x) {
        var p = G.find.project(projectId);
        var after = p.flow.order.indexOf(x.after) >= 0 && x.after !== "close" ? x.after : p.flow.order[p.flow.order.length - 2];
        run(x.name, ops.addStation(projectId, { id: x.id, name: x.name, agent: x.agent, purpose: x.purpose, wip: x.wip }, after));
      });
      c.gates.forEach(function (x) { run(x.label + " " + x.name, ops.addGate(projectId, { id: x.id, label: x.label, name: x.name, after: x.after, kind: x.kind, roles: x.roles, required: x.required, purpose: x.purpose })); });
      c.bays.forEach(function (x) { run(x.name, ops.addBay(projectId, { id: x.id, name: x.name, desc: x.desc })); });
      c.classes.forEach(function (x) {
        var p = G.find.project(projectId);
        var def = clone(x); delete def.custom; delete def.project; delete def.enabled;
        def.skips = (def.skips || []).filter(function (sid) { return p.flow.order.indexOf(sid) >= 0 && sid !== "intake" && sid !== "close"; });
        def.gates = (def.gates || []).filter(function (gid) { return p.flow.gates[gid] && !p.flow.gates[gid].absent; });
        run(x.name, ops.addClass(projectId, def));
      });
      return { done: done, failed: failed };
    }
  };
  var baseSaveTemplate = G.ops.saveTemplate, baseCreateProject = G.ops.createProject;
  /* saveTemplate: a template saved from a project keeps its custom stations, gates, bays and classes, and
     records only built-in ids in stationsOff / gatesOff / classesSkip / order */
  ops.saveTemplate = function (o) {
    var r = baseSaveTemplate(o);
    if (!r.ok || !o.fromProject) return r;
    var p = G.find.project(o.fromProject), t = r.template;
    function builtSt(id) { var d = G.stationDef(id); return d && !d.custom; }
    function builtG(id) { var d = G.gateDef(id); return d && !d.custom; }
    G.store.update("templates", function () {
      t.custom = TK.fromProject(p);
      t.order = (p.flow.order || []).filter(builtSt);
      t.bays = (p.flow.bays || []).filter(function (id) { var b = G.bayDef(id); return b && !b.custom; });
      t.stationsOff = (t.stationsOff || []).filter(builtSt);
      t.gatesOff = (t.gatesOff || []).filter(builtG);
      t.classesSkip = Object.keys(t.classesSkip || {}).filter(function (k) { var c = G.find.cls(k); return c && !c.custom; }).reduce(function (a, k) { a[k] = t.classesSkip[k]; return a; }, {});
    });
    var n = TK.count(t);
    return ok(r.msg + (n ? " Carries " + n + " custom flow entr" + (n === 1 ? "y" : "ies") + ": " + TK.text(t) + "." : ""), { template: t });
  };
  /* createProject: after the base project exists, the template's custom entries are added through the flow ops */
  ops.createProject = function (o) {
    var r = baseCreateProject(o);
    if (!r.ok) return r;
    var t = G.find.template(o.templateId) || S("templates")[0];
    var cx = TK.count(t) ? TK.apply(r.project.id, t) : { done: [], failed: [] };
    return Object.assign({}, r, { custom: cx, msg: r.msg + (cx.done.length ? " Added " + cx.done.join(", ") + "." : "") + (cx.failed.length ? " Not added: " + cx.failed.join("; ") + "." : "") });
  };

  /* keep the round-two per-channel integration objects in step with instances */
  function syncLegacy(type) {
    var leg = S("integrations"); if (!leg || !leg[type]) return;
    var list = S("integrationInstances").filter(function (i) { return i.type === type; });
    G.store.update("integrations", function (x) {
      x[type].connected = list.some(function (i) { return i.connected; });
      x[type].status = !list.length || !x[type].connected ? "offline" : list.some(function (i) { return i.status === "failing"; }) ? "degraded" : "healthy";
      x[type].lastSync = Date.now();
      if (type === "webhook") x.webhook.endpoints = list.filter(function (i) { return i.targetId; }).map(function (i) { return { id: i.targetId, url: i.config.url, secretMask: i.secretMask, status: i.status === "failing" ? "failing" : "healthy" }; });
    });
  }

  /* apply a learning proposal through the matching op; returns { ok, msg } */
  function applyChange(lp) {
    var c = lp.change || {}, r;
    if (lp.kind === "skill") {
      var sk = G.find.skill(c.skill); if (!sk) return fail("skill not found");
      r = G.ops.saveSkill(sk.id, { body: c.after }, "From " + lp.id);
      return r.ok ? ok(sk.name + " updated.") : r;
    }
    if (lp.kind === "eval") { r = ops.addEvalCase(c.suite, c.case || { name: lp.title }); return r.ok ? ok("Case added to " + c.suite + ".") : r; }
    if (lp.kind === "guideline") {
      var p = G.find.project(c.project); if (!p) return fail("project not found");
      var g = p.guidelines || { items: [] };
      r = G.ops.saveGuidelines({ items: (g.items || []).concat([Object.assign({ id: "pg-" + Date.now().toString(36).slice(-4) }, c.item)]) }, "From " + lp.id, p.id);
      return r.ok ? ok(p.name + " guidelines now v" + p.guidelines.version + ".") : r;
    }
    if (lp.kind === "guardrail") {
      var a = G.find.agent(c.agent); if (!a) return fail("agent not found");
      var gr = clone(a.guardrails || { paths: [], maxDiff: 0 });
      if (gr.paths.indexOf(c.path) < 0) gr.paths.push(c.path);
      r = G.ops.saveAgent(a.id, { guardrails: gr }, "From " + lp.id);
      return r.ok ? ok(a.name + " guardrail added: " + c.path + ".") : r;
    }
    if (lp.kind === "approver") {
      var pp = G.find.project(c.project); if (!pp || !pp.approvers[c.gate]) return fail("gate rule not found");
      var da = G.me("approvers.edit", { project: pp.id }); if (!da.allowed) return fail((da.needs ? da.needs + ". " : "") + da.reason);
      var before = JSON.stringify(pp.approvers[c.gate].conditions);
      G.store.update("projects", function () { pp.approvers[c.gate].conditions.push(Object.assign({ id: "C-" + Date.now().toString(36).slice(-4) }, clone(c.condition))); });
      G.audit("approvers.edit", pp.name + " " + c.gate + ": " + c.condition.text, pp.id, "ok", { project: pp.id, category: "config", before: before, after: JSON.stringify(pp.approvers[c.gate].conditions), entity: { type: "gaterule", id: pp.id + ":" + c.gate } });
      return ok(pp.name + " " + c.gate + " condition added.");
    }
    if (lp.kind === "route") {
      var pr = G.find.project(c.project); if (!pr) return fail("project not found");
      var cl = pr.flow.classes.find(function (x) { return x.id === c.cls; }); if (!cl) return fail("class not found");
      r = ops.updateClass(pr.id, cl.id, { skips: cl.skips.indexOf(c.addSkip) >= 0 ? cl.skips : cl.skips.concat([c.addSkip]) });
      return r.ok ? ok(cl.name + " on " + pr.name + " now skips " + G.find.station(c.addSkip).name + ".") : r;
    }
    return fail("unknown kind");
  }

  Object.assign(G.ops, ops);
})(window.G);
