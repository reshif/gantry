/* Domain operations (G.ops) and the simulation tick.
   Every op checks the policy engine for the signed-in person (or the API key / trigger),
   mutates the store, writes the audit ledger, fires notifications and returns { ok, msg, ... }.
   A backend would replace these bodies with API calls and push results through store.set. */
(function (G) {
  "use strict";
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  function S(k) { return G.store.get(k); }
  function me() { return G.viewerId(); }
  function ok(msg, extra) { return Object.assign({ ok: true, msg: msg }, extra || {}); }
  function fail(msg, extra) { return Object.assign({ ok: false, msg: msg }, extra || {}); }
  function deny(action, target, where, d, via, category) {
    G.audit(action, target, where, "denied", { via: via, category: category });
    return fail((d.needs ? d.needs + ". " : "") + d.reason, { decision: d });
  }
  /* after any work-order mutation: regenerate lifecycle records, then notify subscribers */
  function touch() { S("workOrders").forEach(function (w) { G.lc.sync(w); }); G.store.set("workOrders", S("workOrders")); }
  G.syncRecords = touch;
  function proj(wo) { return G.find.project(wo.project); }
  function openEntry(wo) { return wo.history[wo.history.length - 1]; }
  /* notification card catalogue: template id -> { name, actions }, action labels, default template per event */
  G.CARD_TEMPLATES = {
    gate: { name: "Gate request", actions: ["approve", "reject", "open"] },
    question: { name: "Question for a person", actions: ["answer", "open"] },
    incident: { name: "Incident", actions: ["ack", "open"] },
    kill: { name: "Kill switch", actions: ["open"] },
    release: { name: "Release", actions: ["notes", "open"] },
    onboarding: { name: "Onboarding PR", actions: ["pr", "open"] },
    submitted: { name: "Work order submitted", actions: ["open"] },
    budget: { name: "Budget threshold", actions: ["budget"] },
    eval: { name: "Eval regression", actions: ["evals"] }
  };
  G.CARD_ACTIONS = { approve: "Approve", reject: "Reject", open: "Open in Gantry", answer: "Answer", ack: "Acknowledge", notes: "Release notes", pr: "Review PR", budget: "Open budget", evals: "Open evals" };
  G.CARD_DEFAULTS = { submitted: "submitted", question: "question", "gate.waiting": "gate", "gate.decided": "gate", blocked: "incident", "security.hold": "incident", andon: "incident", kill: "kill", restore: "kill", "onboarding.pr": "onboarding", released: "release", "eval.regression": "eval", budget: "budget",
    "trust.changed": "submitted", "learning.proposed": "submitted", "outcome.recorded": "incident" };
  G.costFor = function (model, tokens) { var m = G.find.model(model); return tokens / 1e6 * (m ? ((+m.inPrice || 0) * 0.7 + (+m.outPrice || 0) * 0.3) : 6); };

  /* ---------- slots and station entry ---------- */
  G.slotsUsed = function (projectId) {
    return S("workOrders").filter(function (w) { return w.project === projectId && w.slot && w.state !== "done" && w.state !== "killed"; });
  };
  function freeSlot(project) {
    var used = G.slotsUsed(project.id).map(function (w) { return w.slot; });
    for (var i = 1; i <= project.flow.slots; i++) if (used.indexOf(i) < 0) return i;
    return null;
  }
  function modelFor(project, stationId, agent) {
    if (agent.overrides && agent.overrides[project.id] && agent.overrides[project.id].model) return agent.overrides[project.id].model;
    if (project.regulated && stationId !== "intake") return "bedrock-claude-sonnet-5-5";
    return agent.model;
  }
  function enter(wo, sid, by) {
    var project = proj(wo);
    var cur = openEntry(wo);
    if (cur && !cur.endedAt) { cur.endedAt = Date.now(); cur.outcome = cur.outcome || "passed"; }
    if (G.STATIONS[wo.station].id === "build" && sid !== "build") wo.slot = null;
    wo.station = G.stationIndex(sid);
    wo.blockReason = null; wo.failReason = null; wo.bay = null; wo.bayReason = ""; wo.bayFrom = null;
    if (sid === "build" && !wo.slot) {
      var slot = freeSlot(project);
      if (!slot) {
        wo.state = "parked"; wo.bay = "queue"; wo.bayFrom = "build"; wo.bayAt = Date.now(); wo.bayReason = "All " + project.flow.slots + " coding slots on " + project.name + " are busy.";
        wo.log.push({ at: Date.now(), who: "ag-build", text: "Queued for a coding slot." });
        return;
      }
      wo.slot = slot;
    }
    var ag = G.find.agent(G.find.station(sid).agent);
    wo.state = "running"; wo.progress = 0;
    wo.history.push({ station: sid, agent: ag.id, model: modelFor(project, sid, ag), startedAt: Date.now(), endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" });
    wo.log.push({ at: Date.now(), who: by || ag.id, text: "Entered " + G.find.station(sid).name + (wo.slot && sid === "build" ? " in coding slot " + wo.slot : "") + "." });
    G.logEvent("wo.enter", { project: wo.project, wo: wo.id, station: sid, by: by || ag.id });
    if (G.stationIndex(sid) >= 5 && !wo.pr) wo.pr = { number: S("nextPR"), branch: "gantry/" + wo.id.toLowerCase(), checks: "pending", state: "open", tag: null };
    if (G.stationIndex(sid) >= 5 && wo.pr && wo.pr.number === S("nextPR")) G.store.set("nextPR", S("nextPR") + 1);
  }
  function finish(wo, by) {
    var cur = openEntry(wo);
    if (cur && !cur.endedAt) { cur.endedAt = Date.now(); cur.outcome = "passed"; }
    wo.slot = null; wo.state = "done"; wo.doneAt = Date.now(); wo.progress = 100;
    if (wo.pr) { wo.pr.state = "merged"; }
    wo.log.push({ at: Date.now(), who: by || "ag-close", text: wo.cls === "spike" ? "Spike finished; report attached." : "Shipped." });
    G.lc.sync(wo);
    G.logEvent(wo.pr && wo.pr.tag ? "release" : "wo.done", { project: wo.project, wo: wo.id, text: wo.pr && wo.pr.tag ? wo.pr.tag : "" });
    afterOutcome(wo);
  }
  G.PROPOSAL_CAP = 5; G.PROPOSAL_DAY = 2;
  /* trust bookkeeping when a work order finishes: clean runs feed promotion proposals; reverts and incidents demote */
  function afterOutcome(wo) {
    var bad = (wo.outcomes || []).find(function (o) { return o.kind === "revert" || o.kind === "incident"; });
    if (bad) { demoteMatching(wo, bad.kind, (bad.kind === "revert" ? "Post-release revert" : "Post-release incident") + " on " + wo.id); return; }
    var clean = !(wo.sendbacks || []).length && !Object.keys(wo.gates).some(function (k) { return wo.gates[k].rejections.length; });
    if (!clean) return;
    Object.keys(wo.gates).forEach(function (k) {
      var ag = G.trustAgentFor(k); if (!ag || k === "G0G1") return;
      var cell = G.trust.cell(ag, wo.cls, wo.project, wo.repo); if (!cell) return;
      cell.cleanRuns = (cell.cleanRuns || 0) + 1;
      var m = G.trust.meets(cell);
      var tr = S("trust");
      var recent = tr.proposals.some(function (x) { return x.cell === cell.id && (x.status === "pending" || (x.decidedAt || x.at) > Date.now() - 3 * DAY); });
      /* caps: one open proposal per cell, at most PROPOSAL_CAP pending overall and PROPOSAL_DAY opened by the system per day */
      var pending = tr.proposals.filter(function (x) { return x.status === "pending"; }).length;
      var today = tr.proposals.filter(function (x) { return !x.manual && x.at > Date.now() - DAY && x.at > (tr.seededAt || 0); }).length;
      if (m.ok && !recent && pending < G.PROPOSAL_CAP && today < G.PROPOSAL_DAY) {
        var prop = { id: "TP-" + (tr.nextProposal++), cell: cell.id, from: cell.level, to: m.next, at: Date.now(), status: "pending", by: null, decidedAt: null, reason: "", evidence: { cleanRuns: m.evidence.cleanRuns, evalScore: m.evidence.evalScore, note: "Met the L" + m.next + " criteria with no incidents in the window." }, savedPerWeek: G.trust.projection(cell, m.next) };
        tr.proposals.push(prop);
        G.audit("trust.propose", cell.id + " L" + cell.level + " → L" + m.next, wo.project, "ok", { actor: "system", via: "agent", project: wo.project, category: "agents", entity: { type: "trust", id: cell.id } });
        G.notify(wo.project, "trust.changed", { cell: cell.id });
      }
    });
    G.store.set("trust", S("trust"));
  }
  function demoteMatching(wo, causeType, reason) {
    var tr = S("trust");
    tr.cells.filter(function (c) { return c.project === wo.project && c.cls === wo.cls && c.level >= 2; }).forEach(function (c) { demoteCell(c, c.level - 1, reason, { type: causeType, wo: wo.id }); });
  }
  function demoteCell(cell, to, reason, cause) {
    var from = cell.level; if (to >= from) return;
    cell.level = to; cell.since = Date.now(); cell.cleanRuns = 0;
    cell.history.push({ at: Date.now(), from: from, to: to, by: "system", kind: "demote", reason: reason, cause: cause || null });
    S("trust").proposals.forEach(function (x) { if (x.cell === cell.id && x.status === "pending") { x.status = "withdrawn"; x.decidedAt = Date.now(); x.reason = "Withdrawn by automatic demotion"; } });
    G.audit("trust.demote", cell.id + " L" + from + " → L" + to + ": " + reason, cell.project, "warn", { actor: "system", via: "agent", project: cell.project, category: "agents", before: "L" + from, after: "L" + to, entity: { type: "trust", id: cell.id } });
    G.logEvent("trust.change", { project: cell.project, cell: cell.id, from: from, to: to, by: "system", text: reason });
    G.notify(cell.project, "trust.changed", { cell: cell.id });
    G.store.set("trust", S("trust"));
  }
  G._demoteCell = demoteCell;
  /* move a work order past its current station: gate handling or entry to the next station */
  function advance(wo, by) {
    var project = proj(wo);
    if (wo.cls === "epic" && G.STATIONS[wo.station].id === "plan" && wo.brief.children && wo.brief.children.length && !wo.children.length) {
      return splitEpic(wo, by);
    }
    var next = G.nextStationId(project, wo);
    if (!next) {
      if (wo.gates.G6 && wo.gates.G6.status !== "passed") { wo.state = "waiting"; wo.gates.G6.status = "waiting"; return; }
      return finish(wo, by);
    }
    enter(wo, next, by);
  }
  function splitEpic(wo, by) {
    var st = S();
    wo.brief.children.forEach(function (name) {
      var child = G.buildWO(st, { project: wo.project, repo: wo.repo, title: wo.title + ": " + name, description: "Child of " + wo.id + ". " + name + " part of the epic.", forceCls: "feature", requestedBy: wo.requestedBy, source: "epic", parent: wo.id });
      child.conv.done = true; child.conv.qi = child.conv.questions.length;
      child.conv.messages.push({ from: "ag-intake", at: Date.now(), text: "Created from epic " + wo.id + "; brief inherited." });
      child.gates.G0G1.status = "passed"; child.gates.G0G1.approvals.push({ by: by || wo.requestedBy, at: Date.now(), via: "epic" });
      ["research", "spec", "design", "plan"].forEach(function (sid) { var g = G.gateAfter(sid); if (child.gates[g.id]) { child.gates[g.id].status = "skipped"; } });
      child.history[0].endedAt = Date.now(); child.history[0].outcome = "passed";
      st.workOrders.push(child);
      enter(child, "build", by);
      wo.children.push(child.id);
    });
    var cur = openEntry(wo); cur.endedAt = Date.now(); cur.outcome = "split";
    wo.state = "done"; wo.doneAt = Date.now(); wo.split = true;
    wo.log.push({ at: Date.now(), who: by || "ag-plan", text: "Split into " + wo.children.join(", ") + "." });
    G.audit("wo.split", wo.id + " → " + wo.children.join(", "), wo.repo, "ok", { project: wo.project, entity: { type: "wo", id: wo.id } });
  }
  /* run gate after the current station when the station finishes */
  function arriveAtGate(wo) {
    var project = proj(wo);
    var g = G.gateForWO(project, wo);
    if (!g || !wo.gates[g.id] || wo.gates[g.id].status === "passed" || wo.gates[g.id].status === "skipped") return advance(wo);
    var gs = wo.gates[g.id];
    var kind = G.gateKind(project, g.id);
    if ((kind === "auto" || kind === "mixed") && !g.checks.length) { if (kind === "auto") { gs.status = "passed"; wo.log.push({ at: Date.now(), who: "system", text: g.label + " passed automatically (gate set to automatic in this project)." }); return advance(wo); } }
    else if (kind === "auto" || kind === "mixed") {
      var failIdx = -1;
      if (g.id === "G4" && Math.random() < 0.1) failIdx = 0;
      if (g.id === "G3G3s" && Math.random() < 0.08) failIdx = 1;
      gs.checks = g.checks.map(function (c, i) { return { name: c, ok: i !== failIdx }; });
      if (failIdx >= 0) {
        gs.status = "failed";
        /* a failed check is not a regression: it resets the clean-run streak of the cells judging this work */
        S("trust").cells.forEach(function (c) { if (c.project === wo.project && c.cls === wo.cls) c.cleanRuns = 0; });
        if (g.id === "G4") {
          wo.state = "failed"; wo.failReason = "G4: required check 'ci/test' failed on " + wo.repo + "."; wo.tests.failed = 1; if (wo.pr) wo.pr.checks = "red";
          G.audit("gate.check", g.label + " failed on " + wo.id, wo.repo, "failed", { actor: "ag-test", via: "agent", project: wo.project, entity: { type: "wo", id: wo.id } });
          G.notify(wo.project, "blocked", { wo: wo.id, cls: wo.cls, priority: wo.priority });
        } else {
          wo.state = "parked"; wo.bay = "sechold"; wo.bayFrom = G.STATIONS[wo.station].id; wo.bayAt = Date.now(); wo.bayReason = "G3s dependency scan found a high-severity CVE in a new dependency.";
          G.audit("gate.check", "G3s failed on " + wo.id + ": security hold", wo.repo, "failed", { actor: "ag-sec", via: "agent", project: wo.project, category: "approvals", entity: { type: "wo", id: wo.id } });
          G.notify(wo.project, "security.hold", { wo: wo.id, cls: wo.cls, priority: wo.priority });
        }
        wo.log.push({ at: Date.now(), who: g.id === "G4" ? "ag-test" : "ag-sec", text: g.label + " check failed." });
        return;
      }
      if (kind === "auto") {
        gs.status = "passed"; gs.decision = { mode: "auto", at: Date.now(), trust: null };
        if (g.id === "G4" && wo.pr) wo.pr.checks = "green";
        wo.log.push({ at: Date.now(), who: "system", text: g.label + " " + g.name + " passed automatically." });
        return advance(wo);
      }
    }
    /* human or mixed gate: trust may pass it automatically */
    var td = gs.approvals.length || g.id === "G0G1" ? { auto: false } : G.trust.decide(wo, g.id);
    if (td.guardrail && td.level >= 3) { var lvc = G.trust.levelFor(wo, g.id); if (lvc.cell) demoteCell(lvc.cell, 2, "Guardrail breach on " + wo.id + ": " + td.reason, { type: "guardrail", wo: wo.id }); }
    if (td.auto) {
      gs.status = "passed"; gs.waitingSince = Date.now(); gs.decision = { mode: "trust", trust: td.level, at: Date.now(), reason: td.reason };
      wo.log.push({ at: Date.now(), who: "system", text: g.label + " " + g.name + " passed under trust: " + td.reason });
      G.logEvent("trust.auto", { project: wo.project, wo: wo.id, gate: g.id, mode: "trust", trust: td.level });
      G.audit("gate.trust", g.label + " on " + wo.id + " passed at L" + td.level, wo.repo, "ok", { actor: "system", via: "agent", project: wo.project, category: "approvals", entity: { type: "wo", id: wo.id } });
      if (g.id === "G6") { finish(wo, "system"); return; }
      if (g.id === "G5" && wo.pr) { wo.pr.state = "merged"; wo.pr.checks = "green"; }
      return advance(wo);
    }
    gs.status = "waiting"; wo.state = "waiting"; gs.waitingSince = Date.now(); gs.trustNote = td.reason || null;
    wo.log.push({ at: Date.now(), who: openEntry(wo).agent, text: "Waiting at " + g.label + " " + g.name + "." + (td.reason ? " " + td.reason : "") });
    G.notify(wo.project, "gate.waiting", { wo: wo.id, cls: wo.cls, priority: wo.priority, gate: g.id });
  }

  function submitGuard(projectId, repoId) {
    var project = G.find.project(projectId);
    if (!project) return "Pick a project.";
    var stop = G.stopState(projectId, repoId);
    if (stop) return "Submissions are refused. " + stop.reason;
    var repo = G.find.repo(repoId);
    if (!repo || repo.project !== projectId) return "Pick a repo in " + project.name + ".";
    if (repo.onboarding.stage !== "ready" && !repo.onboarding.exception) return repo.name + " is not ready: onboarding is at '" + G.ONBOARD_STAGES.concat([{ id: "failed", name: "Failed" }, { id: "person", name: "Needs a person" }]).find(function (x) { return x.id === repo.onboarding.stage; }).name + "'. Finish onboarding first (#onboarding).";
    return null;
  }
  G.submitGuard = submitGuard;

  G.ops = {
    /* ===== sign-in and sessions ===== */
    signIn: function (personId, method, meta) {
      var p = G.find.person(personId);
      meta = meta || {};
      if (!p || p.status !== "active") { G.ops.recordSignInFailure(meta.email || personId, method, "Unknown or inactive account"); return fail("No active account for that identity."); }
      var dom = p.email.split("@")[1];
      if (S("security").domains.indexOf(dom) < 0) { G.ops.recordSignInFailure(p.email, method, "Domain not allowed"); return fail(dom + " is not an allowed email domain."); }
      if (method === "github" && !S("security").githubLogin) { G.ops.recordSignInFailure(p.email, method, "GitHub sign-in disabled"); return fail("GitHub sign-in is turned off by your admin."); }
      var sid = "ses-" + Date.now().toString(36);
      var ses = { id: sid, person: p.id, method: method, device: meta.device || "This browser", ip: "10.4.0.12", started: Date.now(), lastSeen: Date.now(), revoked: false, current: true };
      G.store.update("sessions", function (l) { l.forEach(function (x) { x.current = false; }); l.push(ses); });
      G.store.update("signins", function (l) { l.push({ at: Date.now(), person: p.id, email: p.email, method: method, outcome: "success", reason: meta.mfa ? "MFA passed" : "", ip: ses.ip, device: ses.device }); });
      G.store.set("session", { id: sid, person: p.id, method: method, at: Date.now() });
      var vis = G.visibleProjects(p.id);
      if (vis.length && !vis.some(function (x) { return x.id === S("prefs").project; })) G.store.update("prefs", function (pr) { pr.project = vis[0].id; });
      G.audit("auth.signin", p.name + " via " + method + (meta.mfa ? " with MFA" : ""), "factory", "ok", { actor: p.id, category: "auth", via: method });
      return ok("Signed in as " + p.name + ".");
    },
    recordSignInFailure: function (email, method, reason) {
      G.store.update("signins", function (l) { l.push({ at: Date.now(), person: null, email: email, method: method, outcome: "failure", reason: reason, ip: "10.4.0.12", device: "This browser" }); });
      G.audit("auth.signin", (email || "unknown") + " via " + method + ": " + reason, "factory", "denied", { actor: email || "unknown", category: "auth", via: method });
    },
    signOut: function (reason) {
      var s = S("session"); if (!s) return fail("Not signed in.");
      G.store.update("sessions", function (l) { var x = l.find(function (y) { return y.id === s.id; }); if (x) { x.revoked = true; x.ended = Date.now(); x.current = false; } });
      G.audit("auth.signout", G.actorName(s.person) + (reason ? " (" + reason + ")" : ""), "factory", "ok", { actor: s.person, category: "auth" });
      G.store.set("session", null);
      return ok("Signed out.");
    },
    revokeSession: function (sessionId) {
      var d = G.me("security.manage");
      var ses = S("sessions").find(function (x) { return x.id === sessionId; });
      if (!ses) return fail("No such session.");
      var own = ses.person === me();
      if (!d.allowed && !own) return deny("session.revoke", sessionId, "factory", d, "web", "auth");
      G.store.update("sessions", function () { ses.revoked = true; ses.ended = Date.now(); });
      G.audit("session.revoke", G.actorName(ses.person) + " · " + ses.device, "factory", "ok", { category: "auth", entity: { type: "person", id: ses.person } });
      if (S("session") && S("session").id === sessionId) G.store.set("session", null);
      return ok("Session revoked for " + G.actorName(ses.person) + ".");
    },

    /* ===== generic audited config change =====
       o: { perm, ctx, slice, fn(sliceValue), action, target, where, project, before, after, category, entity, via } */
    change: function (o) {
      var d = G.me(o.perm, o.ctx || {});
      if (!d.allowed) return deny(o.action, o.target, o.where || (o.ctx && o.ctx.project) || "factory", d, o.via, o.category);
      G.store.update(o.slice, o.fn);
      G.audit(o.action, o.target, o.where || (o.ctx && o.ctx.project) || "factory", "ok", { project: o.project || (o.ctx && o.ctx.project), category: o.category, before: o.before, after: o.after, entity: o.entity, via: o.via });
      return ok(o.msg || "Saved.");
    },

    /* ===== work orders ===== */
    /* o: { project, repo, title, description, priority, requestedCls, attachments[], source } ; via: "web"|"console"|"slack"|"api"|"github"; actor: override (api key / trigger id) */
    submitWO: function (o, via, actor) {
      via = via || "web";
      var byKey = via === "api" || via === "github" || via === "schedule" || !!(actor && G.find.trigger(actor));
      if (!byKey) {
        var d = G.me("wo.submit", { project: o.project });
        if (!d.allowed) return deny("wo.submit", o.title || "work order", o.project, d, via);
      }
      var why = submitGuard(o.project, o.repo);
      if (why) { G.audit("wo.submit", (o.title || "work order") + " refused: " + why, o.repo || o.project, "denied", { project: o.project, via: via, actor: actor }); return fail(why); }
      if (!o.title || !o.title.trim()) return fail("Give the work order a title.");
      var st = S();
      var wo = G.buildWO(st, { project: o.project, repo: o.repo, title: o.title.trim(), description: (o.description || "").trim(), priority: o.priority, requestedCls: o.requestedCls || null,
        attachments: o.attachments || [], source: o.source || via, requestedBy: actor && !G.find.person(actor) ? (o.onBehalfOf || me() || "p-tomas") : (actor || me()), awaiting: byKey ? (via === "api" ? "api" : "slack") : "submitter" });
      if (byKey) wo.submittedBy = actor;
      G.store.update("workOrders", function (l) { l.push(wo); });
      G.audit("wo.submit", wo.id + " " + wo.title + " · class " + wo.cls + " (" + Math.round(wo.clsConfidence * 100) + "%)", wo.repo, "ok", { project: wo.project, via: via, actor: actor, entity: { type: "wo", id: wo.id } });
      G.logEvent("wo.submit", { project: wo.project, wo: wo.id, repo: wo.repo, by: wo.requestedBy, text: wo.title });
      G.notify(wo.project, "submitted", { wo: wo.id, repo: wo.repo, cls: wo.cls, priority: wo.priority });
      G.notify(wo.project, "question", { wo: wo.id, repo: wo.repo, cls: wo.cls, priority: wo.priority });
      return ok(wo.id + " submitted to " + G.find.project(wo.project).name + " as " + G.find.cls(wo.cls).name + ".", { wo: wo });
    },
    answer: function (woId, text, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      if (!text || !String(text).trim()) return fail("Write an answer.");
      var d = G.me("wo.answer", { project: wo.project });
      if (!d.allowed && wo.requestedBy !== me()) return deny("wo.answer", wo.id, wo.repo, d, via);
      var r = G.answerConversation(wo, String(text).trim(), me());
      if (r.returned && wo.bay === "person") {
        var back = wo.bayFrom;
        wo.bay = null; wo.bayReason = ""; wo.bayFrom = null; wo.state = "running"; wo.progress = Math.max(wo.progress, 40);
        wo.station = G.stationIndex(back);
        wo.log.push({ at: Date.now(), who: me(), text: "Answered; returned to " + G.find.station(back).name + "." });
      }
      touch();
      G.audit("wo.answer", wo.id + ": " + String(text).slice(0, 80), wo.repo, "ok", { project: wo.project, via: via, entity: { type: "wo", id: wo.id } });
      return ok(r.returned ? "Answer sent; " + wo.id + " is back on the belt." : wo.conv.done ? "Brief is ready to confirm." : "Answer recorded.");
    },
    reclassify: function (woId, cls, reason) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var d = G.me("wo.classify", { project: wo.project });
      if (!d.allowed) return deny("wo.classify", wo.id, wo.repo, d);
      if (!reason || String(reason).trim().length < 5) return fail("Give a reason for the override (at least 5 characters). It is audited.");
      if (!G.find.cls(cls)) return fail("Unknown class.");
      if (cls === wo.cls) return fail(wo.id + " is already " + G.find.cls(cls).name + ".");
      if (G.stationIndex(G.STATIONS[wo.station].id) > 0) return fail("Class can only change at Intake. Send it back to Intake first.");
      var before = wo.cls;
      var project = proj(wo);
      wo.cls = cls; wo.clsOverridden = { by: me(), at: Date.now(), from: before, reason: reason || "" };
      var gates = {}; G.routeGates(project, cls).forEach(function (g) { gates[g] = wo.gates[g] || { status: "pending", approvals: [], rejections: [], checks: [] }; });
      gates.G0G1 = wo.gates.G0G1; wo.gates = gates;
      wo.priority = G.classOf(project, cls).priority;
      var keep = wo.conv.answers;
      G.startConversation(wo, wo.conv.awaiting);
      Object.keys(keep).forEach(function (k) { if (wo.conv.questions[wo.conv.qi] && wo.conv.questions[wo.conv.qi].id === k) G.answerConversation(wo, keep[k], me()); });
      wo.log.push({ at: Date.now(), who: me(), text: "Class overridden: " + before + " → " + cls + (reason ? " (" + reason + ")" : "") + "." });
      touch();
      G.audit("wo.classify", wo.id + " class override", wo.repo, "ok", { project: wo.project, before: before, after: cls, entity: { type: "wo", id: wo.id } });
      return ok(wo.id + " is now " + G.find.cls(cls).name + ". Route: " + G.route(project, cls).map(function (s) { return G.find.station(s).name; }).join(" → ") + ".");
    },
    confirmBrief: function (woId, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      if (!wo.conv.done) return fail("Answer the open intake questions first; the brief is not complete.");
      var d = G.gateDecision(me(), wo, "G0G1");
      if (!d.allowed) return deny("brief.confirm", wo.id, wo.repo, d, via, "approvals");
      var gs = wo.gates.G0G1;
      gs.approvals.push({ by: me(), at: Date.now(), via: via || "web", trust: null }); gs.status = "passed"; gs.decision = { mode: "human", by: me(), at: Date.now(), via: via || "web", trust: null };
      G.logEvent("gate.decision", { project: wo.project, wo: wo.id, gate: "G0G1", by: me(), mode: "human" });
      wo.conv.messages.push({ from: "ag-intake", at: Date.now(), text: "Brief confirmed by " + G.actorName(me()) + ". Starting the route: " + wo.brief.route.map(function (s) { return G.find.station(s).name; }).join(" → ") + "." });
      wo.log.push({ at: Date.now(), who: me(), text: "G0+G1 brief confirmed." });
      openEntry(wo).endedAt = Date.now(); openEntry(wo).outcome = "passed";
      advance(wo, me());
      touch();
      G.audit("brief.confirm", "G0+G1 on " + wo.id, wo.repo, "ok", { project: wo.project, via: via, category: "approvals", entity: { type: "wo", id: wo.id } });
      G.notify(wo.project, "gate.decided", { wo: wo.id, cls: wo.cls, priority: wo.priority, gate: "G0G1" });
      return ok("Brief confirmed. " + wo.id + " moved to " + (wo.bay ? G.bayDef(wo.bay).name : G.STATIONS[wo.station].name) + ".");
    },
    decline: function (woId, reason, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var d = G.me("wo.decline", { project: wo.project });
      if (!d.allowed) return deny("wo.decline", wo.id, wo.repo, d, via);
      if (!reason || reason.trim().length < 5) return fail("Give a reason of at least 5 characters.");
      wo.bayFrom = G.STATIONS[wo.station].id; wo.bay = "declined"; wo.state = "parked"; wo.bayReason = reason.trim(); wo.bayAt = Date.now(); wo.slot = null;
      wo.log.push({ at: Date.now(), who: me(), text: "Declined: " + reason.trim() });
      touch();
      G.audit("wo.decline", wo.id + ": " + reason.trim(), wo.repo, "ok", { project: wo.project, via: via, entity: { type: "wo", id: wo.id } });
      return ok(wo.id + " moved to Declined.");
    },
    /* approve a waiting human gate (G0G1 routes to confirmBrief; G6 is the release confirmation) */
    approveGate: function (woId, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var g = G.gateForWO(proj(wo), wo);
      if (!g || !wo.gates[g.id] || wo.gates[g.id].status !== "waiting") return fail(wo.id + " is not waiting at a gate.");
      if (g.id === "G0G1") return G.ops.confirmBrief(woId, via);
      var d = G.gateDecision(me(), wo, g.id);
      if (!d.allowed) return deny(g.id === "G6" ? "release" : "gate.approve", g.label + " on " + wo.id, wo.repo, d, via, "approvals");
      if (G.haltState(wo.project, wo.repo)) return fail(G.haltState(wo.project, wo.repo).reason + " Resume first.");
      var gs = wo.gates[g.id];
      var lvNow = G.trust.levelFor(wo, g.id).effective;
      gs.approvals.push({ by: me(), at: Date.now(), via: via || "web", trust: lvNow });
      var prog = G.gateProgress(proj(wo), wo, g.id);
      var msg;
      if (prog.passes) {
        gs.status = "passed"; gs.decision = { mode: "human", by: me(), at: Date.now(), via: via || "web", trust: lvNow, approvals: gs.approvals.length };
        G.logEvent("gate.decision", { project: wo.project, wo: wo.id, gate: g.id, by: me(), mode: "human", trust: lvNow });
        wo.log.push({ at: Date.now(), who: me(), text: g.label + " " + g.name + " approved" + (via && via !== "web" ? " via " + via : "") + "." });
        if (g.id === "G6") { finish(wo, me()); if (wo.pr) wo.pr.tag = wo.pr.tag || "v1." + (10 + Math.floor(Math.random() * 20)) + ".0"; G.notify(wo.project, "released", { wo: wo.id, cls: wo.cls, priority: wo.priority }); msg = wo.id + " released and confirmed."; }
        else if (g.id === "G5") { if (wo.pr) { wo.pr.state = "merged"; wo.pr.checks = "green"; } advance(wo, me()); msg = "G5 approved; PR merged. " + wo.id + " moved to Close."; }
        else { advance(wo, me()); msg = g.label + " approved. " + wo.id + " moved to " + (wo.bay ? G.bayDef(wo.bay).name : G.STATIONS[wo.station].name) + "."; }
      } else {
        msg = g.label + " approval recorded (" + prog.have + " of " + prog.need + (prog.unmet.length ? "; still needs: " + prog.unmet.map(function (c) { return c.text; }).join("; ") : "") + ").";
        wo.log.push({ at: Date.now(), who: me(), text: g.label + " approval " + prog.have + " of " + prog.need + "." });
      }
      touch();
      G.audit(g.id === "G6" ? "gate.release" : "gate.approve", g.label + " on " + wo.id + (prog.passes ? " (passed)" : " (" + prog.have + "/" + prog.need + ")"), wo.repo, "ok", { project: wo.project, via: via, category: "approvals", entity: { type: "wo", id: wo.id } });
      G.notify(wo.project, "gate.decided", { wo: wo.id, cls: wo.cls, priority: wo.priority, gate: g.id });
      return ok(msg, { passed: prog.passes });
    },
    rejectGate: function (woId, reason, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var g = G.gateForWO(proj(wo), wo);
      if (!g || !wo.gates[g.id] || wo.gates[g.id].status !== "waiting") return fail(wo.id + " is not waiting at a gate.");
      var d = g.id === "G0G1" ? G.me("wo.decline", { project: wo.project }) : G.gateDecision(me(), wo, g.id);
      if (!d.allowed) return deny("gate.reject", g.label + " on " + wo.id, wo.repo, d, via, "approvals");
      if (!reason || reason.trim().length < 5) return fail("Give a reason of at least 5 characters.");
      if (g.id === "G0G1") return G.ops.decline(woId, reason, via);
      var gs = wo.gates[g.id];
      gs.rejections.push({ by: me(), at: Date.now(), reason: reason.trim() }); gs.approvals = []; gs.status = "pending";
      var cur = openEntry(wo); cur.outcome = "rejected at " + g.label; cur.endedAt = Date.now(); cur.note = reason.trim();
      var route = G.route(proj(wo), wo.cls);
      var here = route.indexOf(G.STATIONS[wo.station].id);
      enter(wo, route[here], me());
      wo.log.push({ at: Date.now(), who: me(), text: g.label + " rejected: " + reason.trim() + ". Reworking " + G.STATIONS[wo.station].name + "." });
      touch();
      G.audit("gate.reject", g.label + " on " + wo.id + ": " + reason.trim(), wo.repo, "ok", { project: wo.project, via: via, category: "approvals", entity: { type: "wo", id: wo.id } });
      G.notify(wo.project, "gate.decided", { wo: wo.id, cls: wo.cls, priority: wo.priority, gate: g.id });
      return ok(g.label + " rejected; " + wo.id + " is reworking " + G.STATIONS[wo.station].name + ".");
    },
    park: function (woId, bay, reason, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      if (bay === "declined") return G.ops.decline(woId, reason, via);
      var d = G.me("wo.park", { project: wo.project });
      if (!d.allowed) return deny("wo.park", wo.id + " → " + bay, wo.repo, d, via);
      if (["done", "killed"].indexOf(wo.state) >= 0) return fail(wo.id + " is " + wo.state + ".");
      var pb = proj(wo).flow.bays; if (!G.bayDef(bay) || (pb && pb.indexOf(bay) < 0)) return fail("No bay " + bay + " in " + proj(wo).name + ".");
      if (!reason || reason.trim().length < 3) return fail("Give a reason.");
      if (bay === "queue" && G.STATIONS[wo.station].id !== "build" && G.nextStationId(proj(wo), wo) !== "build") return fail("Only work about to build can wait in the Queue.");
      wo.bayFrom = wo.bay ? wo.bayFrom : G.STATIONS[wo.station].id; wo.bay = bay; wo.state = "parked"; wo.bayReason = reason.trim(); wo.bayAt = Date.now(); wo.slot = null;
      G.logEvent("wo.bay", { project: wo.project, wo: wo.id, bay: bay, by: me(), text: reason.trim() });
      if (bay === "person") { wo.conv.raised.push({ station: wo.bayFrom, text: reason.trim(), at: Date.now(), answered: false }); wo.conv.messages.push({ from: me(), at: Date.now(), text: reason.trim() }); G.notify(wo.project, "question", { wo: wo.id, cls: wo.cls, priority: wo.priority }); }
      wo.log.push({ at: Date.now(), who: me(), text: "Moved to " + G.bayDef(bay).name + ": " + reason.trim() });
      touch();
      G.audit("wo.park", wo.id + " → " + G.bayDef(bay).name + ": " + reason.trim(), wo.repo, "ok", { project: wo.project, via: via, entity: { type: "wo", id: wo.id } });
      return ok(wo.id + " moved to " + G.bayDef(bay).name + ".");
    },
    unpark: function (woId, reason, via) {
      var wo = G.find.wo(woId); if (!wo || !wo.bay) return fail("That work order is not in a bay.");
      var d = G.me("wo.park", { project: wo.project });
      if (!d.allowed) return deny("wo.unpark", wo.id, wo.repo, d, via);
      if (wo.bay === "sechold" && !G.can(me(), "gate.approve", { project: wo.project }).allowed) return fail("Security hold can only be released by someone who may approve gates in " + proj(wo).name + ".");
      var stop = G.stopState(wo.project, wo.repo); if (stop) return fail(stop.reason);
      var from = wo.bay, back = wo.bayFrom || G.STATIONS[wo.station].id;
      wo.bay = null; wo.bayReason = "";
      if (from === "declined" || from === "hold" || from === "person" || from === "sechold") {
        if (from === "sechold" && wo.gates.G3G3s) { wo.gates.G3G3s.status = "waiting"; wo.gates.G3G3s.checks.forEach(function (c) { c.ok = true; }); wo.state = "waiting"; }
        else if (back === "intake" && wo.gates.G0G1 && wo.gates.G0G1.status !== "passed") { wo.state = "waiting"; wo.station = 0; }
        else { wo.state = "running"; wo.station = G.stationIndex(back); }
      }
      if (from === "queue") { wo.station = G.stationIndex("build"); var s2 = freeSlot(proj(wo)); if (!s2) { wo.bay = "queue"; wo.state = "parked"; return fail("No free coding slot yet."); } wo.slot = s2; wo.state = "running"; wo.progress = 0; wo.history.push({ station: "build", agent: "ag-build", model: modelFor(proj(wo), "build", G.find.agent("ag-build")), startedAt: Date.now(), endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" }); }
      wo.bayFrom = null;
      wo.log.push({ at: Date.now(), who: me(), text: "Returned from " + G.bayDef(from).name + (reason ? ": " + reason : "") + "." });
      touch();
      G.audit("wo.unpark", wo.id + " ← " + G.bayDef(from).name + (reason ? ": " + reason : ""), wo.repo, "ok", { project: wo.project, via: via, entity: { type: "wo", id: wo.id } });
      return ok(wo.id + " is back at " + G.STATIONS[wo.station].name + ".");
    },
    sendBack: function (woId, toStation, note, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var d = G.me("wo.sendback", { project: wo.project });
      if (!d.allowed) return deny("wo.sendback", wo.id, wo.repo, d, via);
      var route = G.route(proj(wo), wo.cls);
      var cur = G.STATIONS[wo.station].id;
      if (route.indexOf(toStation) < 0 || route.indexOf(toStation) >= route.indexOf(cur)) return fail("Pick an earlier station on this work order's route.");
      var e = openEntry(wo); e.outcome = "sent back"; e.endedAt = Date.now(); e.note = note || "";
      wo.sendbacks = (wo.sendbacks || []).concat([{ from: cur, to: toStation, note: note || "", at: Date.now(), by: me() }]);
      Object.keys(wo.gates).forEach(function (gid) { var gd = G.gateDef(gid); if (route.indexOf(gd.after) >= route.indexOf(toStation) && gid !== "G0G1") { wo.gates[gid].status = "pending"; wo.gates[gid].approvals = []; } });
      if (toStation === "intake") { wo.gates.G0G1.status = "waiting"; wo.gates.G0G1.approvals = []; wo.station = 0; wo.state = "waiting"; wo.slot = null; wo.history.push({ station: "intake", agent: "ag-intake", model: "claude-haiku-5-5", startedAt: Date.now(), endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" }); }
      else enter(wo, toStation, me());
      if (wo.pr && G.stationIndex(toStation) < 5) wo.pr.checks = "pending";
      wo.log.push({ at: Date.now(), who: me(), text: "Sent back from " + G.find.station(cur).name + " to " + G.find.station(toStation).name + (note ? ": " + note : ".") });
      touch();
      G.audit("wo.sendback", wo.id + " " + cur + " → " + toStation + (note ? ": " + note : ""), wo.repo, "ok", { project: wo.project, via: via, entity: { type: "wo", id: wo.id } });
      return ok(wo.id + " sent back to " + G.find.station(toStation).name + ".");
    },
    /* board move: target is a station id or a bay id */
    moveTo: function (woId, target, reason, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var check = G.moveCheck(wo, target);
      if (!check.allowed) { G.audit("wo.move", wo.id + " → " + target, wo.repo, "denied", { project: wo.project, via: via }); return fail(check.reason); }
      if (check.kind === "park") return G.ops.park(woId, target, reason || "Moved on the board", via);
      if (check.kind === "unpark") return G.ops.unpark(woId, reason, via);
      if (check.kind === "back") return G.ops.sendBack(woId, target, reason, via);
      if (check.kind === "approve") return G.ops.approveGate(woId, via);
      return fail("Not a valid move.");
    },
    reassign: function (woId, agentId, via) {
      var wo = G.find.wo(woId), ag = G.find.agent(agentId);
      if (!wo || !ag) return fail("Pick an agent.");
      var d = G.me("wo.reassign", { project: wo.project });
      if (!d.allowed) return deny("wo.reassign", wo.id, wo.repo, d, via);
      var e = openEntry(wo), old = e.agent;
      e.agent = ag.id; e.model = modelFor(proj(wo), e.station, ag);
      wo.log.push({ at: Date.now(), who: me(), text: "Reassigned " + G.find.station(e.station).name + " from " + G.actorName(old) + " to " + ag.name + "." });
      touch();
      G.audit("wo.reassign", wo.id + " → " + ag.name, wo.repo, "ok", { project: wo.project, before: old, after: ag.id, entity: { type: "wo", id: wo.id } });
      return ok(wo.id + " now staffed by " + ag.name + ".");
    },
    retry: function (woId, via) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var d = G.me("wo.sendback", { project: wo.project });
      if (!d.allowed) return deny("wo.retry", wo.id, wo.repo, d, via);
      if (["failed", "blocked"].indexOf(wo.state) < 0) return fail(wo.id + " is not failed or blocked.");
      wo.log.push({ at: Date.now(), who: me(), text: "Retried " + G.STATIONS[wo.station].name + "." });
      wo.state = "running"; wo.progress = 20; wo.failReason = null; wo.blockReason = null; wo.tests.failed = 0;
      Object.keys(wo.gates).forEach(function (k) { if (wo.gates[k].status === "failed") wo.gates[k].status = "pending"; });
      if (wo.pr) wo.pr.checks = "pending";
      touch();
      G.audit("wo.retry", wo.id, wo.repo, "ok", { project: wo.project, via: via, entity: { type: "wo", id: wo.id } });
      return ok(wo.id + " is running again.");
    },
    raiseQuestion: function (woId, text, fromAgent) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      var st = G.STATIONS[wo.station].id;
      wo.conv.raised.push({ station: st, text: text, at: Date.now(), answered: false });
      wo.conv.messages.push({ from: fromAgent || G.STATIONS[wo.station].agent, at: Date.now(), text: text });
      wo.bayFrom = st; wo.bay = "person"; wo.state = "parked"; wo.bayReason = "Question raised at " + G.STATIONS[wo.station].name; wo.bayAt = Date.now();
      wo.log.push({ at: Date.now(), who: fromAgent || G.STATIONS[wo.station].agent, text: "Question for a person: " + text });
      touch();
      G.audit("wo.question", wo.id + ": " + text, wo.repo, "ok", { project: wo.project, actor: fromAgent || G.STATIONS[wo.station].agent, via: "agent", entity: { type: "wo", id: wo.id } });
      G.notify(wo.project, "question", { wo: wo.id, cls: wo.cls, priority: wo.priority });
      return ok("Question raised; " + wo.id + " moved to Needs a person.");
    },

    /* ===== andon (soft, resumable) ===== */
    haltRepo: function (repoId, reason, via) {
      var r = G.find.repo(repoId); if (!r) return fail("No such repo.");
      var d = G.me("line.halt", { project: r.project });
      if (!d.allowed) return deny("line.halt", r.name, r.id, d, via);
      if (r.halted) return fail(r.name + " is already halted.");
      if (!reason || reason.trim().length < 4) return fail("Give a reason of at least 4 characters.");
      G.store.update("repos", function () { r.halted = { by: me(), reason: reason.trim(), at: Date.now(), via: via || "web" }; });
      G.logEvent("halt", { scope: "repo", project: r.project, repo: r.id, by: me(), text: reason.trim() });
      G.audit("line.halt", r.name + ": " + reason.trim(), r.id, "ok", { project: r.project, via: via, entity: { type: "repo", id: r.id } });
      G.notify(r.project, "andon", { repo: r.id });
      return ok(r.name + " halted. Agents on this repo have stopped.");
    },
    resumeRepo: function (repoId, via) {
      var r = G.find.repo(repoId); if (!r) return fail("No such repo.");
      var d = G.me("line.resume", { project: r.project });
      if (!d.allowed) return deny("line.resume", r.name, r.id, d, via);
      if (!r.halted) return fail(r.name + " is not halted.");
      G.store.update("repos", function () { r.halted = null; });
      G.logEvent("resume", { scope: "repo", project: r.project, repo: r.id, by: me() });
      G.audit("line.resume", r.name, r.id, "ok", { project: r.project, via: via, entity: { type: "repo", id: r.id } });
      return ok(r.name + " resumed.");
    },
    haltProject: function (projectId, reason, via) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("line.halt", { project: p.id });
      if (!d.allowed) return deny("line.halt", p.name, p.id, d, via);
      if (p.halted) return fail(p.name + " is already halted.");
      if (!reason || reason.trim().length < (p.regulated ? 20 : 4)) return fail("Give a reason of at least " + (p.regulated ? 20 : 4) + " characters" + (p.regulated ? " (regulated project)." : "."));
      G.store.update("projects", function () { p.halted = { by: me(), reason: reason.trim(), at: Date.now(), via: via || "web" }; });
      G.logEvent("halt", { scope: "project", project: p.id, by: me(), text: reason.trim() });
      G.audit("line.halt", p.name + " (whole project): " + reason.trim(), p.id, "ok", { project: p.id, via: via, entity: { type: "project", id: p.id } });
      G.notify(p.id, "andon", {});
      return ok(p.name + " halted. Resume it from the floor.");
    },
    resumeProject: function (projectId, via) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("line.resume", { project: p.id });
      if (!d.allowed) return deny("line.resume", p.name, p.id, d, via);
      if (!p.halted) return fail(p.name + " is not halted.");
      G.store.update("projects", function () { p.halted = null; });
      G.logEvent("resume", { scope: "project", project: p.id, by: me() });
      G.audit("line.resume", p.name + " (whole project)", p.id, "ok", { project: p.id, via: via, entity: { type: "project", id: p.id } });
      return ok(p.name + " resumed.");
    },

    /* ===== kill switches (hard stop) =====
       scope: "factory" | "project" | "workorder"; id: project id or WO id (ignored for factory)
       o: { reason, mode: "hold" | "cancel", confirmText } */
    killImpact: function (scope, id) {
      var wos = S("workOrders").filter(function (w) {
        if (["done", "killed"].indexOf(w.state) >= 0 || w.bay === "declined") return false;
        if (scope === "factory") return true;
        if (scope === "project") return w.project === id;
        return w.id === String(id).toUpperCase();
      });
      var projects = scope === "factory" ? S("projects").filter(function (p) { return p.status !== "archived"; }) : scope === "project" ? [G.find.project(id)] : [];
      return { projects: projects.length, workOrders: wos.length, running: wos.filter(function (w) { return w.state === "running"; }).length, slots: wos.filter(function (w) { return w.slot; }).length, prs: wos.filter(function (w) { return w.pr && w.pr.state === "open"; }).length, list: wos };
    },
    kill: function (scope, id, o, via) {
      o = o || {};
      var action = "kill." + (scope === "workorder" ? "workorder" : scope);
      var wo = scope === "workorder" ? G.find.wo(id) : null;
      var project = scope === "project" ? G.find.project(id) : wo ? proj(wo) : null;
      if (scope !== "factory" && !project) return fail("Nothing to kill.");
      var d = G.me(action, { project: project && project.id });
      var label = scope === "factory" ? "the factory" : scope === "project" ? project.name : wo.id;
      if (!d.allowed) return deny(action, label, project ? project.id : "factory", d, via, "kill");
      if (!o.reason || o.reason.trim().length < 5) return fail("Give a reason of at least 5 characters.");
      if (scope === "factory" && o.confirmText !== "KILL FACTORY") return fail("Type KILL FACTORY to confirm.");
      if (scope === "project" && o.confirmText !== project.name) return fail("Type the project name exactly: " + project.name);
      if (scope === "factory" && S("factory").killed) return fail("The factory is already killed.");
      if (scope === "project" && project.killed) return fail(project.name + " is already killed.");
      if (scope === "workorder" && wo.state === "killed") return fail(wo.id + " is already killed.");
      var mode = scope === "workorder" ? "cancel" : (o.mode === "cancel" ? "cancel" : "hold");
      var imp = G.ops.killImpact(scope, scope === "project" ? project.id : id);
      var rec = { by: me(), at: Date.now(), reason: o.reason.trim(), mode: mode, counts: { projects: imp.projects, workOrders: imp.workOrders, running: imp.running, slots: imp.slots }, restoreApprovals: [] };
      imp.list.forEach(function (w) {
        w.slot = null;
        if (mode === "cancel") {
          w.killed = { by: me(), at: Date.now(), reason: o.reason.trim(), scope: scope, prev: { state: w.state, station: w.station, bay: w.bay, bayFrom: w.bayFrom } };
          w.state = "killed"; w.bay = null;
          var e = openEntry(w); if (e && !e.endedAt) { e.endedAt = Date.now(); e.outcome = "killed"; }
          if (w.pr && w.pr.state === "open") { w.pr.state = "draft"; w.log.push({ at: Date.now(), who: me(), text: "PR #" + w.pr.number + " converted to draft by the kill switch." }); }
          w.log.push({ at: Date.now(), who: me(), text: "Killed (" + scope + "): " + o.reason.trim() });
        } else {
          w.heldByKill = scope;
          w.log.push({ at: Date.now(), who: me(), text: "Held in place by " + scope + " kill: " + o.reason.trim() });
        }
      });
      if (scope === "factory") G.store.update("factory", function (f) { f.killed = rec; });
      if (scope === "project") G.store.update("projects", function () { project.killed = rec; });
      touch();
      G.logEvent("kill", { scope: scope === "workorder" ? "workorder" : scope, project: project ? project.id : null, wo: wo ? wo.id : null, by: me(), text: o.reason.trim(), mode: mode });
      G.audit(action, label + " · " + mode + " · " + imp.workOrders + " work orders, " + imp.running + " running agents" + (scope === "factory" ? ", " + imp.projects + " projects" : "") + ": " + o.reason.trim(), project ? project.id : "factory", "ok",
        { project: project && project.id, category: "kill", via: via, entity: { type: scope === "workorder" ? "wo" : scope, id: scope === "factory" ? "factory" : scope === "project" ? project.id : wo.id } });
      if (scope === "factory") S("projects").forEach(function (p) { G.notify(p.id, "kill", { scope: scope }); });
      else G.notify(project.id, "kill", { scope: scope, wo: wo && wo.id });
      return ok((scope === "factory" ? "Factory" : label) + " killed. " + imp.workOrders + " work orders " + (mode === "cancel" ? "cancelled" : "held") + ", " + imp.running + " agents stopped.", { impact: imp });
    },
    restore: function (scope, id, reason, via) {
      var action = "restore." + (scope === "workorder" ? "workorder" : scope);
      var wo = scope === "workorder" ? G.find.wo(id) : null;
      var project = scope === "project" ? G.find.project(id) : wo ? proj(wo) : null;
      var d = G.me(action, { project: project && project.id });
      var label = scope === "factory" ? "the factory" : scope === "project" ? project.name : wo.id;
      if (!d.allowed) return deny(action, label, project ? project.id : "factory", d, via, "kill");
      if (!reason || reason.trim().length < 5) return fail("Give a reason of at least 5 characters.");
      var ent = { type: scope === "workorder" ? "wo" : scope, id: scope === "factory" ? "factory" : scope === "project" ? project.id : wo.id };
      if (scope === "factory") {
        var k = S("factory").killed; if (!k) return fail("The factory is not killed.");
        if (S("security").restoreFactoryNeedsTwo) {
          if (k.restoreApprovals.some(function (a) { return a.by === me(); })) return fail("You already approved the restore. A second Factory Admin must approve.");
          k.restoreApprovals.push({ by: me(), at: Date.now(), reason: reason.trim() });
          if (k.restoreApprovals.length < 2) {
            G.store.set("factory", S("factory"));
            G.audit(action, "Restore approval 1 of 2: " + reason.trim(), "factory", "ok", { category: "kill", via: via, entity: ent });
            return ok("Restore approval recorded (1 of 2). A second Factory Admin must approve.", { pending: true });
          }
        }
        G.store.update("factory", function (f) { f.killed = null; });
        S("workOrders").forEach(function (w) { if (w.heldByKill === "factory") delete w.heldByKill; });
      } else if (scope === "project") {
        if (!project.killed) return fail(project.name + " is not killed.");
        G.store.update("projects", function () { project.killed = null; });
        S("workOrders").forEach(function (w) { if (w.project === project.id && w.heldByKill === "project") delete w.heldByKill; });
      } else {
        if (wo.state !== "killed") return fail(wo.id + " is not killed.");
        var stop = G.stopState(wo.project, wo.repo); if (stop) return fail(stop.reason + " Restore that first.");
        var prev = wo.killed.prev;
        wo.state = prev.state === "running" || prev.state === "waiting" || prev.state === "parked" ? prev.state : "running";
        wo.station = prev.station; wo.bay = prev.bay; wo.bayFrom = prev.bayFrom;
        if (wo.state === "running") { wo.progress = 0; var ag = G.find.agent(G.STATIONS[wo.station].agent); wo.history.push({ station: G.STATIONS[wo.station].id, agent: ag.id, model: ag.model, startedAt: Date.now(), endedAt: null, tokens: 0, cost: 0, outcome: null, note: "restored" }); }
        if (G.STATIONS[wo.station].id === "build" && wo.state === "running") { var sl = freeSlot(project); if (sl) wo.slot = sl; else { wo.bay = "queue"; wo.state = "parked"; wo.bayFrom = "build"; } }
        if (wo.pr && wo.pr.state === "draft") wo.pr.state = "open";
        wo.log.push({ at: Date.now(), who: me(), text: "Restored after kill: " + reason.trim() });
        wo.restoredFrom = wo.killed; wo.killed = null;
      }
      touch();
      G.logEvent("restore", { scope: scope === "workorder" ? "workorder" : scope, project: project ? project.id : null, wo: wo ? wo.id : null, by: me(), text: reason.trim() });
      G.audit(action, label + ": " + reason.trim(), project ? project.id : "factory", "ok", { project: project && project.id, category: "kill", via: via, entity: ent });
      if (scope === "factory") S("projects").forEach(function (p) { G.notify(p.id, "restore", { scope: scope }); });
      else G.notify(project.id, "restore", { scope: scope, wo: wo && wo.id });
      return ok((scope === "factory" ? "Factory" : label) + " restored." + (scope !== "workorder" ? " Work orders killed with 'cancel' stay killed until restored one by one." : ""));
    },

    /* ===== projects and templates ===== */
    /* o: { name, key, templateId, owner, teams[], repos:[{name, team}], approvers (optional override), notifications (optional), desc } */
    createProject: function (o) {
      var d = G.me("project.create");
      if (!d.allowed) return deny("project.create", o.name || "project", "factory", d);
      if (!o.name || o.name.trim().length < 3) return fail("Name the project (3+ characters).");
      var id = o.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (G.find.project(id)) return fail("A project called " + o.name + " already exists.");
      var tpl = G.find.template(o.templateId) || S("templates")[0];
      var p = { id: id, name: o.name.trim(), key: (o.key || id.slice(0, 3)).toUpperCase(), status: "new", teams: o.teams || [], owner: o.owner || me(), template: tpl.id, regulated: tpl.approverPreset === "strict",
        desc: o.desc || "Created from " + tpl.name + ".", flow: G.flowFrom(tpl), approvers: o.approvers || G.approversPreset(tpl.approverPreset), notifications: o.notifications || G.routesPreset(tpl.notify), mcp: tpl.mcp.slice(),
        budget: { monthly: o.budget || 1000, mtd: 0, alertAt: 0.8 }, created: Date.now(), halted: null, killed: null, overlay: "" };
      G.store.update("projects", function (l) { l.push(p); });
      G.store.update("people", function (l) { var x = G.find.person(p.owner); if (x && !x.roles.some(function (g) { return g.scope === p.id; }) && !G.isFactoryAdmin(x.id)) x.roles.push({ role: "project_admin", scope: p.id }); });
      G.audit("project.create", p.name + " from template " + tpl.name, p.id, "ok", { project: p.id, category: "config", entity: { type: "project", id: p.id } });
      (o.repos || []).forEach(function (r) { G.ops.connectRepo(p.id, r.name, r.team || (p.teams[0] || "platform")); });
      return ok(p.name + " created.", { project: p });
    },
    archiveProject: function (projectId, confirmText) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("project.archive", { project: p.id });
      if (!d.allowed) return deny("project.archive", p.name, p.id, d);
      if (confirmText !== p.name) return fail("Type the project name exactly: " + p.name);
      var before = p.status;
      G.store.update("projects", function () { p.status = "archived"; });
      G.audit("project.archive", p.name, p.id, "ok", { project: p.id, category: "config", before: before, after: "archived", entity: { type: "project", id: p.id } });
      return ok(p.name + " archived.");
    },
    /* duplicate a template, or save a project's flow as a template */
    saveTemplate: function (o) {
      var d = G.me("template.edit");
      if (!d.allowed) return deny("template.edit", o.name || "template", "factory", d, "web", "config");
      var base = o.fromProject ? G.find.project(o.fromProject) : null;
      var src = o.fromTemplate ? G.find.template(o.fromTemplate) : null;
      var t = src ? JSON.parse(JSON.stringify(src)) : { desc: "Saved from " + base.name, stationsOff: [], gatesOff: [], slots: base.flow.slots, classesSkip: {}, mcp: base.mcp.slice(), approverPreset: base.regulated ? "strict" : "standard", notify: "standard" };
      if (base) {
        t.stationsOff = Object.keys(base.flow.stations).filter(function (k) { return !base.flow.stations[k].enabled; });
        t.gatesOff = Object.keys(base.flow.gates).filter(function (k) { return !base.flow.gates[k].enabled; });
        base.flow.classes.forEach(function (c) { var def = G.CLASSES.find(function (x) { return x.id === c.id; }); if (JSON.stringify(def.skips) !== JSON.stringify(c.skips)) t.classesSkip[c.id] = c.skips.slice(); });
      }
      t.id = "tpl-" + Date.now().toString(36); t.name = o.name || (src ? src.name + " (copy)" : base.name + " template"); t.builtIn = false;
      G.store.update("templates", function (l) { l.push(t); });
      G.audit("template.save", t.name + (base ? " from project " + base.name : " from " + src.name), "factory", "ok", { category: "config", entity: { type: "template", id: t.id } });
      return ok("Template " + t.name + " saved.", { template: t });
    },
    updateTemplate: function (tplId, patch) {
      var t = G.find.template(tplId); if (!t) return fail("No such template.");
      var d = G.me("template.edit");
      if (!d.allowed) return deny("template.edit", t.name, "factory", d, "web", "config");
      var before = JSON.stringify({ name: t.name, stationsOff: t.stationsOff, gatesOff: t.gatesOff, classesSkip: t.classesSkip });
      G.store.update("templates", function () { Object.keys(patch).forEach(function (k) { t[k] = patch[k]; }); });
      G.audit("template.edit", t.name, "factory", "ok", { category: "config", before: before, after: JSON.stringify({ name: t.name, stationsOff: t.stationsOff, gatesOff: t.gatesOff, classesSkip: t.classesSkip }), entity: { type: "template", id: t.id } });
      return ok("Template saved.");
    },
    /* project config edit: path like "flow.slots", "flow.stations.design.enabled", "approvers.G5.required", "budget.monthly", "overlay" */
    setProject: function (projectId, path, value, perm) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      perm = perm || (path.indexOf("approvers") === 0 ? "approvers.edit" : path.indexOf("notifications") === 0 ? "notify.edit" : "project.config");
      var d = G.me(perm, { project: p.id });
      if (!d.allowed) return deny(perm, p.name + " " + path, p.id, d, "web", "config");
      var parts = path.split("."), obj = p;
      for (var i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      var before = JSON.stringify(obj[parts[parts.length - 1]]);
      G.store.update("projects", function () { obj[parts[parts.length - 1]] = value; });
      G.audit(perm === "approvers.edit" ? "approvers.edit" : perm === "notify.edit" ? "notify.edit" : "project.config", p.name + ": " + path, p.id, "ok", { project: p.id, category: perm === "notify.edit" ? "integrations" : "config", before: before, after: JSON.stringify(value), entity: { type: path.indexOf("approvers.") === 0 ? "gaterule" : "project", id: path.indexOf("approvers.") === 0 ? p.id + ":" + parts[1] : p.id } });
      return ok("Saved " + path + ".");
    },
    setMemberRole: function (personId, projectId, role, add) {
      var person = G.find.person(personId), p = G.find.project(projectId);
      if (!person || !p) return fail("Pick a person and project.");
      var d = G.me("project.members", { project: p.id });
      if (!d.allowed) return deny("project.members", person.name + " " + role, p.id, d, "web", "access");
      var before = G.rolesIn(person, p.id).join(",");
      G.store.update("people", function () {
        if (add) { if (!person.roles.some(function (g) { return g.role === role && g.scope === p.id; })) person.roles.push({ role: role, scope: p.id }); }
        else person.roles = person.roles.filter(function (g) { return !(g.role === role && g.scope === p.id); });
      });
      G.audit(add ? "role.grant" : "role.revoke", person.name + ": " + G.find.role(role).name + " on " + p.name, p.id, "ok", { project: p.id, category: "access", before: before, after: G.rolesIn(person, p.id).join(","), entity: { type: "person", id: person.id } });
      return ok((add ? "Granted " : "Removed ") + G.find.role(role).name + (add ? " to " : " from ") + person.name + " on " + p.name + ".");
    },
    invite: function (o) {
      var d = G.me("people.manage");
      if (!d.allowed) return deny("people.invite", o.email || "", "factory", d, "web", "access");
      if (!o.name || o.name.trim().length < 2) return fail("Enter a name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email || "")) return fail("Enter a valid email address.");
      if (S("people").some(function (p) { return p.email === o.email.toLowerCase(); })) return fail(o.email + " is already in the org.");
      var id = "p-" + o.email.split("@")[0].replace(/[^a-z0-9]/gi, "").toLowerCase() + "-" + Date.now().toString(36).slice(-3);
      var person = { id: id, name: o.name.trim(), title: "Invited", email: o.email.toLowerCase(), teams: o.teams || [], roles: o.roles || [], status: "invited", oncall: false, github: "", away: null };
      G.store.update("people", function (l) { l.push(person); });
      G.audit("people.invite", person.name + " <" + person.email + ">", "factory", "ok", { category: "access", entity: { type: "person", id: id } });
      return ok("Invite sent to " + person.email + " (simulated).", { person: person });
    },

    /* ===== repo onboarding ===== */
    /* sourceId: the source-control instance the repo lives on (defaults to the project's source, G.sourceIntegrationFor) */
    connectRepo: function (projectId, repoName, team, sourceId) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("repo.onboard", { project: p.id });
      if (!d.allowed) return deny("repo.onboard", repoName, p.id, d, "web", "onboarding");
      if (!repoName || !String(repoName).trim()) return fail("Name the repo.");
      var src = sourceId ? G.find.integration(sourceId) : G.sourceIntegrationFor(p.id);
      if (sourceId && (!src || G.sourceInstances(p.id).indexOf(src) < 0)) return fail("That source is not a source-control integration open to " + p.name + ".");
      if (!src) return fail("No source-control integration is open to " + p.name + ". Add one in Integrations.");
      if (!src.connected || src.status === "offline") return fail(src.name + " is offline. Fix it in Integrations or pick another source.");
      var org = (src.config && (src.config.org || src.config.group || src.config.workspace)) || "acme";
      var name = String(repoName).trim(); name = name.indexOf("/") < 0 ? org + "/" + name : name;
      var id = name.split("/")[1];
      var ex = G.find.repo(id);
      if (ex) { var vis = G.visibleProjects(me()).some(function (x) { return x.id === ex.project; }); return fail(name + " is already connected to " + (vis ? G.find.project(ex.project).name : "another project") + "."); }
      var av = (src.available || []).find(function (x) { return x.repo === name; }) || (S("integrations").github.available || []).find(function (x) { return x.repo === name; });
      var rp = { id: id, name: name, project: p.id, team: team || p.teams[0] || "platform", tags: p.regulated ? ["regulated"] : [], lang: av ? av.lang : "Unknown", halted: null,
        config: { defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", tagging: "semver-patch", requiredChecks: ["ci/test"], protectedPaths: [".github/workflows/**"] },
        mcp: [], notifyOverrides: [], triggers: true, guidelines: "",
        source: src.id,
        onboarding: { stage: "connected", findings: [], pr: null, timeline: [{ at: Date.now(), who: me(), text: "Connected through " + src.name + " (" + ((G.find.integrationType(src.type) || {}).name || src.type) + ")." }], exception: null, startedAt: Date.now(), auto: true } };
      G.store.update("repos", function (l) { l.push(rp); });
      G.store.update("integrationInstances", function () { if (src.available) src.available = src.available.filter(function (x) { return x.repo !== name; }); });
      G.store.update("integrations", function (i) { if (i.github && i.github.available) i.github.available = i.github.available.filter(function (x) { return x.repo !== name; }); });
      if (p.status === "new") G.store.update("projects", function () { p.status = "onboarding"; });
      G.audit("repo.connect", name + " → " + p.name + " via " + src.name, id, "ok", { project: p.id, category: "onboarding", entity: { type: "repo", id: id } });
      return ok(name + " connected. The Onboarding agent will assess it.", { repo: rp });
    },
    /* per-repo settings during onboarding; patch keys: team, config{}, mcp[], notifyOverrides[], triggers(bool), tags[], guidelines */
    configureRepo: function (repoId, patch) {
      var r = G.find.repo(repoId); if (!r) return fail("No such repo.");
      var d = G.me("onboarding.manage", { project: r.project });
      if (!d.allowed) return deny("repo.config", r.name, r.id, d, "web", "onboarding");
      var before = JSON.stringify(Object.keys(patch).reduce(function (o, k) { o[k] = r[k]; return o; }, {}));
      G.store.update("repos", function () { Object.keys(patch).forEach(function (k) { r[k] = k === "config" ? Object.assign({}, r.config, patch.config) : patch[k]; }); });
      G.audit("repo.config", r.name + ": " + Object.keys(patch).join(", "), r.id, "ok", { project: r.project, category: "onboarding", before: before, after: JSON.stringify(patch), entity: { type: "repo", id: r.id } });
      return ok("Saved " + r.name + ".");
    },
    rerunAssessment: function (repoId) {
      var r = G.find.repo(repoId); if (!r) return fail("No such repo.");
      var d = G.me("onboarding.manage", { project: r.project });
      if (!d.allowed) return deny("onboarding.assess", r.name, r.id, d, "web", "onboarding");
      G.store.update("repos", function () {
        G.assessRepo(r);
        r.onboarding.stage = "assessed"; r.onboarding.blocker = null;
        r.onboarding.timeline.push({ at: Date.now(), who: "ag-onboard", text: "Re-assessed at " + G.actorName(me()) + "'s request: " + r.onboarding.findings.filter(function (f) { return !f.ok; }).length + " gaps." });
      });
      G.audit("onboarding.assess", r.name, r.id, "ok", { project: r.project, entity: { type: "repo", id: r.id } });
      return ok("Assessment re-run for " + r.name + ".");
    },
    openOnboardingPR: function (repoId, actor) {
      var r = G.find.repo(repoId); if (!r) return fail("No such repo.");
      if (!actor || !G.find.agent(actor)) {
        var dp = G.me("onboarding.manage", { project: r.project });
        if (!dp.allowed) return deny("onboarding.pr", r.name, r.id, dp, "web", "onboarding");
        actor = null;
      }
      if (r.onboarding.pr && r.onboarding.pr.state === "open") return fail(r.name + " already has an open onboarding PR (#" + r.onboarding.pr.number + ").");
      if (["assessed", "failed"].indexOf(r.onboarding.stage) < 0) return fail("An onboarding PR is opened after the assessment; " + r.name + " is at '" + r.onboarding.stage + "'.");
      G.store.update("repos", function () {
        G.makeOnboardingPR(r, S("nextPR"));
        var p = G.find.project(r.project);
        r.onboarding.pr.reviewers = S("people").filter(function (x) { return x.roles.some(function (g) { return g.scope === p.id && ["project_admin", "release_manager"].indexOf(g.role) >= 0; }); }).map(function (x) { return x.id; });
        r.onboarding.stage = "pr_opened";
        r.onboarding.timeline.push({ at: Date.now(), who: actor || "ag-onboard", text: "Opened PR #" + r.onboarding.pr.number + " with " + r.onboarding.pr.files.length + " files." });
      });
      G.store.set("nextPR", S("nextPR") + 1);
      G.audit("onboarding.pr", r.name + "#" + r.onboarding.pr.number + " opened", r.id, "ok", { project: r.project, actor: actor || "ag-onboard", via: "agent", entity: { type: "repo", id: r.id } });
      G.notify(r.project, "onboarding.pr", { repo: r.id });
      return ok("Onboarding PR #" + r.onboarding.pr.number + " opened on " + r.name + ".");
    },
    simulateChecksPass: function (repoId) {
      var r = G.find.repo(repoId); if (!r || !r.onboarding.pr) return fail("No onboarding PR yet.");
      var d = G.me("onboarding.manage", { project: r.project });
      if (!d.allowed) return deny("onboarding.checks", r.name, r.id, d, "web", "onboarding");
      G.store.update("repos", function () { r.onboarding.pr.checks = "green"; r.onboarding.stage = "pr_checks"; r.onboarding.timeline.push({ at: Date.now(), who: "ci", text: "All checks passed on PR #" + r.onboarding.pr.number + " (simulated)." }); });
      G.audit("onboarding.checks", r.name + "#" + r.onboarding.pr.number + " checks green (simulated)", r.id, "ok", { project: r.project, entity: { type: "repo", id: r.id } });
      return ok("Checks are green on " + r.name + "#" + r.onboarding.pr.number + ".");
    },
    mergeOnboardingPR: function (repoId) {
      var r = G.find.repo(repoId); if (!r || !r.onboarding.pr) return fail("No onboarding PR yet.");
      var d = G.me("onboarding.merge", { project: r.project });
      if (!d.allowed) return deny("onboarding.merge", r.name + "#" + r.onboarding.pr.number, r.id, d, "web", "onboarding");
      if (r.onboarding.pr.checks !== "green") return fail("Checks are not green yet.");
      G.store.update("repos", function () { r.onboarding.pr.state = "merged"; r.onboarding.pr.mergedBy = me(); r.onboarding.stage = "pr_merged"; r.onboarding.timeline.push({ at: Date.now(), who: me(), text: "Approved and merged PR #" + r.onboarding.pr.number + "." }); });
      G.audit("onboarding.merge", r.name + "#" + r.onboarding.pr.number, r.id, "ok", { project: r.project, entity: { type: "repo", id: r.id } });
      G.notify(r.project, "onboarding.pr", { repo: r.id });
      return ok("Merged. The Onboarding agent will verify " + r.name + ".");
    },
    requestChanges: function (repoId, text) {
      var r = G.find.repo(repoId); if (!r || !r.onboarding.pr) return fail("No onboarding PR yet.");
      var d = G.me("onboarding.manage", { project: r.project });
      if (!d.allowed) return deny("onboarding.changes", r.name, r.id, d, "web", "onboarding");
      if (!text || text.trim().length < 5) return fail("Describe the change you want.");
      G.store.update("repos", function () { r.onboarding.pr.checks = "pending"; r.onboarding.stage = "pr_opened"; r.onboarding.timeline.push({ at: Date.now(), who: me(), text: "Requested changes: " + text.trim() }); r.onboarding.timeline.push({ at: Date.now() + 1000, who: "ag-onboard", text: "Pushed a fix commit for the requested change." }); });
      G.audit("onboarding.changes", r.name + ": " + text.trim(), r.id, "ok", { project: r.project, entity: { type: "repo", id: r.id } });
      return ok("Change requested; the agent pushed an update.");
    },
    markException: function (repoId, reason) {
      var r = G.find.repo(repoId); if (!r) return fail("No such repo.");
      var d = G.me("onboarding.exception", { project: r.project });
      if (!d.allowed) return deny("onboarding.exception", r.name, r.id, d, "web", "onboarding");
      if (!reason || reason.trim().length < 10) return fail("Give a reason of at least 10 characters.");
      var before = r.onboarding.stage;
      G.store.update("repos", function () { r.onboarding.exception = { by: me(), at: Date.now(), reason: reason.trim() }; r.onboarding.stage = "ready"; r.onboarding.readyAt = Date.now(); r.onboarding.timeline.push({ at: Date.now(), who: me(), text: "Marked ready by exception: " + reason.trim() }); });
      G.audit("onboarding.exception", r.name + ": " + reason.trim(), r.id, "ok", { project: r.project, before: before, after: "ready (exception)", entity: { type: "repo", id: r.id } });
      return ok(r.name + " marked ready by exception.");
    },
    saveGuidelines: function (patch, note, projectId) {
      if (projectId) {
        var pp = G.find.project(projectId); if (!pp) return fail("No such project.");
        var dp2 = G.me("onboarding.guidelines", { project: pp.id });
        if (!dp2.allowed) return deny("guidelines.edit", pp.name + " onboarding guidelines", pp.id, dp2, "web", "onboarding");
        var cur = pp.guidelines || { items: [], notes: "", version: 0, history: [] };
        var b2 = JSON.stringify({ items: cur.items, notes: cur.notes });
        G.store.update("projects", function () {
          pp.guidelines = Object.assign({}, cur, patch); pp.guidelines.version = (cur.version || 0) + 1;
          pp.guidelines.history = (cur.history || []).concat([{ v: pp.guidelines.version, at: Date.now(), by: me(), note: note || "Edited" }]);
        });
        G.audit("guidelines.edit", pp.name + " onboarding guidelines v" + pp.guidelines.version + (note ? ": " + note : ""), pp.id, "ok", { project: pp.id, category: "onboarding", before: b2, after: JSON.stringify({ items: pp.guidelines.items, notes: pp.guidelines.notes }), entity: { type: "guidelines", id: pp.id } });
        return ok(pp.name + " guidelines saved as v" + pp.guidelines.version + ".");
      }
      var d = G.me("agent.edit");
      if (!d.allowed) return deny("guidelines.edit", "Onboarding guidelines", "factory", d, "web", "onboarding");
      var g = S("guidelines");
      var before = JSON.stringify({ items: g.items, may: g.may, mayNot: g.mayNot });
      G.store.update("guidelines", function (x) { Object.keys(patch).forEach(function (k) { x[k] = patch[k]; }); x.version++; x.by = me(); x.at = Date.now(); x.history.push({ v: x.version, at: Date.now(), by: me(), note: note || "Edited" }); });
      G.audit("guidelines.edit", "Onboarding guidelines v" + S("guidelines").version + (note ? ": " + note : ""), "factory", "ok", { category: "onboarding", before: before, after: JSON.stringify({ items: g.items, may: g.may, mayNot: g.mayNot }), entity: { type: "guidelines", id: "onboarding" } });
      return ok("Guidelines saved as v" + S("guidelines").version + ".");
    },

    /* ===== agents and skills ===== */
    /* patch: any agent fields (model, fallbacks, autonomy, tools, skills, mcp, stations, projects, budget, guardrails, instructions, overrides, status, name) */
    saveAgent: function (agentId, patch, note) {
      var a = G.find.agent(agentId); if (!a) return fail("No such agent.");
      var d = G.me("agent.edit");
      if (!d.allowed) return deny("agent.edit", a.name, "factory", d, "web", "agents");
      if (patch.autonomy) { var chk = G.agentAutonomyCheck(Object.assign({}, a, patch), patch.autonomy); if (!chk.allowed) return fail(chk.reason); }
      var ovs = patch.overrides || {};
      for (var pid in ovs) { if (ovs[pid] && ovs[pid].autonomy) { var c2 = G.agentAutonomyCheck(Object.assign({}, a, patch), ovs[pid].autonomy, pid); if (!c2.allowed) return fail("Override for " + (G.find.project(pid) || { name: pid }).name + ": " + c2.reason); } }
      var keys = Object.keys(patch);
      var before = JSON.stringify(keys.reduce(function (o, k) { o[k] = a[k]; return o; }, {}));
      G.store.update("agents", function () { keys.forEach(function (k) { a[k] = JSON.parse(JSON.stringify(patch[k])); }); });
      G.audit("agent.edit", a.name + ": " + keys.join(", ") + (note ? " (" + note + ")" : ""), "factory", "ok", { category: "agents", before: before, after: JSON.stringify(patch), entity: { type: "agent", id: a.id } });
      return ok("Saved " + a.name + ".");
    },
    /* new version from current config; promotion to live is gated by eval eligibility */
    newAgentVersion: function (agentId, v, note) {
      var a = G.find.agent(agentId); if (!a) return fail("No such agent.");
      var d = G.me("agent.edit");
      if (!d.allowed) return deny("agent.version", a.name, "factory", d, "web", "agents");
      if (!/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(v || "")) return fail("Version must look like 1.2.3 or 1.2.3-rc1.");
      if (a.versions.some(function (x) { return x.v === v; })) return fail(v + " already exists.");
      G.store.update("agents", function () { a.versions.push({ v: v, at: Date.now(), note: note || "", diff: note || "", suiteScore: 0, live: false, rc: true, snapshot: JSON.stringify({ model: a.model, skills: a.skills, instructions: a.instructions, autonomy: a.autonomy }) }); });
      G.audit("agent.version", a.name + " " + v + " created", "factory", "ok", { category: "agents", entity: { type: "agent", id: a.id } });
      return ok(a.name + " " + v + " created as a candidate. Run its eval suite to promote it.");
    },
    promoteAgent: function (agentId, v) {
      var a = G.find.agent(agentId); if (!a) return fail("No such agent.");
      var d = G.me("agent.edit");
      if (!d.allowed) return deny("agent.promote", a.name + " " + v, "factory", d, "web", "agents");
      var el = G.agentEligibility(a, a.versions.find(function (x) { return x.v === v; }));
      if (!el.ok) return fail("Blocked: " + el.text + ".");
      var before = a.version;
      G.store.update("agents", function () { a.versions.forEach(function (x) { x.live = x.v === v; if (x.v === v) x.rc = false; }); a.version = v; a.evalScore = el.score; });
      G.audit("agent.promote", a.name + " " + v + " to floor", "factory", "ok", { category: "agents", before: before, after: v, entity: { type: "agent", id: a.id } });
      return ok(a.name + " " + v + " is on the floor.");
    },
    rollbackAgent: function (agentId, v) {
      var a = G.find.agent(agentId); if (!a) return fail("No such agent.");
      var d = G.me("agent.edit");
      if (!d.allowed) return deny("agent.rollback", a.name + " " + v, "factory", d, "web", "agents");
      var ver = a.versions.find(function (x) { return x.v === v; }); if (!ver) return fail("No such version.");
      var before = a.version;
      G.store.update("agents", function () { a.versions.forEach(function (x) { x.live = x.v === v; }); a.version = v; a.evalScore = ver.suiteScore; if (ver.snapshot) { var sn = JSON.parse(ver.snapshot); Object.keys(sn).forEach(function (k) { a[k] = sn[k]; }); } });
      G.audit("agent.rollback", a.name + " → " + v, "factory", "ok", { category: "agents", before: before, after: v, entity: { type: "agent", id: a.id } });
      return ok(a.name + " rolled back to " + v + ".");
    },
    createAgent: function (o) {
      var d = G.me("agent.edit");
      if (!d.allowed) return deny("agent.create", o.name || "agent", "factory", d, "web", "agents");
      if (!o.name || !o.name.trim()) return fail("Give the agent a name.");
      if (o.autonomy) { var chk0 = G.agentAutonomyCheck({ station: o.station || null, projects: o.projects || "all" }, o.autonomy); if (!chk0.allowed) return fail(chk0.reason); }
      var id = "ag-" + o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now().toString(36).slice(-4);
      var a = Object.assign({ id: id, name: o.name.trim(), station: o.station || null, model: o.model || S("routing").defaultModel, fallbacks: [], version: "0.1.0", status: "paused", autonomy: "suggest",
        tools: { readRepo: true, writeBranch: false, runTests: false, openPR: false, merge: false, postSlack: true, sendEmail: false, readSecrets: false }, skills: [], mcp: [], stations: o.station ? [o.station] : [], projects: "all",
        budget: 1, guardrails: { paths: [], maxDiff: 0 }, suite: "SUITE-" + id.slice(3).toUpperCase(), instructions: "", overrides: {}, versions: [{ v: "0.1.0", at: Date.now(), note: "Created", diff: "Created", suiteScore: 0, live: true, rc: false, snapshot: null }],
        spark: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], spend7d: 0, evalScore: 0 }, o, { id: id });
      a.initials = a.name.split(/\s+/).map(function (w) { return (w.match(/[A-Za-z0-9]/) || [""])[0]; }).join("").slice(0, 2).toUpperCase() || "AG";
      G.store.update("agents", function (l) { l.push(a); });
      G.store.update("suites", function (l) { l.push({ id: a.suite, name: a.name + " golden set", station: a.station || "intake", threshold: 0.85, agent: a.id, cases: [{ id: "NEW-01", name: "Golden task A" }, { id: "NEW-02", name: "Golden task B" }, { id: "NEW-03", name: "Respects guardrails" }] }); });
      G.store.update("scorecards", function (sc) { sc[a.id] = { taskSuccess: 0, firstPass: 0, testPass: 0, rework: 0, costPerWO: 0, minutesPerStation: 0, gateRejections: 0, overrideRate: 0, trend: { success: [0, 0, 0, 0, 0, 0, 0, 0], cost: [0, 0, 0, 0, 0, 0, 0, 0] } }; });
      G.audit("agent.create", a.name, "factory", "ok", { category: "agents", entity: { type: "agent", id: a.id } });
      return ok(a.name + " created, paused until its suite passes.", { agent: a });
    },
    /* patch: name, desc, when, body, resources[], projects; bump: true creates a new version */
    saveSkill: function (skillId, patch, note) {
      var d = G.me("skill.edit");
      var sk = skillId ? G.find.skill(skillId) : null;
      if (!d.allowed) return deny("skill.edit", sk ? sk.name : patch.name || "skill", "factory", d, "web", "agents");
      if (!sk) {
        if (!patch.name || !patch.name.trim()) return fail("Name the skill.");
        sk = { id: "sk-" + patch.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20) + "-" + Date.now().toString(36).slice(-3), name: patch.name.trim(), desc: patch.desc || "", when: patch.when || "", body: patch.body || "", resources: patch.resources || [],
          version: "1.0.0", projects: "all", owner: me(), versions: [{ v: "1.0.0", at: Date.now(), by: me(), note: "Created" }], coverage: { suite: null, cases: 0, pass: 0 } };
        G.store.update("skills", function (l) { l.push(sk); });
        G.audit("skill.create", sk.name, "factory", "ok", { category: "agents", entity: { type: "skill", id: sk.id } });
        return ok("Skill " + sk.name + " created.", { skill: sk });
      }
      var before = JSON.stringify({ desc: sk.desc, when: sk.when, body: sk.body, resources: sk.resources, projects: sk.projects, version: sk.version });
      G.store.update("skills", function () {
        Object.keys(patch).forEach(function (k) { sk[k] = patch[k]; });
        var p = sk.version.split(".").map(Number); p[1]++; p[2] = 0; sk.version = p.join(".");
        sk.versions.push({ v: sk.version, at: Date.now(), by: me(), note: note || "Edited" });
      });
      G.audit("skill.edit", sk.name + " v" + sk.version + (note ? ": " + note : ""), "factory", "ok", { category: "agents", before: before, after: JSON.stringify(patch), entity: { type: "skill", id: sk.id } });
      return ok(sk.name + " saved as v" + sk.version + ".");
    },
    attachSkill: function (agentId, skillId, attach) {
      var a = G.find.agent(agentId), sk = G.find.skill(skillId);
      if (!a || !sk) return fail("Pick an agent and a skill.");
      var list = a.skills.filter(function (x) { return x !== skillId; });
      if (attach) list.push(skillId);
      return G.ops.saveAgent(agentId, { skills: list }, (attach ? "attached " : "detached ") + sk.name);
    },

    /* ===== MCP servers ===== */
    /* o: { name, transport, url, auth, secret, sensitivity, tools:[{name,write,allowed}] } */
    addMCP: function (o) {
      var d = G.me("mcp.edit");
      if (!d.allowed) return deny("mcp.add", o.name || "server", "factory", d, "web", "integrations");
      if (!o.name || !o.url) return fail("Name and URL are required.");
      var id = "mcp-" + o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16) + "-" + Date.now().toString(36).slice(-3);
      var srv = { id: id, name: o.name.trim(), transport: o.transport || "http", url: o.url.trim(), auth: o.auth || "API key", authMask: o.secret ? o.secret.slice(0, 3) + "••••" + o.secret.slice(-3) : "none", health: "healthy", sensitivity: o.sensitivity || "internal", writeGate: true, tools: o.tools || [], projects: [], repos: [], agents: [], stations: [] };
      G.store.update("mcp", function (l) { l.push(srv); });
      G.audit("mcp.add", srv.name + " · " + srv.url + " · " + srv.tools.length + " tools", "factory", "ok", { category: "integrations", entity: { type: "mcp", id: id } });
      return ok(srv.name + " added. Scope it to projects, repos and agents before use.", { server: srv });
    },
    /* simulated tool discovery by URL/name */
    discoverTools: function (name, url) {
      var n = (name + " " + url).toLowerCase();
      var sets = [[/jira|issue|ticket|linear/, ["search_issues", "get_issue", "create_issue*", "transition_issue*"]], [/wiki|docs|confluence|notion/, ["search_pages", "get_page", "update_page*"]], [/grafana|observ|metric|log|datadog/, ["query_metrics", "get_logs", "list_alerts"]],
        [/sql|db|postgres|replica/, ["describe_schema", "explain_query", "sample_rows"]], [/figma|design/, ["get_frame", "list_components"]], [/flag/, ["get_flag", "list_flags", "toggle_flag*"]]];
      var hit = sets.find(function (s) { return s[0].test(n); });
      var tools = (hit ? hit[1] : ["list_resources", "get_resource", "call_action*"]).map(function (t) { return { name: t.replace("*", ""), write: /\*$/.test(t), allowed: !/\*$/.test(t) }; });
      return ok("Discovered " + tools.length + " tools (simulated).", { tools: tools });
    },
    /* patch: projects, repos, agents, stations, tools, writeGate, sensitivity, health */
    updateMCP: function (id, patch) {
      var srv = G.find.mcp(id); if (!srv) return fail("No such server.");
      var d = G.me("mcp.edit");
      if (!d.allowed) return deny("mcp.edit", srv.name, "factory", d, "web", "integrations");
      var before = JSON.stringify(Object.keys(patch).reduce(function (o, k) { o[k] = srv[k]; return o; }, {}));
      G.store.update("mcp", function () { Object.keys(patch).forEach(function (k) { srv[k] = patch[k]; }); });
      G.audit("mcp.edit", srv.name + ": " + Object.keys(patch).join(", "), "factory", "ok", { category: "integrations", before: before, after: JSON.stringify(patch), entity: { type: "mcp", id: id } });
      return ok("Saved " + srv.name + ".");
    },
    removeMCP: function (id) {
      var srv = G.find.mcp(id); if (!srv) return fail("No such server.");
      var d = G.me("mcp.edit");
      if (!d.allowed) return deny("mcp.remove", srv.name, "factory", d, "web", "integrations");
      G.store.update("mcp", function (l) { l.splice(l.indexOf(srv), 1); });
      G.audit("mcp.remove", srv.name, "factory", "ok", { category: "integrations", entity: { type: "mcp", id: id } });
      return ok(srv.name + " removed.");
    },

    /* ===== notifications and integrations ===== */
    /* route: { event, dest:[{channel,target}], template, cond:{classes[],priority[],hours}, enabled, fields{} } ; routeId null = add */
    saveRoute: function (projectId, routeId, route) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("notify.edit", { project: p.id });
      if (!d.allowed) return deny("notify.edit", p.name + " route", p.id, d, "web", "integrations");
      var before = null, id = routeId;
      G.store.update("projects", function () {
        if (routeId) { var r = p.notifications.find(function (x) { return x.id === routeId; }); before = JSON.stringify(r); Object.assign(r, route); }
        else { id = "NR-" + (p.notifications.reduce(function (m, x) { return Math.max(m, +x.id.slice(3)); }, 0) + 1); p.notifications.push(Object.assign({ id: id, enabled: true, fields: { title: true, repo: true, class: true, priority: true, approvers: true, link: true }, cond: { classes: [], priority: [], hours: "any" } }, route)); }
      });
      G.audit("notify.edit", p.name + " " + id + " (" + (route.event || "") + ")", p.id, "ok", { project: p.id, category: "integrations", before: before, after: JSON.stringify(route), entity: { type: "route", id: p.id + ":" + id } });
      return ok("Route " + id + " saved.", { id: id });
    },
    deleteRoute: function (projectId, routeId) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("notify.edit", { project: p.id });
      if (!d.allowed) return deny("notify.edit", p.name + " " + routeId, p.id, d, "web", "integrations");
      G.store.update("projects", function () { p.notifications = p.notifications.filter(function (x) { return x.id !== routeId; }); });
      G.audit("notify.delete", p.name + " " + routeId, p.id, "ok", { project: p.id, category: "integrations" });
      return ok("Route removed.");
    },
    /* test send to one destination. dest: { channel, target, integration? } (or the round-two form sendTest(projectId, channel, target, event)).
       Resolves the integration instance (a second Slack workspace, a custom type) like G.notify does. */
    sendTest: function (projectId, dest, target, event) {
      var d0 = typeof dest === "object" && dest ? { channel: dest.channel, target: String(dest.target || "").trim(), integration: dest.integration || null } : { channel: dest, target: String(target || "").trim(), integration: null };
      if (typeof dest === "object") event = target;
      var inst = G.integrationFor(d0, projectId);
      var label = (inst ? inst.name : d0.channel) + " → " + d0.target;
      var d = G.me("notify.edit", { project: projectId });
      if (!d.allowed) return deny("notify.test", label, projectId, d, "web", "integrations");
      if (!d0.target) return fail("Give the " + (((inst && G.find.integrationType(inst.type)) || {}).targetLabel || "target").toLowerCase() + " to send the test to.");
      var st = G.integrationState(inst, d0), failed = st.state !== "healthy";
      var dl = { id: "DLV-" + S("nextDelivery"), at: Date.now(), project: projectId, event: event || "test", channel: inst ? inst.type : d0.channel, target: d0.target, integration: inst ? inst.id : null, status: failed ? "failed" : "delivered", attempts: 1, error: st.error, test: true };
      G.store.set("nextDelivery", S("nextDelivery") + 1);
      G.store.update("deliveries", function (l) { l.push(dl); });
      G.audit("notify.test", label + " (" + (event || "test") + ")", projectId, failed ? "failed" : "ok", { project: projectId, category: "integrations", entity: inst ? { type: "integration", id: inst.id } : null });
      return failed ? fail("Test to " + d0.target + " failed: " + st.error + ".", { delivery: dl }) : ok("Test sent to " + d0.target + " on " + (inst ? inst.name : d0.channel) + " (simulated).", { delivery: dl });
    },
    retryDelivery: function (deliveryId) {
      var dl = S("deliveries").find(function (x) { return x.id === deliveryId; }); if (!dl) return fail("No such delivery.");
      var d = G.me("notify.edit", { project: dl.project });
      if (!d.allowed) return deny("delivery.retry", deliveryId, dl.project, d, "web", "integrations");
      var inst = dl.integration ? G.find.integration(dl.integration) : G.integrationFor({ channel: dl.channel, target: dl.target }, dl.project);
      var st = dl.integration && !inst ? { state: "missing", error: "the connection was removed" } : G.integrationState(inst, { channel: dl.channel, target: dl.target });
      var still = st.state !== "healthy";
      G.store.update("deliveries", function () { dl.attempts++; dl.status = still ? "failed" : "delivered"; dl.error = still ? st.error : ""; dl.retriedAt = Date.now(); if (inst) dl.integration = inst.id; });
      G.audit("delivery.retry", deliveryId + " → " + (inst ? inst.name + " " : "") + dl.target + ": " + dl.status, dl.project, still ? "failed" : "ok", { project: dl.project, category: "integrations", entity: inst ? { type: "integration", id: inst.id } : null });
      return still ? fail("Retry failed again: " + st.error + ".") : ok("Delivered on retry.");
    },
    /* channel: github|slack|teams|email|webhook|paging; patch: connected, workspace, tenant, endpoints, schedules, approveFromSlack, ... */
    setIntegration: function (channel, patch) {
      var d = G.me("integration.edit");
      if (!d.allowed) return deny("integration.edit", channel, "factory", d, "web", "integrations");
      var i = S("integrations")[channel]; if (!i) return fail("Unknown integration.");
      var before = JSON.stringify(Object.keys(patch).reduce(function (o, k) { o[k] = i[k]; return o; }, {}));
      G.store.update("integrations", function (x) { Object.keys(patch).forEach(function (k) { x[channel][k] = patch[k]; }); x[channel].lastSync = Date.now(); if (patch.connected === true) x[channel].status = "healthy"; if (patch.connected === false) x[channel].status = "offline"; });
      G.audit("integration.edit", channel + ": " + Object.keys(patch).join(", "), "factory", "ok", { category: "integrations", before: before, after: JSON.stringify(patch) });
      return ok(channel + " updated.");
    },
    testIntegration: function (channel) {
      var i = S("integrations")[channel]; if (!i) return fail("Unknown integration.");
      var dti = G.me("integration.edit");
      if (!dti.allowed) return deny("integration.test", channel, "factory", dti, "web", "integrations");
      G.store.update("integrations", function (x) { x[channel].lastSync = Date.now(); });
      G.audit("integration.test", channel + " test", "factory", i.connected && i.status !== "degraded" ? "ok" : "warn", { category: "integrations" });
      return i.connected ? ok(channel + " answered" + (i.status === "degraded" ? " with errors on one endpoint." : ".")) : fail(channel + " is not connected.");
    },

    /* ===== API keys, API submit, triggers ===== */
    createKey: function (o) {
      var d = G.me("api.keys", { project: o.project });
      if (!d.allowed) return deny("api.key.create", o.name || "key", o.project, d, "web", "api");
      if (!o.name || !o.name.trim()) return fail("Name the key.");
      var secret = "gk_live_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 14);
      var k = { id: "key-" + Date.now().toString(36), name: o.name.trim(), prefix: secret.slice(0, 12), project: o.project, actions: o.actions && o.actions.length ? o.actions : ["wo.submit", "wo.read"], created: Date.now(), lastUsed: null, revoked: false, by: me() };
      G.store.update("apiKeys", function (l) { l.push(k); });
      G.audit("api.key.create", k.name + " (" + k.prefix + "…) on " + o.project + ": " + k.actions.join(", "), o.project, "ok", { project: o.project, category: "api", entity: { type: "apikey", id: k.id } });
      return ok("Key created. Copy it now; it is not shown again.", { key: k, secret: secret });
    },
    revokeKey: function (keyId) {
      var k = S("apiKeys").find(function (x) { return x.id === keyId; }); if (!k) return fail("No such key.");
      var d = G.me("api.keys", { project: k.project });
      if (!d.allowed) return deny("api.key.revoke", k.name, k.project, d, "web", "api");
      G.store.update("apiKeys", function () { k.revoked = true; k.revokedAt = Date.now(); });
      G.audit("api.key.revoke", k.name + " (" + k.prefix + "…)", k.project, "ok", { project: k.project, category: "api", entity: { type: "apikey", id: k.id } });
      return ok(k.name + " revoked.");
    },
    /* simulated POST /v1/projects/{id}/work-orders. body: { repo, title, description, class, priority, idempotency_key }. Returns { ok, status, response } */
    apiSubmit: function (keyId, projectId, body) {
      var k = S("apiKeys").find(function (x) { return x.id === keyId; });
      function log(status) { G.store.update("requestLog", function (l) { l.push({ at: Date.now(), key: keyId, method: "POST", path: "/v1/projects/" + projectId + "/work-orders", status: status, ms: Math.round(40 + Math.random() * 200) }); }); }
      var err = function (status, msg) { log(status); G.audit("api.submit", "POST " + projectId + ": " + status + " " + msg, projectId, "denied", { project: projectId, category: "api", via: "api", actor: keyId }); return { ok: false, status: status, msg: msg, response: { error: { status: status, message: msg } } }; };
      if (!k) return err(401, "Unknown API key");
      if (k.revoked) return err(401, "API key revoked");
      if (k.project !== projectId) return err(403, "Key is scoped to project '" + k.project + "'");
      if (k.actions.indexOf("wo.submit") < 0) return err(403, "Key may not submit work orders");
      body = body || {};
      if (body.idempotency_key) {
        var dup = S("workOrders").find(function (w) { return w.idempotencyKey === body.idempotency_key && w.createdAt > Date.now() - S("apiConfig").idempotencyHours * HOUR; });
        if (dup) { log(200); return { ok: true, status: 200, msg: "Idempotent replay", response: { id: dup.id, status: "existing", class: dup.cls } }; }
      }
      var r = G.ops.submitWO({ project: projectId, repo: body.repo, title: body.title, description: body.description, requestedCls: body["class"] || null, priority: body.priority, source: "api", onBehalfOf: k.by }, "api", keyId);
      if (!r.ok) return err(422, r.msg);
      r.wo.idempotencyKey = body.idempotency_key || null;
      log(201);
      G.store.update("apiKeys", function () { k.lastUsed = Date.now(); });
      return { ok: true, status: 201, msg: r.msg, wo: r.wo, response: { id: r.wo.id, project: projectId, repo: r.wo.repo, status: "intake", class: r.wo.cls, class_confidence: r.wo.clsConfidence, route: G.route(G.find.project(projectId), r.wo.cls), conversation: { state: "awaiting_answers", via: "api", next_question: r.wo.conv.questions[r.wo.conv.qi].text }, links: { self: "/v1/work-orders/" + r.wo.id } } };
    },
    saveTrigger: function (triggerId, patch) {
      var t = triggerId ? G.find.trigger(triggerId) : null;
      var pid = t ? t.project : patch.project;
      var d = G.me("triggers.edit", { project: pid });
      if (!d.allowed) return deny("trigger.edit", t ? t.name : patch.name || "trigger", pid, d, "web", "integrations");
      if (!t) {
        t = Object.assign({ id: "TR-" + (S("triggers").length + 1), enabled: true, who: "org", reply: "", dedupe: true, repos: "ready", runs: [], labelMap: {} }, patch);
        G.store.update("triggers", function (l) { l.push(t); });
        G.audit("trigger.create", t.name, pid, "ok", { project: pid, category: "integrations", entity: { type: "trigger", id: t.id } });
        return ok("Trigger " + t.name + " created.", { trigger: t });
      }
      var before = JSON.stringify(Object.keys(patch).reduce(function (o, k) { o[k] = t[k]; return o; }, {}));
      G.store.update("triggers", function () { Object.keys(patch).forEach(function (k) { t[k] = patch[k]; }); });
      G.audit("trigger.edit", t.name + ": " + Object.keys(patch).join(", "), pid, "ok", { project: pid, category: "integrations", before: before, after: JSON.stringify(patch), entity: { type: "trigger", id: t.id } });
      return ok("Saved " + t.name + ".");
    },
    /* simulate an incoming event for a trigger. input: { repo, title, labels[], author } */
    simulateTrigger: function (triggerId, input) {
      var t = G.find.trigger(triggerId); if (!t) return fail("No such trigger.");
      var d = G.me("triggers.edit", { project: t.project });
      if (!d.allowed) return deny("trigger.simulate", t.name, t.project, d, "web", "integrations");
      input = input || {};
      /* the trigger's real source: an integration instance (GitHub, GitLab, Jira-style, CI, custom) or "schedule" */
      var src = t.source && t.source !== "schedule" ? G.find.integration(t.source) : null;
      var srcType = t.type === "schedule" || t.source === "schedule" ? "schedule" : src ? src.type : "github";
      var srcName = src ? src.name : srcType === "schedule" ? "Schedule" : "GitHub";
      if (src && (!src.connected || src.status === "offline")) {
        var off = { at: Date.now(), source: srcName, integration: src.id, outcome: "refused", wo: null };
        G.store.update("triggers", function () { t.runs.push(off); });
        G.audit("trigger.run", t.name + ": refused (" + src.name + " is offline)", t.project, "denied", { project: t.project, category: "integrations", via: srcType, actor: t.id, entity: { type: "trigger", id: t.id } });
        return { ok: false, msg: src.name + " is offline, so the trigger cannot receive events.", run: off };
      }
      var ref = srcType === "jira" ? (input.key || "ACME-" + (300 + Math.floor(Math.random() * 99))) : srcType === "linear" ? "GRW-" + (40 + Math.floor(Math.random() * 50)) : (input.repo ? (src && src.config && (src.config.org || src.config.group) || "acme") + "/" + input.repo : "") + (t.type === "issue" ? "#" + (900 + Math.floor(Math.random() * 99)) : "");
      var run = { at: Date.now(), source: srcName + (ref ? " " + ref : ""), integration: src ? src.id : null, outcome: "", wo: null };
      function done(outcome, msg, wo) { run.outcome = outcome; run.wo = wo || null; G.store.update("triggers", function () { t.runs.push(run); }); G.audit("trigger.run", t.name + " via " + srcName + ": " + outcome + (wo ? " " + wo : "") + (msg ? " (" + msg + ")" : ""), t.project, outcome === "created" ? "ok" : outcome === "refused" ? "denied" : "ok", { project: t.project, category: "integrations", via: srcType, actor: t.id, entity: { type: "trigger", id: t.id } }); return { ok: outcome === "created", msg: msg, run: run }; }
      if (!t.enabled) return done("skipped", "Trigger is disabled");
      if (t.type === "issue" && (input.labels || []).indexOf(t.label) < 0) return done("skipped", "Issue has no '" + t.label + "' label");
      if (t.who === "org" && input.author && !/@acme\.dev$|-acme$/.test(input.author)) return done("refused", "Author is not an org member");
      var title = input.title || (t.type === "schedule" ? "Weekly dependency updates" : t.type === "ci" ? "Main is red: fix failing ci/test" : "Issue from " + srcName);
      if (t.dedupe && S("workOrders").some(function (w) { return w.project === t.project && w.title === title && w.state !== "done"; })) return done("deduped", "An open work order already has this title");
      var cls = t.cls || null;
      (input.labels || []).forEach(function (l) { if (t.labelMap && t.labelMap[l]) cls = t.labelMap[l]; });
      var repo = input.repo || (S("repos").find(function (r) { return r.project === t.project && r.onboarding.stage === "ready"; }) || {}).id;
      var r = G.ops.submitWO({ project: t.project, repo: repo, title: title, description: (input.body || "Created by trigger " + t.name + " from " + srcName + (ref ? " " + ref : "") + ".") + (t.type === "ci" ? " Needs a person to confirm the hotfix." : ""), requestedCls: cls, source: srcType, onBehalfOf: G.find.project(t.project).owner }, srcType, t.id);
      if (!r.ok) return done("refused", r.msg);
      r.wo.sourceIntegration = src ? src.id : null; r.wo.sourceRef = ref || null; r.wo.trigger = t.id;
      if (r.wo.request) { r.wo.request.source = srcType; r.wo.request.integration = src ? src.id : null; r.wo.request.ref = ref || null; r.wo.request.trigger = t.id; }
      if (t.type === "ci") G.ops.raiseQuestionAtIntake(r.wo.id, "CI on main is red. Confirm this hotfix or decline it.");
      return done("created", t.reply ? t.reply.replace("{wo}", r.wo.id) : "", r.wo.id);
    },
    raiseQuestionAtIntake: function (woId, text) {
      var wo = G.find.wo(woId); if (!wo) return fail("No such work order.");
      wo.conv.messages.push({ from: "ag-intake", at: Date.now(), text: text });
      wo.bay = "person"; wo.bayFrom = "intake"; wo.state = "parked"; wo.bayReason = text; wo.bayAt = Date.now();
      touch();
      return ok("Moved to Needs a person.");
    },
    setApiConfig: function (patch) {
      var d = G.me("integration.edit");
      if (!d.allowed) return deny("api.config", "API config", "factory", d, "web", "api");
      var before = JSON.stringify(S("apiConfig"));
      G.store.update("apiConfig", function (c) { Object.keys(patch).forEach(function (k) { c[k] = patch[k]; }); });
      G.audit("api.config", Object.keys(patch).join(", "), "factory", "ok", { category: "api", before: before, after: JSON.stringify(S("apiConfig")) });
      return ok("API settings saved.");
    },

    /* ===== security ===== */
    setSecurity: function (path, value) {
      var d = G.me("security.manage");
      if (!d.allowed) return deny("security.edit", path, "factory", d, "web", "auth");
      var parts = path.split("."), obj = S("security");
      for (var i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      var before = JSON.stringify(obj[parts[parts.length - 1]]);
      G.store.update("security", function () { obj[parts[parts.length - 1]] = value; });
      G.audit("security.edit", path, "factory", "ok", { category: "auth", before: before, after: JSON.stringify(value) });
      return ok("Saved " + path + ".");
    },

    /* ===== access: matrix, policies, freezes ===== */
    setMatrix: function (roleId, actionId, on) {
      var d = G.me("policy.edit");
      var ro = G.find.role(roleId), act = G.find.action(actionId);
      if (!ro || !act) return fail("Unknown role or action.");
      if (!d.allowed) return deny("policy.matrix", ro.name + " · " + actionId, "factory", d, "web", "access");
      if (!on && roleId === "factory_admin" && ["policy.edit", "people.manage", "restore.factory", "security.manage"].indexOf(actionId) >= 0) return fail("Factory Admins always keep '" + act.name.toLowerCase() + "' so nobody is locked out.");
      var before = !!S("matrix")[roleId][actionId];
      G.store.update("matrix", function (m) { m[roleId][actionId] = !!on; });
      G.audit("policy.matrix", ro.name + (on ? " may " : " may not ") + act.name.toLowerCase(), "factory", "ok", { category: "access", before: before, after: !!on, entity: { type: "matrix", id: roleId + ":" + actionId } });
      return ok(ro.name + (on ? " can now " : " can no longer ") + act.name.toLowerCase() + ".");
    },
    /* data: { name, effect, roles[], actions[], where{}, when{days,from,to}|null, oncallOnly, extend? } ; id null = create */
    savePolicy: function (policyId, data) {
      var d = G.me("policy.edit");
      if (!d.allowed) return deny("policy.edit", (data && data.name) || policyId, "factory", d, "web", "access");
      if (!data.name || !data.name.trim()) return fail("Name the policy.");
      if (!data.actions || !data.actions.length) return fail("Pick at least one action.");
      if (!data.roles || !data.roles.length) return fail("Pick at least one role.");
      if (data.when && (!data.when.days.length || (data.when.to !== "24:00" && data.when.from >= data.when.to))) return fail("Check the days and times.");
      var list = S("policies"), p = policyId ? list.find(function (x) { return x.id === policyId; }) : null;
      var before = p ? G.policyText.sentence(p) : null, id = p ? p.id : "POL-" + (list.reduce(function (m, x) { return Math.max(m, +x.id.slice(4) || 0); }, 100) + 1);
      G.store.update("policies", function (l) {
        if (p) Object.keys(data).forEach(function (k) { p[k] = JSON.parse(JSON.stringify(data[k])); });
        else { p = JSON.parse(JSON.stringify(data)); p.id = id; p.enabled = data.enabled !== false; p.custom = true; l.push(p); }
      });
      G.audit(before ? "policy.edit" : "policy.create", id + " " + p.name, "factory", "ok", { category: "access", before: before, after: G.policyText.sentence(p), entity: { type: "policy", id: id } });
      return ok(id + (before ? " saved." : " added."), { id: id });
    },
    setPolicyEnabled: function (policyId, on) {
      var p = S("policies").find(function (x) { return x.id === policyId; }); if (!p) return fail("No such policy.");
      var d = G.me("policy.edit");
      if (!d.allowed) return deny("policy.edit", p.id, "factory", d, "web", "access");
      G.store.update("policies", function () { p.enabled = !!on; });
      G.audit("policy.edit", p.id + (on ? " enabled" : " disabled"), "factory", "ok", { category: "access", before: !on, after: !!on, entity: { type: "policy", id: p.id } });
      return ok(p.id + (on ? " enabled." : " disabled. It no longer affects decisions."));
    },
    deletePolicy: function (policyId) {
      var p = S("policies").find(function (x) { return x.id === policyId; }); if (!p) return fail("No such policy.");
      var d = G.me("policy.edit");
      if (!d.allowed) return deny("policy.delete", p.id, "factory", d, "web", "access");
      var before = G.policyText.sentence(p);
      G.store.update("policies", function (l) { l.splice(l.indexOf(p), 1); });
      G.audit("policy.delete", p.id + " " + p.name, "factory", "ok", { category: "access", before: before, after: "deleted", entity: { type: "policy", id: p.id } });
      return ok(p.id + " deleted.");
    },
    /* f: { name, repos: "all" | [repoId], from, to } */
    saveFreeze: function (f) {
      var d = G.me("policy.edit");
      if (!d.allowed) return deny("freeze.create", f.name || "freeze", "factory", d, "web", "access");
      if (!f.name || !f.name.trim()) return fail("Name the freeze.");
      if (!(f.to > f.from)) return fail("The end must be after the start.");
      var id = "FRZ-" + String(S("freezes").reduce(function (m, x) { return Math.max(m, +x.id.slice(4) || 0); }, 0) + 1).padStart(2, "0");
      var rec = { id: id, name: f.name.trim(), repos: f.repos === "all" ? "all" : f.repos.slice(), from: f.from, to: f.to, by: me() };
      G.store.update("freezes", function (l) { l.push(rec); });
      var where = rec.repos === "all" ? "factory" : rec.repos[0];
      G.audit("freeze.create", id + " " + rec.name + " · " + (rec.repos === "all" ? "all repos" : rec.repos.join(", ")), where, "ok", { category: "access", after: G.fmt.stamp(rec.from) + " to " + G.fmt.stamp(rec.to), entity: { type: "freeze", id: id } });
      return ok(id + " scheduled.", { freeze: rec });
    },
    endFreeze: function (freezeId) {
      var f = S("freezes").find(function (x) { return x.id === freezeId; }); if (!f) return fail("No such freeze.");
      var d = G.me("policy.edit");
      if (!d.allowed) return deny("freeze.end", f.id, "factory", d, "web", "access");
      var now = Date.now(), active = now >= f.from && now < f.to, before = G.fmt.stamp(f.to);
      if (now >= f.to) return fail(f.id + " has already ended.");
      G.store.update("freezes", function () { if (active) f.to = now; else { f.from = now - 1000; f.to = now - 500; } });
      G.audit("freeze.end", f.id + " " + f.name + (active ? " ended early" : " cancelled"), f.repos === "all" ? "factory" : f.repos[0], "ok", { category: "access", before: before, after: G.fmt.stamp(now), entity: { type: "freeze", id: f.id } });
      return ok(f.id + (active ? " ended." : " cancelled."));
    },

    /* ===== people ===== */
    setFactoryRole: function (personId, roleId, add) {
      var p = G.find.person(personId); if (!p) return fail("No such person.");
      var ro = G.find.role(roleId);
      if (!ro || ro.level !== "factory") return fail("Pick a factory-level role (Factory Admin, Auditor or a custom factory role).");
      var d = G.me("people.manage");
      if (!d.allowed) return deny("role." + (add ? "grant" : "revoke"), p.name + " " + roleId, "factory", d, "web", "access");
      if (!add && roleId === "factory_admin" && S("people").filter(function (x) { return x.status === "active" && x.roles.some(function (g) { return g.role === "factory_admin"; }); }).length <= 1) return fail("Keep at least one active Factory Admin.");
      if (!add && personId === me() && roleId === "factory_admin") return fail("You cannot remove your own Factory Admin role. Ask another admin.");
      var before = p.roles.filter(function (g) { return g.scope === "factory"; }).map(function (g) { return g.role; }).join(",") || "none";
      G.store.update("people", function () {
        p.roles = p.roles.filter(function (g) { return !(g.scope === "factory" && g.role === roleId); });
        if (add) p.roles.push({ role: roleId, scope: "factory" });
      });
      var after = p.roles.filter(function (g) { return g.scope === "factory"; }).map(function (g) { return g.role; }).join(",") || "none";
      G.audit(add ? "role.grant" : "role.revoke", p.name + ": factory " + G.find.role(roleId).name, "factory", "ok", { category: "access", before: before, after: after, entity: { type: "person", id: p.id } });
      return ok((add ? "Granted " : "Removed ") + G.find.role(roleId).name + (add ? " to " : " from ") + p.name + ".");
    },
    setTeams: function (personId, teams) {
      var p = G.find.person(personId); if (!p) return fail("No such person.");
      var d = G.me("people.manage");
      if (!d.allowed) return deny("people.teams", p.name, "factory", d, "web", "access");
      var before = p.teams.join(",");
      G.store.update("people", function () { p.teams = teams.slice(); });
      G.audit("people.teams", p.name + ": teams", "factory", "ok", { category: "access", before: before, after: teams.join(","), entity: { type: "person", id: p.id } });
      return ok("Teams saved for " + p.name + ".");
    },
    setOncall: function (personId, on) {
      var p = G.find.person(personId); if (!p) return fail("No such person.");
      var d = G.me("people.manage");
      if (!d.allowed && personId !== me()) return deny("people.oncall", p.name, "factory", d, "web", "access");
      G.store.update("people", function () { p.oncall = !!on; });
      G.audit("people.oncall", p.name + (on ? " on call" : " off call"), "factory", "ok", { category: "access", before: !on, after: !!on, entity: { type: "person", id: p.id } });
      return ok(p.name + (on ? " is on call. On-call policies such as POL-106 now apply." : " is off call."));
    },
    acceptInvite: function (personId) {
      var p = G.find.person(personId); if (!p) return fail("No such person.");
      var d = G.me("people.manage");
      if (!d.allowed) return deny("people.accept", p.name, "factory", d, "web", "access");
      if (p.status === "active") return fail(p.name + " is already active.");
      G.store.update("people", function () { p.status = "active"; if (p.title === "Invited") p.title = p.roles[0] ? G.find.role(p.roles[0].role).name : "Member"; });
      G.audit("people.accept", p.name + " accepted the invite (simulated)", "factory", "ok", { category: "access", before: "invited", after: "active", entity: { type: "person", id: p.id } });
      return ok(p.name + " is active.");
    },
    /* away: null | { from, to, delegate } ; allowed with approvers.edit in projectId, people.manage, or for yourself */
    setAway: function (personId, away, projectId) {
      var p = G.find.person(personId); if (!p) return fail("No such person.");
      var d = projectId ? G.me("approvers.edit", { project: projectId }) : G.me("people.manage");
      if (!d.allowed && personId !== me()) return deny("approvers.delegate", p.name, projectId || "factory", d, "web", "approvals");
      if (away && (!G.find.person(away.delegate) || away.delegate === personId)) return fail("Pick a delegate other than " + p.name + ".");
      var before = p.away ? G.actorName(p.away.delegate) : "present";
      G.store.update("people", function () { p.away = away ? { from: away.from || Date.now(), to: away.to, delegate: away.delegate } : null; });
      G.audit("approvers.delegate", p.name + (away ? " away until " + G.fmt.istDate(away.to) + ", delegate " + G.actorName(away.delegate) : " back, delegation cleared"), projectId || "factory", "ok", { project: projectId, category: "approvals", before: before, after: away ? G.actorName(away.delegate) : "present", entity: { type: "person", id: p.id } });
      return ok(away ? p.name + " is away; " + G.actorName(away.delegate) + " approves instead." : p.name + " is back.");
    },

    /* ===== models and routing ===== */
    /* patch: connected, health, latency, keyMask, region, endpoint, product, budget */
    setVendor: function (vendorId, patch, action) {
      var v = G.find.vendor(vendorId); if (!v) return fail("No such vendor.");
      var d = G.me("model.edit");
      if (!d.allowed) return deny(action || "vendor.update", v.name, "factory", d, "web", "agents");
      if (patch.connected === false && v.models.some(function (m) { return m.id === S("routing").defaultModel; })) return fail("The factory default model is on " + v.name + ". Pick another default first.");
      var keys = Object.keys(patch);
      var before = JSON.stringify(keys.reduce(function (o, k) { o[k] = v[k]; return o; }, {}));
      G.store.update("vendors", function () {
        keys.forEach(function (k) { v[k] = patch[k]; });
        if (patch.connected === true && v.health === "offline") { v.health = "healthy"; v.latency = v.id === "local" ? 240 : 900; if (v.id === "local") v.models.forEach(function (m) { m.enabled = true; }); }
        if (patch.connected === false) { v.health = "offline"; v.latency = 0; v.keyMask = ""; }
      });
      G.audit(action || (patch.connected === true ? "vendor.connect" : patch.connected === false ? "vendor.disconnect" : "vendor.update"), v.name + ": " + keys.join(", "), "factory", "ok", { category: "agents", before: before, after: JSON.stringify(patch).replace(/"keyMask":"[^"]*"/, '"keyMask":"••••"'), entity: { type: "vendor", id: v.id } });
      return ok(v.name + (patch.connected === true ? " connected (simulated)." : patch.connected === false ? " disconnected." : " updated."));
    },
    setModelEnabled: function (modelId, on) {
      var m = G.find.model(modelId); if (!m) return fail("No such model.");
      var d = G.me("model.edit");
      if (!d.allowed) return deny("model.toggle", modelId, "factory", d, "web", "agents");
      if (!on && S("routing").defaultModel === modelId) return fail("This is the factory default model. Pick another default first.");
      var prim = S("agents").filter(function (a) { return a.model === modelId; });
      if (!on && prim.length) return fail("Primary model of " + prim.map(function (a) { return a.name; }).join(", ") + ". Change those agents first.");
      G.store.update("vendors", function (vs) { vs.forEach(function (v) { v.models.forEach(function (x) { if (x.id === modelId) x.enabled = !!on; }); }); });
      G.audit("model.toggle", modelId + (on ? " enabled" : " disabled"), "factory", "ok", { category: "agents", before: !on, after: !!on, entity: { type: "model", id: modelId } });
      return ok(m.name + (on ? " enabled." : " disabled."));
    },
    /* next: full routing object { defaultModel, overrides, fallback, rules } */
    setRouting: function (next, label) {
      var d = G.me("model.edit");
      if (!d.allowed) return deny("routing.edit", label || "routing", "factory", d, "web", "agents");
      if (!next.fallback || !next.fallback.length) return fail("Keep at least one fallback model.");
      if (!G.find.model(next.defaultModel)) return fail("Unknown default model.");
      var before = JSON.stringify(S("routing"));
      G.store.set("routing", JSON.parse(JSON.stringify(next)));
      G.audit("routing.edit", label || "Routing policy", "factory", "ok", { category: "agents", before: before, after: JSON.stringify(next), entity: { type: "routing", id: "factory" } });
      return ok((label || "Routing") + " saved.");
    },

    /* ===== instructions, skills scope, evals ===== */
    saveInstructions: function (text) {
      var d = G.me("agent.edit");
      if (!d.allowed) return deny("agent.instructions", "Factory base instructions", "factory", d, "web", "agents");
      if (!text || text.trim().length < 20) return fail("Base instructions need at least 20 characters.");
      var ins = S("instructions"), before = ins.base;
      G.store.update("instructions", function (x) { x.base = text.trim(); x.baseVersion++; });
      G.audit("agent.instructions", "Factory base instructions v" + S("instructions").baseVersion, "factory", "ok", { category: "agents", before: before, after: text.trim(), entity: { type: "instructions", id: "base" } });
      return ok("Factory base saved as v" + S("instructions").baseVersion + ".");
    },
    setSkillProjects: function (skillId, projects) {
      var sk = G.find.skill(skillId); if (!sk) return fail("No such skill.");
      var d = G.me("skill.edit");
      if (!d.allowed) return deny("skill.scope", sk.name, "factory", d, "web", "agents");
      var before = sk.projects === "all" ? "all" : sk.projects.join(",");
      G.store.update("skills", function () { sk.projects = projects === "all" ? "all" : projects.slice(); });
      var after = projects === "all" ? "all" : projects.join(",");
      G.audit("skill.scope", sk.name + ": " + (projects === "all" ? "all projects" : projects.length + " projects"), "factory", "ok", { category: "agents", before: before, after: after, entity: { type: "skill", id: sk.id } });
      return ok(sk.name + ": enabled on " + (projects === "all" ? "all projects" : projects.length ? projects.map(function (p) { return (G.find.project(p) || { name: p }).name; }).join(", ") : "no projects") + ".");
    },
    /* record a (simulated) suite run. results: [{ caseId, pass, reason, ms }] */
    runSuite: function (agentId, suiteId, version, model, results) {
      var ag = G.find.agent(agentId), su = G.find.suite(suiteId);
      if (!ag || !su) return fail("Pick an agent and suite.");
      var d = G.me("eval.run");
      if (!d.allowed) return deny("eval.run", su.id + " on " + ag.name, "factory", d, "web", "agents");
      var ver = ag.versions.find(function (v) { return v.v === version; }); if (!ver) return fail("No such version.");
      if (!results || !results.length) return fail("No results.");
      var score = results.filter(function (x) { return x.pass; }).length / results.length;
      var st = S();
      var prev = st.evalRuns.filter(function (r) { return r.suite === su.id && r.version === ver.v; }).pop();
      var liveVer = ag.versions.find(function (v) { return v.live; });
      var livePrev = liveVer ? st.evalRuns.filter(function (r) { return r.suite === su.id && r.version === liveVer.v; }).pop() : null;
      var run = { id: "RUN-" + st.nextRun, suite: su.id, agent: ag.id, version: ver.v, model: model, at: Date.now(), score: score, results: results, by: me(), cost: +(2 + Math.random() * 20).toFixed(2), simulated: true };
      G.store.set("nextRun", st.nextRun + 1);
      G.store.update("evalRuns", function (l) { l.push(run); });
      G.store.update("agents", function () { ver.suiteScore = score; if (ver.live && model === ag.model) ag.evalScore = score; ag.spark = ag.spark.slice(1).concat([score]); });
      G.store.update("scorecards", function (sc) {
        var c = sc[ag.id]; if (!c) return;
        var t = c.trend.success; t[t.length - 1] = +(t[t.length - 1] * 0.6 + score * 0.4).toFixed(3);
        c.taskSuccess = t[t.length - 1];
      });
      var pass = score >= su.threshold;
      var base = livePrev && livePrev.id !== run.id ? livePrev : prev;
      var regression = !pass || (base && score < base.score - 0.03);
      G.audit("eval.run", su.id + " on " + ag.name + " " + ver.v + " (" + model + "): " + G.fmt.pct(score) + (pass ? " passes" : " below gate"), "factory", regression ? "regression" : "ok", { category: "agents", before: prev ? G.fmt.pct(prev.score) : null, after: G.fmt.pct(score), entity: { type: "agent", id: ag.id } });
      if (regression) {
        var projs = (ag.projects === "all" ? st.projects : ag.projects.map(G.find.project).filter(Boolean)).filter(function (p) { return p.status !== "archived" && (!ag.station || p.flow.stations[ag.station].enabled); });
        projs.forEach(function (p) { G.notify(p.id, "eval.regression", { agent: ag.id }); });
      }
      return ok(run.id + ": " + G.fmt.pct(score) + " on " + su.id + ". " + ag.name + " " + ver.v + " is " + (pass ? "eligible" : "blocked") + " for the floor.", { run: run, regression: regression, pass: pass });
    },

    /* ===== flow config extras ===== */
    setGateMode: function (projectId, gateId, mode) {
      var p = G.find.project(projectId), g = G.gateDef(gateId);
      if (!p || !g) return fail("Unknown project or gate.");
      if (["auto", "human", "mixed"].indexOf(mode) < 0) return fail("Mode is auto, human or mixed.");
      if (gateId === "G0G1" && mode !== "human") return fail("G0+G1 is always confirmed by a person.");
      if (gateId === "G6" && mode === "auto") return fail("Release confirmation always needs a person.");
      var d = G.me("project.config", { project: p.id });
      if (!d.allowed) return deny("flow.gate", p.name + " " + g.label, p.id, d, "web", "config");
      var before = G.gateKind(p, gateId);
      G.store.update("projects", function () {
        p.flow.gates[gateId].mode = mode;
        var r = p.approvers[gateId];
        if (mode !== "auto" && r && !r.roles.length && !r.people.length) { r.roles = ["line_lead", "project_admin"]; r.required = 1; }
      });
      G.audit("flow.gate", p.name + ": " + g.label + " mode", p.id, "ok", { project: p.id, category: "config", before: before, after: mode, entity: { type: "gaterule", id: p.id + ":" + gateId } });
      return ok(g.label + " is now " + (mode === "auto" ? "automatic" : mode === "mixed" ? "checks, then a person" : "a human approval") + " on " + p.name + ".");
    },
    unarchiveProject: function (projectId) {
      var p = G.find.project(projectId); if (!p) return fail("No such project.");
      var d = G.me("project.archive", { project: p.id });
      if (!d.allowed) return deny("project.unarchive", p.name, p.id, d, "web", "config");
      if (p.status !== "archived") return fail(p.name + " is not archived.");
      var ready = S("repos").filter(function (r) { return r.project === p.id; });
      var next = ready.length && ready.every(function (r) { return r.onboarding.stage === "ready"; }) ? "active" : ready.length ? "onboarding" : "new";
      G.store.update("projects", function () { p.status = next; });
      G.audit("project.unarchive", p.name, p.id, "ok", { project: p.id, category: "config", before: "archived", after: next, entity: { type: "project", id: p.id } });
      return ok(p.name + " is back (" + next + ").");
    },
    verifyNow: function (repoId) {
      var r = G.find.repo(repoId); if (!r) return fail("No such repo.");
      var d = G.me("onboarding.manage", { project: r.project });
      if (!d.allowed) return deny("onboarding.verify", r.name, r.id, d, "web", "onboarding");
      var o = r.onboarding;
      if (["pr_merged", "verified"].indexOf(o.stage) < 0) return fail("Verify runs after the onboarding PR is merged.");
      G.store.update("repos", function () {
        if (o.stage === "pr_merged") { o.stage = "verified"; o.timeline.push({ at: Date.now(), who: "ag-onboard", text: "Verified on request: a dry-run work order built and passed checks." }); }
        o.stage = "ready"; o.readyAt = Date.now(); o.timeline.push({ at: Date.now(), who: "ag-onboard", text: "Ready. Work orders can be submitted." });
      });
      var p = G.find.project(r.project);
      if (S("repos").filter(function (x) { return x.project === p.id; }).every(function (x) { return x.onboarding.stage === "ready"; }) && p.status !== "active" && p.status !== "archived") G.store.update("projects", function () { p.status = "active"; });
      G.audit("onboarding.ready", r.name + " (verified on request)", r.id, "ok", { project: r.project, category: "onboarding", entity: { type: "repo", id: r.id } });
      return ok(r.name + " is ready.");
    }

  };

  /* Can this work order be moved to target (station id or bay id) by the viewer? -> { allowed, reason, kind } */
  G.moveCheck = function (wo, target) {
    var project = proj(wo);
    var stop = G.stopState(wo.project, wo.repo);
    if (stop) return { allowed: false, reason: stop.reason };
    if (wo.state === "killed" || wo.state === "done") return { allowed: false, reason: wo.id + " is " + wo.state + "." };
    if (G.bayDef(target)) {
      if (project.flow.bays && project.flow.bays.indexOf(target) < 0) return { allowed: false, reason: G.bayDef(target).name + " is not a bay in " + project.name + "." };
      if (wo.bay === target) return { allowed: false, reason: "Already in " + G.bayDef(target).name + "." };
      var perm = target === "declined" ? "wo.decline" : "wo.park";
      var d = G.me(perm, { project: wo.project });
      if (!d.allowed) return { allowed: false, reason: (d.needs ? d.needs + ". " : "") + d.reason };
      if (target === "queue" && G.STATIONS[wo.station].id !== "build" && G.nextStationId(project, wo) !== "build") return { allowed: false, reason: "Only work about to build can wait in the Queue." };
      return { allowed: true, kind: "park", reason: "Moves to " + G.bayDef(target).name + " with a reason." };
    }
    var route = G.route(project, wo.cls);
    if (route.indexOf(target) < 0) return { allowed: false, reason: G.find.station(target).name + " is not on the " + G.find.cls(wo.cls).name + " route" + (project.flow.stations[target] && project.flow.stations[target].enabled ? "" : " (station is off or absent in this project)") + "." };
    var cur = G.STATIONS[wo.station].id;
    if (wo.bay) {
      if (target !== (wo.bayFrom || cur)) return { allowed: false, reason: "From " + G.bayDef(wo.bay).name + " it can only return to " + G.find.station(wo.bayFrom || cur).name + "." };
      var du = G.me("wo.park", { project: wo.project });
      return du.allowed ? { allowed: true, kind: "unpark", reason: "Returns to " + G.find.station(target).name + "." } : { allowed: false, reason: (du.needs ? du.needs + ". " : "") + du.reason };
    }
    var ci = route.indexOf(cur), ti = route.indexOf(target);
    if (ti === ci) return { allowed: false, reason: "Already at " + G.find.station(target).name + "." };
    if (ti < ci) { var db = G.me("wo.sendback", { project: wo.project }); return db.allowed ? { allowed: true, kind: "back", reason: "Sends back to " + G.find.station(target).name + "." } : { allowed: false, reason: (db.needs ? db.needs + ". " : "") + db.reason }; }
    if (ti > ci + 1) return { allowed: false, reason: "Work moves one station at a time; " + G.find.station(route[ci + 1]).name + " comes first." };
    var g = G.gateForWO(project, wo);
    if (wo.state === "running") return { allowed: false, reason: "Still running at " + G.find.station(cur).name + "; it moves when the station finishes" + (g ? " and " + g.label + " passes" : "") + "." };
    if (!g) return { allowed: false, reason: "It moves automatically when the station finishes." };
    if (G.gateKind(project, g.id) === "auto") return { allowed: false, reason: g.label + " is automatic in this project; it passes when its checks pass." };
    var dg = G.gateDecision(G.viewerId(), wo, g.id);
    if (!dg.allowed) return { allowed: false, reason: g.label + ": " + (dg.needs ? dg.needs + ". " : "") + dg.reason };
    return { allowed: true, kind: "approve", reason: "Approves " + g.label + " " + g.name + "." };
  };

  G.agentEligibility = function (agent, ver) {
    var suite = G.find.suite(agent.suite);
    if (!ver || !suite) return { ok: false, text: "No suite", score: null };
    var runs = S("evalRuns").filter(function (r) { return r.agent === agent.id && r.version === ver.v && r.suite === suite.id; });
    var last = runs[runs.length - 1];
    if (!last) return { ok: false, text: "No run of " + suite.id + " yet", score: null };
    return { ok: last.score >= suite.threshold, text: (last.score >= suite.threshold ? "Eligible" : "Blocked") + ": " + G.fmt.pct(last.score) + " vs " + G.fmt.pct(suite.threshold) + " on " + suite.id, score: last.score, run: last.id };
  };
  G.woTotals = function (wo) { var t = 0, c = 0; wo.history.forEach(function (e) { t += e.tokens; c += e.cost; }); return { tokens: t, cost: c }; };

  /* ---------- simulation tick ---------- */
  var timer = null;
  function tick() {
    var st = S();
    if (st.prefs.paused || !st.session || st.factory.killed) return;
    var changed = false;
    st.workOrders.forEach(function (wo) {
      if (wo.state !== "running" || wo.heldByKill) return;
      var p = G.find.project(wo.project);
      if (!p || p.killed || p.halted || p.status === "archived") return;
      var r = G.find.repo(wo.repo); if (r && r.halted) return;
      var e = openEntry(wo); if (!e) return;
      wo.progress = Math.min(100, wo.progress + 9 + Math.random() * 16);
      var tk = Math.round((2000 + Math.random() * 9000) * (e.station === "build" ? 2.5 : 1));
      e.tokens += tk; e.cost = +(e.cost + G.costFor(e.model, tk)).toFixed(4);
      p.budget.mtd += G.costFor(e.model, tk);
      if (e.station === "build") { wo.diff.plus += Math.round(Math.random() * 30); wo.diff.minus += Math.round(Math.random() * 10); wo.diff.files = Math.max(1, Math.round(wo.diff.plus / 60)); }
      changed = true;
      if (wo.progress >= 100) {
        if (["spec", "design", "plan"].indexOf(e.station) >= 0 && Math.random() < 0.04) { G.ops.raiseQuestion(wo.id, G.find.station(e.station).name + ": the brief does not say whether to keep the old behaviour behind a flag. Keep it?"); return; }
        if (e.station === "verify") { wo.tests.passed += 40 + Math.round(Math.random() * 200); wo.tests.added += 1 + Math.round(Math.random() * 5); }
        e.endedAt = Date.now(); e.outcome = "passed";
        arriveAtGate(wo);
      }
    });
    st.projects.forEach(function (p) {
      if (p.killed || p.halted) return;
      var queue = st.workOrders.filter(function (w) { return w.project === p.id && w.bay === "queue" && !w.heldByKill; }).sort(function (a, b) { return a.bayAt - b.bayAt; });
      queue.forEach(function (w) {
        var slot = freeSlot(p); if (!slot) return;
        w.bay = null; w.bayFrom = null; w.slot = slot; w.state = "running"; w.progress = 0; w.station = G.stationIndex("build");
        w.history.push({ station: "build", agent: "ag-build", model: modelFor(p, "build", G.find.agent("ag-build")), startedAt: Date.now(), endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" });
        w.log.push({ at: Date.now(), who: "ag-build", text: "Took coding slot " + slot + "." });
        changed = true;
      });
    });
    st.repos.forEach(function (r) {
      var o = r.onboarding, p = G.find.project(r.project);
      if (!p || p.killed || Math.random() > 0.35) return;
      if (o.stage === "connected") { G.assessRepo(r); o.stage = "assessed"; o.timeline.push({ at: Date.now(), who: "ag-onboard", text: "Assessment finished: " + o.findings.filter(function (f) { return !f.ok; }).length + " gaps." }); G.audit("onboarding.assess", r.name, r.id, "ok", { project: r.project, actor: "ag-onboard", via: "agent", entity: { type: "repo", id: r.id } }); changed = true; }
      else if (o.stage === "assessed") {
        var manual = o.findings.filter(function (f) { return !f.ok && f.manual; });
        if (manual.length) { o.stage = "person"; o.blocker = manual[0].fix; o.timeline.push({ at: Date.now(), who: "ag-onboard", text: "Needs a person: " + manual[0].fix }); }
        else G.ops.openOnboardingPR(r.id, "ag-onboard");
        changed = true;
      }
      else if (o.stage === "pr_opened") { o.stage = "pr_checks"; o.pr.checks = "running"; o.timeline.push({ at: Date.now(), who: "ci", text: "Checks started on PR #" + o.pr.number + "." }); changed = true; }
      else if (o.stage === "pr_checks" && o.pr.checks === "running" && Math.random() < 0.15) {
        o.pr.checks = "red"; o.stage = "failed"; o.blocker = "Check 'gantry-ci / build' failed on PR #" + o.pr.number + ": the pinned toolchain is not available on the CI runner.";
        o.timeline.push({ at: Date.now(), who: "ci", text: "Checks failed on PR #" + o.pr.number + ". Re-run the assessment or request changes." });
        G.audit("onboarding.checks", r.name + "#" + o.pr.number + " checks failed", r.id, "failed", { project: r.project, actor: "ag-onboard", via: "agent", entity: { type: "repo", id: r.id } });
        G.notify(r.project, "onboarding.pr", { repo: r.id }); changed = true;
      }
      else if (o.stage === "pr_checks" && o.pr.checks === "running" && Math.random() < 0.5) { o.pr.checks = "green"; o.timeline.push({ at: Date.now(), who: "ci", text: "Checks passed. Waiting for a person to approve and merge." }); changed = true; }
      else if (o.stage === "pr_merged") { o.stage = "verified"; o.timeline.push({ at: Date.now(), who: "ag-onboard", text: "Verified: dry-run work order built and passed checks." }); changed = true; }
      else if (o.stage === "verified") { o.stage = "ready"; o.readyAt = Date.now(); o.timeline.push({ at: Date.now(), who: "ag-onboard", text: "Ready. Work orders can be submitted." }); G.audit("onboarding.ready", r.name, r.id, "ok", { project: r.project, actor: "ag-onboard", via: "agent", entity: { type: "repo", id: r.id } });
        if (st.repos.filter(function (x) { return x.project === p.id; }).every(function (x) { return x.onboarding.stage === "ready"; }) && p.status !== "active") p.status = "active";
        changed = true; }
    });
    if (changed) { st.workOrders.forEach(function (w) { G.lc.sync(w); }); G.store.set("workOrders", st.workOrders); G.store.set("repos", st.repos); G.store.set("projects", st.projects); }
  }
  G.sim = {
    start: function () { if (!timer) timer = setInterval(tick, 3500); },
    stop: function () { clearInterval(timer); timer = null; },
    tick: tick
  };
})(window.G);
