/* Work orders (#work-orders): sortable, filterable table for the current project, the post-submit
   classification card shown after G.newWODialog submits (class, confidence, rationale, proposed route,
   audited override). */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { sort: "id", dir: -1, q: "", cls: "all", where: "all", repo: "all", prio: "all", source: "all", state: "all" };
  var shown = {};
  var PRIOS = ["P0", "P1", "P2", "P3"];

  /* ---------- helpers shared with conversations.js ---------- */
  function routeText(project, cls) { return G.route(project, cls).map(function (s) { var st = G.find.station(s) || { no: "", name: s }; return st.no + " " + st.name; }).join(" → "); }
  function skipsText(project, cls) {
    var r = G.route(project, cls);
    var sk = G.flowOf(project).active.filter(function (s) { return r.indexOf(s.id) < 0; }).map(function (s) { return s.name; });
    return sk.length ? "Skips " + sk.join(", ") : "Full route, no skips";
  }
  /* route strip: stations as numbered cells, skipped struck through, gate diamonds between */
  function routeStrip(project, cls, idPrefix) {
    var r = G.route(project, cls), gates = G.routeGates(project, cls);
    var out = h("ol", { class: "int-route", "aria-label": "Route: " + routeText(project, cls) });
    G.flowOf(project).active.forEach(function (s) {
      var on = r.indexOf(s.id) >= 0;
      out.appendChild(h("li", { class: "int-rs" + (on ? "" : " is-skip") + (s.custom ? " is-custom" : ""), title: s.name + (on ? "" : " (skipped)") + (s.custom ? " · custom station" : "") }, h("span", { class: "mono int-rs-no" }, s.no), h("span", { class: "int-rs-n" }, s.name)));
      var g = G.gateAfter(s.id);
      if (g && gates.indexOf(g.id) >= 0) out.appendChild(h("li", { class: "int-rg gate-kind-" + g.kind, title: g.label + " " + g.name + " (" + g.kind + ")" }, h("span", { class: "int-rg-d", "aria-hidden": "true" }), h("span", { class: "mono int-rg-l" }, g.label)));
    });
    return out;
  }
  G.intakeRouteStrip = routeStrip;

  function confMeter(c) {
    var pct = Math.round(c * 100);
    var lvl = c >= 0.8 ? "hi" : c >= 0.65 ? "mid" : "lo";
    return h("span", { class: "int-conf int-conf-" + lvl, role: "img", "aria-label": "Confidence " + pct + "%" },
      h("span", { class: "int-conf-bar", "aria-hidden": "true" }, h("span", { style: "width:" + pct + "%" })),
      h("span", { class: "mono" }, pct + "%"), h("span", { class: "small muted" }, lvl === "hi" ? "high" : lvl === "mid" ? "medium" : "low, please check"));
  }
  G.intakeConfMeter = confMeter;

  function atIntake(wo) { return wo.station === 0 && !wo.bay && wo.state !== "killed" && wo.gates.G0G1 && wo.gates.G0G1.status !== "passed"; }

  /* override dialog: class radio cards with a live route preview and a required reason */
  G.intakeReclassifyDialog = function (woId, preset) {
    var wo = G.find.wo(woId); if (!wo) return;
    var project = G.find.project(wo.project);
    var dec = G.me("wo.classify", { project: wo.project });
    var pick = preset || wo.cls;
    var preview = h("div", { class: "int-rc-prev" });
    function paintPrev() {
      G.clear(preview);
      preview.appendChild(h("div", { class: "small" }, h("strong", null, G.find.cls(pick).name + ": "), skipsText(project, pick) + ". Default priority " + G.classOf(project, pick).priority + "."));
      preview.appendChild(routeStrip(project, pick));
    }
    var classes = G.classesOf(project);
    var cards = h("div", { class: "radio-cards int-rc-cards" }, classes.map(function (c) {
      var rb = h("input", { type: "radio", name: "int-rc", id: "int-rc-" + c.id, value: c.id, checked: c.id === pick, disabled: !dec.allowed });
      rb.addEventListener("change", function () { pick = c.id; paintPrev(); });
      return h("label", { class: "radio-card", for: "int-rc-" + c.id }, rb, h("span", { class: "rc-t" }, G.classChip(c.id), c.id === wo.clsSuggested ? h("span", { class: "muted small" }, " suggested") : null), h("span", { class: "rc-d" }, "SLA " + c.slaH + "h · est " + c.est));
    }));
    paintPrev();
    var reason = h("textarea", { id: "int-rc-reason", class: "input", rows: "2", placeholder: "Why is the suggested class wrong?", disabled: !dec.allowed });
    var err = h("div", { class: "form-err", role: "alert" });
    var notIntake = wo.station !== 0;
    G.dialog({ title: "Change the class of " + wo.id, kicker: "Intake · classification override", wide: true,
      sub: "The Intake classifier suggested " + G.find.cls(wo.clsSuggested || wo.cls).name + " at " + Math.round(wo.clsConfidence * 100) + "%. Changing the class changes the route and restarts the open intake questions; answers you already gave are kept where they still apply. The override is audited.",
      body: h("div", { class: "form-grid" }, G.lockNote(dec, "The class"), notIntake ? h("div", { class: "callout callout-warn" }, G.icon("alert"), h("div", null, "Class can only change at Intake.")) : null, cards, preview, G.field("Reason (required)", reason), err),
      actions: [{ label: "Cancel" }, { label: "Change class", kind: "primary", submit: true, id: "int-rc-ok", guard: dec, onClick: function (close) {
        if (pick === wo.cls) { err.textContent = "Pick a different class."; return; }
        if (reason.value.trim().length < 5) { err.textContent = "Give a reason of at least 5 characters."; return; }
        var r = G.ops.reclassify(wo.id, pick, reason.value.trim());
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  };

  G.openConversation = function (woId) {
    var wo = G.find.wo(woId); if (!wo) return;
    G.store.update("prefs", function (p) { p.project = wo.project; p.openConversation = wo.id; });
    if (G.drawer.isOpen()) G.drawer.close();
    if (location.hash !== "#conversations") location.hash = "conversations"; else G.rerender();
  };

  /* shown once after a submission: what the Intake classifier decided and the route it proposes */
  G.afterSubmitWO = function (woId) {
    var wo = G.find.wo(woId); if (!wo || shown[woId]) return;
    shown[woId] = true;
    var project = G.find.project(wo.project);
    var dec = G.me("wo.classify", { project: wo.project });
    var alts = G.classify(wo.title + " " + wo.description).alternatives.filter(function (a) { return a !== wo.cls; });
    var c = G.classOf(project, wo.cls);
    var body = h("div", { class: "int-cls" },
      h("div", { class: "int-cls-top" },
        h("div", { class: "int-cls-big" }, h("div", { class: "kicker" }, "Class"), G.classChip(wo.cls)),
        h("div", null, h("div", { class: "kicker" }, "Confidence"), confMeter(wo.clsConfidence)),
        h("div", null, h("div", { class: "kicker" }, "Priority · SLA"), h("span", { class: "mono" }, wo.priority + " · " + c.slaH + "h"))),
      h("p", { class: "int-cls-why" }, wo.clsRationale),
      wo.requestedCls && wo.requestedCls !== wo.clsSuggested ? h("div", { class: "callout callout-warn" }, G.icon("swap"), h("div", null, "You asked for " + G.find.cls(wo.requestedCls).name + "; the classifier suggested " + G.find.cls(wo.clsSuggested).name + ". " + (wo.cls === wo.requestedCls ? "Your request was kept because confidence was below 80%." : "The suggestion was used because confidence was 80% or more."))) : null,
      wo.clsConfidence < 0.65 ? h("div", { class: "callout callout-warn" }, G.icon("alert"), h("div", null, "Low confidence. Check the class before answering the questions.")) : null,
      h("h3", { class: "sub-h" }, "Proposed route"), h("p", { class: "small" }, skipsText(project, wo.cls) + "."), routeStrip(project, wo.cls),
      alts.length ? h("div", { class: "int-alts" }, h("span", { class: "small muted" }, "Also possible: "), alts.map(function (a) {
        return G.btn("Use " + G.find.cls(a).name, { small: true, id: "int-alt-" + a, guard: dec, onClick: function () { G.closeTopDialog(); G.intakeReclassifyDialog(wo.id, a); } });
      })) : null,
      h("h3", { class: "sub-h" }, "Next"),
      h("p", { class: "small" }, "The Intake Clerk has opened a conversation with " + wo.conv.questions.length + " questions" + (wo.conv.misses.length ? " and noticed " + wo.conv.misses.length + " gap" + (wo.conv.misses.length > 1 ? "s" : "") : "") + ". " + wo.id + " stays at Intake until you confirm the brief (gate G0+G1)."),
      h("p", { class: "footnote" }, "Classification runs on local sample logic in this demo."));
    G.dialog({ title: wo.id + " classified as " + G.find.cls(wo.cls).name, kicker: "Intake · classification", sub: wo.title + " · " + G.find.repo(wo.repo).name, wide: true, body: body,
      actions: [{ label: "Close", id: "int-cls-close" }, { label: "Change class", id: "int-cls-change", guard: dec, onClick: function (close) { close(); G.intakeReclassifyDialog(wo.id); } },
        { label: "Answer intake questions", kind: "primary", submit: true, icon: "chat", id: "int-cls-open", onClick: function (close) { close(); G.openConversation(wo.id); } }] });
  };

  /* watch for a submission made through the traveler's dialog so the classification card still appears */
  function watchNext() {
    var start = G.store.get("nextWO"), me = G.viewerId();
    var unsub = G.store.subscribe(function (ch) {
      if (!ch.workOrders) return;
      var w = G.store.get("workOrders").find(function (x) { return +x.id.slice(3) >= start && x.requestedBy === me && !shown[x.id]; });
      if (w) { unsub(); setTimeout(function () { G.afterSubmitWO(w.id); }, 80); }
    });
    setTimeout(unsub, 10 * G.MIN);
  }
  /* reason the New work order button is locked for an allowed person, or null */
  G.intakeSubmitBlock = function (project) {
    var stop = G.stopState(project.id);
    if (stop) return stop.reason;
    var ok = G.store.get("repos").some(function (r) { return r.project === project.id && !G.submitGuard(project.id, r.id); });
    return ok ? null : "No repo in " + project.name + " is Ready yet. Finish onboarding first";
  };
  G.startNewWO = function (preset) {
    if (G.newWODialog) { watchNext(); G.newWODialog(preset); } else G.toast("The New work order dialog is not available.", "error");
  };

  /* ---------- table ---------- */
  function where(w) { return w.bay ? "b:" + w.bay : "s:" + w.station; }
  function render() {
    var project = G.currentProject();
    if (!project) return h("div", { class: "view" }, G.emptyState({ title: "No project", text: "You do not have a project to show." }));
    var flow = G.flowOf(project);
    var order = flow.stations.map(function (s) { return s.index; });
    var all = G.store.get("workOrders").filter(function (w) { return w.project === project.id; });
    var q = ui.q.trim().toLowerCase();
    var rows = all.filter(function (w) {
      if (ui.cls !== "all" && w.cls !== ui.cls) return false;
      if (ui.where !== "all" && where(w) !== ui.where) return false;
      if (ui.repo !== "all" && w.repo !== ui.repo) return false;
      if (ui.prio !== "all" && w.priority !== ui.prio) return false;
      if (ui.source !== "all" && w.source !== ui.source) return false;
      if (ui.state !== "all" && w.state !== ui.state) return false;
      if (q && (w.id + " " + w.title + " " + w.repo).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    function whereSort(w) { return w.bay ? 100 + flow.bays.findIndex(function (b) { return b.id === w.bay; }) : w.state === "done" ? 99 : order.indexOf(w.station); }
    function whereCell(w) {
      if (w.bay) return G.bayChip(w.bay);
      if (w.state === "done") return h("span", { class: "small" }, "Shipped" + (w.pr && w.pr.tag ? " " + w.pr.tag : ""));
      var st = G.stationOf(w) || { no: "", name: "?" };
      return h("span", null, h("span", { class: "mono muted" }, st.no + " "), st.name);
    }
    var columns = [
      { key: "id", label: "Work order", sort: function (w) { return +w.id.slice(3); }, render: function (w) { return h("span", { class: "mono strong wo-id" + (w.state === "killed" ? " is-killed" : "") }, w.id); } },
      { key: "title", label: "Title", sort: function (w) { return w.title.toLowerCase(); }, render: function (w) {
        return h("span", { class: "wo-title" + (w.state === "killed" ? " is-killed" : "") }, w.title, w.parent ? h("span", { class: "muted small" }, " · child of " + w.parent) : null, w.children.length ? h("span", { class: "muted small" }, " · " + w.children.length + " children") : null); } },
      { key: "cls", label: "Class", sort: function (w) { return w.cls; }, render: function (w) { return h("span", { class: "wo-cls" }, G.classChip(w.cls, { small: true }), w.clsOverridden ? h("span", { class: "wo-ovr", title: "Class overridden from " + (G.find.cls(w.clsOverridden.from) || { name: w.clsOverridden.from }).name }, G.icon("swap")) : null); } },
      { key: "where", label: "Station / bay", sort: whereSort, render: whereCell },
      { key: "state", label: "State", sort: function (w) { return ["killed", "failed", "blocked", "waiting", "parked", "running", "done"].indexOf(w.state); }, render: function (w) { return G.stateChip(w.state); } },
      { key: "repo", label: "Repo", hideSmall: true, sort: function (w) { return w.repo; }, render: function (w) { return h("span", { class: "mono small" }, w.repo); } },
      { key: "prio", label: "Pri", sort: function (w) { return w.priority; }, render: function (w) { return h("span", { class: "chip wo-prio wo-prio-" + w.priority }, w.priority); } },
      { key: "by", label: "Requested", hideSmall: true, sort: function (w) { return G.actorName(w.requestedBy); }, render: function (w) { return h("span", { class: "small wo-by" }, G.actorName(w.requestedBy), h("span", { class: "muted" }, " via " + w.source)); } },
      { key: "age", label: "Age", align: "end", sort: function (w) { return Date.now() - w.createdAt; }, render: function (w) { return h("span", { class: "mono" }, G.fmt.dur(Date.now() - w.createdAt)); } },
      { key: "cost", label: "Spend", align: "end", hideSmall: true, sort: function (w) { return G.woTotals(w).cost; }, render: function (w) { return h("span", { class: "mono" }, G.fmt.money(G.woTotals(w).cost)); } },
      { key: "act", label: "Open", render: function (w) {
        return h("span", { class: "wo-acts" },
          h("button", { type: "button", class: "icon-btn icon-btn-sm", id: "wo-rec-" + w.id, "aria-label": "Open full record for " + w.id, "data-tip": "Full record", onClick: function (e) { e.stopPropagation(); G.openRecord(w.id); } }, G.icon("record")),
          h("button", { type: "button", class: "icon-btn icon-btn-sm", id: "wo-conv-" + w.id, "aria-label": "Open intake conversation for " + w.id, "data-tip": "Intake conversation", onClick: function (e) { e.stopPropagation(); G.openConversation(w.id); } }, G.icon("chat")));
      } }
    ];
    var table = G.dataTable({ id: "wo-table", idPrefix: "wo-sort-", caption: "Work orders in " + project.name, columns: columns, rows: rows, rowKey: function (w) { return w.id; }, sort: { key: ui.sort, dir: ui.dir },
      onSort: function (s) { ui.sort = s.key; ui.dir = s.dir; },
      onRow: function (w) { G.openTraveler(w.id); }, pageSize: 60,
      empty: { title: "No work orders match", text: "Clear the search or filters, or submit the first work order to a Ready repo." } });
    table.classList.add("wo-table");
    var search = h("input", { id: "wo-q", class: "input", type: "search", placeholder: "Id, title or repo", value: ui.q, autocomplete: "off" });
    search.addEventListener("input", function () { ui.q = search.value; G.rerender(); });
    function sel(id, key, opts) {
      if (ui[key] !== "all" && !opts.some(function (o) { return o.value === ui[key]; })) ui[key] = "all";
      return G.select(id, [{ value: "all", label: "All" }].concat(opts), ui[key], function (v) { ui[key] = v; G.rerender(); });
    }
    var repos = G.store.get("repos").filter(function (r) { return r.project === project.id; });
    var sources = all.map(function (w) { return w.source; }).filter(function (s, i, a) { return a.indexOf(s) === i; }).sort();
    var count = function (f) { return all.filter(f).length; };
    var intake = all.filter(atIntake);
    var subD = G.me("wo.submit", { project: project.id });
    var filtered = ["cls", "where", "repo", "prio", "source", "state"].some(function (k) { return ui[k] !== "all"; }) || q;
    return h("div", { class: "view wo-view" },
      G.pageHeader({ id: "wo-head", kicker: "Project · " + project.name, title: "Work orders", sub: "Everything this project has taken on. Open a row for its traveler, or the record icon for the full lifecycle record.",
        meta: [["In flight", String(count(function (w) { return ["done", "killed"].indexOf(w.state) < 0 && !w.bay; }))], ["At Intake", String(intake.length)], ["In bays", String(count(function (w) { return !!w.bay; }))], ["Shipped", String(count(function (w) { return w.state === "done"; }))], ["Killed", String(count(function (w) { return w.state === "killed"; }))]],
        actions: [G.btn("All records", { icon: "record", id: "wo-records", onClick: function () { G.store.update("prefs", function (p) { p.record = null; }); location.hash = "record"; } }),
          G.btn("New work order", { kind: "primary", icon: "plus", id: "wo-new", guard: subD, disabledReason: subD.allowed ? G.intakeSubmitBlock(project) : null, onClick: function () { G.startNewWO({ project: project.id }); } })] }),
      intake.length ? h("div", { class: "callout wo-intake-note" }, G.icon("chat"), h("div", null, h("strong", null, intake.length + " at Intake. "), "They wait for their brief to be confirmed at G0+G1. ",
        h("a", { href: "#conversations", id: "wo-to-conv" }, "Open Conversations"))) : null,
      h("div", { class: "toolbar wo-toolbar" }, h("div", { class: "filters wo-filters" },
        G.field("Search", search),
        G.field("Class", sel("wo-f-cls", "cls", G.classesOf(project).map(function (c) { return { value: c.id, label: c.name + (c.custom ? " (custom)" : "") }; }))),
        G.field("Station or bay", sel("wo-f-where", "where", flow.stations.map(function (s) { return { value: "s:" + s.index, label: s.no + " " + s.name + (s.enabled ? "" : " (off)") }; }).concat(flow.bays.map(function (b) { return { value: "b:" + b.id, label: "Bay: " + b.name }; })))),
        G.field("Repo", sel("wo-f-repo", "repo", repos.map(function (r) { return { value: r.id, label: r.name }; }))),
        G.field("Priority", sel("wo-f-prio", "prio", PRIOS.map(function (p) { return { value: p, label: p }; }))),
        G.field("Source", sel("wo-f-source", "source", sources.map(function (s) { return { value: s, label: s }; }))),
        G.field("State", sel("wo-f-state", "state", Object.keys(G.STATES).map(function (k) { return { value: k, label: G.STATES[k].label }; })))),
        h("div", { class: "wo-count" }, h("span", { class: "muted small" }, rows.length + " of " + all.length + " shown"),
          filtered ? G.btn("Clear filters", { small: true, kind: "ghost", id: "wo-clear-top", onClick: clear }) : null)),
      rows.length ? table
        : G.emptyState({ id: "wo-empty", icon: "list", title: "No work orders match", text: filtered ? "Clear the search or filters." : "Submit the first work order to a Ready repo.", action: filtered ? G.btn("Clear filters", { id: "wo-clear", onClick: clear }) : null }));
  }
  function clear() { ui.q = ""; ui.cls = ui.where = ui.repo = ui.prio = ui.source = ui.state = "all"; G.rerender(); }

  G.views["work-orders"] = { title: "Work orders", render: render, keys: ["workOrders", "repos"] };
})(window.G);
