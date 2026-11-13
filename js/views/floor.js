/* Floor (#floor): the live plant for the current project.
   Three views: Belt (serpentine conveyor with gates, bays and a shipped strip), Board (kanban with
   pointer drag and a keyboard "Move to" menu) and List (sortable table). Header carries project KPIs,
   simulation pause, new work order, andon halts and the project kill switch. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};

  var ui = { sort: { k: "where", dir: 1 }, hover: null, drag: null, lastNode: null, prevPos: {}, prevSpot: {} };

  /* belt geometry: top row left to right, turn, bottom row right to left; computed per project by layoutFor */

  function prefs() { return G.store.get("prefs"); }
  function setPref(fn) { G.store.update("prefs", fn); }
  function res(r) { G.toast(r.msg, r.ok ? "ok" : "error"); return r.ok; }
  function projWos(p) { return G.store.get("workOrders").filter(function (w) { return w.project === p.id; }); }
  function isLive(w) { return w.state !== "done" && w.state !== "killed"; }
  function sidx(sid) { return G.stationIndex(sid); }
  /* belt geometry from the project's flow definition (custom stations included): stations up to Plan on
     the top row, the rest on the bottom row; order gives the stacking order for the vertical layout. */
  function layoutFor(p) {
    var order = G.flowOf(p).stations.map(function (s) { return s.id; });
    var pi = order.indexOf("plan"); if (pi < 0) pi = Math.min(4, order.length - 2);
    var top = order.slice(0, pi + 1), bottom = order.slice(pi + 1);
    var o = {}, n = 1;
    order.forEach(function (sid) { o[sid] = n++; var g = gateFor(p, sid); if (g) o[g.id] = n++; });
    return { top: top, bottom: bottom, order: o };
  }
  function gateFor(p, sid) { var g = G.gateAfter(sid); return g && !(p.flow.gates[g.id] || {}).absent ? g : null; }
  var LAYOUT = { top: [], bottom: [], order: {} };   /* set by layoutFor(project) on every render */
  function openEntry(w) { return w.history[w.history.length - 1] || {}; }
  function since(w) { var e = openEntry(w); return w.bay ? (w.bayAt || e.startedAt) : w.state === "waiting" ? (e.endedAt || e.startedAt) : e.startedAt; }
  function filters() { var f = prefs().boardFilters || {}; return { cls: f.cls || "all", repo: f.repo || "all", assignee: f.assignee || "all", prio: f.prio || "all" }; }
  function stopped(p) { return G.stopState(p.id); }
  function motionOk() { return !G.reducedMotion(); }

  /* ================= replay (reads G.stateAt; never mutates the store) ================= */
  var REPLAY_LOCK = { allowed: false, reason: "Replay is showing the past. Go back to live to act.", needs: "" };
  var SPEEDS = { "24h": [[1, "10 min/s"], [4, "40 min/s"], [12, "2 h/s"]], "7d": [[1, "1 h/s"], [4, "4 h/s"], [12, "12 h/s"]] };
  function replayCtx(p) {
    var r = prefs().replay; if (!r || !p) return null;
    var span = r.span === "7d" ? "7d" : "24h", rg = G.replay.range(span);
    var at = Math.max(rg.from, Math.min(rg.to, r.at || rg.to));
    return { at: at, span: span, from: rg.from, to: rg.to, speed: r.speed || 1, state: G.stateAt(at, p.id) };
  }
  function rp() { return ui.rp || null; }
  function nowT() { return ui.rp ? ui.rp.at : Date.now(); }
  function lockIf(d) { return ui.rp ? REPLAY_LOCK : d; }
  /* a read-only stand-in for a work order as it was at time t */
  function virtualWo(w, s, t) {
    var v = Object.create(w);
    v.state = s.state; v.bay = s.bay || null;
    v.station = s.station === "done" ? G.stationIndex(w.history.length ? w.history[w.history.length - 1].station : "close") : G.stationIndex(s.station);
    if (v.station < 0) v.station = w.station;
    v.heldByKill = null; v.slot = null; v.progress = s.progress == null ? 100 : s.progress;
    var hist = w.history.filter(function (e) { return e.startedAt <= t; }).map(function (e) { return e.endedAt && e.endedAt > t ? Object.assign({}, e, { endedAt: null }) : e; });
    v.history = hist.length ? hist : w.history.slice(0, 1);
    var gates = {};
    Object.keys(w.gates).forEach(function (k) {
      var g = w.gates[k], d = g.decision;
      var approvals = g.approvals.filter(function (a) { return a.at <= t; }), rejections = g.rejections.filter(function (a) { return a.at <= t; });
      var passed = g.status === "passed" && (d ? d.at <= t : approvals.length > 0 || s.state === "done");
      var status = passed ? "passed" : s.gate === k && s.state === "waiting" ? "waiting" : g.status === "skipped" ? "skipped" : "pending";
      gates[k] = Object.assign({}, g, { status: status, approvals: approvals, rejections: rejections, decision: passed ? d : null, trustNote: status === "waiting" ? g.trustNote : null });
    });
    v.gates = gates;
    v.doneAt = s.state === "done" ? w.doneAt : null;
    v.killed = s.state === "killed" ? w.killed : null;
    v.replay = true;
    return v;
  }
  function replayWos(p, ctx) {
    var map = {};
    ctx.state.workOrders.forEach(function (s) { map[s.id] = s; });
    ui.vmap = {};
    return projWos(p).filter(function (w) { return map[w.id]; }).map(function (w) { var v = virtualWo(w, map[w.id], ctx.at); ui.vmap[w.id] = v; return v; });
  }
  function slotsBusy(p, wos) {
    if (!ui.rp) return G.slotsUsed(p.id);
    var bi = G.stationIndex("build");
    return wos.filter(function (w) { return w.station === bi && !w.bay && w.state === "running"; }).slice(0, p.flow.slots).map(function (w, i) { return { id: w.id, slot: i + 1 }; });
  }
  function fixTokTime(tok, w) {
    if (!ui.rp || w.state === "done" || w.state === "killed") return tok;
    var el = tok.querySelector(".tok-time"); if (el) el.textContent = G.fmt.dur(Math.max(0, nowT() - since(w)));
    return tok;
  }
  function stopTimer() { if (ui.playTimer) { clearInterval(ui.playTimer); ui.playTimer = null; } }
  function setReplay(o) { G.ops.setReplay(o); }
  function enterReplay(p) {
    var rg = G.replay.range("24h");
    setReplay({ at: rg.to - 6 * G.HOUR, span: "24h", project: p.id, speed: 1 });
  }
  function exitReplay() {
    stopTimer(); ui.vmap = null;
    setReplay(null);
    setTimeout(function () { var b = document.getElementById("floor-replay-enter"); if (b) b.focus(); }, 60);
  }
  function togglePlay() {
    if (ui.playTimer) { stopTimer(); G.rerender(); return; }
    var p = G.currentProject(), ctx = replayCtx(p); if (!ctx) return;
    if (ctx.at >= ctx.to - G.MIN) setReplay({ at: ctx.from });
    ui.playTimer = setInterval(function () {
      var pp = G.currentProject(), c = replayCtx(pp);
      if (!c || location.hash.replace("#", "") !== "floor") { stopTimer(); if (c) G.rerender(); return; }
      var base = c.span === "7d" ? G.HOUR : 10 * G.MIN;
      var next = c.at + base * c.speed * 0.5;
      if (next >= c.to) { stopTimer(); next = c.to; }
      setReplay({ at: next });
    }, 500);
    G.rerender();
  }
  var EV_LABEL = { "gate.decision": "Gate decision", "trust.auto": "Passed under trust", halt: "Andon halt", resume: "Resumed", kill: "Kill", restore: "Restored", release: "Release", "wo.submit": "Submitted", "wo.enter": "Entered station", "wo.bay": "Moved to bay", "wo.done": "Done", "trust.change": "Trust change" };
  function evText(e) {
    var gd = e.gate && G.gateDef(e.gate), st = e.station && G.find.station(e.station);
    switch (e.type) {
      case "gate.decision": return (gd ? gd.label : e.gate) + " decided by " + (e.by ? G.actorName(e.by) : "a person") + (e.trust != null ? " (cell at L" + e.trust + ")" : "");
      case "trust.auto": return (gd ? gd.label : e.gate) + " passed under trust at L" + e.trust;
      case "halt": return (e.scope === "repo" ? ((G.find.repo(e.repo) || {}).name || e.repo) : "Project") + " halted by " + G.actorName(e.by) + (e.text ? ": " + e.text : "");
      case "resume": return (e.scope === "repo" ? ((G.find.repo(e.repo) || {}).name || e.repo) : "Project") + " resumed by " + G.actorName(e.by);
      case "kill": return (e.scope === "factory" ? "Factory" : e.scope === "workorder" ? "Work order" : "Project") + " killed by " + G.actorName(e.by) + (e.text ? ": " + e.text : "");
      case "restore": return (e.scope === "factory" ? "Factory" : e.scope === "workorder" ? "Work order" : "Project") + " restored by " + G.actorName(e.by) + (e.text ? ": " + e.text : "");
      case "release": return "Released " + (e.text || "");
      case "wo.submit": return "Submitted" + (e.text ? ": " + e.text : "");
      case "wo.enter": return "Entered " + (st ? st.no + " " + st.name : e.station);
      case "wo.bay": return "Moved to " + ((G.bayDef(e.bay) || {}).name || e.bay) + (e.text ? ": " + e.text : "");
      case "trust.change": return "Trust L" + e.from + " to L" + e.to + (e.text ? ": " + e.text : "");
      default: return e.text || e.type;
    }
  }
  function markCls(e) { return e.type === "gate.decision" ? "mk-gate" : e.type === "trust.auto" ? "mk-trust" : "mk-" + e.type; }

  function replayBar(p, ctx) {
    var marks = G.replay.events({ project: p.id, from: ctx.from, to: ctx.to, types: G.replay.MARK_TYPES });
    var playing = !!ui.playTimer;
    var span = ctx.to - ctx.from;
    var before = marks.filter(function (e) { return e.at < ctx.at - 1000; }), after = marks.filter(function (e) { return e.at > ctx.at + 1000; });
    var prevE = before[before.length - 1], nextE = after[0];
    var label = h("span", { class: "fl-rp-at mono", id: "floor-rp-at", "aria-live": "polite" }, G.fmt.stamp(ctx.at));
    var scrub = h("input", { type: "range", class: "fl-rp-range", id: "floor-rp-scrub", min: String(Math.floor(ctx.from)), max: String(Math.ceil(ctx.to)), step: String(G.MIN), value: String(Math.round(ctx.at)), "aria-label": "Replay time", "aria-valuetext": G.fmt.stamp(ctx.at) });
    var dragging = false;
    scrub.addEventListener("pointerdown", function () { dragging = true; stopTimer(); });
    scrub.addEventListener("input", function () { var v = +scrub.value; label.textContent = G.fmt.stamp(v); scrub.setAttribute("aria-valuetext", G.fmt.stamp(v)); if (!dragging) setReplay({ at: v }); });
    scrub.addEventListener("change", function () { dragging = false; setReplay({ at: +scrub.value }); });
    var counts = {};
    marks.forEach(function (e) { var k = markCls(e); counts[k] = (counts[k] || 0) + 1; });
    var markRow = h("div", { class: "fl-rp-marks", "aria-hidden": "true" }, marks.map(function (e) {
      var m = h("span", { class: "fl-mk " + markCls(e) + (e.at <= ctx.at ? " is-past" : ""), style: "left:" + ((e.at - ctx.from) / span * 100).toFixed(2) + "%", "data-tip": G.fmt.stamp(e.at) + " · " + (EV_LABEL[e.type] || e.type) + (e.wo ? " · " + e.wo : "") + " · " + evText(e) });
      m.addEventListener("click", function () { stopTimer(); setReplay({ at: e.at + 1000 }); });
      return m;
    }), h("span", { class: "fl-rp-now", style: "left:" + ((ctx.at - ctx.from) / span * 100).toFixed(2) + "%" }));
    var recent = G.replay.events({ project: p.id, from: ctx.from, to: ctx.at }).filter(function (e) { return e.type !== "wo.enter"; }).slice(-5).reverse();
    var speedSel = G.select("floor-rp-speed", SPEEDS[ctx.span].map(function (s) { return { value: String(s[0]), label: s[1] }; }), String(ctx.speed), function (v) { setReplay({ speed: +v }); }, { "aria-label": "Replay speed" });
    var legend = [["mk-gate", "gate decision by a person"], ["mk-trust", "passed under trust"], ["mk-halt", "halt"], ["mk-resume", "resume"], ["mk-kill", "kill"], ["mk-restore", "restore"], ["mk-release", "release"]];
    return h("section", { class: "fl-replay", id: "floor-replay", "aria-label": "Replay controls" },
      h("div", { class: "fl-rp-head" },
        h("div", { class: "fl-rp-stamp", role: "status" }, G.icon("replay"), h("span", null, "Replay · not live"), label),
        h("div", { class: "fl-rp-ctl" },
          G.segmented("floor-rp-span", [{ id: "24h", label: "Last 24h" }, { id: "7d", label: "Last 7 days" }], ctx.span, function (v) { stopTimer(); var rg = G.replay.range(v); setReplay({ span: v, speed: 1, at: Math.max(rg.from, ctx.at) }); }, "Replay window"),
          G.btn("Previous event", { small: true, icon: "back", id: "floor-rp-prev", aria: "Jump to the previous event", disabledReason: prevE ? null : "No earlier event in this window.", onClick: function () { stopTimer(); setReplay({ at: prevE.at + 1000 }); } }),
          G.btn(playing ? "Pause" : "Play", { small: true, kind: "primary", icon: playing ? "pause" : "play", id: "floor-rp-play", onClick: togglePlay }),
          G.btn("Next event", { small: true, icon: "chevron", id: "floor-rp-next", aria: "Jump to the next event", disabledReason: nextE ? null : "No later event in this window.", onClick: function () { stopTimer(); setReplay({ at: nextE.at + 1000 }); } }),
          h("label", { class: "fl-rp-speed", for: "floor-rp-speed" }, h("span", { class: "small muted" }, "Speed"), speedSel),
          G.btn("Back to live", { small: true, icon: "st-run", id: "floor-rp-live", onClick: exitReplay }))),
      h("div", { class: "fl-rp-track" }, scrub, markRow,
        h("div", { class: "fl-rp-axis mono" }, h("span", null, G.fmt.stamp(ctx.from)), h("span", null, marks.length + " events marked"), h("span", null, "now " + G.fmt.ist(ctx.to)))),
      h("div", { class: "fl-rp-foot" },
        h("ul", { class: "fl-rp-legend", "aria-label": "Mark legend" }, legend.map(function (l) { return h("li", null, h("span", { class: "fl-mk-key " + l[0], "aria-hidden": "true" }), l[1] + " " + (counts[l[0]] || 0)); })),
        h("div", { class: "fl-rp-recent" }, h("div", { class: "fl-rp-recent-h" }, "Up to this moment"),
          recent.length ? h("ol", { class: "fl-rp-list" }, recent.map(function (e) {
            return h("li", null, h("span", { class: "fl-mk-key " + markCls(e), "aria-hidden": "true" }), h("span", { class: "mono muted" }, G.fmt.ist(e.at)),
              e.wo ? h("button", { type: "button", class: "linkish mono", id: "floor-rp-wo-" + e.id, onClick: function () { G.openTraveler(e.wo); } }, e.wo) : null, h("span", null, evText(e)));
          })) : h("p", { class: "muted small" }, "No events yet in this window."))),
      h("p", { class: "footnote" }, "The floor below is rebuilt from the event log and traveler history at the chosen time. Approvals, moves, halts and kills are locked until you go back to live. Tokens open the live traveler."));
  }

  /* ================= header ================= */
  function kpis(p, wos) {
    var now = nowT();
    var live = wos.filter(function (w) { return isLive(w) && w.bay !== "declined"; });
    var waiting = live.filter(function (w) { return w.state === "waiting" && !w.bay; });
    var oldest = waiting.reduce(function (m, w) { return Math.max(m, now - since(w)); }, 0);
    var shipped7 = wos.filter(function (w) { return w.state === "done" && !w.split && w.doneAt > now - 7 * G.DAY; }).length;
    var shipped24 = wos.filter(function (w) { return w.state === "done" && !w.split && w.doneAt > now - G.DAY; }).length;
    var stuck = live.filter(function (w) { return w.state === "blocked" || w.state === "failed" || w.bay === "sechold" || w.bay === "person"; }).length;
    var slots = slotsBusy(p, wos).length;
    var spendPct = p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0;
    var killed = wos.filter(function (w) { return w.state === "killed"; }).length;
    return [
      { k: "Work in flight", v: String(live.length), sub: live.filter(function (w) { return w.state === "running"; }).length + " running now" },
      { k: "Gates waiting", v: String(waiting.length), sub: waiting.length ? "oldest " + G.fmt.dur(oldest) : "none waiting", tone: waiting.length ? "wait" : "" },
      { k: "Stuck", v: String(stuck), sub: "blocked, failed, held, asking", tone: stuck ? "block" : "" },
      { k: "Coding slots", v: slots + "/" + p.flow.slots, sub: slots >= p.flow.slots ? "all busy" : (p.flow.slots - slots) + " free" },
      { k: "Shipped", v: String(shipped7), sub: shipped24 + " in 24h, 7 days total" },
      { k: "Spend MTD", v: G.fmt.money0(p.budget.mtd), sub: ui.rp ? "live figure, not replayed" : G.fmt.pct(spendPct) + " of " + G.fmt.money0(p.budget.monthly), tone: spendPct >= p.budget.alertAt ? "wait" : "" },
      killed ? { k: "Killed", v: String(killed), sub: "work orders stopped", tone: "kill" } : null
    ].filter(Boolean);
  }

  function andonMenu(anchor, p) {
    var repos = G.store.get("repos").filter(function (r) { return r.project === p.id; });
    var items = [];
    items.push(p.halted
      ? { label: "Resume " + p.name, icon: "play", hint: "whole project", guard: G.me("line.resume", { project: p.id }), onClick: function () { res(G.ops.resumeProject(p.id)); } }
      : { label: "Halt " + p.name, icon: "halt", hint: "whole project", guard: G.me("line.halt", { project: p.id }), onClick: function () { G.haltDialog("project", p.id); } });
    items.push({ sep: true });
    repos.forEach(function (r) {
      items.push(r.halted
        ? { label: "Resume " + r.name, icon: "play", hint: "halted", guard: G.me("line.resume", { project: p.id }), onClick: function () { res(G.ops.resumeRepo(r.id)); } }
        : { label: "Halt " + r.name, icon: "halt", hint: "repo", guard: G.me("line.halt", { project: p.id }), onClick: function () { G.haltDialog("repo", r.id); } });
    });
    G.menu(anchor, "Andon: pull the cord", items);
  }

  function header(p, wos) {
    var paused = prefs().paused;
    var f = G.store.get("factory").killed;
    var subGuard = G.submitGuard(p.id, (G.store.get("repos").find(function (r) { return r.project === p.id && (r.onboarding.stage === "ready" || r.onboarding.exception); }) || {}).id);
    var dSubmit = G.me("wo.submit", { project: p.id });
    var newGuard = lockIf(!dSubmit.allowed ? dSubmit : subGuard && /refused/.test(subGuard) ? { allowed: false, reason: subGuard, needs: "" } : null);
    var killBtn = p.killed
      ? G.btn("Restore project", { icon: "power", id: "floor-restore", guard: lockIf(G.me("restore.project", { project: p.id })), onClick: function () { G.restoreDialog("project", p.id); } })
      : G.btn("Kill project", { kind: "danger", icon: "st-kill", id: "floor-kill", guard: lockIf(f ? { allowed: false, reason: "The whole factory is killed; restore it from Home.", needs: "" } : G.me("kill.project", { project: p.id })), onClick: function () { G.killDialog("project", p.id); } });
    var andon = G.btn(p.halted ? "Andon: halted" : "Andon", { kind: "andon", icon: "halt", id: "floor-andon", aria: "Andon controls: halt or resume the project or a repo", guard: lockIf(null), onClick: function (e) { andonMenu(e.currentTarget, p); } });
    andon.setAttribute("aria-haspopup", "menu");
    var head = G.pageHeader({
      id: "floor-head", kicker: "Project · Floor · " + p.key, title: p.name,
      sub: p.desc, badge: ui.rp ? h("span", { class: "chip fl-rp-chip" }, G.icon("replay"), "Replay · not live") : null,
      actions: [
        G.btn(paused ? "Resume simulation" : "Pause simulation", { icon: paused ? "play" : "pause", id: "floor-sim", guard: lockIf(null), onClick: function () { setPref(function (x) { x.paused = !x.paused; }); } }),
        G.btn("New work order", { kind: "primary", icon: "plus", id: "floor-new-wo", guard: newGuard, onClick: function () { G.newWODialog({ project: p.id }); } }),
        andon, killBtn
      ]
    });
    var strip = h("div", { class: "fl-kpis", role: "list", "aria-label": "Project figures" }, kpis(p, wos).map(function (x) {
      return h("div", { class: "fl-kpi" + (x.tone ? " tone-" + x.tone : ""), role: "listitem" }, h("div", { class: "fl-kpi-k" }, x.k), h("div", { class: "fl-kpi-v" }, x.v), h("div", { class: "fl-kpi-sub" }, x.sub));
    }));
    return [head, strip];
  }

  /* ================= station / gate details (drawer) ================= */
  function avgTime(wos, sid) {
    var d = [];
    wos.forEach(function (w) { w.history.forEach(function (e) { if (e.station === sid && e.endedAt) d.push(e.endedAt - e.startedAt); }); });
    return d.length ? d.reduce(function (a, b) { return a + b; }, 0) / d.length : 0;
  }
  function mcpFor(p, sid) {
    return G.store.get("mcp").filter(function (m) { return (m.stations || []).indexOf(sid) >= 0 && (m.projects === "all" || (m.projects || []).indexOf(p.id) >= 0) && (p.mcp || []).indexOf(m.id) >= 0; });
  }
  function kv(k, v) { return h("div", null, h("dt", null, k), h("dd", null, v)); }

  function approverSummary(p, gid) {
    var g = G.gateDef(gid), rule = p.approvers[gid];
    if (G.gateKind(p, g.id) === "auto") return h("p", { class: "small" }, "Automatic. Passes when its checks pass: " + g.checks.join(", ") + ".");
    if (gid === "G0G1") return h("p", { class: "small" }, "The submitter confirms the brief. Line Leads and Project Admins may confirm any brief.");
    if (!rule) return h("p", { class: "small muted" }, "No approver rule set. Factory Admins can approve (break-glass).");
    var roles = rule.roles.map(function (r) { return G.find.role(r).name; });
    var people = rule.people.map(G.actorName);
    return h("div", { class: "fl-rule" },
      h("p", { class: "small" }, h("strong", null, rule.required + " approval" + (rule.required > 1 ? "s" : "") + " from: "), roles.concat(people).join(", ") || "nobody listed"),
      G.gateKind(p, g.id) === "mixed" ? h("p", { class: "small" }, "Automatic checks first: " + g.checks.join(", ") + ".") : null,
      rule.sod ? h("p", { class: "small" }, "Separation of duties: the author cannot approve.") : null,
      rule.conditions.length ? h("ul", { class: "plain-list small" }, rule.conditions.map(function (c) { return h("li", null, G.icon("tag"), " ", c.text); })) : null,
      rule.escalateH ? h("p", { class: "small muted" }, "Escalates after " + rule.escalateH + "h" + (rule.fallback ? " to " + G.actorName(rule.fallback) : " to the Project Admins") + ".") : null);
  }

  function gateRowActions(p, w, gid) {
    var me = G.viewerId();
    var d = lockIf(G.gateDecision(me, w, gid));
    var dRej = lockIf(gid === "G0G1" ? G.me("wo.decline", { project: p.id }) : d);
    return h("span", { class: "fl-gate-acts" },
      G.btn(gid === "G0G1" ? "Confirm brief" : gid === "G6" ? "Confirm release" : "Approve", { small: true, kind: "primary", icon: "check", id: "floor-gapp-" + w.id, guard: d, onClick: function () { res(G.ops.approveGate(w.id)); } }),
      G.btn(gid === "G0G1" ? "Decline" : "Reject", { small: true, icon: "x", id: "floor-grej-" + w.id, guard: dRej, onClick: function () {
        G.reasonDialog({ title: (gid === "G0G1" ? "Decline " : "Reject " + G.gateDef(gid).label + " on ") + w.id, kicker: "Gate decision", ok: gid === "G0G1" ? "Decline" : "Reject", kind: "danger", min: 5,
          placeholder: gid === "G0G1" ? "Why will the factory not do this?" : "What must change before this passes?",
          sub: gid === "G0G1" ? "The work order moves to Declined." : "The station's agent reworks the step with your reason.",
          onOk: function (v) { var r = G.ops.rejectGate(w.id, v); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      } }));
  }

  /* ---- trust on the floor ---- */
  function trustLink(id) {
    return G.btn("Open the trust ladder", { small: true, icon: "trust", id: id, disabledReason: G.canSeeRoute && !G.canSeeRoute("trust") ? "Your role cannot open the trust ladder." : null, onClick: function () { G.drawer.close(); location.hash = "trust"; } });
  }
  function whyNotTrust(w, gid) {
    var gs = w.gates[gid] || {};
    if (gid === "G0G1") return "The brief is always confirmed by a person.";
    if (gs.trustNote) return gs.trustNote;
    if (gs.approvals && gs.approvals.length) return "A person already started approving; trust does not take over.";
    return G.trust.decide(w, gid).reason;
  }
  function levelTag(n, extra, codeOnly) {
    var L = G.trust.level(n);
    return h("span", { class: "fl-lv fl-lv-" + n, title: L.code + " " + L.name + ": " + L.desc }, h("span", { class: "mono" }, L.code), codeOnly ? null : " " + L.name + (extra || ""));
  }
  function gateTrust(p, gid) {
    var g = G.gateDef(gid);
    if (G.gateKind(p, gid) === "auto") return null;
    if (gid === "G0G1") return h("div", null, h("h3", { class: "sub-h" }, "Trust"), h("p", { class: "small muted" }, "Not under trust: the submitter always confirms the brief."));
    var agent = G.trustAgentFor(gid), ag = agent && G.find.agent(agent);
    var rate = (G.store.get("trust") || {}).sampleRate || 5;
    var rows = G.classesOf(p).filter(function (c) { return G.routeGates(p, c.id).indexOf(gid) >= 0; }).map(function (c) {
      var cell = G.trust.cell(agent, c.id, p.id);
      var granted = cell ? cell.level : 1;
      var ceil = G.trust.ceiling(p.id, c.id, gid);
      var eff = Math.min(granted, ceil.max);
      var how = gid === "G6" ? (eff >= 4 ? "auto" : "person (needs L4)") : eff >= 3 ? "auto" : eff === 2 ? "auto, 1 in " + rate + " checked" : "person";
      return h("tr", null, h("td", null, G.classChip(c.id, { small: true })), h("td", null, levelTag(granted, null, true)),
        h("td", { class: "mono small", title: ceil.ceilings.map(function (x) { return x.id + ": " + x.text; }).join("; ") || null }, ceil.max < 4 ? "L" + ceil.max + " " + ceil.ceilings.map(function (x) { return x.id; }).join(", ") : "none"),
        h("td", null, eff < granted ? levelTag(eff, " (capped)") : levelTag(eff)), h("td", { class: "small" + (eff >= 2 ? " fl-auto-yes" : "") }, how));
    });
    return h("div", { class: "fl-trust" },
      h("h3", { class: "sub-h" }, "Trust in force at " + g.label),
      h("p", { class: "small" }, "Judges the work of " + (ag ? ag.name : "the agent before it") + " in " + p.name + ". Level per work class, capped by policy ceilings."),
      rows.length ? h("div", { class: "table-scroll" }, h("table", { class: "table table-compact fl-trust-t" }, h("caption", { class: "sr" }, "Trust levels at " + g.label + " by class"),
        h("thead", null, h("tr", null, ["Class", "Granted", "Ceiling", "In force", "At this gate"].map(function (x) { return h("th", { scope: "col" }, x); }))), h("tbody", null, rows)))
        : h("p", { class: "muted small" }, "No class in this project routes through " + g.label + "."),
      trustLink("floor-gate-trust-link"));
  }
  function stationTrust(p, sid) {
    var st = G.find.station(sid), g = gateFor(p, sid);
    var gate = g && G.gateKind(p, g.id) !== "auto" && g.id !== "G0G1" ? g : null;
    var props = ((G.store.get("trust") || {}).proposals || []).filter(function (x) { return x.status === "pending"; });
    var rows = G.classesOf(p).filter(function (c) { return G.route(p, c.id).indexOf(sid) >= 0; }).map(function (c) {
      var cell = G.trust.cell(st.agent, c.id, p.id);
      var granted = cell ? cell.level : 1;
      var ceil = gate ? G.trust.ceiling(p.id, c.id, gate.id).max : 4;
      var prop = cell && props.find(function (x) { return x.cell === cell.id; });
      return h("tr", null, h("td", null, G.classChip(c.id, { small: true })), h("td", null, levelTag(granted, null, true)), h("td", { class: "mono small" }, cell ? String(cell.cleanRuns || 0) : "0"),
        h("td", { class: "mono small" }, ceil < 4 ? "L" + ceil : "none"), h("td", { class: "small" }, prop ? "proposed L" + prop.to : cell && cell.history && cell.history.length ? G.fmt.ago(cell.history[cell.history.length - 1].at) : "default"));
    });
    return h("div", { class: "fl-trust" },
      h("h3", { class: "sub-h" }, "Trust for " + (G.find.agent(st.agent) || {}).name + " in this project"),
      h("p", { class: "small muted" }, gate ? "Applies at " + gate.label + ", the gate that judges this station's work." : "No human gate judges this station's work, so trust does not change who approves here."),
      rows.length ? h("div", { class: "table-scroll" }, h("table", { class: "table table-compact fl-trust-t" }, h("caption", { class: "sr" }, "Trust by class"),
        h("thead", null, h("tr", null, ["Class", "Level", "Clean runs", "Ceiling", "Last change"].map(function (x) { return h("th", { scope: "col" }, x); }))), h("tbody", null, rows)))
        : h("p", { class: "muted small" }, "No class routes through this station."),
      trustLink("floor-st-trust-link"));
  }

  function openGate(gid) {

    G.drawer.open("gate:" + gid, function (close) {
      var p = G.currentProject(); if (!p) return null;
      var g = G.gateDef(gid);
      var wos = projWos(p);
      var here = wos.filter(function (w) { return isLive(w) && w.gates[gid] && G.STATIONS[w.station].id === g.after; });
      var waiting = here.filter(function (w) { return w.gates[gid].status === "waiting" && !w.bay; });
      var failing = here.filter(function (w) { return w.gates[gid].status === "failed"; });
      var off = !p.flow.gates[gid].enabled && gid !== "G0G1";
      var recent = [];
      wos.forEach(function (w) { var gs = w.gates[gid]; if (!gs) return;
        gs.approvals.forEach(function (a) { recent.push({ w: w, at: a.at, by: a.by, text: "approved" + (a.trust != null ? " (cell at " + G.trust.level(a.trust).code + ")" : ""), via: a.via, mode: "human" }); });
        gs.rejections.forEach(function (a) { recent.push({ w: w, at: a.at, by: a.by, text: "rejected: " + a.reason, mode: "human" }); });
        if (gs.decision && gs.decision.mode === "trust") recent.push({ w: w, at: gs.decision.at, by: null, text: gs.decision.reason || "passed under trust at " + G.trust.level(gs.decision.trust).code, mode: "trust" });
      });
      recent.sort(function (a, b) { return b.at - a.at; });
      return h("div", { class: "drawer-inner" },
        h("div", { class: "drawer-head" },
          h("div", null, h("div", { class: "kicker" }, "Gate · after " + G.find.station(g.after).no + " " + G.find.station(g.after).name),
            h("div", { class: "drawer-id" }, h("span", { class: "fl-dgate", "aria-hidden": "true" }), h("span", { class: "mono big-id" }, g.label), h("span", { class: "chip" }, G.gateKind(p, g.id) === "auto" ? "automatic" : G.gateKind(p, g.id) === "mixed" ? "checks + human" : "human")),
            h("h2", { class: "drawer-title" }, g.name)),
          h("button", { type: "button", class: "icon-btn drawer-close", "aria-label": "Close gate details", onClick: close }, G.icon("x"))),
        h("div", { class: "drawer-scroll" },
          off ? h("div", { class: "callout" }, G.icon("alert"), h("span", null, g.label + " is off in " + p.name + ". Work passes straight through.")) : null,
          h("p", { class: "drawer-desc" }, g.purpose),
          ui.rp ? h("div", { class: "callout callout-warn" }, G.icon("replay"), h("span", null, "Replay is on. This drawer shows the gate as it is now; decisions are locked until you go back to live.")) : null,
          h("h3", { class: "sub-h" }, "Approvers"), approverSummary(p, gid),
          gateTrust(p, gid),
          h("h3", { class: "sub-h" }, "Waiting here (" + waiting.length + ")"),
          waiting.length ? h("ul", { class: "fl-gate-list" }, waiting.map(function (w) {
            var prog = G.gateProgress(p, w, gid);
            return h("li", null, G.woToken(w, { compact: true, idPrefix: "floor-gtok-" }),
              h("div", { class: "small" }, G.gateKind(p, g.id) === "auto" ? "Checks running" : prog.have + " of " + prog.need + " approvals" + (prog.unmet.length ? "; still needs: " + prog.unmet.map(function (c) { return c.text; }).join("; ") : "") + " · waiting " + G.fmt.dur(Date.now() - since(w))),
              G.gateKind(p, g.id) === "auto" ? null : h("div", { class: "small fl-why-trust" }, G.icon("trust"), h("span", null, h("strong", null, "Why trust did not pass it: "), whyNotTrust(w, gid))),
              G.gateKind(p, g.id) === "auto" ? null : gateRowActions(p, w, gid));
          })) : h("p", { class: "muted small" }, "Nothing is waiting at " + g.label + "."),
          failing.length ? h("h3", { class: "sub-h" }, "Failing (" + failing.length + ")") : null,
          failing.length ? h("ul", { class: "fl-gate-list" }, failing.map(function (w) {
            return h("li", null, G.woToken(w, { compact: true, idPrefix: "floor-gftok-" }), h("div", { class: "small" }, w.failReason || w.bayReason || "Check failed"),
              w.state === "failed" ? G.btn("Retry " + G.STATIONS[w.station].name, { small: true, icon: "refresh", id: "floor-gretry-" + w.id, guard: lockIf(G.me("wo.sendback", { project: p.id })), onClick: function () { res(G.ops.retry(w.id)); } }) : null);

          })) : null,
          h("h3", { class: "sub-h" }, "Recent decisions"),
          recent.length ? h("ol", { class: "history" }, recent.slice(0, 8).map(function (x) {
            return h("li", { class: x.mode === "trust" ? "fl-dec-trust" : null }, h("span", { class: "mono muted" }, G.fmt.iso(x.at)), x.by ? G.who(x.by) : h("span", { class: "fl-trust-tag" }, G.icon("trust"), "trust"), h("span", { class: "mono" }, x.w.id), h("span", null, x.text + (x.via && x.via !== "web" ? " via " + x.via : "")));
          })) : h("p", { class: "muted small" }, "No decisions recorded yet."),
          h("h3", { class: "sub-h" }, "Rule history"), G.historyList({ type: "gaterule", id: p.id + ":" + gid, limit: 10 })));
    });
  }

  function openStation(sid) {
    G.drawer.open("station:" + sid, function (close) {
      var p = G.currentProject(); if (!p) return null;
      var st = G.find.station(sid), i = sidx(sid);
      var ag = G.find.agent(st.agent);
      var wos = projWos(p);
      var here = wos.filter(function (w) { return w.station === i && isLive(w) && !w.bay; });
      var g = G.gateAfter(sid);
      var conf = p.flow.stations[sid];
      var skills = (ag.skills || []).map(function (s) { var sk = G.find.skill(s); return sk ? sk.name + " " + sk.version : s; });
      var model = p.regulated && sid !== "intake" ? "bedrock-claude-sonnet-5-5" : (ag.overrides && ag.overrides[p.id] && ag.overrides[p.id].model) || ag.model;
      var mcps = mcpFor(p, sid);
      return h("div", { class: "drawer-inner" },
        h("div", { class: "drawer-head" },
          h("div", null, h("div", { class: "kicker" }, "Station · " + p.name),
            h("div", { class: "drawer-id" }, h("span", { class: "mono big-id" }, st.no), conf.enabled ? h("span", { class: "chip" }, here.length + " / " + conf.wip + " WIP") : h("span", { class: "chip" }, "off in this project")),
            h("h2", { class: "drawer-title" }, st.name)),
          h("button", { type: "button", class: "icon-btn drawer-close", "aria-label": "Close station details", onClick: close }, G.icon("x"))),
        h("div", { class: "drawer-scroll" },
          ui.rp ? h("div", { class: "callout callout-warn" }, G.icon("replay"), h("span", null, "Replay is on. This drawer shows the station as it is now.")) : null,
          h("p", { class: "drawer-desc" }, st.purpose),

          h("dl", { class: "titleblock tb-drawer" },
            kv("Agent", ag.name + " " + ag.version), kv("Model", model), kv("Autonomy", ag.autonomy || "gate"), kv("Average time", G.fmt.dur(avgTime(wos, sid))),
            kv("WIP limit", String(conf.wip)), kv("In progress", String(here.length)), sid === "build" ? kv("Coding slots", G.slotsUsed(p.id).length + " of " + p.flow.slots + " busy") : kv("Gate after", g ? g.label : "none"), kv("MCP servers", String(mcps.length))),
          stationTrust(p, sid),
          h("h3", { class: "sub-h" }, "Skills"),
          skills.length ? h("ul", { class: "plain-list mono small" }, skills.map(function (s) { return h("li", null, s); })) : h("p", { class: "muted small" }, "No skills attached."),
          h("h3", { class: "sub-h" }, "Instructions"),
          h("p", { class: "small" }, ag.instructions),
          p.overlay ? h("p", { class: "small muted" }, "Project overlay: " + p.overlay) : null,
          mcps.length ? h("p", { class: "small" }, "Tools: " + mcps.map(function (m) { return m.name; }).join(", ") + ".") : null,
          g ? h("h3", { class: "sub-h" }, "Gate after: " + g.label + " " + g.name) : null,
          g ? approverSummary(p, g.id) : null,
          g ? G.btn("Open " + g.label + " details", { small: true, icon: "diamond", id: "floor-st-gate-" + g.id, onClick: function () { openGate(g.id); } }) : null,
          h("h3", { class: "sub-h" }, "Work here (" + here.length + ")"),
          here.length ? h("div", { class: "fl-tokgrid" }, here.map(function (w) { return G.woToken(w, { idPrefix: "floor-stok-" }); })) : h("p", { class: "muted small" }, "Nothing at " + st.name + " right now."),
          h("p", { class: "footnote" }, "Change agents, skills and instructions on the Agents screen; WIP limits and gates in Project config.")));
    });
  }

  /* ================= belt ================= */
  function classRoutePill(p, c) {
    var route = G.route(p, c.id);
    var skipped = G.flowOf(p).active.filter(function (s) { return route.indexOf(s.id) < 0; }).map(function (s) { return s.name; });
    var text = c.endsAfter ? c.name + ": ends after " + G.find.station(c.endsAfter).name : skipped.length ? c.name + ": skips " + skipped.join(", ") : c.name + ": full route";
    var active = prefs().activeClass === c.id;
    var b = h("button", { type: "button", class: "fl-route cls-" + c.id + (c.custom && c.token ? " " + c.token : "") + (c.custom ? " is-custom" : "") + (active ? " is-active" : ""), id: "floor-route-" + c.id, "aria-pressed": active ? "true" : "false", "data-cls": c.id },
      h("span", { class: "cls-mark", "aria-hidden": "true" }), h("span", null, text));
    b.addEventListener("click", function () { setPref(function (x) { x.activeClass = x.activeClass === c.id ? null : c.id; }); });
    b.addEventListener("mouseenter", function () { ui.hover = c.id; highlight(); });
    b.addEventListener("mouseleave", function () { ui.hover = null; highlight(); });
    b.addEventListener("focus", function () { ui.hover = c.id; highlight(); });
    b.addEventListener("blur", function () { ui.hover = null; highlight(); });
    return b;
  }

  function staffing(p, sid) {
    var st = G.find.station(sid), ag = G.find.agent(st.agent), g = G.gateAfter(sid);
    var mcps = mcpFor(p, sid).length;
    g = gateFor(p, sid);
    var human = g && G.gateKind(p, g.id) !== "auto" && (p.flow.gates[g.id].enabled || g.id === "G0G1");
    return h("div", { class: "fl-staff" },
      h("span", { class: "fl-glyph", title: "Agent: " + ag.name }, G.icon("agent"), h("span", { class: "sr" }, "Agent "), ag.name),
      h("span", { class: "fl-glyph", title: mcps + " MCP servers allowed here" }, G.icon("tool"), h("span", { class: "sr" }, "MCP servers "), String(mcps)),
      human ? h("span", { class: "fl-glyph is-human", title: "A person approves " + g.label }, G.icon("human"), h("span", { class: "sr" }, "Human gate "), g.label) : null);
  }

  function stationCard(p, wos, sid) {
    var st = G.find.station(sid), i = sidx(sid);
    var conf = p.flow.stations[sid];
    var here = wos.filter(function (w) { return w.station === i && !w.bay && w.state !== "done"; });
    var live = here.filter(isLive);
    var killed = here.filter(function (w) { return w.state === "killed"; });
    var over = conf.enabled && live.length > conf.wip;
    var show = live.concat(killed);
    var max = sid === "build" ? 4 : 4;
    var headBtn = h("button", { type: "button", class: "fl-st-head", id: "floor-st-" + sid, "aria-label": st.no + " " + st.name + ": " + live.length + " in progress, limit " + conf.wip + ". Open station details" },
      h("span", { class: "fl-st-no mono" }, st.no),
      h("span", { class: "fl-st-name" }, st.name),
      h("span", { class: "fl-wip mono" + (over ? " is-over" : "") }, conf.enabled ? live.length + "/" + conf.wip : "off"));
    headBtn.addEventListener("click", function () { openStation(sid); });
    var body = [];
    if (!conf.enabled) body.push(h("p", { class: "fl-off" }, "Off in this project. Work passes by."));
    if (sid === "build" && conf.enabled) {
      var used = slotsBusy(p, wos);
      var slots = [];
      for (var s = 1; s <= p.flow.slots; s++) {
        var w = used.find(function (x) { return x.slot === s; }); // eslint-disable-line no-loop-func
        slots.push(h("li", { class: "fl-slot" + (w ? " is-busy" : "") }, h("span", { class: "fl-slot-k" }, "coding slot " + s + " of " + p.flow.slots), h("span", { class: "mono fl-slot-v" }, w ? w.id : "free")));
      }
      var queued = wos.filter(function (x) { return x.bay === "queue" && isLive(x); }).length;
      body.push(h("ul", { class: "fl-slots", "aria-label": "Coding slots" }, slots, queued ? h("li", { class: "fl-slot is-queue" }, h("span", { class: "fl-slot-k" }, "queue"), h("span", { class: "mono fl-slot-v" }, queued + " waiting")) : null));
    }
    var toks = h("div", { class: "fl-toks" }, show.slice(0, max).map(function (w) { return token(w); }));
    if (show.length > max) toks.appendChild(G.btn("+" + (show.length - max) + " more at " + st.name, { small: true, kind: "ghost", id: "floor-more-" + sid, onClick: function () { openStation(sid); } }));
    if (!show.length && conf.enabled) toks.appendChild(h("p", { class: "fl-idle" }, "idle"));
    return h("section", { class: "fl-st" + (conf.enabled ? "" : " is-off") + (over ? " is-over" : "") + (sid === "build" ? " is-build" : ""), "data-station": sid, style: "--o:" + LAYOUT.order[sid], "aria-label": st.no + " " + st.name },
      headBtn, staffing(p, sid), body, toks, h("span", { class: "fl-bypass", "aria-hidden": "true" }));
  }

  function token(w) {
    var t = fixTokTime(G.woToken(w, { idPrefix: "floor-tok-" }), w);
    var r = G.find.repo(w.repo);
    var halted = ui.rp ? ui.rp.state.haltedRepos[w.repo] : r && r.halted;
    if (r && halted && isLive(w)) { t.classList.add("fl-tok-halted"); t.setAttribute("data-tip", r.name + " is halted (andon)"); }
    return t;
  }

  function gateNode(p, wos, gid) {
    var g = G.gateDef(gid);
    var i = sidx(g.after);
    var here = wos.filter(function (w) { return w.station === i && isLive(w); });
    var gs = G.gateState(p, gid, here);
    var rule = p.approvers[gid];
    var d = G.gateDiamond({ gateId: gid, state: gs.state, count: gs.state === "failing" ? gs.failing : gs.waiting, size: "md", onClick: function () { openGate(gid); } });
    d.id = "floor-gate-" + gid;
    var cap = gs.state === "off" ? "off" : gs.state === "failing" ? gs.failing + " failing" : gs.state === "waiting" ? gs.waiting + " waiting" : "clear";
    var need = G.gateKind(p, g.id) !== "auto" && gs.state !== "off" ? (gid === "G0G1" ? "submitter" : "needs " + (rule ? rule.required : 1)) : null;
    var tr = gs.state !== "off" ? gateTrustSummary(p, wos, gid) : null;
    if (tr) { d.setAttribute("data-tip", d.getAttribute("data-tip") + ". " + tr.tip); d.setAttribute("aria-label", d.getAttribute("aria-label") + ". " + tr.tip); }
    return h("div", { class: "fl-gate fl-gate-" + gs.state + (tr && tr.mode === "trust" ? " is-trusted" : ""), "data-gate": gid, style: "--o:" + LAYOUT.order[gid] },
      d, h("span", { class: "fl-gate-cap mono" }, cap, need ? h("span", { class: "fl-gate-need" }, need) : null,
        tr ? h("span", { class: "fl-gate-tr is-" + tr.mode, "aria-hidden": "true" }, tr.mode === "trust" ? G.icon("trust") : G.icon("human"), tr.short) : null));
  }
  /* how this gate has been passing: under trust or by a person (last decision in the 24h before now/replay time) */
  function gateTrustSummary(p, wos, gid) {
    if (G.gateKind(p, gid) === "auto" || gid === "G0G1") return null;
    var t = nowT(), from = t - G.DAY, list = [];
    wos.forEach(function (w) { var gs = w.gates[gid]; if (gs && gs.status === "passed" && gs.decision && gs.decision.at <= t && gs.decision.at > from) list.push(gs.decision); });
    var waitingSampled = wos.some(function (w) { var gs = w.gates[gid]; return gs && gs.status === "waiting" && !w.bay && /sampled/.test(gs.trustNote || ""); });
    if (!list.length && !waitingSampled) return null;
    list.sort(function (a, b) { return a.at - b.at; });
    var last = list[list.length - 1];
    var nT = list.filter(function (d) { return d.mode === "trust"; }).length, nH = list.length - nT;
    var tip = "Last 24h: " + nT + " passed under trust, " + nH + " by a person" + (waitingSampled ? "; one waiting was sampled for review" : "") + ".";
    if (waitingSampled && (!last || last.mode !== "trust")) return { mode: "sampled", short: "sampled", tip: tip };
    if (last.mode === "trust") return { mode: "trust", short: "L" + last.trust + " auto", tip: tip + " Last: " + (last.reason || "under trust") };
    return { mode: "human", short: "person", tip: tip + " Last: approved by " + G.actorName(last.by) + (last.trust != null ? " with the cell at L" + last.trust : "") + "." };
  }

  function bays(p, wos) {
    var nb = G.flowOf(p).bays.length;
    return h("section", { class: "fl-bays", "aria-label": "Off the main belt", style: "--bays:" + Math.min(6, nb) },
      h("div", { class: "fl-bays-h" }, h("span", { class: "fl-bays-t" }, "Off the main belt"), h("span", { class: "muted small" }, "bays hold work that left the belt; it returns to the station it came from")),
      h("div", { class: "fl-bays-row" }, G.flowOf(p).bays.map(function (b) {
        var list = wos.filter(function (w) { return w.bay === b.id && w.state !== "killed"; });
        var shown = b.id === "declined" ? list.slice(-3) : list;
        return h("div", { class: "fl-bay fl-bay-" + b.id + (list.length ? " has-work" : ""), "data-bay": b.id },
          h("div", { class: "fl-bay-h", title: b.desc }, G.icon(b.id === "sechold" ? "shield" : b.id === "person" ? "human" : b.id === "queue" ? "clock" : b.id === "declined" ? "x" : "st-park"), h("span", { class: "fl-bay-n" }, b.name), h("span", { class: "mono fl-bay-c" }, String(list.length))),
          h("div", { class: "fl-bay-toks" }, shown.map(function (w) { return fixTokTime(G.woToken(w, { compact: true, idPrefix: "floor-tok-" }), w); }),
            b.id === "declined" && list.length > 3 ? h("span", { class: "muted small" }, (list.length - 3) + " older") : null));
      })));
  }

  function shipped(p, wos) {
    var done = wos.filter(function (w) { return w.state === "done" && !w.split; }).sort(function (a, b) { return b.doneAt - a.doneAt; });
    var today = done.filter(function (w) { return w.doneAt > nowT() - G.DAY; }).length;
    return h("section", { class: "fl-ship", "data-ship": "1", style: "--o:99", "aria-label": "Shipped" },
      h("div", { class: "fl-ship-h" }, G.icon("rocket"), h("span", { class: "fl-ship-t" }, "Shipped"), h("span", { class: "mono small" }, today + " in 24h · " + done.length + " total")),
      h("div", { class: "fl-ship-toks" }, done.slice(0, 6).map(function (w) { return G.woToken(w, { compact: true, idPrefix: "floor-tok-" }); }), !done.length ? h("span", { class: "muted small" }, "Nothing shipped yet.") : null));
  }

  function beltStatus(p) {
    if (ui.rp) {
      var s = ui.rp.state, at = " · " + G.fmt.stamp(ui.rp.at);
      if (s.killed) return { cls: "is-replay is-killed", label: "Replay · " + (s.killed.scope === "factory" ? "factory" : "project") + " killed at this time" + at, icon: "st-kill" };
      if (s.halted) return { cls: "is-replay is-halted", label: "Replay · halted at this time" + at, icon: "halt" };
      return { cls: "is-replay", label: "Replay · not live" + at, icon: "replay" };
    }
    var f = G.store.get("factory").killed;
    if (f) return { cls: "is-killed", label: "Line stopped · factory killed", icon: "st-kill" };
    if (p.killed) return { cls: "is-killed", label: "Line stopped · project killed", icon: "st-kill" };
    if (p.status === "archived") return { cls: "is-killed", label: "Archived", icon: "lock" };
    if (p.halted) return { cls: "is-halted", label: "Halted · andon pulled", icon: "halt" };
    if (prefs().paused) return { cls: "is-paused", label: "Simulation paused", icon: "pause" };
    var rh = G.store.get("repos").filter(function (r) { return r.project === p.id && r.halted; });
    if (rh.length) return { cls: "is-partial", label: "Running · " + rh.length + " repo" + (rh.length > 1 ? "s" : "") + " halted", icon: "halt" };
    return { cls: "is-live", label: "Running · simulated tick 3.5 s", icon: "st-run" };
  }

  function belt(p, wos) {
    var status = beltStatus(p);
    var classes = G.classesOf(p);
    var active = prefs().activeClass;
    var repoHalts = ui.rp ? Object.keys(ui.rp.state.haltedRepos).map(function (id) { var r = G.find.repo(id) || { name: id }; return { name: r.name, halted: { reason: ui.rp.state.haltedRepos[id].text || "" } }; })
      : G.store.get("repos").filter(function (r) { return r.project === p.id && r.halted; });
    var L = LAYOUT = layoutFor(p);
    var turnGate = gateFor(p, L.top[L.top.length - 1]);
    var bottomVisual = L.bottom.slice().reverse();
    var grid = h("div", { class: "fl-grid" + (L.bottom.length > 4 || L.top.length > 5 ? " has-custom" : "") + (Math.max(L.top.length, L.bottom.length) > 5 ? " is-dense" : "") },
      h("div", { class: "fl-row fl-top" }, L.top.map(function (sid, k) {
        var g = gateFor(p, sid);
        return [stationCard(p, wos, sid), k < L.top.length - 1 ? (g ? gateNode(p, wos, g.id) : h("div", { class: "fl-link", "aria-hidden": "true" })) : null];
      })),
      h("div", { class: "fl-turn" }, turnGate ? gateNode(p, wos, turnGate.id) : null),
      bays(p, wos),
      h("div", { class: "fl-row fl-bottom" }, bottomVisual.map(function (sid, k) {
        if (k === 0) return stationCard(p, wos, sid);
        var earlier = sid, g = gateFor(p, earlier);
        return [g && g.id !== "G6" ? gateNode(p, wos, g.id) : h("div", { class: "fl-link", "aria-hidden": "true", title: "No gate between " + G.find.station(earlier).name + " and " + G.find.station(bottomVisual[k - 1]).name }), stationCard(p, wos, sid)];
      })),
      h("div", { class: "fl-row fl-g6" }, gateFor(p, L.bottom[L.bottom.length - 1]) ? gateNode(p, wos, gateFor(p, L.bottom[L.bottom.length - 1]).id) : null),

      shipped(p, wos));
    /* column templates follow the children so custom stations fit the row */
    if (L.bottom.length !== 4 || L.top.length !== 5) {
      var colsOf = function (row) { return Array.prototype.map.call(row.children, function (c) { return c.classList.contains("fl-gate") ? "60px" : c.classList.contains("fl-link") ? "24px" : c.classList.contains("is-build") ? "minmax(0, 1.6fr)" : "minmax(0, 1fr)"; }).join(" "); };
      var top = grid.querySelector(".fl-top"), bot = grid.querySelector(".fl-bottom"), g6 = grid.querySelector(".fl-g6");
      top.style.setProperty("--cols", colsOf(top)); bot.style.setProperty("--cols", colsOf(bot)); g6.style.setProperty("--cols", colsOf(bot));
    }
    var svg = h("div", { class: "fl-svg", "aria-hidden": "true" });
    return h("section", { class: "fl-belt " + status.cls, id: "floor-belt", "aria-label": "Belt for " + p.name + ". " + status.label, "data-active": active || "" },
      h("div", { class: "fl-belt-head" },
        h("div", { class: "fl-stamp" }, G.icon(status.icon), h("span", null, status.label)),
        repoHalts.length ? h("div", { class: "fl-halts" }, repoHalts.map(function (r) { return h("span", { class: "chip chip-block", title: r.halted.reason }, G.icon("halt"), " " + r.name + " halted"); })) : null,
        h("div", { class: "fl-legend", "aria-label": "Gate legend" },
          legendItem("clear", "clear"), legendItem("waiting", "waiting on people"), legendItem("failing", "failing"), legendItem("off", "off"))),
      h("div", { class: "fl-routes", role: "group", "aria-label": "Class routes. Hover to preview, select to pin" },
        h("span", { class: "fl-routes-l" }, "Routes"), classes.map(function (c) { return classRoutePill(p, c); })),
      h("div", { class: "fl-stage", "data-keep-scroll": "floor-belt" }, svg, grid));
  }
  function legendItem(state, text) {
    return h("span", { class: "fl-leg gate-" + state }, h("span", { class: "fl-leg-d", "aria-hidden": "true" }), text);
  }

  /* highlight the route of a class (hover or pinned) without a re-render */
  function highlight() {
    var beltEl = document.getElementById("floor-belt"); if (!beltEl) return;
    var p = G.currentProject(); if (!p) return;
    var cls = ui.hover || prefs().activeClass;
    var route = cls ? G.route(p, cls) : null;
    var gates = cls ? G.routeGates(p, cls) : null;
    var name = cls ? G.classOf(p, cls).name : "";
    beltEl.classList.toggle("has-route", !!cls);
    beltEl.querySelectorAll("[data-station]").forEach(function (el) {
      var sid = el.getAttribute("data-station");
      var by = route && route.indexOf(sid) < 0;
      el.classList.toggle("is-bypassed", !!by);
      el.querySelector(".fl-bypass").textContent = by ? "Bypassed by " + name : "";
    });
    beltEl.querySelectorAll("[data-gate]").forEach(function (el) { el.classList.toggle("is-offroute", !!gates && gates.indexOf(el.getAttribute("data-gate")) < 0); });
    beltEl.querySelectorAll(".fl-route").forEach(function (el) { el.classList.toggle("is-hl", el.getAttribute("data-cls") === cls); });
    drawBelt(beltEl, cls, route);
  }

  /* SVG conveyor layer: measured from the laid-out cards. */
  function drawBelt(beltEl, cls, route) {
    var stage = beltEl.querySelector(".fl-stage"), holder = beltEl.querySelector(".fl-svg");
    if (!stage || !holder) return;
    var sr = stage.getBoundingClientRect();
    if (!sr.width) return;
    function box(sel) { var el = stage.querySelector(sel); if (!el) return null; var r = el.getBoundingClientRect(); return { l: r.left - sr.left, t: r.top - sr.top, w: r.width, h: r.height, cx: r.left - sr.left + r.width / 2, cy: r.top - sr.top + r.height / 2, r: r.right - sr.left, b: r.bottom - sr.top }; }
    var vertical = getComputedStyle(stage.querySelector(".fl-grid")).getPropertyValue("--vertical").trim() === "1";
    var W = Math.round(sr.width), H = Math.round(stage.scrollHeight);
    var s = "";
    var d, arrows = [];
    if (vertical) {
      var first = box('[data-station="intake"]'), last = box("[data-ship]");
      var gx = box('[data-gate="G0G1"] .gate-shape'); var x = gx ? Math.round(gx.cx) : 18;
      d = "M" + x + " " + (first.t + 10) + " V" + (last.t + 8);
      [["research", 0], ["plan", 0], ["verify", 0], ["close", 0]].forEach(function (a) { var b = box('[data-station="' + a[0] + '"]'); if (b) arrows.push([x, b.t - 8, 90]); });
    } else {
      var L0 = LAYOUT.top, L1 = LAYOUT.bottom;
      var intake = box('[data-station="' + L0[0] + '"]'), ship = box("[data-ship]"), plan = box('[data-station="' + L0[L0.length - 1] + '"]'), build = box('[data-station="' + L1[0] + '"]'), close = box('[data-station="' + L1[L1.length - 1] + '"]');
      if (!intake || !ship || !plan || !build || !close) { holder.innerHTML = ""; return; }
      var g0 = box(".fl-top .fl-gate .gate-shape"), turn = box(".fl-turn .gate-shape"), g4 = box(".fl-bottom .fl-gate .gate-shape"), g6 = box(".fl-g6 .gate-shape");
      var yT = g0 ? g0.cy : intake.t + 40, xT = turn ? turn.cx : plan.r + 32, yB = g4 ? g4.cy : build.t + 40, xG = g6 ? g6.cx : close.cx, R = 18;
      if (!g6) g6 = { t: close.b + 20 };

      d = "M" + (intake.l - 6) + " " + yT + " H" + (xT - R) + " Q" + xT + " " + yT + " " + xT + " " + (yT + R) + " V" + (yB - R) + " Q" + xT + " " + yB + " " + (xT - R) + " " + yB + " H" + (xG + R) + " Q" + xG + " " + yB + " " + xG + " " + (yB + R) + " V" + (ship.t + 6);
      arrows.push([(plan.r + xT) / 2, yT, 0], [xT, (yT + yB) / 2 - 40, 90], [xT, (yT + yB) / 2 + 40, 90], [(build.r + xT) / 2, yB, 180], [xG, (close.b + g6.t) / 2, 90]);
    }
    s += '<path d="' + d + '" class="fl-band"/>';
    s += '<path d="' + d + '" class="fl-rollers"/>';
    s += '<path d="' + d + '" class="fl-center"/>';
    arrows.forEach(function (a) { s += '<path d="M-4 -5 L4 0 L-4 5" class="fl-arrow" transform="translate(' + a[0].toFixed(1) + " " + a[1].toFixed(1) + ") rotate(" + a[2] + ')"/>'; });
    /* bypass arcs for the highlighted class (horizontal layout only) */
    if (cls && route && !vertical) {
      var p = G.currentProject();
      var name = G.classOf(p, cls).name;
      var rows = [LAYOUT.top, LAYOUT.bottom];
      rows.forEach(function (row, ri) {
        var k = 0;
        while (k < row.length) {
          if (route.indexOf(row[k]) >= 0) { k++; continue; }
          var j = k; while (j < row.length && route.indexOf(row[j]) < 0) j++;
          var a = box('[data-station="' + row[k] + '"]'), b = box('[data-station="' + row[j - 1] + '"]');
          var label = name + " skips " + row.slice(k, j).map(function (sid) { return G.find.station(sid).name; }).join(", ");
          var ends = j >= row.length && ri === 1 || (G.classOf(p, cls).endsAfter && sidx(row[k]) > sidx(G.classOf(p, cls).endsAfter));
          if (ri === 0) {
            var x1 = a.l - 10, x2 = b.r + 10, y = a.t + 4, top = a.t - 22;
            s += '<path d="M' + x1 + " " + (y + 10) + " C" + x1 + " " + top + " " + x2 + " " + top + " " + x2 + " " + (y + 10) + '" class="fl-bypass-arc"/>';
            s += pill((x1 + x2) / 2, top + 3, ends ? name + " ends here" : label);
          } else {
            var l = Math.min(a.l, b.l) - 10, r = Math.max(a.r, b.r) + 10, yb = a.b - 4, bot = a.b + 22;
            s += '<path d="M' + r + " " + (yb - 10) + " C" + r + " " + bot + " " + l + " " + bot + " " + l + " " + (yb - 10) + '" class="fl-bypass-arc"/>';
            s += pill((l + r) / 2, bot - 3, ends ? name + " ends before here" : label);
          }
          k = j;
        }
      });
    }
    holder.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' + s + "</svg>";
  }
  function pill(x, y, text) {
    var w = Math.max(60, text.length * 6.1 + 16);
    return '<g class="fl-pill"><rect x="' + (x - w / 2).toFixed(1) + '" y="' + (y - 9).toFixed(1) + '" width="' + w.toFixed(1) + '" height="18" rx="9"/><text x="' + x.toFixed(1) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="middle">' + G.esc(text) + "</text></g>";
  }

  /* FLIP: tokens that changed spot slide from their old position */
  function animateTokens(node) {
    var pos = {}, spot = {};
    var list = node.querySelectorAll("#floor-belt .tok[data-wo]");
    list.forEach(function (el) {
      var id = el.getAttribute("data-wo"), w = (ui.vmap && ui.vmap[id]) || G.find.wo(id); if (!w) return;
      var r = el.getBoundingClientRect();
      pos[id] = [r.left, r.top]; spot[id] = (w.bay || w.station) + ":" + (w.state === "done" ? "d" : w.state === "killed" ? "k" : "");
      var old = ui.prevPos[id];
      if (old && ui.prevSpot[id] && ui.prevSpot[id] !== spot[id] && motionOk() && el.animate) {
        var dx = old[0] - r.left, dy = old[1] - r.top;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          el.classList.add("fl-moving");
          var a = el.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: 650, easing: "cubic-bezier(.3,.7,.2,1)" });
          a.onfinish = function () { el.classList.remove("fl-moving"); };
        }
      }
    });
    ui.prevPos = pos; ui.prevSpot = spot;
  }

  /* ================= board ================= */
  function assigneeOf(w) { return w.bay || w.state === "done" || w.state === "killed" ? null : openEntry(w).agent; }
  function applyFilters(list) {
    var f = filters();
    return list.filter(function (w) {
      return (f.cls === "all" || w.cls === f.cls) && (f.repo === "all" || w.repo === f.repo) && (f.prio === "all" || w.priority === f.prio) && (f.assignee === "all" || assigneeOf(w) === f.assignee);
    });
  }
  function setFilter(k) { return function (v) { setPref(function (x) { x.boardFilters = Object.assign({ cls: "all", repo: "all", assignee: "all", prio: "all" }, x.boardFilters || {}); x.boardFilters[k] = v; }); }; }

  function filterBar(p, wos, withSwim) {
    var f = filters();
    var repos = G.store.get("repos").filter(function (r) { return r.project === p.id; });
    var agents = [];
    wos.forEach(function (w) { var a = assigneeOf(w); if (a && agents.indexOf(a) < 0) agents.push(a); });
    var any = f.cls !== "all" || f.repo !== "all" || f.prio !== "all" || f.assignee !== "all";
    return h("div", { class: "toolbar fl-toolbar" },
      h("div", { class: "filters" },
        G.field("Class", G.select("floor-f-cls", [{ value: "all", label: "All classes" }].concat(G.classesOf(p).map(function (c) { return { value: c.id, label: c.name }; })), f.cls, setFilter("cls"))),
        G.field("Repo", G.select("floor-f-repo", [{ value: "all", label: "All repos" }].concat(repos.map(function (r) { return { value: r.id, label: r.name }; })), f.repo, setFilter("repo"))),
        G.field("Assignee", G.select("floor-f-assignee", [{ value: "all", label: "Anyone" }].concat(agents.map(function (a) { return { value: a, label: G.actorName(a).replace(" (agent)", "") }; })), f.assignee, setFilter("assignee"))),
        G.field("Priority", G.select("floor-f-prio", ["all", "P1", "P2", "P3"].map(function (x) { return { value: x, label: x === "all" ? "Any priority" : x }; }), f.prio, setFilter("prio"))),
        withSwim ? G.field("Swimlanes", G.select("floor-f-swim", [{ value: "none", label: "None" }, { value: "repo", label: "By repo" }, { value: "class", label: "By class" }], prefs().boardSwim || "none", function (v) { setPref(function (x) { x.boardSwim = v; }); })) : null,
        any ? G.btn("Clear filters", { small: true, kind: "ghost", icon: "x", id: "floor-f-clear", onClick: function () { setPref(function (x) { x.boardFilters = { cls: "all", repo: "all", assignee: "all", prio: "all" }; }); } }) : null));
  }

  function gateText(p, w) {
    if (w.state === "killed") return { t: "Killed", c: "kill" };
    if (w.bay) return { t: G.bayDef(w.bay).name, c: "park" };
    var g = G.gateForWO(p, w);
    if (w.state === "waiting" && g) { var pr = G.gateProgress(p, w, g.id); return { t: g.label + " waiting" + (g.id === "G0G1" ? "" : " " + pr.have + "/" + pr.need), c: "wait" }; }
    if (w.state === "failed") return { t: (g ? g.label : "check") + " failing", c: "fail" };
    if (w.state === "blocked") return { t: "Blocked", c: "block" };
    return g ? { t: "next " + g.label, c: "" } : { t: "no gate next", c: "" };
  }

  function targetsFor(w) {
    var out = [];
    var fl = G.flowOf(G.find.project(w.project));
    fl.stations.forEach(function (s) { out.push({ id: s.id, label: s.no + " " + s.name }); });
    fl.bays.forEach(function (b) { out.push({ id: b.id, label: b.name, bay: true }); });
    return out.map(function (t) { return Object.assign(t, { check: G.moveCheck(w, t.id) }); });
  }

  function moveMenu(anchor, w) {
    var items = [];
    var ts = targetsFor(w);
    ts.forEach(function (t, i) {
      if (t.bay && i > 0 && !ts[i - 1].bay) items.push({ sep: true });
      items.push({ label: t.label, icon: t.bay ? "st-park" : "move", hint: t.check.allowed ? ({ approve: "approve gate", back: "send back", park: "park", unpark: "return" })[t.check.kind] : null,
        guard: t.check.allowed ? null : { allowed: false, reason: t.check.reason, needs: "" }, onClick: function () { performMove(w.id, t.id); } });
    });
    G.menu(anchor, "Move " + w.id + " to", items);
  }

  function performMove(woId, target) {
    var w = G.find.wo(woId); if (!w) return;
    var c = G.moveCheck(w, target);
    if (!c.allowed) { G.toast("Cannot move " + w.id + ": " + c.reason, "error"); return; }
    if (c.kind === "park") {
      var bay = G.bayDef(target);
      G.reasonDialog({ title: (target === "declined" ? "Decline " : "Move " + w.id + " to ") + (target === "declined" ? w.id : bay.name), kicker: "Board move", ok: target === "declined" ? "Decline" : "Move to " + bay.name, kind: target === "declined" ? "danger" : "primary", min: target === "declined" ? 5 : 3,
        sub: bay.desc + ". It returns to " + G.STATIONS[w.station].name + " when someone releases it.", placeholder: "Why?",
        onOk: function (v) { var r = G.ops.moveTo(w.id, target, v); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      return;
    }
    if (c.kind === "back") {
      G.reasonDialog({ title: "Send " + w.id + " back to " + G.find.station(target).name, kicker: "Board move", ok: "Send back", min: 3, label: "Note for the agent",
        sub: "The station's agent picks it up again with your note. Gates after that station reset.", placeholder: "What needs to change?",
        onOk: function (v) { var r = G.ops.moveTo(w.id, target, v); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      return;
    }
    res(G.ops.moveTo(w.id, target));
  }

  function card(p, w) {
    var gt = gateText(p, w);
    var e = openEntry(w);
    var agent = assigneeOf(w);
    var moveB = h("button", { type: "button", class: "icon-btn icon-btn-sm fl-card-move", id: "floor-move-" + w.id, "aria-label": "Move " + w.id + " to another station or bay", "aria-haspopup": "menu", "data-tip": "Move to" }, G.icon("move"));
    if (ui.rp) G.guard(moveB, REPLAY_LOCK);
    moveB.addEventListener("click", function () { if (moveB.getAttribute("aria-disabled") === "true") { G.tip.show(moveB); return; } moveMenu(moveB, w); });
    var open = h("button", { type: "button", class: "fl-card-title", id: "floor-card-" + w.id }, w.title);
    open.addEventListener("click", function () { G.openTraveler(w.id); });
    var c = h("article", { class: "fl-card fl-card-" + w.state + (w.heldByKill ? " is-held" : ""), "data-wo": w.id, "aria-label": w.id + " " + w.title },
      h("div", { class: "fl-card-top" },
        h("span", { class: "fl-grip", "aria-hidden": "true", title: "Drag to move" }, G.icon("grip")),
        G.icon(G.STATES[w.state].glyph, "fl-card-glyph"), h("span", { class: "mono fl-card-id" }, w.id), h("span", { class: "chip fl-prio prio-" + w.priority }, w.priority), moveB),
      open,
      h("div", { class: "fl-card-meta" }, G.classChip(w.cls, { small: true }), h("span", { class: "mono fl-card-repo" }, (G.find.repo(w.repo) || {}).name || w.repo)),
      h("div", { class: "fl-card-foot" },
        agent ? h("span", { class: "fl-card-agent" }, G.avatar(agent, "xs"), G.actorName(agent).replace(" (agent)", "")) : h("span", { class: "muted" }, w.state === "killed" ? "stopped" : "no agent"),
        h("span", { class: "mono muted" }, w.state === "killed" ? "killed" : G.fmt.dur(Math.max(0, nowT() - since(w)))),
        h("span", { class: "fl-gt fl-gt-" + gt.c }, gt.t)));
    c.addEventListener("pointerdown", function (ev) { dragStart(ev, w, c); });
    return c;
  }

  function dragStart(ev, w, el) {
    if (ev.button !== 0 || ui.rp) return;
    if (ev.target.closest("button") && !ev.target.closest(".fl-grip")) return;
    if (w.state === "killed" || w.state === "done") return;
    ui.drag = { wo: w.id, x: ev.clientX, y: ev.clientY, el: el, started: false, over: null };
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragEnd);
    window.addEventListener("pointercancel", dragCancel);
  }
  function dragMove(ev) {
    var d = ui.drag; if (!d) return;
    if (!d.started) {
      if (Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < 6) return;
      d.started = true;
      var r = d.el.getBoundingClientRect();
      d.dx = d.x - r.left; d.dy = d.y - r.top;
      d.ghost = d.el.cloneNode(true); d.ghost.removeAttribute("id"); d.ghost.querySelectorAll("[id]").forEach(function (x) { x.removeAttribute("id"); });
      d.ghost.classList.add("fl-ghost"); d.ghost.style.width = r.width + "px";
      d.ghost.setAttribute("aria-hidden", "true");
      document.body.appendChild(d.ghost);
      d.el.classList.add("is-dragging");
      document.body.classList.add("fl-dragging");
    }
    ev.preventDefault();
    d.ghost.style.transform = "translate(" + (ev.clientX - d.dx) + "px," + (ev.clientY - d.dy) + "px)";
    var under = document.elementFromPoint(ev.clientX, ev.clientY);
    var col = under && under.closest("[data-drop]");
    var target = col ? col.getAttribute("data-drop") : null;
    if (target !== d.over) {
      document.querySelectorAll(".fl-col.is-over").forEach(function (x) { x.classList.remove("is-over", "is-ok", "is-no"); x.removeAttribute("data-why"); });
      d.over = target;
      if (col) {
        var c = G.moveCheck(G.find.wo(d.wo), target);
        col.classList.add("is-over", c.allowed ? "is-ok" : "is-no");
        var hint = col.querySelector(".fl-col-why"); if (hint) hint.textContent = c.allowed ? c.reason : "Refused: " + c.reason;
      }
    }
  }
  function dragFinish() {
    var d = ui.drag; ui.drag = null;
    window.removeEventListener("pointermove", dragMove); window.removeEventListener("pointerup", dragEnd); window.removeEventListener("pointercancel", dragCancel);
    if (d && d.ghost) d.ghost.remove();
    document.body.classList.remove("fl-dragging");
    document.querySelectorAll(".fl-col.is-over").forEach(function (x) { x.classList.remove("is-over", "is-ok", "is-no"); var hint = x.querySelector(".fl-col-why"); if (hint) hint.textContent = ""; });
    if (d && d.el) d.el.classList.remove("is-dragging");
    return d;
  }
  function dragEnd() {
    var d = dragFinish();
    if (d && d.started && d.over) {
      var w = G.find.wo(d.wo);
      var cur = w.bay || G.STATIONS[w.station].id;
      if (d.over !== cur) performMove(d.wo, d.over);
    }
    G.rerender();
  }
  function dragCancel() { dragFinish(); G.rerender(); }

  function board(p, wos) {
    var list = applyFilters(wos.filter(function (w) { return w.state !== "done"; }));
    var swim = prefs().boardSwim || "none";
    var collapsed = !!prefs().collapsedBays;
    var lanes;
    if (swim === "repo") lanes = G.store.get("repos").filter(function (r) { return r.project === p.id; }).map(function (r) { return { id: r.id, label: r.name, items: list.filter(function (w) { return w.repo === r.id; }) }; });
    else if (swim === "class") lanes = G.classesOf(p).map(function (c) { return { id: c.id, label: c.name, items: list.filter(function (w) { return w.cls === c.id; }) }; }).filter(function (l) { return l.items.length; });
    else lanes = [{ id: "all", label: null, items: list }];
    var shipped7 = wos.filter(function (w) { return w.state === "done" && !w.split && w.doneAt > Date.now() - 7 * G.DAY; }).length;
    var allLive = wos.filter(function (w) { return isLive(w) && !w.bay; });

    var cols = G.flowOf(p).stations.map(function (s) { return { id: s.id, station: s }; });
    var bayCols = G.flowOf(p).bays.map(function (b) { return { id: b.id, bay: b }; });

    function colHead(c, laneItems) {
      if (c.station) {
        var conf = p.flow.stations[c.id];
        var n = allLive.filter(function (w) { return w.station === sidx(c.id); }).length;
        var over = conf.enabled && n > conf.wip;
        var g = G.gateAfter(c.id);
        return h("div", { class: "fl-col-h" + (over ? " is-over" : "") },
          h("span", { class: "mono fl-st-no" }, c.station.no), h("span", { class: "fl-col-name" }, c.station.name),
          h("span", { class: "mono fl-wip" + (over ? " is-over" : ""), title: over ? "Over the WIP limit of " + conf.wip : "WIP limit " + conf.wip }, conf.enabled ? n + "/" + conf.wip : "off"),
          over ? h("span", { class: "fl-over-l" }, G.icon("alert"), "over limit") : null,
          g && p.flow.gates[g.id] && !p.flow.gates[g.id].absent && (p.flow.gates[g.id].enabled || g.id === "G0G1") ? h("span", { class: "fl-col-gate mono", title: g.name }, G.icon("diamond"), g.label) : null);
      }
      return h("div", { class: "fl-col-h is-bay" }, h("span", { class: "fl-col-name" }, c.bay.name), h("span", { class: "mono fl-wip" }, String(wos.filter(function (w) { return w.bay === c.id && w.state !== "killed"; }).length)));
    }
    function column(c, items, laneId) {
      var here = c.station ? items.filter(function (w) { return !w.bay && w.station === sidx(c.id); }) : items.filter(function (w) { return w.bay === c.id && w.state !== "killed"; });
      var conf = c.station && p.flow.stations[c.id];
      return h("div", { class: "fl-col" + (c.bay ? " is-bay" : "") + (conf && !conf.enabled ? " is-off" : "") + (conf && conf.enabled && allLive.filter(function (w) { return w.station === sidx(c.id); }).length > conf.wip ? " is-over-limit" : ""), "data-drop": c.id, role: "group", "aria-label": (c.station ? c.station.name : c.bay.name) + (laneId !== "all" ? " in lane " + laneId : "") + ": " + here.length },
        laneId === lanes[0].id ? colHead(c) : null,
        h("div", { class: "fl-col-why", "aria-live": "polite" }),
        h("div", { class: "fl-col-cards" }, here.map(function (w) { return card(p, w); }),
          c.id === "close" && laneId === lanes[0].id ? h("p", { class: "fl-col-note" }, G.icon("st-done"), " " + shipped7 + " shipped in 7 days") : null,
          !here.length && conf && !conf.enabled ? h("p", { class: "fl-col-note" }, "Off in this project") : null));
    }
    var bayToggle = G.btn(collapsed ? "Show bays" : "Collapse bays", { small: true, kind: "ghost", icon: collapsed ? "chevron" : "back", id: "floor-bays-toggle", onClick: function () { setPref(function (x) { x.collapsedBays = !x.collapsedBays; }); } });
    bayToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    var bayCount = wos.filter(function (w) { return w.bay && w.state !== "killed"; }).length;
    var wrap = h("div", { class: "fl-board-scroll", "data-keep-scroll": "floor-board" },
      h("div", { class: "fl-board" + (collapsed ? " bays-collapsed" : ""), style: "--cols:" + (cols.length + (collapsed ? 0 : bayCols.length)) },
        lanes.map(function (lane) {
          return h("div", { class: "fl-lane" },
            lane.label ? h("div", { class: "fl-lane-h" }, h("span", { class: "mono" }, lane.label), h("span", { class: "muted small" }, lane.items.length + " work orders")) : null,
            h("div", { class: "fl-lane-cols", style: collapsed ? "grid-template-columns: repeat(" + cols.length + ", 196px) 84px" : null }, cols.map(function (c) { return column(c, lane.items, lane.id); }),
              collapsed ? (lane.id === lanes[0].id ? h("div", { class: "fl-col fl-col-collapsed" }, h("div", { class: "fl-col-h is-bay" }, h("span", { class: "fl-col-name" }, "Bays"), h("span", { class: "mono fl-wip" }, String(bayCount)))) : h("div", { class: "fl-col fl-col-collapsed" }))
                : bayCols.map(function (c) { return column(c, lane.items, lane.id); })));
        })));
    return h("div", { class: "fl-boardwrap" },
      filterBar(p, wos, true),
      h("div", { class: "fl-board-tools" }, h("p", { class: "muted small" }, ui.rp ? "Board as it was at " + G.fmt.stamp(ui.rp.at) + ". Moves are locked in replay. " + list.length + " work orders shown." : "Drag a card by its grip or body, or use its Move button. Refused moves say why. " + list.length + " work orders shown."), bayToggle),
      wrap);
  }

  /* ================= list ================= */
  function whereText(w) { return w.bay ? G.bayDef(w.bay).name : G.STATIONS[w.station].no + " " + G.STATIONS[w.station].name; }
  function listView(p, wos) {
    var rows = applyFilters(wos);
    var s = ui.sort;
    var fl = G.flowOf(p), bayIds = fl.bays.map(function (b) { return b.id; }), order = fl.stations.map(function (x) { return x.id; });
    var keyf = {
      id: function (w) { return w.id; }, title: function (w) { return w.title.toLowerCase(); }, cls: function (w) { return w.cls; }, repo: function (w) { return w.repo; },
      where: function (w) { return w.state === "done" ? 1000 : w.bay ? 500 + bayIds.indexOf(w.bay) : order.indexOf(G.STATIONS[w.station].id); },
      state: function (w) { return w.state; }, prio: function (w) { return w.priority; }, age: function (w) { return since(w); }, cost: function (w) { return G.woTotals(w).cost; }
    };
    rows.sort(function (a, b) { var x = keyf[s.k](a), y = keyf[s.k](b); return (x < y ? -1 : x > y ? 1 : 0) * s.dir; });
    function th(k, label, num) {
      var on = s.k === k;
      var b = h("button", { type: "button", class: "th-sort", id: "floor-sort-" + k }, label, on ? G.icon(s.dir > 0 ? "up" : "down") : null);
      b.addEventListener("click", function () { ui.sort = { k: k, dir: on ? -s.dir : 1 }; G.rerender(); });
      return h("th", { class: num ? "num" : null, "aria-sort": on ? (s.dir > 0 ? "ascending" : "descending") : "none", scope: "col" }, b);
    }
    return h("div", { class: "fl-listwrap" },
      filterBar(p, wos, false),
      h("div", { class: "table-scroll", "data-keep-scroll": "floor-list" },
        h("table", { class: "table table-compact fl-table" },
          h("caption", { class: "sr" }, "Work orders in " + p.name),
          h("thead", null, h("tr", null, th("id", "ID"), th("title", "Title"), th("cls", "Class"), th("repo", "Repo"), th("where", "Station or bay"), th("state", "State"), h("th", { scope: "col" }, "Gate"), h("th", { scope: "col" }, "Agent"), th("prio", "Priority"), th("age", "Here for", true), th("cost", "Cost", true))),
          h("tbody", null, rows.length ? rows.map(function (w) {
            var gt = gateText(p, w), ag = assigneeOf(w);
            var b = h("button", { type: "button", class: "linkish mono", id: "floor-row-" + w.id }, w.id);
            b.addEventListener("click", function () { G.openTraveler(w.id); });
            return h("tr", { class: "fl-tr-" + w.state }, h("td", null, b), h("td", { class: "fl-td-title" }, w.title), h("td", null, G.classChip(w.cls, { small: true })), h("td", { class: "mono small" }, (G.find.repo(w.repo) || {}).name || w.repo),
              h("td", null, whereText(w)), h("td", null, G.stateChip(w.state)), h("td", null, w.state === "done" ? h("span", { class: "muted" }, w.split ? "split" : "shipped") : h("span", { class: "fl-gt fl-gt-" + gt.c }, gt.t)),
              h("td", { class: "small" }, ag ? G.actorName(ag).replace(" (agent)", "") : "none"), h("td", { class: "mono" }, w.priority), h("td", { class: "num mono" }, w.state === "done" ? "done" : G.fmt.dur(Math.max(0, nowT() - since(w)))), h("td", { class: "num mono" }, G.fmt.money(G.woTotals(w).cost)));
          }) : h("tr", null, h("td", { colspan: "11" }, G.empty("No work orders match", "Clear the filters to see everything in " + p.name + ".")))))));
  }

  /* ================= view ================= */
  function render() {
    if (ui.drag && ui.drag.started && ui.lastNode) return ui.lastNode;
    var p = G.currentProject();
    if (!p) return h("div", { class: "view" }, G.empty("No project selected", "Pick a project in the top bar to see its floor."));
    ui.rp = replayCtx(p);
    if (!ui.rp) { stopTimer(); ui.vmap = null; }
    var wos = ui.rp ? replayWos(p, ui.rp) : projWos(p);
    var view = prefs().floorView || "belt";
    var seg = G.segmented("floor-view", [{ id: "belt", label: "Belt", icon: "belt" }, { id: "board", label: "Board", icon: "board" }, { id: "list", label: "List", icon: "list" }], view, function (v) { setPref(function (x) { x.floorView = v; }); }, "Floor view");
    var body = view === "board" ? board(p, wos) : view === "list" ? listView(p, wos) : belt(p, wos);
    var enter = ui.rp ? null : G.btn("Replay", { icon: "replay", id: "floor-replay-enter", aria: "Replay the floor over the last 24 hours or 7 days", onClick: function () { enterReplay(p); } });
    var node = h("div", { class: "view view-floor" + (ui.rp ? " is-replaying" : "") }, header(p, wos),
      h("div", { class: "fl-switch" }, seg, enter, h("span", { class: "muted small" }, ui.rp ? "Replaying recorded history. Nothing here changes the live floor." : "Agents, ticks and external systems are simulated locally.")),
      ui.rp ? replayBar(p, ui.rp) : null,
      body);

    ui.lastNode = node;
    return node;
  }

  G.views.floor = {
    title: "Floor",
    render: render,
    keys: ["workOrders", "projects", "repos", "agents", "skills", "mcp", "factory"],
    afterRender: function (node) {
      var beltEl = node.querySelector("#floor-belt");
      if (beltEl) { highlight(); animateTokens(node); }
    },
    onResize: function () { var b = document.getElementById("floor-belt"); if (b) highlight(); }
  };
  G.floorOpenGate = openGate;
  G.floorOpenStation = openStation;
})(window.G);
