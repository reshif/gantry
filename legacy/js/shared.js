/* Shared domain widgets used by many views: class chip, gate diamond, mini belt,
   stop banners, typed-confirm dialog, kill/restore/halt dialogs, work-order token, history list. */
(function (G) {
  "use strict";
  var h = G.h;

  G.classChip = function (clsId, opts) {
    var c = G.find.cls(clsId) || { id: clsId, name: clsId };
    var shape = c.shape && /^(bar|arrow|wide)$/.test(c.shape) ? " cls-shape-" + c.shape : "";
    return h("span", { class: "cls cls-" + c.id + (c.custom && c.token ? " " + c.token : "") + shape + (opts && opts.small ? " cls-sm" : ""), title: c.name }, h("span", { class: "cls-mark", "aria-hidden": "true" }), c.name);
  };
  G.bayChip = function (bayId) {
    var b = G.bayDef(bayId);
    return h("span", { class: "bay-chip bay-" + bayId }, G.icon("st-park"), b ? b.name : bayId);
  };

  /* gate state for a whole station column (or a single WO): clear | waiting | failing | off */
  G.gateState = function (project, gateId, wos) {
    if (project && project.flow.gates[gateId] && !project.flow.gates[gateId].enabled && gateId !== "G0G1") return { state: "off", waiting: 0, failing: 0 };
    var waiting = 0, failing = 0;
    (wos || []).forEach(function (w) { var g = w.gates[gateId]; if (!g) return; if (g.status === "waiting" && !w.bay) waiting++; if (g.status === "failed") failing++; });
    return { state: failing ? "failing" : waiting ? "waiting" : "clear", waiting: waiting, failing: failing };
  };
  /* <button> diamond. o: { gateId, state, count, onClick, size: "sm"|"md" } */
  G.gateDiamond = function (o) {
    var g = G.gateDef(o.gateId);
    var label = g.label + " " + g.name + ": " + (o.state === "waiting" ? o.count + " waiting on approvers" : o.state === "failing" ? o.count + " failing" : o.state === "off" ? "off in this project" : "clear");
    var b = h(o.onClick ? "button" : "span", { type: o.onClick ? "button" : null, class: "gate gate-" + o.state + " gate-" + (o.size || "md") + " gate-kind-" + g.kind, "aria-label": label, "data-tip": label },
      h("span", { class: "gate-shape", "aria-hidden": "true" }, h("span", { class: "gate-count" }, o.state === "waiting" ? String(o.count) : o.state === "failing" ? "!" : o.state === "off" ? "–" : "✓")),
      o.size === "sm" ? null : h("span", { class: "gate-label mono" }, g.label));
    if (o.onClick) b.addEventListener("click", o.onClick);
    return b;
  };

  /* compact belt: one segment per station with WIP heat and blocked markers.
     o: { project, wos (optional), cls (route highlight), stationsOff (template preview), gatesOff, onStation(sid) } */
  G.miniBelt = function (o) {
    var project = o.project;
    var wos = o.wos || (project ? G.store.get("workOrders").filter(function (w) { return w.project === project.id; }) : []);
    var route = o.cls ? G.route(project, o.cls) : null;
    /* stations in this project's flow order (custom stations included) */
    var stations = G.flowOf(project).stations;
    var max = 1;
    var counts = stations.map(function (s) { var n = wos.filter(function (w) { return w.station === s.index && !w.bay && ["done", "killed"].indexOf(w.state) < 0; }).length; max = Math.max(max, n); return n; });
    var wrap = h("div", { class: "mbelt" + (o.labels ? " has-labels" : "") + (project && (project.killed || G.store.get("factory").killed) ? " is-killed" : project && project.halted ? " is-halted" : ""), role: "img",
      "aria-label": (project ? project.name + " flow: " : "Flow: ") + stations.map(function (s, i) { return s.name + " " + counts[i]; }).join(", ") });
    stations.forEach(function (s, i) {
      var off = o.stationsOff ? o.stationsOff.indexOf(s.id) >= 0 : project && !s.enabled;
      var skipped = route && route.indexOf(s.id) < 0;
      var blocked = wos.some(function (w) { return w.station === s.index && (w.state === "blocked" || w.state === "failed"); });
      var heat = counts[i] / max;
      var seg = h(o.onStation ? "button" : "span", { type: o.onStation ? "button" : null, class: "mseg" + (off ? " is-off" : "") + (skipped ? " is-skipped" : "") + (blocked ? " is-blocked" : "") + (s.custom ? " is-custom" : ""), style: "--heat:" + heat.toFixed(2), title: s.no + " " + s.name + (off ? " (off)" : "") + ": " + counts[i] + " WIP" + (blocked ? ", blocked work" : "") },
        o.labels ? h("span", { class: "mseg-l" }, s.name) : null, h("span", { class: "mseg-n mono" }, off ? "–" : String(counts[i])), blocked ? h("span", { class: "mseg-x", "aria-hidden": "true" }) : null);
      if (o.onStation) seg.addEventListener("click", function () { o.onStation(s.id); });
      wrap.appendChild(seg);
      var g = G.gateAfter(s.id);
      var gcfg = g && project ? project.flow.gates[g.id] : null;
      if (g && !(gcfg && gcfg.absent) && (i < stations.length - 1 || g.id === "G6")) {
        var gOff = o.gatesOff ? o.gatesOff.indexOf(g.id) >= 0 : project && gcfg && !gcfg.enabled && g.id !== "G0G1";
        var gs = gOff ? { state: "off" } : G.gateState(project, g.id, wos);
        wrap.appendChild(h("span", { class: "mgate gate-" + gs.state, title: g.label + (gs.waiting ? ": " + gs.waiting + " waiting" : "") }));
      }
    });
    return wrap;
  };

  /* work-order token for belt/board/lists. o: { compact, onClick, draggable } */
  G.woToken = function (wo, o) {
    o = o || {};
    var e = wo.history[wo.history.length - 1] || {};
    var st = wo.state;
    var time = st === "done" ? "done" : st === "killed" ? "killed" : G.fmt.dur(Date.now() - (wo.bay ? wo.bayAt || e.startedAt : e.startedAt));
    var g = G.gateForWO(G.find.project(wo.project), wo);
    var note = st === "running" ? null : st === "waiting" && g ? "waiting at " + g.label : st === "parked" ? G.bayDef(wo.bay).name : st === "killed" ? "Killed" : st === "blocked" ? "Blocked" : st === "failed" ? "Check failed" : st === "done" ? (wo.split ? "Split" : "Shipped") : "";
    var b = h("button", { type: "button", class: "tok tok-" + st + (wo.heldByKill ? " is-held" : "") + (o.compact ? " tok-compact" : ""), id: (o.idPrefix || "tok-") + wo.id, "data-wo": wo.id,
      "aria-label": wo.id + ", " + wo.title + ", " + G.find.cls(wo.cls).name + ", " + G.STATES[st].label + (note ? ", " + note : "") + ", " + time },
      h("span", { class: "tok-top" }, G.icon(G.STATES[st].glyph, "tok-glyph"), h("span", { class: "mono tok-id" }, wo.id), h("span", { class: "mono tok-time" }, time)),
      o.compact ? null : h("span", { class: "tok-title" }, wo.title),
      h("span", { class: "tok-foot" + (st === "running" ? "" : " has-note") }, G.classChip(wo.cls, { small: true }), st === "running" ? h("span", { class: "tok-prog", role: "progressbar", "aria-valuenow": String(Math.round(wo.progress)), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Station progress" }, h("span", { style: "width:" + Math.round(wo.progress) + "%" })) : h("span", { class: "tok-note" }, note)));
    if (o.onClick !== false) b.addEventListener("click", function () { (o.onClick || G.openTraveler)(wo.id); });
    return b;
  };

  /* banner for factory/project kill or project halt. Returns null when running normally. */
  G.stopBanner = function (projectId) {
    var f = G.store.get("factory").killed;
    var p = projectId && G.find.project(projectId);
    if (f) return h("div", { class: "stop-banner is-kill", role: "alert" }, G.icon("st-kill"), h("div", null, h("strong", null, "FACTORY KILLED"), " · " + f.reason + " · " + G.actorName(f.by) + ", " + G.fmt.stamp(f.at) + " · in-flight work " + (f.mode === "cancel" ? "cancelled" : "held") + (f.restoreApprovals.length ? " · restore approvals " + f.restoreApprovals.length + "/2" : "")));
    if (p && p.killed) return h("div", { class: "stop-banner is-kill", role: "alert" }, G.icon("st-kill"), h("div", null, h("strong", null, "PROJECT KILLED"), " · " + p.name + ": " + p.killed.reason + " · " + G.actorName(p.killed.by) + ", " + G.fmt.stamp(p.killed.at) + " · " + (p.killed.mode === "cancel" ? "work cancelled" : "work held in place")));
    if (p && p.halted) return h("div", { class: "stop-banner is-halt", role: "status" }, G.icon("halt"), h("div", null, h("strong", null, "HALTED"), " · " + p.name + ": " + p.halted.reason + " · " + G.actorName(p.halted.by) + ", " + G.fmt.ist(p.halted.at) + " IST"));
    return null;
  };

  /* typed confirmation. o: { title, kicker, sub, body (Node), phrase, okLabel, kind, guard, onOk(close) -> {ok,msg} } */
  G.typedConfirm = function (o) {
    var input = h("input", { id: "tc-input", class: "input mono", autocomplete: "off", placeholder: o.phrase });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: o.title, kicker: o.kicker, sub: o.sub, wide: o.wide,
      body: h("div", { class: "form-grid" }, o.body || null, G.field("Type " + o.phrase + " to confirm", input), err),
      actions: [{ label: "Cancel" }, { label: o.okLabel || "Confirm", kind: o.kind || "danger", submit: true, id: "tc-ok", guard: o.guard, onClick: function (close) {
        if (input.value !== o.phrase) { err.textContent = "Type " + o.phrase + " exactly."; return; }
        var r = o.onOk(input.value);
        if (r && r.ok === false) { err.textContent = r.msg; return; }
        close();
      } }] });
  };

  /* kill dialog for scope "factory" | "project" | "workorder" */
  G.killDialog = function (scope, id) {
    var project = scope === "project" ? G.find.project(id) : scope === "workorder" ? G.find.project(G.find.wo(id).project) : null;
    var action = "kill." + scope;
    var d = G.me(action, { project: project && project.id });
    var imp = G.ops.killImpact(scope, id);
    var reason = h("textarea", { id: "kill-reason", class: "input", rows: "3", placeholder: "What is happening? This is posted to the notification routes." });
    var mode = "hold";
    var modeSel = scope === "workorder" ? null : G.segmented("kill-mode", [{ id: "hold", label: "Hold in place (resumable)" }, { id: "cancel", label: "Cancel in-flight work" }], mode, function (v) { mode = v; }, "In-flight work");
    var phrase = scope === "factory" ? "KILL FACTORY" : scope === "project" ? project.name : null;
    var confirm = phrase ? h("input", { id: "kill-confirm", class: "input mono", autocomplete: "off", placeholder: phrase }) : null;
    var routes = [];
    (scope === "factory" ? G.store.get("projects") : [project]).forEach(function (p) { p.notifications.filter(function (r) { return r.enabled && r.event === "kill"; }).forEach(function (r) { r.dest.forEach(function (x) { var s = x.channel + " " + x.target; if (routes.indexOf(s) < 0) routes.push(s); }); }); });
    var err = h("div", { class: "form-err", role: "alert" });
    var label = scope === "factory" ? "the whole factory" : scope === "project" ? project.name : id;
    G.dialog({
      title: "Kill " + label, kicker: "Kill switch · " + scope, wide: true,
      sub: "A kill is a hard stop. Agents stop, coding slots are freed, and new submissions are refused" + (scope === "workorder" ? " for this work order." : " until someone restores it."),
      body: h("div", { class: "form-grid" },
        G.lockNote(d, "This kill switch"),
        h("dl", { class: "titleblock kill-impact" },
          scope === "factory" ? h("div", null, h("dt", null, "Projects"), h("dd", null, String(imp.projects))) : null,
          h("div", null, h("dt", null, "Work orders in flight"), h("dd", null, String(imp.workOrders))),
          h("div", null, h("dt", null, "Running agents"), h("dd", null, String(imp.running))),
          h("div", null, h("dt", null, "Coding slots freed"), h("dd", null, String(imp.slots))),
          h("div", null, h("dt", null, "Open PRs"), h("dd", null, String(imp.prs)))),
        G.field("Reason (required)", reason),
        modeSel ? h("div", { class: "field" }, h("div", { class: "field-label" }, "In-flight work"), modeSel, h("div", { class: "field-hint" }, "Hold keeps work where it is and resumes on restore. Cancel moves it to Killed, converts open PRs to drafts, and needs a restore per work order.")) : h("p", { class: "muted small" }, "The work order moves to Killed; its open PR becomes a draft. It stays killed unless someone permitted restores it."),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Who gets notified"), routes.length ? h("ul", { class: "plain-list mono small" }, routes.map(function (x) { return h("li", null, x); })) : h("p", { class: "muted small" }, "No kill routes configured. Add one in Notifications.")),
        confirm ? G.field("Type " + phrase + " to confirm", confirm) : null, err),
      actions: [{ label: "Cancel" }, { label: "Kill " + (scope === "workorder" ? id : scope === "project" ? "project" : "factory"), kind: "danger", icon: "st-kill", submit: true, id: "kill-ok", guard: d, onClick: function (close) {
        var r = G.ops.kill(scope, id, { reason: reason.value, mode: mode, confirmText: confirm ? confirm.value : null });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "warn"); close();
      } }]
    });
  };
  G.restoreDialog = function (scope, id) {
    var project = scope === "project" ? G.find.project(id) : scope === "workorder" ? G.find.project(G.find.wo(id).project) : null;
    var d = G.me("restore." + scope, { project: project && project.id });
    var k = scope === "factory" ? G.store.get("factory").killed : scope === "project" ? project.killed : G.find.wo(id).killed;
    G.reasonDialog({ title: "Restore " + (scope === "factory" ? "the factory" : scope === "project" ? project.name : id), kicker: "Kill switch · restore", ok: "Restore", guard: d, min: 5,
      sub: (k ? "Killed by " + G.actorName(k.by) + " at " + G.fmt.stamp(k.at) + ": " + k.reason + ". " : "") + (scope === "factory" && G.store.get("security").restoreFactoryNeedsTwo ? "Restoring the factory needs two Factory Admins." : ""),
      extra: G.lockNote(d, "Restoring"), placeholder: "Why is it safe to restore?",
      onOk: function (v) { var r = G.ops.restore(scope, id, v); if (r.ok) G.toast(r.msg, "ok"); return r; } });
  };
  G.haltDialog = function (scope, id) {
    var isRepo = scope === "repo";
    var target = isRepo ? G.find.repo(id) : G.find.project(id);
    var pid = isRepo ? target.project : target.id;
    G.reasonDialog({ title: "Pull the andon cord on " + target.name, kicker: "Andon · " + scope, ok: "Halt " + scope, kind: "danger", guard: G.me("line.halt", { project: pid }),
      sub: "A soft, resumable pause. Agents on this " + scope + " stop at their current step until someone resumes it. Use a kill for a hard stop.",
      min: !isRepo && target.regulated ? 20 : 4, placeholder: "What did you see?",
      onOk: function (v) { var r = isRepo ? G.ops.haltRepo(id, v) : G.ops.haltProject(id, v); if (r.ok) G.toast(r.msg, "warn"); return r; } });
  };

  /* audit history for one entity. o: { type, id, limit } */
  G.historyList = function (o) {
    var list = G.store.get("audit").filter(function (e) {
      if (e.entity && e.entity.type === o.type && e.entity.id === o.id) return true;
      return o.type === "wo" ? String(e.target).indexOf(o.id) >= 0 : o.type === "repo" ? e.where === o.id : o.type === "project" ? e.project === o.id : false;
    }).slice().reverse().slice(0, o.limit || 50);
    if (!list.length) return G.empty("No history yet", "Changes to this item are written to the audit ledger and appear here.");
    return h("ol", { class: "history" }, list.map(function (e) {
      return h("li", null, h("span", { class: "mono muted" }, G.fmt.iso(e.at)), G.who(e.actor), h("span", { class: "mono" }, e.action), h("span", null, e.target),
        e.before != null || e.after != null ? h("span", { class: "diff-ba mono small" }, h("del", null, String(e.before)), " → ", h("ins", null, String(e.after))) : null,
        h("span", { class: "outcome o-" + e.outcome }, e.outcome));
    }));
  };

  /* ---------- project health and waiting gates (G.homeKit), used by home, projects and project config ---------- */
  function wosOf(pid) { return G.store.get("workOrders").filter(function (w) { return w.project === pid; }); }
  function inFlight(w) { return ["done", "killed"].indexOf(w.state) < 0 && w.bay !== "declined"; }
  function waitSince(w) { var e = w.history[w.history.length - 1] || {}; return e.endedAt || e.startedAt || w.createdAt; }
  /* gates waiting with their age and SLA (approver rule escalateH) */
  function waitingGates(pid) {
    var out = [];
    G.store.get("workOrders").forEach(function (w) {
      if (pid && w.project !== pid) return;
      if (w.bay || !inFlight(w)) return;
      Object.keys(w.gates).forEach(function (gid) {
        if (w.gates[gid].status !== "waiting") return;
        var p = G.find.project(w.project);
        var rule = p.approvers[gid] || {};
        var age = Date.now() - waitSince(w);
        out.push({ wo: w, gate: gid, age: age, slaH: rule.escalateH || 0, late: rule.escalateH ? age > rule.escalateH * G.HOUR : false });
      });
    });
    return out.sort(function (a, b) { return b.age - a.age; });
  }
  function projectHealth(p) {
    var wos = wosOf(p.id).filter(inFlight);
    if (G.store.get("factory").killed) return { id: "killed", label: "Factory kill", icon: "st-kill", detail: "Stopped by the factory kill switch" };
    if (p.killed) return { id: "killed", label: "Killed", icon: "st-kill" };
    if (p.status === "archived") return { id: "archived", label: "Archived", icon: "st-park" };
    if (p.halted) return { id: "halted", label: "Halted (andon)", icon: "halt" };
    var bad = wos.filter(function (w) { return w.state === "blocked" || w.state === "failed" || w.bay === "sechold"; }).length;
    var late = waitingGates(p.id).filter(function (g) { return g.late; }).length;
    var haltedRepos = G.store.get("repos").filter(function (r) { return r.project === p.id && r.halted; }).length;
    if (bad || late || haltedRepos) return { id: "attention", label: "Needs attention", icon: "alert", detail: [bad ? bad + " blocked or failing" : null, late ? late + " gate" + (late > 1 ? "s" : "") + " past SLA" : null, haltedRepos ? haltedRepos + " repo halted" : null].filter(Boolean).join(", ") };
    if (p.status === "new") return { id: "new", label: "Setting up", icon: "rocket" };
    if (p.status === "onboarding") return { id: "onboarding", label: "Onboarding repos", icon: "rocket" };
    return { id: "ok", label: "Healthy", icon: "st-done" };
  }
  function healthChip(p) { var hl = projectHealth(p); return h("span", { class: "hk-health hk-" + hl.id, title: hl.detail || hl.label }, G.icon(hl.icon), h("span", null, hl.label)); }
  function goProject(pid, route) { G.store.update("prefs", function (x) { x.project = pid; }); location.hash = route || "floor"; }
  function slotsText(p) { return G.slotsUsed(p.id).length + " of " + p.flow.slots; }
  function onboardingOf(pid) { return G.store.get("repos").filter(function (r) { return r.project === pid && r.onboarding.stage !== "ready"; }); }
  G.homeKit = { wosOf: wosOf, waitSince: waitSince, projectHealth: projectHealth, healthChip: healthChip, goProject: goProject, waitingGates: waitingGates, inFlight: inFlight, onboardingOf: onboardingOf, slotsText: slotsText };

  /* a view not yet built registers this: G.views[id] = G.placeholderView(id) */
  G.placeholderView = function (id) {
    return { placeholder: true, get title() { var r = G.routeDef && G.routeDef(id); return r ? r.title : id; }, render: function () {
      var r = (G.routeDef && G.routeDef(id)) || { title: id, group: "" };
      return h("div", { class: "view" }, G.viewHead({ kicker: r.group + " · " + r.title, title: r.title, sub: "This screen is being built." }), G.empty("Being built", "This view is being built and will appear here."));
    } };
  };

  /* ================= round three shared components ================= */

  /* page header: G.pageHeader({ id, kicker, title, sub, meta: [[k, v]], actions: [nodes], badge: node, crumbs: [{ label, href }] }) */
  G.pageHeader = function (o) {
    var head = G.viewHead({ kicker: o.kicker || "", title: o.title, sub: o.sub, meta: o.meta, actions: o.actions });
    if (o.id) head.id = o.id;
    if (o.badge) head.querySelector(".vtitle").appendChild(h("span", { class: "vtitle-badge" }, o.badge));
    if (o.crumbs && o.crumbs.length) {
      var nav = h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, o.crumbs.map(function (c, i) { return [i ? h("span", { class: "crumb-sep", "aria-hidden": "true" }, "/") : null, c.href ? h("a", { href: c.href }, c.label) : h("span", null, c.label)]; }));
      head.querySelector(".vhead-main").insertBefore(nav, head.querySelector(".kicker"));
    }
    return head;
  };

  /* tab bar with counts and disabled-with-reason tabs.
     G.tabBar({ id, items: [{ id, label, count, disabled: "reason" }], active, onChange(id) }) */
  G.tabBar = function (o) {
    var bar = G.tabs(o.items, o.active, function (id) { var it = o.items.find(function (x) { return x.id === id; }); if (it && it.disabled) return; o.onChange(id); }, o.id || "tab");
    o.items.forEach(function (it) {
      var b = bar.querySelector("#" + (o.id || "tab") + "-" + it.id);
      if (b) { b.setAttribute("aria-controls", (o.id || "tab") + "-panel"); b.tabIndex = it.id === o.active ? 0 : -1; if (it.disabled) { b.setAttribute("aria-disabled", "true"); b.setAttribute("data-reason", it.disabled); b.classList.add("is-locked"); } }
    });
    bar.classList.add("tabbar");
    return bar;
  };

  /* empty state: G.emptyState({ icon, title, text, action }) */
  G.emptyState = function (o) {
    return h("div", { class: "empty empty-state", id: o.id || null }, o.icon ? h("div", { class: "empty-icon", "aria-hidden": "true" }, G.icon(o.icon)) : null,
      h("div", { class: "empty-title" }, o.title), o.text ? h("p", null, o.text) : null, o.action || null);
  };

  /* sortable, responsive table. Under 640px rows become cards labelled by column.
     G.dataTable({ id, caption, columns: [{ key, label, render(row) -> node|string, sort: true | fn(row) -> value, align: "end", width, hideSmall }],
                   rows, rowKey(row) -> id, onRow(row), sort: { key, dir: 1|-1 }, pageSize, empty: { title, text } }) */
  G.dataTable = function (o) {
    /* o.sortState: an object the caller keeps across re-renders (mutated in place on sort); o.onSort({ key, dir }) after a
       header click; o.idPrefix: header sort buttons get id idPrefix + column key (default "<id>-sort-") */
    var sort = o.sortState && o.sortState.key ? o.sortState : o.sort ? { key: o.sort.key, dir: o.sort.dir || 1 } : null;
    if (o.sortState && !o.sortState.key && sort) { o.sortState.key = sort.key; o.sortState.dir = sort.dir; sort = o.sortState; }
    var prefix = o.idPrefix || (o.id ? o.id + "-sort-" : null);
    var shown = o.pageSize || 0;
    var wrap = h("div", { class: "dtable-wrap", id: o.id || null });
    function val(col, row) { return typeof col.sort === "function" ? col.sort(row) : row[col.key]; }
    function paint() {
      G.clear(wrap);
      if (!o.rows.length) { wrap.appendChild(G.emptyState(o.empty || { title: "Nothing here", text: "No rows match." })); return; }
      var rows = o.rows.slice();
      if (sort) { var col = o.columns.find(function (c) { return c.key === sort.key; }); if (col) rows.sort(function (a, b) { var x = val(col, a), y = val(col, b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; }); }
      var visible = shown ? rows.slice(0, shown) : rows;
      var table = h("table", { class: "dtable" + (o.onRow ? " is-clickable" : "") },
        o.caption ? h("caption", { class: "sr-only" }, o.caption) : null,
        h("thead", null, h("tr", null, o.columns.map(function (c) {
          var active = sort && sort.key === c.key;
          var th = h("th", { scope: "col", class: (c.align === "end" ? "is-end" : "") + (c.hideSmall ? " hide-sm" : ""), style: c.width ? "width:" + c.width : null, "aria-sort": active ? (sort.dir > 0 ? "ascending" : "descending") : null },
            c.sort ? h("button", { type: "button", id: prefix ? prefix + c.key : null, class: "th-sort" + (active ? " is-active" : ""), onclick: function () {
              var next = { key: c.key, dir: active ? -sort.dir : 1 };
              if (o.sortState) { o.sortState.key = next.key; o.sortState.dir = next.dir; sort = o.sortState; } else sort = next;
              if (o.onSort) { try { o.onSort({ key: next.key, dir: next.dir }); } catch (e) { console.error(e); } }
              paint();
              var b = prefix && document.getElementById(prefix + c.key); if (b) b.focus();
            } }, c.label, h("span", { class: "th-arrow", "aria-hidden": "true" }, active ? (sort.dir > 0 ? "↑" : "↓") : "")) : c.label);
          return th;
        }))),
        h("tbody", null, visible.map(function (row) {
          var tr = h("tr", { "data-key": o.rowKey ? o.rowKey(row) : null });
          o.columns.forEach(function (c) {
            var v = c.render ? c.render(row) : row[c.key];
            tr.appendChild(h("td", { "data-label": c.label, class: (c.align === "end" ? "is-end" : "") + (c.hideSmall ? " hide-sm" : "") }, v == null ? "" : typeof v === "object" ? v : String(v)));
          });
          if (o.onRow) {
            tr.tabIndex = 0;
            tr.addEventListener("click", function (e) { if (e.target.closest("button,a,input,select,textarea")) return; o.onRow(row); });
            tr.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === tr) o.onRow(row); });
          }
          return tr;
        })));
      wrap.appendChild(h("div", { class: "dtable-scroll" }, table));
      if (shown && rows.length > shown) wrap.appendChild(h("div", { class: "dtable-more" }, G.btn("Show " + Math.min(o.pageSize, rows.length - shown) + " more of " + (rows.length - shown), { small: true, id: (o.id || "dt") + "-more", onClick: function () { shown += o.pageSize; paint(); } })));
    }
    wrap.update = function (rows) { o.rows = rows; paint(); };
    paint();
    return wrap;
  };

  /* open the full work order record page */
  G.openRecord = function (woId) {
    G.store.update("prefs", function (p) { p.record = woId; });
    if (location.hash === "#record") { if (G.rerender) G.rerender(); } else location.hash = "record";
  };
  /* lifecycle content for the traveler tab; js/views/record.js replaces this with the full renderer.
     G.renderLifecycle(wo, { compact: true }) -> Node */
  if (!G.renderLifecycle) G.renderLifecycle = function (wo) {
    G.lc.ensure(wo);
    var c = G.lc.completeness(wo);
    return h("div", { class: "lc-stub" },
      h("p", null, G.lc.summaryText(wo)),
      h("p", { class: "muted" }, "Record " + c.done + " of " + c.total + " sections filled. " + (wo.files || []).length + " files planned or changed, " + (wo.criteria || []).length + " acceptance criteria."),
      G.btn("Open full record", { small: true, id: "lc-open-" + wo.id, onClick: function () { G.openRecord(wo.id); } }));
  };

  /* fallback traveler: replaced by js/views/traveler.js when that view is built */
  if (!G.openTraveler) G.openTraveler = function (woId) {
    G.drawer.open("wo:" + woId, function (close) {
      var wo = G.find.wo(woId); if (!wo) return null;
      return h("div", { class: "drawer-inner" }, h("div", { class: "drawer-head" }, h("div", null, h("div", { class: "kicker" }, "Traveler"), h("div", { class: "drawer-id" }, h("span", { class: "mono big-id" }, wo.id), G.stateChip(wo.state)), h("h2", { class: "drawer-title" }, wo.title)),
        h("button", { type: "button", class: "icon-btn drawer-close", "aria-label": "Close", onClick: close }, G.icon("x"))),
        h("div", { class: "drawer-scroll" }, h("p", { class: "muted" }, "The full traveler view is being built."), G.historyList({ type: "wo", id: wo.id })));
    });
  };
})(window.G);
