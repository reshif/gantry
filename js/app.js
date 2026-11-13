/* App shell: sign-in gate, router (#name hashes), nav groups filtered by role, top bar
   (project switcher, palette, inbox, user menu), kill banner, command palette, boot. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};

  function anyRole(p, roles) { return !!p && p.roles.some(function (g) { return roles.indexOf(g.role) >= 0; }); }
  var FACTORY_READ = ["factory_admin", "auditor"];
  /* Route table. Views register in G.views[id]; canSee here is the default when a view does not define one. */
  var BUILD_READ = FACTORY_READ.concat(["project_admin", "line_lead"]);
  G.ROUTES = [
    { id: "home", title: "Home", group: "Overview", icon: "home", canSee: function () { return true; } },
    { id: "projects", title: "Projects", group: "Overview", icon: "project", canSee: function () { return true; } },
    { id: "console", title: "Console", group: "Overview", icon: "console", canSee: function () { return true; } },
    { id: "floor", title: "Floor", group: "Project", icon: "belt", project: true },
    { id: "work-orders", title: "Work orders", group: "Project", icon: "list", project: true },
    { id: "conversations", title: "Conversations", group: "Project", icon: "chat", project: true },
    { id: "onboarding", title: "Onboarding", group: "Project", icon: "rocket", project: true },
    { id: "project-config", title: "Project config", group: "Project", icon: "filter", project: true },
    { id: "record", title: "Work order record", group: "Project", icon: "record", project: true, nav: false },
    { id: "agents", title: "Agents", group: "Agents", icon: "agent", canSee: function (p) { return anyRole(p, BUILD_READ); } },
    { id: "skills", title: "Skills", group: "Agents", icon: "skill", canSee: function (p) { return anyRole(p, BUILD_READ); } },
    { id: "models", title: "Models", group: "Agents", icon: "model", canSee: function (p) { return anyRole(p, BUILD_READ); } },
    { id: "evals", title: "Evals", group: "Agents", icon: "eval", canSee: function (p) { return anyRole(p, BUILD_READ); } },
    { id: "trust", title: "Trust", group: "Agents", icon: "trust", canSee: function (p) { return anyRole(p, BUILD_READ.concat(["approver", "release_manager"])); } },
    { id: "learning", title: "Learning", group: "Agents", icon: "learn", canSee: function (p) { return anyRole(p, BUILD_READ); } },
    { id: "integrations", title: "Integrations", group: "Connect", icon: "plug", canSee: function (p) { return anyRole(p, FACTORY_READ.concat(["project_admin"])); } },
    { id: "notifications", title: "Notifications", group: "Connect", icon: "bell", canSee: function (p) { return anyRole(p, FACTORY_READ.concat(["project_admin"])); } },
    { id: "mcp", title: "MCP servers", group: "Connect", icon: "server", canSee: function (p) { return anyRole(p, BUILD_READ); } },
    { id: "api", title: "API & triggers", group: "Connect", icon: "api", canSee: function (p) { return anyRole(p, FACTORY_READ.concat(["project_admin"])); } },
    { id: "people", title: "People & teams", group: "Govern", icon: "people", canSee: function (p) { return anyRole(p, FACTORY_READ.concat(["project_admin"])); } },
    { id: "workload", title: "Workload", group: "Govern", icon: "workload", canSee: function (p) { return anyRole(p, BUILD_READ); } },
    { id: "access", title: "Access", group: "Govern", icon: "lock", canSee: function (p) { return anyRole(p, FACTORY_READ); } },
    { id: "security", title: "Security", group: "Govern", icon: "shield", canSee: function (p) { return anyRole(p, FACTORY_READ); } },
    { id: "audit", title: "Audit", group: "Govern", icon: "ledger", canSee: function (p) { return G.can(p.id, "audit.view").allowed || anyRole(p, ["project_admin"]); } }
  ];
  G.NAV_GROUPS = ["Overview", "Project", "Agents", "Connect", "Govern"];
  G.routeDef = function (id) { return G.ROUTES.find(function (r) { return r.id === id; }); };
  G.canSeeRoute = function (id, person) {
    person = person || G.viewer();
    if (!person) return false;
    var r = G.routeDef(id); if (!r) return false;
    var v = G.views[id];
    if (r.project && !G.visibleProjects(person.id).length) return false;
    if (v && typeof v.canSee === "function") return !!v.canSee(person);
    return r.canSee ? !!r.canSee(person) : true;
  };
  var current = null;
  function hashRoute() {
    var name = (location.hash || "").replace(/^#/, "");
    if (!G.routeDef(name)) name = "home";
    if (!G.canSeeRoute(name)) { if (name !== "home") G.toast("You do not have access to " + G.routeDef(name).title + ".", "warn"); name = "home"; }
    return name;
  }

  /* ---------- rendering ---------- */
  function renderView(force) {
    if (!G.viewer()) return;
    var name = hashRoute();
    var main = document.getElementById("main");
    var changed = name !== current;
    var activeId = document.activeElement && main.contains(document.activeElement) ? document.activeElement.id : null;
    var sel = null;
    if (activeId && document.activeElement.setSelectionRange && typeof document.activeElement.selectionStart === "number") { try { sel = [document.activeElement.selectionStart, document.activeElement.selectionEnd]; } catch (e) { sel = null; } }
    var scrollers = {};
    main.querySelectorAll("[data-keep-scroll]").forEach(function (el) { scrollers[el.getAttribute("data-keep-scroll")] = [el.scrollLeft, el.scrollTop]; });
    var top = main.scrollTop;
    current = name;
    var view = G.views[name] || G.placeholderView(name);
    var node;
    try { node = view.render(); } catch (e) { console.error(e); node = h("div", { class: "view" }, G.empty("This screen failed to render", String(e && e.message || e))); }
    G.clear(main);
    if (G.routeDef(name).project) { var b = G.stopBanner(G.store.get("prefs").project); if (b && !G.store.get("factory").killed) main.appendChild(b); }
    main.appendChild(node);
    document.title = (view.title || G.routeDef(name).title) + " · Gantry Software Factory";
    if (!changed) {
      main.scrollTop = top;
      main.querySelectorAll("[data-keep-scroll]").forEach(function (el) { var s = scrollers[el.getAttribute("data-keep-scroll")]; if (s) { el.scrollLeft = s[0]; el.scrollTop = s[1]; } });
      if (activeId) { var a = document.getElementById(activeId); if (a) { a.focus({ preventScroll: true }); if (sel && a.setSelectionRange) { try { a.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not text */ } } } }
    } else { main.scrollTop = 0; if (!force) main.focus({ preventScroll: true }); }
    if (view.afterRender) { try { view.afterRender(node); } catch (e) { console.error(e); } }
    renderNav();
  }
  var scheduled = false;
  function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(function () { scheduled = false; renderView(); }); }
  G.rerender = schedule;
  G.currentRoute = function () { return current; };

  /* badge counts for nav items: { routeId: { n, kind, label } } */
  G.navBadges = function () {
    var out = {}, me = G.viewerId(); if (!me) return out;
    var project = G.currentProject();
    var vis = G.visibleProjects(me).map(function (p) { return p.id; });
    if (project && (project.killed || project.halted)) out.floor = { text: project.killed ? "killed" : "halted", kind: project.killed ? "is-kill" : "is-halt", label: project.name + " is " + (project.killed ? "killed" : "halted") };
    var conv = G.awaitingMe().length; if (conv) out.conversations = { n: conv, label: conv + " conversations waiting for you" };
    var ap = project ? G.myApprovals().filter(function (a) { return a.wo && a.wo.project === project.id; }).length : 0;
    if (ap) out["work-orders"] = { n: ap, label: ap + " approvals you can give in " + project.name };
    var ob = project ? G.store.get("repos").filter(function (r) { return r.project === project.id && ["person", "failed"].indexOf(r.onboarding.stage) >= 0; }).length : 0;
    if (ob) out.onboarding = { n: ob, kind: "is-warn", label: ob + " repos need a person" };
    var tr = G.store.get("trust");
    var tp = tr ? tr.proposals.filter(function (x) { if (x.status !== "pending") return false; var c = G.find.trustCell(x.cell); return c && vis.indexOf(c.project) >= 0; }).length : 0;
    if (tp) out.trust = { n: tp, label: tp + " trust proposals pending" };
    var L = G.store.get("learning");
    var lp = L ? L.proposals.filter(function (x) { return x.status === "proposed"; }).length : 0;
    if (lp) out.learning = { n: lp, label: lp + " learning proposals to review" };
    var bad = (G.store.get("integrationInstances") || []).filter(function (i) { return i.status === "failing" || i.status === "offline"; }).length;
    if (bad) out.integrations = { n: bad, kind: "is-warn", label: bad + " integrations failing or offline" };
    return out;
  };
  function renderNav() {
    var nav = document.getElementById("nav");
    var focusKey = document.activeElement && nav.contains(document.activeElement) ? (document.activeElement.getAttribute("href") || document.activeElement.id) : null;
    G.clear(nav);
    var person = G.viewer(); if (!person) return;
    var prefs = G.store.get("prefs");
    var rail = !!prefs.navRail;
    document.getElementById("app").classList.toggle("nav-rail", rail);
    var project = G.currentProject();
    var badges = G.navBadges();
    nav.appendChild(h("div", { class: "nav-top" }, h("button", { type: "button", class: "icon-btn nav-rail-btn", id: "nav-rail-toggle", "aria-pressed": rail ? "true" : "false", "aria-label": rail ? "Expand sidebar" : "Collapse sidebar to icons", "data-tip": rail ? "Expand sidebar" : "Collapse to icons", onClick: function () {
      G.store.update("prefs", function (p) { p.navRail = !p.navRail; }); renderNav(); var b = document.getElementById("nav-rail-toggle"); if (b) b.focus();
    } }, G.icon("rail"))));
    G.NAV_GROUPS.forEach(function (gname) {
      var items = G.ROUTES.filter(function (r) { return r.group === gname && r.nav !== false && G.canSeeRoute(r.id, person); });
      if (!items.length) return;
      var collapsed = !rail && !!(prefs.navCollapsed || {})[gname];
      var gid = "navg-" + gname.toLowerCase();
      var total = items.reduce(function (n, it) { return n + (badges[it.id] && badges[it.id].n || 0); }, 0);
      var head = h("button", { type: "button", class: "nav-group nav-group-btn", id: gid + "-btn", "aria-expanded": collapsed ? "false" : "true", "aria-controls": gid,
        onClick: function () { G.store.update("prefs", function (p) { p.navCollapsed = Object.assign({}, p.navCollapsed); p.navCollapsed[gname] = !collapsed; }); renderNav(); var b = document.getElementById(gid + "-btn"); if (b) b.focus(); } },
        G.icon(collapsed ? "chevron" : "down", "nav-caret"),
        gname === "Project" && project ? h("span", { class: "nav-group-name" }, "Project · ", h("span", { class: "nav-proj" }, project.name)) : h("span", { class: "nav-group-name" }, gname),
        collapsed && total ? h("span", { class: "nav-count mono" }, String(total)) : null);
      nav.appendChild(rail ? h("div", { class: "nav-group-rule", role: "separator", "aria-label": gname }) : head);
      var list = h("ul", { class: "nav-list", id: gid, hidden: collapsed ? true : null }, items.map(function (it) {
        var bd = badges[it.id], badge = null;
        if (bd) badge = bd.text ? h("span", { class: "nav-badge " + (bd.kind || ""), title: bd.label }, bd.text) : h("span", { class: "nav-count mono " + (bd.kind || ""), title: bd.label }, String(bd.n));
        var active = current === it.id || (it.id === "work-orders" && current === "record");
        return h("li", null, h("a", { href: "#" + it.id, class: "nav-link" + (active ? " is-active" : ""), "aria-current": current === it.id ? "page" : null, "aria-label": rail ? it.title + (bd ? ", " + bd.label : "") : null, "data-tip": rail ? it.title + (bd ? " · " + bd.label : "") : null, onClick: closeNav },
          G.icon(it.icon), h("span", { class: "nav-text" }, it.title), badge));
      }));
      nav.appendChild(list);
    });
    if (focusKey) { var f = nav.querySelector('a[href="' + focusKey + '"]') || document.getElementById(focusKey); if (f) f.focus(); }
  }
  G.renderNav = function () { renderNav(); };
  function openNav() { document.getElementById("app").classList.add("nav-open"); document.getElementById("nav-scrim").hidden = false; var a = document.querySelector(".nav-link"); if (a) a.focus(); }
  function closeNav() { document.getElementById("app").classList.remove("nav-open"); document.getElementById("nav-scrim").hidden = true; }

  /* ---------- inbox ---------- */
  G.awaitingMe = function () {
    var me = G.viewerId(); if (!me) return [];
    var vis = G.visibleProjects(me).map(function (p) { return p.id; });
    return G.store.get("workOrders").filter(function (w) {
      if (vis.indexOf(w.project) < 0 || ["done", "killed"].indexOf(w.state) >= 0 || w.bay === "declined") return false;
      var raised = w.conv.raised.some(function (q) { return !q.answered; });
      var atIntake = w.station === 0 && w.gates.G0G1 && w.gates.G0G1.status === "waiting";
      var intakeOpen = atIntake && !w.conv.done;
      var toConfirm = atIntake && w.conv.done && !w.bay;
      if (!raised && !intakeOpen && !toConfirm) return false;
      if (toConfirm && !intakeOpen && !raised) return G.gateDecision(me, w, "G0G1").allowed && (w.requestedBy === me || G.rolesIn(G.viewer(), w.project).some(function (r) { return ["line_lead", "project_admin"].indexOf(r) >= 0; }));
      return w.requestedBy === me || (raised && G.can(me, "wo.answer", { project: w.project }).allowed && G.rolesIn(G.viewer(), w.project).some(function (r) { return ["line_lead", "project_admin"].indexOf(r) >= 0; }));
    });
  };
  G.myApprovals = function () {
    var me = G.viewerId(); if (!me) return [];
    var vis = G.visibleProjects(me).map(function (p) { return p.id; });
    var out = [];
    G.store.get("workOrders").forEach(function (w) {
      if (vis.indexOf(w.project) < 0 || w.bay) return;
      Object.keys(w.gates).forEach(function (gid) { if (w.gates[gid].status === "waiting" && G.gateDecision(me, w, gid).allowed) out.push({ wo: w, gate: gid }); });
    });
    G.store.get("repos").forEach(function (r) { if (vis.indexOf(r.project) >= 0 && r.onboarding.pr && r.onboarding.pr.checks === "green" && r.onboarding.pr.state === "open" && G.can(me, "onboarding.merge", { project: r.project }).allowed) out.push({ repo: r }); });
    return out;
  };
  function openInbox(anchor) {
    var ap = G.myApprovals(), conv = G.awaitingMe();
    var close;
    function item(icon, main, sub, fn) { return h("li", null, h("button", { type: "button", class: "inbox-item", onClick: function () { close(); fn(); } }, G.icon(icon, "c-wait"), h("span", { class: "inbox-main" }, h("span", null, main), h("span", { class: "muted small" }, sub)))); }
    var list = h("ul", { class: "inbox" },
      ap.map(function (a) {
        if (a.repo) return item("rocket", "Merge onboarding PR " + a.repo.name + "#" + a.repo.onboarding.pr.number, "Checks green", function () { location.hash = "onboarding"; G.store.update("prefs", function (p) { p.project = a.repo.project; }); });
        var g = G.gateDef(a.gate);
        return item("st-wait", a.wo.id + " · " + g.label + " " + g.name, a.wo.title + " · " + G.find.project(a.wo.project).name, function () { G.openTraveler(a.wo.id); });
      }),
      conv.map(function (w) { return item("chat", w.id + " · questions for you", w.title, function () { G.store.update("prefs", function (p) { p.project = w.project; p.openConversation = w.id; }); location.hash = "conversations"; }); }));
    close = G.popover(anchor, h("div", null, h("div", { class: "pop-head" }, h("strong", null, "Waiting for " + G.viewer().name), h("span", { class: "muted small" }, ap.length + " approvals · " + conv.length + " conversations")),
      ap.length + conv.length ? list : G.empty("Nothing waiting for you", "Approvals you may give and questions addressed to you appear here.")));
  }

  /* ---------- status cluster: factory state, IST clock and shift, change windows, simulation ---------- */
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  G.statusInfo = function (t) {
    t = t || Date.now();
    var d = new Date(t + 330 * 60000), day = d.getUTCDay(), hm = d.getUTCHours() * 60 + d.getUTCMinutes();
    var weekend = day === 0 || day === 6;
    var shift = weekend ? "Weekend" : hm >= 540 && hm < 1140 ? "Day shift" : "Out of hours";
    function mins(s) { var p = s.split(":"); return +p[0] * 60 + +p[1]; }
    var vis = G.viewer() ? G.visibleProjects(G.viewerId()).map(function (p) { return p.id; }) : [];
    var windows = G.store.get("policies").filter(function (p) { return p.enabled && p.effect === "allow" && p.when && p.actions.indexOf("release") >= 0 && (!p.where.projects.length || p.where.projects.some(function (x) { return vis.indexOf(x) >= 0; })); }).map(function (p) {
      var open = p.when.days.indexOf(day) >= 0 && hm >= mins(p.when.from) && hm < mins(p.when.to);
      return { id: p.id, name: p.name, open: open, projects: p.where.projects, text: (p.when.days.length === 7 ? "Every day" : p.when.days.map(function (x) { return DAYS[x]; }).join(", ")) + " " + p.when.from + "–" + p.when.to + " IST" };
    });
    var freezes = G.store.get("freezes").map(function (f) { return Object.assign({ active: f.from <= t && f.to > t, upcoming: f.from > t }, f); }).filter(function (f) { return f.active || f.upcoming; });
    var prefs = G.store.get("prefs"), fac = G.store.get("factory");
    return { at: t, clock: G.fmt.ist(t), date: G.fmt.istDate(t), shift: shift, windows: windows, freezes: freezes, activeFreezes: freezes.filter(function (f) { return f.active; }),
      factory: prefs.replay ? "replay" : fac.killed ? "killed" : "running", sim: prefs.paused ? "paused" : "running" };
  };
  function statusCluster() {
    var s = G.statusInfo();
    var stateText = s.factory === "replay" ? "Replay" : s.factory === "killed" ? "Killed" : "Running";
    var winOpen = s.windows.filter(function (w) { return w.open; }).length;
    var btn = h("button", { type: "button", class: "status-cluster is-" + s.factory, id: "status-cluster", "aria-haspopup": "dialog", "aria-expanded": "false",
      "aria-label": "Factory " + stateText.toLowerCase() + ". " + s.clock + " IST, " + s.shift + ". " + (s.activeFreezes.length ? s.activeFreezes.length + " freeze active. " : "") + "Simulation " + s.sim + ". Show change windows and freezes." },
      h("span", { class: "sc-state" }, h("span", { class: "sc-dot", "aria-hidden": "true" }), h("span", { class: "sc-label" }, stateText)),
      h("span", { class: "sc-clock mono", id: "status-clock" }, s.clock, h("span", { class: "sc-tz" }, " IST")),
      h("span", { class: "sc-shift" }, s.shift),
      s.activeFreezes.length ? h("span", { class: "sc-freeze" }, G.icon("lock"), h("span", { class: "sc-long" }, s.activeFreezes.length + " freeze")) : h("span", { class: "sc-win sc-long" }, winOpen + " windows open"),
      h("span", { class: "sc-sim is-" + s.sim, title: "Simulation " + s.sim }, G.icon(s.sim === "paused" ? "pause" : "play")));
    btn.addEventListener("click", function () { statusPopover(btn); });
    return btn;
  }
  function statusPopover(anchor) {
    var s = G.statusInfo(), close;
    var prefs = G.store.get("prefs");
    var body = h("div", { class: "status-pop" },
      h("div", { class: "pop-head" }, h("strong", null, "Factory " + (s.factory === "replay" ? "in replay" : s.factory)), h("span", { class: "muted small" }, s.date + " " + s.clock + " IST · " + s.shift)),
      s.factory === "replay" ? h("div", { class: "sp-row" }, h("span", null, "Showing the floor at " + G.fmt.stamp(prefs.replay.at || Date.now()) + "."), G.btn("Exit replay", { small: true, id: "sp-exit-replay", onClick: function () { G.ops.setReplay(null); close(); } })) : null,
      h("h3", { class: "sp-h" }, "Release windows"),
      s.windows.length ? h("ul", { class: "plain-list sp-list" }, s.windows.map(function (w) { return h("li", null, h("span", { class: "sp-dot " + (w.open ? "is-open" : "is-closed"), "aria-hidden": "true" }), h("span", null, h("strong", null, w.name), " · " + w.text + (w.projects.length ? " · " + w.projects.map(function (p) { return (G.find.project(p) || { name: p }).name; }).join(", ") : " · all projects")), h("span", { class: "muted small" }, w.open ? "open now" : "closed")); })) : h("p", { class: "muted small" }, "No release windows apply to your projects."),
      h("h3", { class: "sp-h" }, "Freezes"),
      s.freezes.length ? h("ul", { class: "plain-list sp-list" }, s.freezes.map(function (f) { return h("li", null, h("span", { class: "sp-dot " + (f.active ? "is-freeze" : "is-closed"), "aria-hidden": "true" }), h("span", null, h("strong", null, f.name), " · " + (f.repos === "all" ? "all repos" : f.repos.join(", "))), h("span", { class: "muted small" }, (f.active ? "until " : "from ") + G.fmt.stamp(f.active ? f.to : f.from))); })) : h("p", { class: "muted small" }, "No freezes active or scheduled."),
      h("div", { class: "sp-row" }, h("span", null, "Simulation is " + s.sim + "."), G.btn(s.sim === "paused" ? "Resume simulation" : "Pause simulation", { small: true, id: "sp-sim", onClick: function () { G.store.update("prefs", function (p) { p.paused = !p.paused; }); close(); } })),
      G.canSeeRoute("access") ? h("a", { href: "#access", class: "small", onClick: function () { close(); } }, "Manage windows and freezes in Access") : null);
    close = G.popover(anchor, body);
  }

  /* ---------- top bar ---------- */
  function renderTop() {
    var top = document.getElementById("topbar");
    var focusId = top.contains(document.activeElement) ? document.activeElement.id : null;
    G.clear(top);
    var v = G.viewer(); if (!v) return;
    var projects = G.visibleProjects(v.id);
    var cur = G.currentProject();
    var n = G.myApprovals().length + G.awaitingMe().length;
    var theme = G.store.get("prefs").theme;
    var projSel = projects.length ? G.select("project-switch", projects.map(function (p) { return { value: p.id, label: p.name + (p.killed ? " · killed" : p.halted ? " · halted" : p.status !== "active" ? " · " + p.status : "") }; }), cur && cur.id, function (id) {
      G.store.update("prefs", function (p) { p.project = id; }); G.toast("Project: " + G.find.project(id).name + ".");
    }, { "aria-label": "Current project" }) : h("span", { class: "muted small" }, "No projects");
    var inboxBtn = h("button", { type: "button", class: "icon-btn inbox-btn", id: "inbox-btn", "aria-label": "Waiting for you: " + n, "aria-haspopup": "dialog", "aria-expanded": "false" }, G.icon("bell"), n ? h("span", { class: "inbox-count mono" }, String(n)) : null);
    inboxBtn.addEventListener("click", function () { openInbox(inboxBtn); });
    var userBtn = h("button", { type: "button", class: "user-btn", id: "user-menu", "aria-haspopup": "menu", "aria-label": "Account menu for " + v.name }, G.avatar(v.id, "sm"), h("span", { class: "user-name" }, v.name.split(" ")[0]), G.icon("down"));
    userBtn.addEventListener("click", function () { userMenu(userBtn, theme); });
    top.appendChild(h("button", { type: "button", class: "icon-btn nav-toggle", "aria-label": "Open navigation", onClick: openNav }, G.icon("menu")));
    top.appendChild(h("a", { href: "#home", class: "brand" }, G.logo(), h("span", { class: "brand-name" }, "Gantry")));
    top.appendChild(h("span", { class: "demo-chip", tabindex: "0", "data-tip": "Everything here is sample data held in memory. Nothing reaches GitHub, Slack, Teams, email, any webhook or any model vendor." }, h("span", { class: "demo-long" }, "Demo workspace · sample data"), h("span", { class: "demo-short" }, "Demo")));
    top.appendChild(h("div", { class: "proj-switch" }, h("label", { for: "project-switch", class: "viewing-l" }, "Project"), projSel));
    top.appendChild(h("button", { type: "button", class: "palette-btn", id: "palette-btn", onClick: openPalette, "aria-label": "Open command palette" }, G.icon("search"), h("span", { class: "palette-label" }, "Jump to or run…"), h("kbd", null, /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘K" : "Ctrl K")));
    top.appendChild(h("div", { class: "top-right" }, statusCluster(), inboxBtn, userBtn));
    if (focusId) { var fe = document.getElementById(focusId); if (fe) fe.focus({ preventScroll: true }); }
    var banner = document.getElementById("sysbanner");
    G.clear(banner);
    var f = G.store.get("factory").killed;
    banner.hidden = !f;
    if (f) banner.appendChild(G.stopBanner(null));
  }
  function userMenu(anchor, theme) {
    var v = G.viewer();
    G.menu(anchor, v.name + " · " + v.email, [
      { label: "Profile", icon: "user", onClick: profileDialog },
      { label: "My roles per project", icon: "lock", onClick: rolesDialog },
      { label: "My sessions", icon: "key", onClick: sessionsDialog },
      { sep: true },
      { label: "Theme: system", icon: "auto", hint: theme === "system" ? "on" : "", onClick: function () { setTheme("system"); } },
      { label: "Theme: light", icon: "sun", hint: theme === "light" ? "on" : "", onClick: function () { setTheme("light"); } },
      { label: "Theme: dark", icon: "moon", hint: theme === "dark" ? "on" : "", onClick: function () { setTheme("dark"); } },
      { sep: true },
      { label: "Switch demo account (demo only)", icon: "swap", onClick: function () { G.signOut("switch demo account"); } },
      { label: "Sign out", icon: "logout", onClick: function () { G.signOut(); } }
    ]);
  }
  function setTheme(t) { G.store.update("prefs", function (p) { p.theme = t; }); applyTheme(); }
  function applyTheme() { var t = G.store.get("prefs").theme; if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t); }
  function profileDialog() {
    var v = G.viewer();
    G.dialog({ title: v.name, kicker: "Profile", body: h("dl", { class: "titleblock" },
      [["Title", v.title], ["Email", v.email], ["GitHub", v.github || "not linked"], ["Teams", v.teams.map(function (t) { return G.find.team(t).name; }).join(", ")], ["On call", v.oncall ? "yes" : "no"], ["Signed in via", G.store.get("session").method]].map(function (x) { return h("div", null, h("dt", null, x[0]), h("dd", null, x[1])); })) });
  }
  function rolesDialog() {
    var v = G.viewer();
    G.dialog({ title: "My roles", kicker: "Access", sub: "Roles are granted at factory level or per project. Projects where you hold no role are hidden from you.",
      body: h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" }, h("thead", null, h("tr", null, h("th", { scope: "col" }, "Scope"), h("th", { scope: "col" }, "Role"))),
        h("tbody", null, v.roles.map(function (g) { return h("tr", null, h("td", null, g.scope === "factory" ? "Factory" : (G.find.project(g.scope) || {}).name), h("td", null, G.find.role(g.role).name)); })))) });
  }
  function sessionsDialog() {
    var v = G.viewer();
    var box = h("div");
    function draw() {
      G.clear(box);
      var mine = G.store.get("sessions").filter(function (s) { return s.person === v.id && !s.revoked; });
      box.appendChild(h("ul", { class: "plain-list" }, mine.map(function (s) {
        var cur = G.store.get("session") && G.store.get("session").id === s.id;
        return h("li", { class: "sess-row" }, h("span", null, h("strong", null, s.device), " · " + s.method + " · " + s.ip), h("span", { class: "muted small" }, "since " + G.fmt.stamp(s.started)),
          cur ? G.chip("this session", "chip-accent") : G.btn("Revoke", { small: true, id: "rev-" + s.id, onClick: function () { var r = G.ops.revokeSession(s.id); G.toast(r.msg, r.ok ? "ok" : "error"); draw(); } }));
      })));
    }
    draw();
    G.dialog({ title: "My sessions", kicker: "Security", body: box });
  }

  /* ---------- command palette ---------- */
  function paletteItems() {
    var items = [], v = G.viewer();
    var vis = G.visibleProjects(v.id);
    G.ROUTES.forEach(function (r) { if (r.nav !== false && G.canSeeRoute(r.id)) items.push({ key: r.id, kind: "View", label: r.title, hint: "#" + r.id, run: function () { location.hash = r.id; } }); });
    vis.forEach(function (p) { items.push({ key: "project:" + p.id, kind: "Project", label: p.name, hint: "switch to " + p.key, run: function () { G.store.update("prefs", function (x) { x.project = p.id; }); location.hash = "floor"; } }); });
    var vids = vis.map(function (p) { return p.id; });
    G.store.get("workOrders").forEach(function (w) { if (vids.indexOf(w.project) >= 0) items.push({ key: "wo:" + w.id, kind: "Work order", label: w.id + " " + w.title, hint: w.repo + " · " + G.STATES[w.state].label, run: function () { G.openTraveler(w.id); } }); if (vids.indexOf(w.project) >= 0) items.push({ key: "record:" + w.id, kind: "Record", label: w.id + " full record", hint: w.title, run: function () { G.store.update("prefs", function (x) { x.project = w.project; }); G.openRecord(w.id); } }); });
    G.store.get("repos").forEach(function (r) { if (vids.indexOf(r.project) >= 0) items.push({ key: "repo:" + r.id, kind: "Repo", label: r.name, hint: G.find.project(r.project).name + " · " + r.onboarding.stage, run: function () { G.store.update("prefs", function (x) { x.project = r.project; }); location.hash = "onboarding"; } }); });
    G.store.get("agents").forEach(function (a) { if (G.canSeeRoute("agents")) items.push({ key: "agent:" + a.id, kind: "Agent", label: a.name, hint: a.model, run: function () { G.store.update("prefs", function (x) { x.agent = a.id; }); location.hash = "agents"; } }); });
    if (G.newWODialog) items.push({ kind: "Action", label: "Submit a work order", hint: "Intake", guard: G.meAnyProject("wo.submit"), run: function () { G.newWODialog(); } });
    var cp = G.currentProject();
    if (cp) {
      items.push({ kind: "Action", label: (cp.halted ? "Resume " : "Halt ") + cp.name, hint: "andon", guard: G.me(cp.halted ? "line.resume" : "line.halt", { project: cp.id }), run: function () { if (cp.halted) { var r = G.ops.resumeProject(cp.id); G.toast(r.msg, r.ok ? "ok" : "error"); } else G.haltDialog("project", cp.id); } });
      items.push({ kind: "Action", label: (cp.killed ? "Restore " : "Kill ") + cp.name, hint: "kill switch", guard: G.me(cp.killed ? "restore.project" : "kill.project", { project: cp.id }), run: function () { if (cp.killed) G.restoreDialog("project", cp.id); else G.killDialog("project", cp.id); } });
    }
    var fk = G.store.get("factory").killed;
    items.push({ kind: "Action", label: fk ? "Restore the factory" : "Kill the factory", hint: "kill switch", guard: G.me(fk ? "restore.factory" : "kill.factory"), run: function () { if (fk) G.restoreDialog("factory"); else G.killDialog("factory"); } });
    items.push({ kind: "Action", label: G.store.get("prefs").paused ? "Resume simulation" : "Pause simulation", hint: "demo", run: function () { G.store.update("prefs", function (p) { p.paused = !p.paused; }); } });
    items.push({ kind: "Action", label: "Sign out", hint: G.viewer().name, run: function () { G.signOut(); } });
    return items;
  }
  function openPalette() {
    var all = paletteItems(), active = 0, shown = [];
    var byKey = {}; all.forEach(function (it) { if (it.key) byKey[it.key] = it; });
    var input = h("input", { id: "palette-input", class: "palette-input", placeholder: "Type a view, project, WO id, repo, agent or action", autocomplete: "off", "aria-controls": "palette-list", "aria-label": "Search commands", role: "combobox", "aria-expanded": "true" });
    var list = h("ul", { id: "palette-list", class: "palette-list", role: "listbox", "aria-label": "Results" });
    function prefs() { return G.store.get("prefs"); }
    function togglePin(key) {
      G.store.update("prefs", function (p) { var l = (p.palettePinned || []).slice(); var i = l.indexOf(key); if (i >= 0) l.splice(i, 1); else l.unshift(key); p.palettePinned = l.slice(0, 8); });
      draw(); input.focus();
    }
    function draw() {
      var q = input.value.trim().toLowerCase();
      var pinned = (prefs().palettePinned || []).map(function (k) { return byKey[k]; }).filter(Boolean);
      var recent = (prefs().paletteRecent || []).filter(function (k) { return (prefs().palettePinned || []).indexOf(k) < 0; }).map(function (k) { return byKey[k]; }).filter(Boolean).slice(0, 5);
      if (!q) {
        var rest = all.filter(function (it) { return (it.kind === "View" || it.kind === "Action") && pinned.indexOf(it) < 0 && recent.indexOf(it) < 0; });
        shown = pinned.map(function (it) { return { it: it, sec: "Pinned" }; }).concat(recent.map(function (it) { return { it: it, sec: "Recent" }; }), rest.map(function (it) { return { it: it, sec: "All" }; })).slice(0, 48);
      } else {
        shown = all.filter(function (it) { var hay = (it.kind + " " + it.label + " " + it.hint).toLowerCase(); return q.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; }); }).slice(0, 40).map(function (it) { return { it: it, sec: null }; });
      }
      if (active >= shown.length) active = Math.max(0, shown.length - 1);
      G.clear(list);
      if (!shown.length) list.appendChild(h("li", { class: "palette-empty", role: "presentation" }, "No match. Try a WO id like WO-2417 or a repo name."));
      var lastSec = null;
      shown.forEach(function (row, i) {
        var it = row.it;
        if (row.sec && row.sec !== lastSec && !(row.sec === "All" && lastSec === null)) list.appendChild(h("li", { class: "palette-sec", role: "presentation" }, row.sec));
        lastSec = row.sec;
        var locked = it.guard && !it.guard.allowed;
        var isPinned = it.key && (prefs().palettePinned || []).indexOf(it.key) >= 0;
        var pin = it.key ? h("button", { type: "button", class: "pal-pin" + (isPinned ? " is-on" : ""), tabindex: "-1", "aria-label": (isPinned ? "Unpin " : "Pin ") + it.label, title: isPinned ? "Unpin" : "Pin to top" }, G.icon("pin")) : null;
        if (pin) pin.addEventListener("mousedown", function (e) { e.preventDefault(); e.stopPropagation(); togglePin(it.key); });
        var li = h("li", { role: "option", id: "pal-opt-" + i, class: "palette-item" + (i === active ? " is-active" : "") + (locked ? " is-locked" : ""), "aria-selected": i === active ? "true" : "false", "aria-disabled": locked ? "true" : null },
          h("span", { class: "pal-kind" }, it.kind), h("span", { class: "pal-label" }, it.label), h("span", { class: "pal-hint mono" }, locked ? (it.guard.needs || "Not permitted") : it.hint), pin);
        li.addEventListener("mousedown", function (e) { if (e.target.closest(".pal-pin")) return; e.preventDefault(); active = i; runActive(); });
        list.appendChild(li);
      });
      input.setAttribute("aria-activedescendant", shown.length ? "pal-opt-" + active : "");
    }
    var dlg;
    function runActive() {
      var row = shown[active]; if (!row) return; var it = row.it;
      if (it.guard && !it.guard.allowed) { G.toast((it.guard.needs ? it.guard.needs + ". " : "") + it.guard.reason, "error"); return; }
      if (it.key) G.store.update("prefs", function (p) { var l = (p.paletteRecent || []).filter(function (k) { return k !== it.key; }); l.unshift(it.key); p.paletteRecent = l.slice(0, 8); });
      dlg.close(); setTimeout(it.run, 0);
    }
    input.addEventListener("input", function () { active = 0; draw(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); draw(); var el = document.getElementById("pal-opt-" + active); if (el) el.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); draw(); var el2 = document.getElementById("pal-opt-" + active); if (el2) el2.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Enter") { e.preventDefault(); runActive(); }
      else if ((e.altKey && (e.key === "p" || e.key === "P" || e.key === "π"))) { e.preventDefault(); var r = shown[active]; if (r && r.it.key) togglePin(r.it.key); }
    });
    dlg = G.dialog({ title: "Command palette", kicker: "Ctrl/Cmd K · Alt+P pins the highlighted item", body: h("div", { class: "palette" }, input, list), actions: [{ label: "Close" }] });
    dlg.panel.classList.add("dlg-palette");
    draw();
  }
  G.openPalette = openPalette;

  /* ---------- signed-in / signed-out switching ---------- */
  var lastSession = undefined;
  function syncAuth() {
    var s = G.store.get("session");
    var key = s ? s.id : null;
    if (key === lastSession) return false;
    lastSession = key;
    document.body.classList.toggle("signed-out", !s);
    document.getElementById("auth").hidden = !!s;
    document.getElementById("app").hidden = !s;
    if (!s) { current = null; G.clear(document.getElementById("main")); G.clear(document.getElementById("nav")); G.clear(document.getElementById("topbar")); G.renderSignIn(); }
    else {
      var vis = G.visibleProjects(s.person);
      if (vis.length && !vis.some(function (p) { return p.id === G.store.get("prefs").project; })) G.store.get("prefs").project = vis[0].id;
      G.clear(document.getElementById("auth")); renderTop(); renderNav(); renderView(true);
    }
    return true;
  }

  function boot() {
    applyTheme();
    syncAuth();
    document.getElementById("nav-scrim").addEventListener("click", closeNav);
    window.addEventListener("hashchange", function () { closeNav(); G.drawer.close(); G.clear(document.getElementById("layer-pop")); if (G.viewer()) renderView(); });
    window.addEventListener("resize", function () { var v = G.views[current]; if (v && v.onResize) v.onResize(); });
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K") && G.viewer()) { e.preventDefault(); openPalette(); }
      else if (e.key === "Escape" && document.getElementById("app").classList.contains("nav-open")) closeNav();
    });
    G.store.subscribe(function (keys) {
      if (keys.session && syncAuth()) return;
      if (!G.viewer()) return;
      var v = G.views[current];
      var global = keys.prefs || keys.matrix || keys.policies || keys.factory || keys.people;
      if (global || keys.projects || keys.workOrders || keys.repos) renderTop();
      if (!v || !v.keys || global || v.keys.some(function (k) { return keys[k]; })) schedule(); else renderNav();
      if (G.drawer.isOpen()) G.drawer.refresh();
    });
    if (G.reducedMotion()) G.store.get("prefs").paused = true;
    G.sim.start();
    var lastShift = null;
    setInterval(function () {
      if (!G.viewer()) return;
      var s = G.statusInfo(), key = s.shift + "|" + s.windows.map(function (w) { return w.open ? 1 : 0; }).join("") + "|" + s.activeFreezes.length;
      var top = document.getElementById("topbar");
      if (lastShift !== null && key !== lastShift && !top.contains(document.activeElement)) renderTop();
      else { var c = document.getElementById("status-clock"); if (c && c.firstChild) c.firstChild.nodeValue = s.clock; }
      lastShift = key;
    }, 20000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(window.G);
