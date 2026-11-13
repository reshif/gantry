/* People & teams: org -> teams -> members, invites, factory role, per-project roles and
   effective permissions evaluated live by the policy engine (G.can). */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { sel: null, q: "", effProject: "all", cell: null };

  /* role lists come from the catalogue, so custom roles appear here as soon as Access adds them */
  function factoryRoles() { return G.ROLES.filter(function (r) { return r.level === "factory"; }).map(function (r) { return r.id; }); }
  function projectRoles() { return G.ROLES.filter(function (r) { return r.level !== "factory"; }); }
  /* G.ops.setFactoryRole accepts any factory-level role, built in or custom */
  function setFactoryRoleAny(personId, roleId, add) { return G.ops.setFactoryRole(personId, roleId, add); }
  G.peopleSelect = function (pid) { if (G.find.person(pid)) { ui.sel = pid; ui.q = ""; } };
  function roleName(id) { var r = G.find.role(id); return r ? r.name : id; }
  function factoryRoleOf(p) { var g = p.roles.find(function (x) { return x.scope === "factory"; }); return g ? g.role : ""; }
  function grantLabel(g) { return roleName(g.role) + " · " + (g.scope === "factory" ? "Factory" : (G.find.project(g.scope) || { name: g.scope }).name); }
  function lockd(reason, needs) { return { allowed: false, reason: reason, needs: needs || "" }; }
  function factoryAdmins() { return G.store.get("people").filter(function (p) { return p.status === "active" && p.roles.some(function (g) { return g.role === "factory_admin"; }); }); }

  /* ---------- invite ---------- */
  G.inviteDialog = function (preset) {
    preset = preset || {};
    var perm = G.me("people.manage");
    var s = G.store.get();
    var name = h("input", { id: "ppl-inv-name", class: "input", autocomplete: "off", placeholder: "Full name" });
    var email = h("input", { id: "ppl-inv-email", class: "input", type: "email", autocomplete: "off", placeholder: "name@" + (s.security.domains[0] || "acme.dev") });
    var teams = h("div", { class: "check-grid" }, s.teams.map(function (t) {
      return h("label", { class: "check", for: "ppl-inv-t-" + t.id }, h("input", { type: "checkbox", id: "ppl-inv-t-" + t.id, value: t.id, checked: preset.team === t.id }), t.name);
    }));
    var fRole = G.select("ppl-inv-frole", [{ value: "", label: "None" }].concat(factoryRoles().map(function (r) { return { value: r, label: roleName(r) }; })), "");
    var proj = G.select("ppl-inv-proj", [{ value: "", label: "No project yet" }].concat(s.projects.filter(function (p) { return p.status !== "archived"; }).map(function (p) { return { value: p.id, label: p.name }; })), preset.project || "");
    var pRole = G.select("ppl-inv-prole", projectRoles().map(function (r) { return { value: r.id, label: r.name + (r.custom ? " (custom)" : "") }; }), "engineer");
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({
      title: "Invite a person", kicker: "People", wide: true,
      sub: "They get an email with a sign-in link (simulated). Until they accept, the policy engine grants them nothing.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Inviting people"),
        h("div", { class: "form-row" }, G.field("Name", name), G.field("Work email", email, "Must use an allowed domain: " + s.security.domains.join(", "))),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Teams"), teams),
        h("div", { class: "form-row" }, G.field("Factory role", fRole, "Factory roles apply in every project."), G.field("First project", proj), G.field("Role in that project", pRole)),
        err),
      actions: [{ label: "Cancel" }, { label: "Send invite", kind: "primary", icon: "send", submit: true, id: "ppl-inv-submit", guard: perm, onClick: function (close) {
        var e = email.value.trim().toLowerCase();
        var dom = e.split("@")[1];
        if (dom && s.security.domains.indexOf(dom) < 0) { err.textContent = dom + " is not an allowed domain. Add it in Security first."; return; }
        var roles = [];
        if (fRole.value) roles.push({ role: fRole.value, scope: "factory" });
        if (proj.value) roles.push({ role: pRole.value, scope: proj.value });
        var r = G.ops.invite({ name: name.value, email: e, teams: Array.prototype.slice.call(teams.querySelectorAll("input:checked")).map(function (x) { return x.value; }), roles: roles });
        if (!r.ok) { err.textContent = r.msg; return; }
        ui.sel = r.person.id;
        G.toast(r.msg, "ok"); close();
      } }]
    });
  };

  function teamsDialog(p) {
    var perm = G.me("people.manage");
    var box = h("div", { class: "check-grid" }, G.store.get("teams").map(function (t) {
      return h("label", { class: "check", for: "ppl-tm-" + t.id }, h("input", { type: "checkbox", id: "ppl-tm-" + t.id, value: t.id, checked: p.teams.indexOf(t.id) >= 0 }), t.name);
    }));
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: "Teams for " + p.name, kicker: "People", sub: "Teams group people and own repos. Permissions come from roles, not teams.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Team membership"), box, err),
      actions: [{ label: "Cancel" }, { label: "Save teams", kind: "primary", submit: true, id: "ppl-tm-save", guard: perm, onClick: function (close) {
        var next = Array.prototype.slice.call(box.querySelectorAll("input:checked")).map(function (x) { return x.value; });
        if (!next.length) { err.textContent = "Keep at least one team."; return; }
        var r = G.ops.setTeams(p.id, next); G.toast(r.msg, r.ok ? "ok" : "error");
        if (r.ok) close(); else err.textContent = r.msg;
      } }] });
  }

  /* ---------- org tree ---------- */
  function matches(p) {
    var q = ui.q.trim().toLowerCase();
    return !q || (p.name + " " + p.email + " " + p.title + " " + p.roles.map(grantLabel).join(" ")).toLowerCase().indexOf(q) >= 0;
  }
  function memberBtn(p, teamId) {
    var fr = factoryRoleOf(p);
    var summary = p.roles.length ? p.roles.map(grantLabel).join(", ") : "No roles yet";
    return h("li", null, h("button", { type: "button", class: "member" + (ui.sel === p.id ? " is-on" : ""), id: "ppl-mem-" + teamId + "-" + p.id, "aria-pressed": ui.sel === p.id ? "true" : "false", onClick: function () { ui.sel = p.id; G.rerender(); if (window.innerWidth < 1100) setTimeout(function () { var d = document.querySelector(".member-detail"); if (d) d.scrollIntoView({ block: "start", behavior: G.reducedMotion() ? "auto" : "smooth" }); }, 60); } },
      G.avatar(p.id, "sm"),
      h("span", { class: "member-main" }, h("span", { class: "ppl-name" }, p.name, fr ? h("span", { class: "ppl-frole" }, roleName(fr)) : null), h("span", { class: "muted small" }, summary)),
      h("span", { class: "ppl-flags" },
        p.status === "invited" ? h("span", { class: "chip chip-warn" }, G.icon("mail"), "invited") : null,
        p.oncall ? h("span", { class: "chip chip-accent" }, G.icon("clock"), "on call") : null,
        p.away && p.away.to > Date.now() ? h("span", { class: "chip" }, G.icon("swap"), "away") : null)));
  }
  function tree(s) {
    var search = h("input", { id: "ppl-q", class: "input", type: "search", placeholder: "Find a person, role or project", value: ui.q, autocomplete: "off", "aria-label": "Find a person" });
    search.addEventListener("input", function () { ui.q = search.value; G.rerender(); });
    var noTeam = s.people.filter(function (p) { return !p.teams || !p.teams.length; }).filter(matches);
    var perm = G.me("people.manage");
    return h("div", { class: "org-tree" },
      h("div", { class: "org-root" }, G.logo(), h("div", null, h("div", { class: "kicker" }, "Organisation · " + s.org.plant), h("strong", null, s.org.name)), h("span", { class: "mono muted small" }, s.people.length + " people")),
      h("div", { class: "ppl-search" }, search),
      h("ul", { class: "teams" }, s.teams.map(function (t) {
        var members = s.people.filter(function (p) { return (p.teams || []).indexOf(t.id) >= 0; });
        var shown = members.filter(matches);
        if (ui.q && !shown.length) return null;
        var owns = s.repos.filter(function (r) { return r.team === t.id; });
        var projs = s.projects.filter(function (p) { return p.teams.indexOf(t.id) >= 0; });
        return h("li", { class: "team" },
          h("div", { class: "team-head" }, h("h3", { class: "team-name" }, t.name, h("span", { class: "mono muted ppl-count" }, String(members.length))), h("span", { class: "muted small" }, t.desc)),
          h("div", { class: "team-lines" }, h("span", { class: "kicker" }, "Projects"), projs.length ? projs.map(function (p) { return h("span", { class: "chip" }, p.name); }) : h("span", { class: "muted small" }, "none"),
            h("span", { class: "kicker ppl-owns" }, "Repos"), h("span", { class: "mono small" }, String(owns.length))),
          h("ul", { class: "members" }, shown.map(function (p) { return memberBtn(p, t.id); })),
          h("div", { class: "team-actions" }, G.btn("Invite to " + t.name, { small: true, kind: "ghost", icon: "plus", id: "ppl-inv-" + t.id, guard: perm, onClick: function () { G.inviteDialog({ team: t.id }); } })));
      }), noTeam.length ? h("li", { class: "team" }, h("div", { class: "team-head" }, h("h3", { class: "team-name" }, "No team")), h("ul", { class: "members" }, noTeam.map(function (p) { return memberBtn(p, "none"); }))) : null));
  }

  /* ---------- member detail ---------- */
  function factoryRoleControl(p) {
    var perm = G.me("people.manage");
    var cur = factoryRoleOf(p);
    var guard = perm;
    if (perm.allowed && p.id === G.viewerId()) guard = lockd("You cannot change your own factory role. Ask another Factory Admin.");
    else if (perm.allowed && cur === "factory_admin" && factoryAdmins().length < 2) guard = lockd(p.name + " is the only Factory Admin. Make someone else a Factory Admin first.");
    var sel = G.select("ppl-frole", [{ value: "", label: "None (project roles only)" }].concat(factoryRoles().map(function (r) { var ro = G.find.role(r); return { value: r, label: roleName(r) + (r === "factory_admin" ? ": everything, every project" : r === "auditor" ? ": read everything, change nothing" : ro.custom ? " (custom): " + (ro.desc || "custom factory role") : "") }; })), cur, function (v) {
      var r = cur && cur !== v ? setFactoryRoleAny(p.id, cur, false) : { ok: true };
      if (r.ok && v) r = setFactoryRoleAny(p.id, v, true);
      G.toast(r.ok ? p.name + (v ? " is now " + roleName(v) + " across the factory." : " has no factory role now.") : r.msg, r.ok ? "ok" : "error");
    }, { disabled: !guard.allowed, "aria-label": "Factory role for " + p.name });
    if (!guard.allowed) G.guard(sel, guard);
    return h("div", { class: "ppl-frole-row" }, sel, !guard.allowed ? h("span", { class: "muted small" }, (guard.needs ? guard.needs + ". " : "") + guard.reason) : null);
  }

  function projectRolesTable(p, s) {
    var roles = projectRoles();
    var projects = s.projects.filter(function (x) { return x.status !== "archived"; });
    return h("div", { class: "table-scroll", "data-keep-scroll": "ppl-proles" }, h("table", { class: "table table-compact ppl-roles" },
      h("caption", { class: "sr" }, "Project roles for " + p.name),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Project"), roles.map(function (r) { return h("th", { scope: "col", class: "ppl-rcol" + (r.custom ? " is-custom" : ""), title: r.desc || null }, r.name, r.custom ? h("span", { class: "ppl-custom mono" }, "custom") : null); }))),
      h("tbody", null, projects.map(function (pr) {
        var perm = G.me("project.members", { project: pr.id });
        var held = p.roles.filter(function (g) { return g.scope === pr.id; }).map(function (g) { return g.role; });
        return h("tr", { class: held.length ? "is-member" : "" },
          h("th", { scope: "row" }, h("span", { class: "ppl-pname" }, pr.name), h("span", { class: "mono muted small" }, pr.key)),
          roles.map(function (r) {
            var on = held.indexOf(r.id) >= 0;
            var guard = perm;
            if (perm.allowed && on && p.id === G.viewerId() && r.id === "project_admin") guard = lockd("You cannot remove your own Project Admin role. Ask another Project Admin or a Factory Admin.");
            return h("td", { class: "ppl-rcell" + (on ? " is-on" : "") }, G.toggle("ppl-r-" + pr.id + "-" + r.id, on, function (v) {
              var res = G.ops.setMemberRole(p.id, pr.id, r.id, v);
              G.toast(res.msg, res.ok ? "ok" : "error");
            }, guard, r.name + " on " + pr.name));
          }));
      }))));
  }

  function effTable(p, s) {
    var projects = s.projects.filter(function (x) { return x.status !== "archived"; });
    var shownProjects = ui.effProject === "all" ? projects : projects.filter(function (x) { return x.id === ui.effProject; });
    var acts = G.ACTIONS.filter(function (a) { return a.scope === "project"; });
    var groups = []; acts.forEach(function (a) { if (groups.indexOf(a.group) < 0) groups.push(a.group); });
    var now = Date.now();
    var rows = [];
    groups.forEach(function (gname) {
      rows.push(h("tr", { class: "ppl-grp" }, h("th", { scope: "rowgroup", colspan: String(shownProjects.length + 1) }, gname)));
      acts.filter(function (a) { return a.group === gname; }).forEach(function (a) {
        rows.push(h("tr", { class: a.group === "Stops" ? "ppl-stop" : "" }, h("th", { scope: "row" }, a.name, h("span", { class: "mono muted small ppl-aid" }, a.id)),
          shownProjects.map(function (pr) {
            var d = G.can(p.id, a.id, { project: pr.id, time: now });
            var viaPolicy = d.allowed && d.rule.kind === "policy";
            var isSel = ui.cell && ui.cell.action === a.id && ui.cell.project === pr.id && ui.cell.person === p.id;
            var td = h("td", { class: "eff-cell " + (d.allowed ? "is-yes" : "is-no") + (viaPolicy ? " is-policy" : "") + (isSel ? " is-sel" : ""), tabindex: "0", role: "button", "aria-pressed": isSel ? "true" : "false", id: "ppl-eff-" + pr.id + "-" + a.id.replace(/\./g, "_"), "data-tip": pr.name + ": " + (d.allowed ? "Allowed. " : "Denied. ") + d.reason + (d.rule ? " [" + d.rule.id + "]" : "") + " Select to see why." },
              G.icon(d.allowed ? "check" : "x"), viaPolicy ? h("span", { class: "eff-pol mono" }, d.rule.id.replace("POL-", "P")) : null, h("span", { class: "sr" }, d.allowed ? "allowed" : "denied"));
            function pick() { ui.cell = { person: p.id, action: a.id, project: pr.id }; G.rerender(); }
            td.addEventListener("click", pick);
            td.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
            return td;
          })));
      });
    });
    return h("div", { class: "table-scroll", "data-keep-scroll": "ppl-eff" }, h("table", { class: "table table-compact eff-table" },
      h("caption", { class: "sr" }, "Effective permissions for " + p.name),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Action"), shownProjects.map(function (pr) { return h("th", { scope: "col", class: "eff-col" }, pr.name); }))),
      h("tbody", null, rows)));
  }

  function cellDetail(p) {
    var c = ui.cell;
    if (!c || c.person !== p.id || !G.find.action(c.action) || !G.find.project(c.project)) return h("p", { class: "muted small ppl-pad" }, "Select a cell to see the deciding rule" + (G.explainDenial ? " and ask for an explanation." : "."));
    var a = G.find.action(c.action), pr = G.find.project(c.project), now = Date.now();
    var d = G.can(p.id, a.id, { project: pr.id, time: now });
    return h("div", { class: "ppl-cell decision " + (d.allowed ? "is-allowed" : "is-denied"), id: "ppl-cell", "aria-live": "polite" },
      h("div", { class: "decision-v" }, G.icon(d.allowed ? "check" : "halt"), d.allowed ? "Allowed" : "Denied"),
      h("div", null, h("strong", null, p.name), " · " + a.name.toLowerCase() + " · " + pr.name + " · now"),
      h("div", { class: "decision-rule" }, h("span", { class: "kicker" }, "Deciding rule"), h("span", { class: "mono strong" }, d.rule.id), h("span", null, d.rule.name || "")),
      h("p", null, d.reason), d.needs && !d.allowed ? h("p", { class: "small" }, h("strong", null, "To allow it: "), d.needs + ".") : null,
      h("div", { class: "row gap-sm" },
        G.explainDenial ? G.explainDenial({ id: "ppl-cell-explain", person: p.id, action: a.id, project: pr.id, time: now, decision: d }) : null,
        G.canSeeRoute("access") && G.accessSimulate ? G.btn("Open in the simulator", { small: true, kind: "ghost", icon: "play", id: "ppl-cell-sim", onClick: function () { var n = new Date(now + 330 * 60000).toISOString(); G.accessSimulate({ person: p.id, action: a.id, project: pr.id, repo: "", date: n.slice(0, 10), time: n.slice(11, 16) }); } }) : null));
  }

  function memberDetail(s) {
    var p = G.find.person(ui.sel) || s.people[0];
    ui.sel = p.id;
    var perm = G.me("people.manage");
    var away = p.away && p.away.to > Date.now() ? p.away : null;
    var factActs = G.ACTIONS.filter(function (a) { return a.scope === "factory"; });
    var effSel = G.select("ppl-eff-proj", [{ value: "all", label: "All projects" }].concat(s.projects.filter(function (x) { return x.status !== "archived"; }).map(function (x) { return { value: x.id, label: x.name }; })), ui.effProject, function (v) { ui.effProject = v; G.rerender(); }, { "aria-label": "Project for effective permissions" });
    return h("section", { class: "panel member-detail", "aria-label": p.name },
      h("div", { class: "ad-head" }, G.avatar(p.id, "lg"),
        h("div", { class: "ppl-who" },
          h("div", { class: "kicker" }, (p.teams || []).map(function (t) { return (G.find.team(t) || { name: t }).name; }).join(", ") + " · " + (p.status === "invited" ? "invite pending" : "active")),
          h("h2", { class: "ad-title" }, p.name),
          h("div", { class: "ad-meta" }, p.title + " · ", h("span", { class: "mono" }, p.email), p.github ? h("span", { class: "mono" }, " · github " + p.github) : null),
          h("div", { class: "ppl-badges" },
            p.mfa ? h("span", { class: "chip" }, G.icon("shield"), "MFA enrolled") : h("span", { class: "chip" }, G.icon("shield"), "No MFA"),
            p.oncall ? h("span", { class: "chip chip-accent" }, G.icon("clock"), "On call") : null,
            away ? h("span", { class: "chip chip-warn" }, G.icon("swap"), "Away until " + G.fmt.istDate(away.to) + ", delegate " + G.actorName(away.delegate)) : null)),
        h("div", { class: "ad-tools" },
          p.status === "invited" ? G.btn("Mark invite accepted", { small: true, icon: "check", id: "ppl-accept", guard: perm, onClick: function () {
            var r = G.ops.acceptInvite(p.id); G.toast(r.msg, r.ok ? "ok" : "error");
          } }) : null,
          G.btn(p.oncall ? "Take off call" : "Put on call", { small: true, icon: "clock", id: "ppl-oncall", guard: perm, onClick: function () {
            var v = !p.oncall;
            var r = G.ops.setOncall(p.id, v); G.toast(r.msg, r.ok ? "ok" : "error");
          } }),
          G.btn("Edit teams", { small: true, kind: "ghost", icon: "teams", id: "ppl-teams", guard: perm, onClick: function () { teamsDialog(p); } }))),
      h("h3", { class: "sub-h" }, "Factory role"),
      h("div", { class: "ppl-pad" }, factoryRoleControl(p)),
      h("h3", { class: "sub-h" }, "Roles per project"),
      h("p", { class: "muted small ppl-pad" }, "One person can hold different roles in each project. A switch is locked where you cannot manage that project's members."),
      projectRolesTable(p, s),
      h("div", { class: "ppl-eff-head" }, h("h3", { class: "sub-h" }, "Effective permissions now"), h("span", { class: "mono muted small" }, G.fmt.ist(Date.now()) + " IST"), effSel),
      h("p", { class: "muted small ppl-pad" }, "Roles, scope, release windows, on-call rules and freezes combined, as the policy engine decides them right now. Hover or focus a cell for the deciding rule. P-numbers mark cells decided by a policy."),
      effTable(p, s),
      cellDetail(p),
      h("h3", { class: "sub-h" }, "Factory-wide"),
      h("ul", { class: "caps caps-grid ppl-pad" }, factActs.map(function (a) {
        var d = G.can(p.id, a.id);
        return h("li", { class: d.allowed ? "ok" : "no", "data-tip": d.reason, tabindex: "0" }, G.icon(d.allowed ? "check" : "lock"), h("span", null, a.name));
      })),
      h("h3", { class: "sub-h" }, "History"),
      h("div", { class: "ppl-pad" }, G.historyList({ type: "person", id: p.id, limit: 8 })));
  }

  function render() {
    var s = G.store.get();
    if (!ui.sel || !G.find.person(ui.sel)) ui.sel = G.viewerId() || s.people[0].id;
    var invited = s.people.filter(function (p) { return p.status === "invited"; }).length;
    return h("div", { class: "view view-people" },
      G.pageHeader({ id: "ppl-head", kicker: "Govern · People & teams", title: "People & teams", sub: "Teams group people. Roles are granted on the factory or on one project, so a person can be an Engineer here and a Reviewer there.",
        meta: [["People", String(s.people.length)], ["Teams", String(s.teams.length)], ["Factory Admins", String(factoryAdmins().length)], ["Custom roles", String(G.ROLES.filter(function (r) { return r.custom; }).length)], ["Invites pending", String(invited)]],
        actions: [G.btn("Invite person", { kind: "primary", icon: "plus", id: "ppl-invite", guard: G.me("people.manage"), onClick: function () { G.inviteDialog(); } })] }),
      G.lockNote(G.me("people.manage"), "Invites, teams and factory roles"),
      h("div", { class: "people-grid" }, G.panel("Organisation", tree(s), { cls: "ppl-tree" }), memberDetail(s)));
  }

  G.views.people = { title: "People & teams", render: render, keys: ["people", "teams", "projects", "repos", "audit", "freezes", "security"] };
})(window.G);
