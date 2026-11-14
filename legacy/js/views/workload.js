/* Workload (#workload): human attention as the scarce resource. Per person and per team: approvals
   waiting, median response, approvals per day, questions answered, after-hours load and the share of
   waiting gates where they are the only eligible approver; human minutes per work order by class and
   project; gates ranked by time work waits on people; suggestions that deep-link to the fix.
   Everything is derived from real history in the store (G.workload.acts) and scoped to the projects
   the viewer can see. Counts sit beside every rate; small samples say "insufficient data". */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "people", days: 7, project: "all", sort: {}, snap: 0, allSugg: false };
  var MINUTES = { approve: 6, confirm: 4, answer: 3 };
  var MIN_N = 5; /* below this many observations a rate is shown as insufficient data */
  function S(k) { return G.store.get(k); }

  function inHours(t) { var d = new Date(t + 330 * G.MIN); var hr = d.getUTCHours(), day = d.getUTCDay(); return day >= 1 && day <= 5 && hr >= 9 && hr < 19; }
  function median(xs) { if (!xs.length) return null; var s = xs.slice().sort(function (a, b) { return a - b; }); var m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function mins(m) { return m == null ? "–" : m < 60 ? Math.round(m) + "m" : G.fmt.dur(m * G.MIN); }
  function projName(id) { return (G.find.project(id) || { name: id }).name; }
  function gateLabel(id) { return (G.gateDef(id) || { label: id }).label; }
  function teamName(id) { return (G.find.team(id) || { name: id || "No team" }).name; }
  function factoryWide() { var v = G.viewer(); return !!v && v.roles.some(function (g) { return g.scope === "factory"; }); }

  /* ---------- scope ---------- */
  function scopeIds() {
    var vis = G.visibleProjects(G.viewerId()).filter(function (p) { return p.status !== "archived"; }).map(function (p) { return p.id; });
    if (ui.project !== "all" && vis.indexOf(ui.project) < 0) ui.project = "all";
    return ui.project === "all" ? vis : [ui.project];
  }

  /* ---------- metrics: the shared engine (G.workload.summary in insight.js), scoped to the projects shown ---------- */
  function compute(o) { o = o || {}; return G.workload.summary({ ids: o.ids || scopeIds(), days: o.days || ui.days }); }

  /* ---------- suggestions with deep links ---------- */
  function goConfig(project, gate) {
    G.store.update("prefs", function (p) { p.project = project; p.configTab = "approvers"; p.configGate = gate || null; });
    location.hash = "project-config";
  }
  function goTrust(o) {
    G.store.update("prefs", function (p) { if (o.project) p.project = o.project; p.trustFocus = o; });
    if (typeof G.trustFocus === "function") { try { G.trustFocus(o); } catch (e) { console.error(e); } }
    location.hash = "trust";
  }
  function goPerson(pid) { if (G.peopleSelect) G.peopleSelect(pid); location.hash = "people"; }

  function suggestions(m) {
    var out = [], seen = {};
    function add(s) { if (seen[s.key]) return; seen[s.key] = 1; out.push(s); }
    m.rows.forEach(function (r) {
      if (r.sole >= 1) {
        var g0 = r.soleGates[0];
        add({ key: "sole:" + r.person, kind: "approver", icon: "people", weight: 3 + r.sole,
          text: r.name + " is the only eligible approver on " + r.sole + " waiting gate" + (r.sole > 1 ? "s" : "") + " (" + r.soleGates.slice(0, 3).map(function (g) { return g.wo.id + " at " + gateLabel(g.gate); }).join(", ") + "). Add a second approver to " + (r.sole > 1 ? "those rules" : "that rule") + ".",
          action: { label: "Open approver rules", id: "wl-sg-sole-" + r.person, guard: G.me("approvers.edit", { project: g0.wo.project }), run: function () { goConfig(g0.wo.project, g0.gate); } } });
      }
      if (r.away && r.waiting && !r.away.delegate) add({ key: "away:" + r.person, kind: "delegate", icon: "swap", weight: 4, text: r.name + " is away with " + r.waiting + " approvals waiting and no delegate.", action: { label: "Set a delegate", id: "wl-sg-away-" + r.person, guard: delegateGuard(r.person), run: function () { delegateDialog(r.person); } } });
      else if (r.waiting >= 4 && !r.away) add({ key: "load:" + r.person, kind: "delegate", icon: "swap", weight: 1 + r.waiting / 4, text: r.name + " has " + r.waiting + " approvals waiting. If they are going to be away, set a delegate so work does not stall.", action: { label: "Delegate while away", id: "wl-sg-del-" + r.person, guard: delegateGuard(r.person), run: function () { delegateDialog(r.person); } } });
      if (r.n >= MIN_N && r.afterHours / r.n > 0.3) add({ key: "ah:" + r.person, kind: "approver", icon: "clock", weight: 2, text: r.name + " did " + r.afterHours + " of " + r.n + " acts (" + G.fmt.pct(r.afterHours / r.n) + ") out of hours in the last " + (ui.days === 1 ? "24 hours" : ui.days + " days") + ". Spread on-call approvals across more people.", action: { label: "Open " + r.name.split(" ")[0] + " in People", id: "wl-sg-ah-" + r.person, run: function () { goPerson(r.person); } } });
    });
    var tr = S("trust");
    tr.proposals.filter(function (x) { return x.status === "pending"; }).forEach(function (x) {
      var c = tr.cells.find(function (y) { return y.id === x.cell; }); if (!c || m.ids.indexOf(c.project) < 0) return;
      add({ key: "tp:" + x.id, kind: "trust", icon: "trust", weight: 2 + (x.savedPerWeek || 0) / 3, text: "Raise trust for " + G.trustCellLabel(c) + " from L" + x.from + " to L" + x.to + ": the evidence meets the criteria and it saves about " + (x.savedPerWeek || 0) + " human approvals a week.",
        action: { label: "Review proposal " + x.id, id: "wl-sg-tp-" + x.id, run: function () { goTrust({ cell: c.id, proposal: x.id, project: c.project, cls: c.cls }); } } });
    });
    m.bottlenecks.slice(0, 4).forEach(function (b) {
      if ((b.medianWaitMin || 0) < 60 && b.oldestMin < 120) return;
      var item = b.items[0], cls = item ? item.wo.cls : null, agent = G.trustAgentFor(b.gate);
      var cell = cls && agent ? G.trust.cell(agent, cls, b.project) : null;
      var ceil = cls ? G.trust.ceiling(b.project, cls, b.gate) : { max: 4 };
      var lvl = cell ? cell.level : 1;
      var trustable = cls && lvl < Math.min(3, ceil.max) && b.gate !== "G0G1";
      add({ key: "bn:" + b.project + b.gate, kind: trustable ? "trust" : "approver", icon: trustable ? "trust" : "gate", weight: 2 + (b.medianWaitMin || 0) / 120,
        text: "Work waits a median " + (b.decisions ? mins(b.medianWaitMin) + " over " + b.decisions + " decision" + (b.decisions > 1 ? "s" : "") : "(no decisions yet)") + " at " + gateLabel(b.gate) + " in " + projName(b.project) + (b.open ? ", " + b.open + " open now, oldest " + mins(b.oldestMin) : "") + ". " +
          (trustable ? "The " + G.find.cls(cls).name + " cell runs at L" + lvl + " (ceiling L" + ceil.max + "); raising it moves routine approvals off people." : "Add an approver to share the load" + (ceil.max < 3 && cls ? " (trust is capped at L" + ceil.max + " here)." : ".")),
        action: trustable ? { label: "Open trust for " + G.find.cls(cls).name, id: "wl-sg-bt-" + b.project + "-" + b.gate, run: function () { goTrust({ cell: cell ? cell.id : G.trustCellId(agent, cls, b.project), project: b.project, cls: cls, proposal: null }); } }
          : { label: "Open approver rules", id: "wl-sg-ba-" + b.project + "-" + b.gate, guard: G.me("approvers.edit", { project: b.project }), run: function () { goConfig(b.project, b.gate); } } });
    });
    out.sort(function (a, b) { return b.weight - a.weight; });
    /* interleave kinds so one kind does not crowd out the others */
    var by = {}, order = []; out.forEach(function (s) { if (!by[s.kind]) { by[s.kind] = []; order.push(s.kind); } by[s.kind].push(s); });
    var mixed = []; while (mixed.length < out.length) order.forEach(function (k) { if (by[k].length) mixed.push(by[k].shift()); });
    return mixed;
  }

  /* ---------- delegate dialog (G.ops.setAway) ---------- */
  function delegateGuard(pid) {
    if (pid === G.viewerId()) return { allowed: true, reason: "You can set your own delegate.", needs: "" };
    var d = G.me("people.manage"); if (d.allowed) return d;
    var ps = G.visibleProjects(G.viewerId());
    for (var i = 0; i < ps.length; i++) { var x = G.me("approvers.edit", { project: ps[i].id }); if (x.allowed) return x; }
    return d;
  }
  function delegateDialog(pid) {
    var p = G.find.person(pid); if (!p) return;
    var guard = delegateGuard(pid);
    var projectId = G.me("people.manage").allowed || pid === G.viewerId() ? null : (G.visibleProjects(G.viewerId()).find(function (x) { return G.me("approvers.edit", { project: x.id }).allowed; }) || {}).id;
    var mates = S("people").filter(function (x) { return x.status === "active" && x.id !== pid; });
    var cur = p.away && p.away.to > Date.now() ? p.away : null;
    var del = G.select("wl-dl-person", mates.map(function (x) { return { value: x.id, label: x.name + " · " + x.title }; }), cur ? cur.delegate : (mates.find(function (x) { return (x.teams || []).some(function (t) { return (p.teams || []).indexOf(t) >= 0; }); }) || mates[0] || {}).id);
    var until = h("input", { id: "wl-dl-until", class: "input mono", type: "date", value: cur ? new Date(cur.to + 330 * G.MIN).toISOString().slice(0, 10) : G.istToday(3) });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: "Delegate approvals for " + p.name, kicker: "Workload · delegation",
      sub: "While away, the delegate may decide the gates " + p.name.split(" ")[0] + " could decide. Approver rules do not change.",
      body: h("div", { class: "form-grid" }, G.lockNote(guard, "Delegation"), h("div", { class: "form-row" }, G.field("Delegate", del), G.field("Away until (IST)", until)), err),
      actions: [{ label: "Cancel" },
        cur ? { label: "End delegation", id: "wl-dl-end", guard: guard, onClick: function (close) { var r = G.ops.setAway(pid, null, projectId); G.toast(r.msg, r.ok ? "ok" : "error"); if (r.ok) { ui.snap = 0; close(); G.rerender(); } else err.textContent = r.msg; } } : null,
        { label: "Set delegate", kind: "primary", submit: true, id: "wl-dl-save", guard: guard, onClick: function (close) {
          var to = G.istTime(until.value, "23:59");
          if (!(to > Date.now())) { err.textContent = "Pick a date in the future."; return; }
          var r = G.ops.setAway(pid, { from: Date.now(), to: to, delegate: del.value }, projectId);
          G.toast(r.msg, r.ok ? "ok" : "error");
          if (!r.ok) { err.textContent = r.msg; return; }
          ui.snap = 0; close(); G.rerender();
        } }].filter(Boolean) });
  }

  /* ---------- small renderers ---------- */
  function rate(num, den, fmt) {
    if (!den) return h("span", { class: "muted small" }, "no data");
    var v = fmt ? fmt(num / den) : G.fmt.pct(num / den);
    if (den < MIN_N) return h("span", { class: "wl-insuf", title: "Only " + den + " observations; at least " + MIN_N + " are needed for a rate." }, h("span", { class: "mono" }, num + "/" + den), h("span", { class: "wl-insuf-l" }, "insufficient data"));
    return h("span", { class: "wl-rate" }, h("span", { class: "mono" }, v), h("span", { class: "wl-n mono" }, "n=" + den));
  }
  function medianCell(m, n) {
    if (!n) return h("span", { class: "muted small" }, "no data");
    if (n < MIN_N) return h("span", { class: "wl-insuf", title: "Only " + n + " timed approvals." }, h("span", { class: "mono" }, mins(m)), h("span", { class: "wl-insuf-l" }, "insufficient data, n=" + n));
    return h("span", { class: "wl-rate" }, h("span", { class: "mono" }, mins(m)), h("span", { class: "wl-n mono" }, "n=" + n));
  }
  function bar(v, max, cls) { return h("span", { class: "wl-bar " + (cls || ""), "aria-hidden": "true" }, h("span", { style: "width:" + Math.max(2, Math.round(100 * v / (max || 1))) + "%" })); }
  function rememberSort(tid, wrap, cols) {
    wrap.addEventListener("click", function (e) {
      if (!e.target.closest(".th-sort")) return;
      setTimeout(function () { var ths = wrap.querySelectorAll("thead th"); ths.forEach(function (th, i) { var s = th.getAttribute("aria-sort"); if (s) ui.sort[tid] = { key: cols[i].key, dir: s === "ascending" ? 1 : -1 }; }); }, 0);
    });
    return wrap;
  }
  function table(tid, cols, rows, def, extra) {
    return rememberSort(tid, G.dataTable(Object.assign({ id: tid, columns: cols, rows: rows, sort: ui.sort[tid] || def }, extra || {})), cols);
  }

  /* ---------- person drawer ---------- */
  function openPerson(pid) {
    G.drawer.open("workload:" + pid, function (close) {
      var m = compute(); var r = m.rows.find(function (x) { return x.person === pid; }); var p = G.find.person(pid);
      if (!p) return null;
      r = r || { acts: [], waitingGates: [], soleGates: [], waiting: 0, approvals: 0, answered: 0, n: 0, afterHours: 0, sole: 0, minutes: 0, waitN: 0 };
      var recent = r.acts.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 14);
      function woLink(id, pre) { return h("button", { type: "button", class: "linkish mono", id: "wl-dr-wo-" + pre + "-" + id, onClick: function () { close(); G.openRecord(id); } }, id); }
      return h("div", { class: "drawer-inner wl-drawer" },
        h("div", { class: "drawer-head" }, h("div", null, h("div", { class: "kicker" }, "Workload · " + teamName((p.teams || [])[0]) + " · last " + (ui.days === 1 ? "24 hours" : ui.days + " days")),
          h("div", { class: "drawer-id" }, G.avatar(p.id), h("h2", { class: "drawer-title" }, p.name)), h("div", { class: "muted small" }, p.title + (r.away ? " · away until " + G.fmt.istDate(r.away.to) + ", delegate " + G.actorName(r.away.delegate) : "") + (p.oncall ? " · on call" : ""))),
          h("button", { type: "button", class: "icon-btn drawer-close", id: "wl-drawer-close", "aria-label": "Close", onClick: close }, G.icon("x"))),
        h("div", { class: "drawer-scroll" },
          h("dl", { class: "titleblock wl-tb" }, [["Waiting", String(r.waiting)], ["Approvals", String(r.approvals)], ["Answers", String(r.answered)], ["Minutes", String(r.minutes)], ["Sole approver", String(r.sole)]].map(function (x) { return h("div", null, h("dt", null, x[0]), h("dd", null, x[1])); })),
          h("div", { class: "row gap-sm wl-dr-actions" },
            G.btn(r.away ? "Change delegation" : "Delegate while away", { small: true, icon: "swap", id: "wl-dr-delegate", guard: delegateGuard(pid), onClick: function () { delegateDialog(pid); } }),
            G.canSeeRoute("people") ? G.btn("Open in People", { small: true, kind: "ghost", icon: "people", id: "wl-dr-people", onClick: function () { close(); goPerson(pid); } }) : null),
          h("h3", { class: "sub-h" }, "Waiting on " + p.name.split(" ")[0]),
          r.waitingGates.length ? h("ul", { class: "wl-list" }, r.waitingGates.map(function (g) {
            return h("li", null, woLink(g.wo.id, "w"), h("span", { class: "mono small" }, gateLabel(g.gate)), h("span", { class: "small" }, g.wo.title), h("span", { class: "mono muted small" }, mins((Date.now() - g.since) / G.MIN)),
              g.eligible.length === 1 ? h("span", { class: "chip chip-warn" }, G.icon("alert"), "only approver") : h("span", { class: "muted small" }, (g.eligible.length - 1) + " others eligible"));
          })) : h("p", { class: "muted small" }, "Nothing is waiting on them right now."),
          h("h3", { class: "sub-h" }, "Recent acts"),
          recent.length ? h("ul", { class: "wl-list" }, recent.map(function (a, i) {
            return h("li", null, h("span", { class: "mono muted small" }, G.fmt.istDate(a.at) + " " + G.fmt.ist(a.at)), woLink(a.wo, "a" + i), h("span", { class: "small" }, a.kind === "answer" ? "answered a question" : a.kind === "confirm" ? "confirmed the brief" : "approved " + gateLabel(a.gate)),
              a.waitMin != null ? h("span", { class: "mono muted small" }, "after " + mins(a.waitMin)) : h("span"), !inHours(a.at) ? h("span", { class: "chip" }, G.icon("clock"), "out of hours") : h("span"));
          })) : h("p", { class: "muted small" }, "No approvals, confirmations or answers in this window.")));
    });
  }

  /* ---------- tabs ---------- */
  function peopleTab(m) {
    var maxMin = Math.max.apply(null, m.rows.map(function (r) { return r.minutes; }).concat([1]));
    var cols = [
      { key: "name", label: "Person", sort: true, render: function (r) { return h("span", { class: "wl-who" }, G.who(r.person), r.away ? h("span", { class: "chip chip-warn" }, G.icon("swap"), "away") : null, r.oncall ? h("span", { class: "chip chip-accent" }, "on call") : null); } },
      { key: "team", label: "Team", sort: function (r) { return teamName(r.team); }, hideSmall: true, render: function (r) { return teamName(r.team); } },
      { key: "waiting", label: "Waiting", sort: true, align: "end", render: function (r) { return h("span", null, h("span", { class: "mono strong" }, String(r.waiting)), r.glass ? h("span", { class: "wl-n mono", title: "Gates a Factory Admin could decide only as break-glass" }, " +" + r.glass + " break-glass") : null); } },
      { key: "medianResponseMin", label: "Median response", sort: function (r) { return r.waitN >= MIN_N ? r.medianResponseMin : -1; }, align: "end", render: function (r) { return medianCell(r.medianResponseMin, r.waitN); } },
      { key: "perDay", label: "Approvals / day", sort: true, align: "end", render: function (r) { return h("span", { class: "wl-rate" }, h("span", { class: "mono" }, r.perDay.toFixed(1)), h("span", { class: "wl-n mono" }, r.approvals + " in " + ui.days + "d")); } },
      { key: "answered", label: "Questions answered", sort: true, align: "end", render: function (r) { return h("span", { class: "mono" }, String(r.answered)); } },
      { key: "afterHours", label: "After hours", sort: function (r) { return r.n >= MIN_N ? r.afterHours / r.n : -1; }, align: "end", render: function (r) { return rate(r.afterHours, r.n); } },
      { key: "sole", label: "Sole approver", sort: function (r) { return r.waiting ? r.sole / r.waiting : -1; }, align: "end", render: function (r) { return r.waiting ? h("span", { class: "wl-rate" + (r.sole ? " is-warn" : "") }, r.sole ? G.icon("alert") : null, h("span", { class: "mono" }, r.sole + " of " + r.waiting), h("span", { class: "wl-n mono" }, G.fmt.pct(r.sole / r.waiting))) : h("span", { class: "muted small" }, "none waiting"); } },
      { key: "minutes", label: "Human minutes", sort: true, align: "end", render: function (r) { return h("span", { class: "wl-mincell" }, bar(r.minutes, maxMin), h("span", { class: "mono" }, String(r.minutes))); } }
    ];
    return table("wl-people", cols, m.rows, { key: "minutes", dir: -1 }, { rowKey: function (r) { return r.person; }, onRow: function (r) { openPerson(r.person); }, caption: "Workload per person", empty: { title: "No human activity", text: "Nobody approved, confirmed or answered anything in this window and scope." } });
  }
  function teamsTab(m) {
    var cols = [
      { key: "name", label: "Team", sort: true, render: function (t) { return h("strong", null, t.name); } },
      { key: "people", label: "People active", sort: true, align: "end" },
      { key: "waiting", label: "Waiting", sort: true, align: "end", render: function (t) { return h("span", { class: "mono strong" }, String(t.waiting)); } },
      { key: "medianResponseMin", label: "Median response", sort: true, align: "end", render: function (t) { return medianCell(t.medianResponseMin, t.waitN); } },
      { key: "approvals", label: "Approvals / day", sort: true, align: "end", render: function (t) { return h("span", { class: "wl-rate" }, h("span", { class: "mono" }, (t.approvals / ui.days).toFixed(1)), h("span", { class: "wl-n mono" }, t.approvals + " in " + ui.days + "d")); } },
      { key: "answered", label: "Questions answered", sort: true, align: "end" },
      { key: "afterHours", label: "After hours", sort: function (t) { return t.n >= MIN_N ? t.afterHours / t.n : -1; }, align: "end", render: function (t) { return rate(t.afterHours, t.n); } },
      { key: "sole", label: "Sole-approver gates", sort: true, align: "end", render: function (t) { return h("span", { class: "mono" + (t.sole ? " wl-warn" : "") }, String(t.sole)); } },
      { key: "minutes", label: "Human minutes", sort: true, align: "end", render: function (t) { return h("span", { class: "mono" }, String(t.minutes)); } }
    ];
    return table("wl-teams", cols, m.teams, { key: "minutes", dir: -1 }, { rowKey: function (t) { return t.team; }, caption: "Workload per team", empty: { title: "No team activity", text: "No team members acted in this window and scope." } });
  }
  function waitsTab(m) {
    var cols = [
      { key: "gate", label: "Gate", sort: function (b) { return gateLabel(b.gate); }, render: function (b) { var st = b.station && G.find.station(b.station); return h("span", { class: "wl-gate" }, h("span", { class: "wl-dia", "aria-hidden": "true" }), h("span", { class: "mono strong" }, gateLabel(b.gate)), h("span", { class: "muted small" }, (G.gateDef(b.gate) || {}).name + (st ? " · after " + st.name : ""))); } },
      { key: "project", label: "Project", sort: function (b) { return projName(b.project); }, render: function (b) { return projName(b.project); } },
      { key: "medianWaitMin", label: "Median wait on people", sort: function (b) { return b.decisions >= MIN_N ? b.medianWaitMin : b.decisions ? b.medianWaitMin / 1000 : -1; }, align: "end", render: function (b) { return medianCell(b.medianWaitMin, b.decisions); } },
      { key: "open", label: "Waiting now", sort: true, align: "end", render: function (b) { return b.open ? h("span", { class: "mono strong" }, String(b.open)) : h("span", { class: "muted" }, "0"); } },
      { key: "oldestMin", label: "Oldest", sort: true, align: "end", render: function (b) { return b.open ? h("span", { class: "mono" }, mins(b.oldestMin)) : "–"; } },
      { key: "minEligible", label: "Eligible approvers", sort: function (b) { return b.minEligible == null ? 99 : b.minEligible; }, align: "end", render: function (b) { return b.minEligible == null ? "–" : h("span", { class: "mono" + (b.minEligible <= 1 ? " wl-warn" : "") }, b.minEligible <= 1 ? "only " + b.minEligible : String(b.minEligible)); } },
      { key: "act", label: "", render: function (b) { return G.btn("Approver rules", { small: true, kind: "ghost", id: "wl-bn-cfg-" + b.project + "-" + b.gate, guard: G.me("approvers.edit", { project: b.project }), onClick: function () { goConfig(b.project, b.gate); } }); } }
    ];
    var np = m.needsPerson;
    return h("div", { class: "wl-waits" },
      h("p", { class: "muted small" }, "Human and mixed gates ranked by how long work waited for a person: decisions in the window plus gates waiting now. Automatic gates and gates passed under trust do not wait on people."),
      table("wl-bottlenecks", cols, m.bottlenecks, { key: "medianWaitMin", dir: -1 }, { rowKey: function (b) { return b.project + ":" + b.gate; }, caption: "Gates ranked by wait on people", empty: { title: "Nothing waits on people", text: "No human gate decisions or waiting gates in this scope." } }),
      h("h3", { class: "sub-h" }, "Waiting for an answer"),
      np.length ? h("ul", { class: "wl-list" }, np.map(function (w) { return h("li", null, h("button", { type: "button", class: "linkish mono", id: "wl-np-" + w.id, onClick: function () { G.openTraveler(w.id); } }, w.id), h("span", { class: "small" }, w.title), h("span", { class: "muted small" }, projName(w.project) + (w.bayReason ? " · " + w.bayReason : ""))); }))
        : h("p", { class: "muted small" }, "No work order is parked in Needs a person."));
  }
  function minutesTab(m) {
    function block(title, rows, label, id) {
      if (!rows.length) return G.emptyState({ id: id + "-empty", icon: "workload", title: "No human minutes", text: "No approvals, confirmations or answers in this window and scope." });
      return h("div", { class: "wl-minblock" },
        G.barChart({ title: title, rows: rows.map(function (r) { return { label: label(r.key), value: Math.round(r.perWO * 10) / 10, note: r.workOrders < MIN_N ? "(n=" + r.workOrders + ", insufficient data)" : "(n=" + r.workOrders + ")" }; }), fmt: function (v) { return (Math.round(v * 10) / 10) + "m"; }, xLabel: "Human minutes per work order", emphasis: "max" }),
        table(id, [
          { key: "key", label: title.split(" by ")[1] || "Key", sort: function (r) { return label(r.key); }, render: function (r) { return label(r.key); } },
          { key: "perWO", label: "Minutes / WO", sort: true, align: "end", render: function (r) { return r.workOrders < MIN_N ? h("span", { class: "wl-insuf" }, h("span", { class: "mono" }, r.perWO.toFixed(1)), h("span", { class: "wl-insuf-l" }, "insufficient data")) : h("span", { class: "mono" }, r.perWO.toFixed(1)); } },
          { key: "workOrders", label: "Work orders", sort: true, align: "end" },
          { key: "minutes", label: "Total minutes", sort: true, align: "end" }
        ], rows, { key: "perWO", dir: -1 }, { rowKey: function (r) { return r.key; }, caption: title }));
    }
    return h("div", { class: "wl-mins" },
      h("p", { class: "muted small" }, "Estimated from real acts: an approval counts 6 minutes, a brief confirmation 4 and a conversation answer 3. Classes and projects with fewer than " + MIN_N + " work orders are marked."),
      h("div", { class: "wl-mins-grid" }, block("Human minutes by class", m.byCls, function (k) { return (G.find.cls(k) || { name: k }).name; }, "wl-min-cls"), m.ids.length > 1 ? block("Human minutes by project", m.byProject, projName, "wl-min-proj") : null));
  }

  /* ---------- view ---------- */
  var cache = { at: 0, key: "", m: null };
  function render() {
    var key = ui.days + "|" + ui.project + "|" + G.viewerId();
    if (!cache.m || cache.key !== key || !ui.snap) { cache = { at: Date.now(), key: key, m: compute() }; ui.snap = cache.at; }
    var m = cache.m;
    var sugg = suggestions(m);
    var vis = G.visibleProjects(G.viewerId()).filter(function (p) { return p.status !== "archived"; });
    var totWait = m.gates.length, soleGates = m.gates.filter(function (g) { return g.eligible.length === 1; }).length, noneGates = m.gates.filter(function (g) { return !g.eligible.length; }).length;
    var timed = m.acts.filter(function (a) { return a.waitMin != null && a.kind !== "answer"; }).map(function (a) { return a.waitMin; });
    var ah = m.acts.filter(function (a) { return !inHours(a.at); }).length;
    var minutes = m.acts.reduce(function (t, a) { return t + MINUTES[a.kind]; }, 0);
    var projSel = G.select("wl-project", [{ value: "all", label: factoryWide() ? "All projects" : "All my projects (" + vis.length + ")" }].concat(vis.map(function (p) { return { value: p.id, label: p.name }; })), ui.project, function (v) { ui.project = v; ui.snap = 0; G.rerender(); }, { "aria-label": "Project scope" });
    var win = G.segmented("wl-days", [{ id: "1", label: "24 hours" }, { id: "7", label: "7 days" }], String(ui.days), function (v) { ui.days = +v; ui.snap = 0; G.rerender(); }, "Window");
    var tabs = G.tabBar({ id: "wl-tab", active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); }, items: [
      { id: "people", label: "People", count: m.rows.length }, { id: "teams", label: "Teams", count: m.teams.length }, { id: "waits", label: "Where work waits", count: m.bottlenecks.filter(function (b) { return b.open; }).length }, { id: "minutes", label: "Minutes per work order" }] });
    var body = ui.tab === "teams" ? teamsTab(m) : ui.tab === "waits" ? waitsTab(m) : ui.tab === "minutes" ? minutesTab(m) : peopleTab(m);
    var sp = h("section", { class: "panel wl-sugg", "aria-label": "Suggestions" },
      h("div", { class: "panel-head" }, h("h2", { class: "panel-title" }, "Suggestions"), sugg.length > 5 ? G.btn(ui.allSugg ? "Show top 5" : "Show all " + sugg.length, { small: true, kind: "ghost", id: "wl-sugg-all", onClick: function () { ui.allSugg = !ui.allSugg; G.rerender(); } }) : null),
      h("div", { class: "panel-body" }, sugg.length ? h("ol", { class: "wl-sugg-list" }, sugg.slice(0, ui.allSugg ? sugg.length : 5).map(function (s) {
        return h("li", { class: "wl-sg wl-sg-" + s.kind }, h("span", { class: "wl-sg-ic", "aria-hidden": "true" }, G.icon(s.icon)),
          h("div", { class: "wl-sg-main" }, h("span", { class: "kicker" }, s.kind === "trust" ? "Raise trust" : s.kind === "delegate" ? "Delegate" : "Add an approver"), h("p", null, s.text)),
          G.btn(s.action.label, { small: true, id: s.action.id, guard: s.action.guard && !s.action.guard.allowed ? s.action.guard : null, onClick: s.action.run }));
      })) : G.emptyState({ id: "wl-sugg-empty", icon: "check", title: "No suggestions", text: "No single points of failure, long waits or pending trust proposals in this scope." })));
    return h("div", { class: "view view-workload" },
      G.pageHeader({ id: "wl-head", kicker: "Govern · Workload", title: "Workload",
        sub: "Human attention is the scarce resource. Who waits on whom, how long, out of hours, and where one person is the only way through. Derived from approvals, brief confirmations and answers in the store.",
        meta: [["Gates waiting", String(totWait)], ["Median wait", timed.length >= MIN_N ? mins(median(timed)) : timed.length ? "n=" + timed.length : "–"], ["After hours", m.acts.length >= MIN_N ? G.fmt.pct(ah / m.acts.length) : "–"], ["Human minutes", String(minutes)]] }),
      h("div", { class: "toolbar wl-tools" }, h("div", { class: "filters" }, G.field("Projects", projSel), h("div", { class: "field" }, h("div", { class: "field-label" }, "Window"), win)),
        h("div", { class: "wl-snap small muted" }, "Snapshot " + G.fmt.ist(cache.at) + " IST · " + m.acts.length + " acts",
          G.btn("Refresh", { small: true, kind: "ghost", icon: "swap", id: "wl-refresh", onClick: function () { ui.snap = 0; G.rerender(); } }))),
      soleGates || noneGates ? h("div", { class: "callout callout-warn wl-bus", role: "note" }, G.icon("alert"), h("span", null,
        (soleGates ? soleGates + " of " + totWait + " waiting gates have exactly one eligible approver" : "") + (soleGates && noneGates ? "; " : "") + (noneGates ? noneGates + " have nobody eligible except break-glass" : "") + ". That person is the bus factor for that work.")) : null,
      sp,
      h("section", { class: "panel wl-main", "aria-label": "Workload detail" }, h("div", { class: "wl-tabbar" }, tabs), h("div", { class: "panel-body", id: "wl-tab-panel", role: "tabpanel" }, body)),
      h("p", { class: "footnote" }, "Out of hours means outside Mon to Fri 09:00 to 19:00 IST. Rates with fewer than " + MIN_N + " observations show the raw count and \"insufficient data\". Factory Admins can decide any gate as break-glass; those are counted separately and not as eligible approvers."));
  }

  G.views.workload = { title: "Workload", render: render, keys: ["people", "teams", "trust"] };
  G.workloadOpenPerson = openPerson;
})(window.G);
