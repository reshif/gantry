/* Policy engine. One function decides every permission in the UI:
   G.can(personId, actionId, { project, repo, time }) -> { allowed, reason, rule, needs }
   1. Role grants in scope: factory-level roles apply everywhere; project roles only in their project.
   2. Role matrix: does any in-scope role allow the action?  (Extend policies can add rights, e.g. on-call kill.)
   3. Deny policies (freezes). Deny always wins.
   4. Conditional allow policies (release windows): if any exist for the action, one must match.
   Gate approvals add approver rules on top: G.gateDecision(personId, wo, gateId). Times are IST. */
(function (G) {
  "use strict";
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  G.DAYS = DAYS;
  function ist(t) { var d = new Date(t + 330 * 60000); return { day: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
  function hm(s) { var p = String(s).split(":"); return (+p[0]) * 60 + (+p[1] || 0); }
  function S(k) { return G.store.get(k); }

  G.policyText = {
    days: function (days) {
      if (!days || days.length === 7) return "any day";
      var s = days.slice().sort();
      var contiguous = s.every(function (d, i) { return i === 0 || d === s[i - 1] + 1; });
      if (contiguous && s.length > 2) return DAYS[s[0]] + "–" + DAYS[s[s.length - 1]];
      return s.map(function (d) { return DAYS[d]; }).join(", ");
    },
    when: function (w) {
      if (!w) return "any time";
      var d = G.policyText.days(w.days);
      if (w.from === "00:00" && w.to === "24:00") return d === "any day" ? "any time" : d + ", all day";
      return d + " " + w.from + "–" + w.to + " IST";
    },
    where: function (p) {
      if (p.where.freeze) return "repos under an active freeze";
      if (p.where.regulated) return "regulated projects";
      if (!p.where.projects || !p.where.projects.length) return "every project";
      return p.where.projects.map(function (t) { var x = G.find.project(t); return x ? x.name : t; }).join(", ");
    },
    roles: function (p) {
      if (p.roles[0] === "*") return "Anyone";
      if (p.roles[0] === "agents") return "Agents";
      return p.roles.map(function (r) { var x = G.find.role(r); return x ? x.name + "s" : r; }).join(" and ");
    },
    sentence: function (p) {
      var acts = p.actions.map(function (a) { var x = G.find.action(a); return x ? x.name.toLowerCase() : a; }).join(", ");
      if (p.id === "POL-112") return "Agents from Plan onward may not act autonomously on regulated projects. The highest autonomy there is act with gate.";
      if (p.effect === "deny") return G.policyText.roles(p) + " may not " + acts + " on " + G.policyText.where(p) + ".";
      var s = G.policyText.roles(p) + " may " + acts + " on " + G.policyText.where(p) + ", " + G.policyText.when(p.when);
      if (p.oncallOnly) s += ", only while on call";
      if (p.extend) s += ". Adds this right even where the role matrix does not grant it";
      return s + (p.actions.indexOf("release") >= 0 ? ", never during a freeze." : ".");
    }
  };

  G.activeFreeze = function (repoId, time) {
    var t = time || Date.now();
    return S("freezes").find(function (f) { return t >= f.from && t < f.to && (f.repos === "all" || f.repos.indexOf(repoId) >= 0); }) || null;
  };

  function roleNames(roles) { return roles.map(function (r) { return G.find.role(r).name; }).join(" or "); }
  G.rolesIn = function (person, projectId) {
    if (!person) return [];
    return person.roles.filter(function (g) { return g.scope === "factory" || g.scope === projectId; }).map(function (g) { return g.role; });
  };
  G.isFactoryAdmin = function (pid) { var p = G.find.person(pid); return !!p && p.roles.some(function (g) { return g.role === "factory_admin"; }); };
  G.visibleProjects = function (pid) {
    var p = G.find.person(pid); if (!p) return [];
    var factoryWide = p.roles.some(function (g) { return g.scope === "factory"; });
    return S("projects").filter(function (pr) { return pr.status !== "archived" || factoryWide; }).filter(function (pr) { return factoryWide || p.roles.some(function (g) { return g.scope === pr.id; }); });
  };

  G.can = function (personId, action, ctx) {
    ctx = ctx || {};
    var matrix = S("matrix");
    var person = G.find.person(personId);
    var act = G.find.action(action);
    var time = ctx.time || Date.now();
    var repo = ctx.repo ? G.find.repo(ctx.repo) : null;
    var projectId = ctx.project || (repo && repo.project) || null;
    var project = projectId ? G.find.project(projectId) : null;
    var MATRIX = { kind: "matrix", id: "MATRIX", name: "Role matrix" };
    if (!person) return { allowed: false, reason: "Not signed in.", rule: MATRIX, needs: "Sign in" };
    if (person.status !== "active") return { allowed: false, reason: person.name + " has not accepted the invite yet.", rule: MATRIX, needs: "Accepted invite" };
    var scoped = act && act.scope === "project";
    var grants = person.roles.filter(function (g) { return g.scope === "factory" || !scoped || !projectId || g.scope === projectId; });
    var granting = grants.filter(function (g) { return matrix[g.role] && matrix[g.role][action]; });
    var heldRoles = grants.map(function (g) { return g.role; });
    var t = ist(time);
    function whenOk(q) { return !q.when || (q.when.days.indexOf(t.day) >= 0 && t.mins >= hm(q.when.from) && t.mins < hm(q.when.to)); }
    function whereOk(q) { return !projectId || !q.where.projects || !q.where.projects.length || q.where.projects.indexOf(projectId) >= 0; }

    if (!granting.length) {
      var ext = S("policies").filter(function (p) { return p.enabled && p.extend && p.effect === "allow" && p.actions.indexOf(action) >= 0; });
      var hit = ext.find(function (q) { return q.roles.some(function (r) { return heldRoles.indexOf(r) >= 0; }) && whereOk(q) && whenOk(q) && (!q.oncallOnly || person.oncall); });
      if (hit) return { allowed: true, reason: "Allowed by " + hit.id + " '" + hit.name + "'.", rule: { kind: "policy", id: hit.id, name: hit.name }, needs: "" };
      var rolesWith = G.ROLES.filter(function (r) { return matrix[r.id] && matrix[r.id][action] && r.id !== "factory_admin"; }).map(function (r) { return r.id; });
      if (!rolesWith.length) rolesWith = ["factory_admin"];
      var needs = "Needs " + roleNames(rolesWith.slice(0, 2)) + (scoped && project ? " on " + project.name : "");
      var outOfScope = person.roles.some(function (g) { return matrix[g.role] && matrix[g.role][action]; });
      var reason = outOfScope ? person.name + "'s roles that allow this do not cover " + (project ? project.name : "this scope") + "."
        : "No role held by " + person.name + (scoped && project ? " in " + project.name : "") + " includes '" + (act ? act.name : action) + "'.";
      if (ext.length && ext.some(function (q) { return q.oncallOnly && q.roles.some(function (r) { return heldRoles.indexOf(r) >= 0; }); }) && !person.oncall) reason += " " + ext[0].id + " would allow it while on call.";
      return { allowed: false, reason: reason, rule: MATRIX, needs: needs };
    }
    var held = granting.map(function (g) { return g.role; });
    var denies = S("policies").filter(function (p) { return p.enabled && p.effect === "deny" && p.actions.indexOf(action) >= 0; });
    for (var i = 0; i < denies.length; i++) {
      var p = denies[i];
      if (p.where.freeze && repo) {
        var f = G.activeFreeze(repo.id, time);
        if (f) return { allowed: false, reason: "Freeze " + f.id + " '" + f.name + "' is active on " + repo.name + " until " + G.fmt.stamp(f.to) + ".", rule: { kind: "policy", id: p.id, name: p.name, freeze: f.id }, needs: "Wait for the freeze to end" };
      }
    }
    var allows = S("policies").filter(function (p) { return p.enabled && p.effect === "allow" && !p.extend && p.actions.indexOf(action) >= 0; });
    if (allows.length) {
      var applicable = allows.filter(function (q) { return q.roles.some(function (r) { return held.indexOf(r) >= 0; }) && whereOk(q); });
      if (!applicable.length) return { allowed: false, reason: "No " + (act ? act.name.toLowerCase() : action) + " policy covers " + roleNames(held) + (project ? " on " + project.name : "") + ".", rule: { kind: "policy-missing", id: "NO-POLICY", name: "No matching policy" }, needs: "Needs a policy for " + roleNames(held) };
      var why = null;
      for (var j = 0; j < applicable.length; j++) {
        var q = applicable[j];
        if (whenOk(q) && (!q.oncallOnly || person.oncall)) return { allowed: true, reason: "Allowed by " + q.id + " '" + q.name + "'.", rule: { kind: "policy", id: q.id, name: q.name }, needs: "" };
        if (!why) why = { q: q, text: q.oncallOnly && !person.oncall ? person.name + " is not on call; " + q.id + " applies only on call." : "Outside the window in " + q.id + ": " + G.policyText.when(q.when) + "." };
      }
      return { allowed: false, reason: why.text, rule: { kind: "policy", id: why.q.id, name: why.q.name }, needs: "Allowed " + G.policyText.when(why.q.when) + (why.q.oncallOnly ? " while on call" : "") };
    }
    var g0 = granting[0];
    var scopeName = g0.scope === "factory" ? "the factory" : (G.find.project(g0.scope) || {}).name;
    return { allowed: true, reason: "Role matrix: " + G.find.role(g0.role).name + " on " + scopeName + " may " + (act ? act.name.toLowerCase() : action) + ".", rule: MATRIX, needs: "" };
  };
  G.me = function (action, ctx) { return G.can(G.viewerId(), action, ctx); };
  G.meAnyProject = function (action) {
    var ps = G.visibleProjects(G.viewerId());
    for (var i = 0; i < ps.length; i++) { var d = G.me(action, { project: ps[i].id }); if (d.allowed) return d; }
    return G.me(action, { project: ps[0] && ps[0].id });
  };
  function deny(reason, needs, rule) { return { allowed: false, reason: reason, needs: needs || "", rule: { kind: "approver", id: rule || "APPROVERS", name: "Approver rules" } }; }

  /* ---------- approver rules ---------- */
  G.conditionsFor = function (project, wo, gateId) {
    var rule = project.approvers[gateId];
    if (!rule) return [];
    return rule.conditions.filter(function (c) {
      if (c.when.type === "class") return wo.cls === c.when.value;
      if (c.when.type === "risk") return wo.risk === c.when.value;
      if (c.when.type === "path") return (wo.paths || []).some(function (p) { return p.indexOf(c.when.value) === 0; }) || (wo.repo === "payments-api" && c.when.value === "/payments" && /settlement|refund|charge/i.test(wo.title));
      return false;
    });
  };
  function satisfies(person, project, needs) {
    var roles = G.rolesIn(person, project.id);
    var ok = needs.people.indexOf(person.id) >= 0 || needs.roles.some(function (r) { return roles.indexOf(r) >= 0; });
    return ok && (!needs.oncall || person.oncall);
  }
  G.gateProgress = function (project, wo, gateId) {
    var rule = project.approvers[gateId] || { required: 1, conditions: [] };
    var st = wo.gates[gateId] || { approvals: [] };
    var conds = G.conditionsFor(project, wo, gateId);
    var unmet = conds.filter(function (c) { return !st.approvals.some(function (a) { var pp = G.find.person(a.by); return pp && satisfies(pp, project, c.needs); }); });
    return { have: st.approvals.length, need: Math.max(1, rule.required || 1), unmet: unmet, conds: conds, passes: st.approvals.length >= Math.max(1, rule.required || 1) && !unmet.length };
  };
  /* effective gate mode in a project: "auto" | "human" | "mixed" (project.flow.gates[id].mode overrides the default kind) */
  G.gateKind = function (project, gateId) {
    var g = G.gateDef(gateId); if (!g) return "human";
    var cfg = project && project.flow && project.flow.gates[gateId];
    return (cfg && cfg.mode) || g.kind;
  };
  G.gateDecision = function (personId, wo, gateId) {
    var person = G.find.person(personId);
    var project = G.find.project(wo.project);
    var g = G.gateDef(gateId);
    if (!person) return deny("Not signed in.");
    if (!g) return deny("Unknown gate.");
    if (G.gateKind(project, gateId) === "auto") return deny(g.label + " is automatic in " + project.name + "; it passes when its checks pass.", "Automatic gate", "AUTO");
    var st = wo.gates[gateId];
    if (!st || st.status !== "waiting") return deny(wo.id + " is not waiting at " + g.label + ".", "", "STATE");
    var stop = G.stopState(project.id, wo.repo);
    if (stop) return deny(stop.reason, "Restore first", "KILL");
    if (gateId === "G0G1") {
      var d0 = G.can(personId, "brief.confirm", { project: project.id });
      if (!d0.allowed) return d0;
      var roles0 = G.rolesIn(person, project.id);
      var senior = roles0.some(function (r) { return ["line_lead", "project_admin", "factory_admin"].indexOf(r) >= 0; });
      if (!senior && wo.requestedBy !== personId) return deny("Engineers may confirm only briefs they submitted. " + G.actorName(wo.requestedBy) + " submitted this one.", "Submitter, Line Lead or Project Admin", "APR-G0G1");
      if (!wo.conv.done) return deny("The intake conversation still has open questions.", "Answer the open questions first", "APR-G0G1");
      return { allowed: true, reason: wo.requestedBy === personId ? "You submitted this work order." : "Line Leads and Project Admins may confirm any brief.", rule: { kind: "approver", id: "APR-G0G1", name: "Brief confirmation" }, needs: "" };
    }
    var base = G.can(personId, g.action || "gate.approve", { project: project.id, repo: wo.repo });
    if (!base.allowed) return base;
    var rule = project.approvers[gateId];
    if (st.approvals.some(function (a) { return a.by === personId; })) return deny("You already approved " + g.label + " on " + wo.id + ".", "Another approver", "APR-" + gateId);
    if (rule.sod && wo.requestedBy === personId) return deny("Separation of duties on " + g.label + ": the author of " + wo.id + " cannot approve it.", "Someone other than the author", "APR-" + gateId);
    var roles = G.rolesIn(person, project.id);
    if (roles.indexOf("factory_admin") >= 0) return { allowed: true, reason: "Factory Admin may approve any gate (break-glass, flagged in audit).", rule: { kind: "approver", id: "APR-" + gateId, name: g.label + " approvers" }, needs: "" };
    var byRole = rule.roles.some(function (r) { return roles.indexOf(r) >= 0; });
    var byName = rule.people.indexOf(personId) >= 0;
    var delegateFor = S("people").find(function (x) { return x.away && x.away.delegate === personId && x.away.to > Date.now() && (rule.people.indexOf(x.id) >= 0 || rule.roles.some(function (r) { return G.rolesIn(x, project.id).indexOf(r) >= 0; })); });
    var conds = G.conditionsFor(project, wo, gateId);
    var byCond = conds.some(function (c) { return satisfies(person, project, c.needs); });
    if (!byRole && !byName && !delegateFor && !byCond) {
      var cn = conds.filter(function (c) { return c.needs.oncall && c.needs.roles.some(function (r) { return roles.indexOf(r) >= 0; }); });
      if (cn.length && !person.oncall) return deny(cn[0].text + "; " + person.name + " is not on call.", "On-call " + roleNames(cn[0].needs.roles), "APR-" + gateId);
      return deny("Approver rule for " + g.label + " on " + project.name + " lists " + (rule.roles.length ? roleNames(rule.roles) : "no roles") + (rule.people.length ? " and " + rule.people.map(G.actorName).join(", ") : "") + ".", "Needs " + (rule.roles.length ? roleNames(rule.roles) : rule.people.map(G.actorName).join(", ")), "APR-" + gateId);
    }
    var why = byName ? "Named approver for " + g.label + "." : byRole ? "Approver rule allows " + roleNames(rule.roles) + "." : delegateFor ? "Delegate for " + delegateFor.name + " while they are away." : "Meets condition: " + conds.find(function (c) { return satisfies(person, project, c.needs); }).text + ".";
    return { allowed: true, reason: why + (base.rule.kind === "policy" ? " " + base.reason : ""), rule: { kind: "approver", id: "APR-" + gateId, name: g.label + " approvers" }, needs: "" };
  };

  /* ---------- stop state (kill and andon) ---------- */
  G.stopState = function (projectId, repoId) {
    var f = S("factory").killed;
    if (f) return { level: "factory", kill: f, reason: "The factory is killed: " + f.reason + " (" + G.actorName(f.by) + ", " + G.fmt.stamp(f.at) + ")." };
    var p = projectId && G.find.project(projectId);
    if (p && p.killed) return { level: "project", kill: p.killed, reason: p.name + " is killed: " + p.killed.reason + "." };
    if (p && p.status === "archived") return { level: "project", reason: p.name + " is archived." };
    return null;
  };
  G.haltState = function (projectId, repoId) {
    var p = projectId && G.find.project(projectId);
    if (p && p.halted) return { level: "project", reason: p.name + " is halted (andon): " + p.halted.reason };
    var r = repoId && G.find.repo(repoId);
    if (r && r.halted) return { level: "repo", reason: r.name + " is halted (andon): " + r.halted.reason };
    return null;
  };

  G.agentAutonomyCheck = function (agent, autonomy, projectId) {
    if (autonomy !== "auto") return { allowed: true };
    var p = S("policies").find(function (x) { return x.id === "POL-112"; });
    if (!p || !p.enabled) return { allowed: true };
    var early = ["intake", "research", "spec", "design"].indexOf(agent.station) >= 0 || agent.station === null;
    if (early) return { allowed: true };
    var projs = projectId ? [G.find.project(projectId)] : (agent.projects === "all" ? S("projects") : agent.projects.map(G.find.project).filter(Boolean));
    var reg = projs.filter(function (x) { return x && x.regulated; });
    if (reg.length) return { allowed: false, reason: "POL-112: no autonomous agents from Plan onward on regulated projects (" + reg.map(function (x) { return x.name; }).join(", ") + "). Use act with gate or exclude those projects.", rule: "POL-112" };
    return { allowed: true };
  };

  /* MCP access resolver: may agent c.agent call tool c.tool on server srv at c.station for c.project / c.repo?
     -> { allowed, gated?, reason, rule } */
  G.mcpAccess = function (srv, c) {
    function inList(v, x) { return v === "all" || (v || []).indexOf(x) >= 0; }
    var p = G.find.project(c.project), tool = srv.tools.find(function (t) { return t.name === c.tool; });
    function no(reason, rule) { return { allowed: false, reason: reason, rule: rule }; }
    if (!tool) return no("Pick a tool.", "tool");
    if (!inList(srv.projects, c.project)) return no(srv.name + " is not scoped to " + (p ? p.name : c.project) + ".", "project scope");
    if (p && (p.mcp || []).indexOf(srv.id) < 0) return no((p ? p.name : c.project) + " has not enabled " + srv.name + " in Project config.", "project config");
    if (c.repo && !inList(srv.repos, c.repo)) return no("Repo " + (G.find.repo(c.repo) || { name: c.repo }).name + " is outside this server's repo scope.", "repo scope");
    if (!inList(srv.agents, c.agent)) return no((G.find.agent(c.agent) || { name: c.agent }).name + " is not allowed to use " + srv.name + ".", "agent scope");
    if (!inList(srv.stations, c.station)) return no("Not available at " + (G.find.station(c.station) || { name: c.station }).name + ".", "station scope");
    if (c.cls && srv.classes != null && !inList(srv.classes, c.cls)) return no("Not available for " + (G.find.cls(c.cls) || { name: c.cls }).name + " work.", "class scope");
    if (!tool.allowed) return no(tool.name + " is denied on this server.", "tool deny");
    if (srv.health !== "healthy" && srv.health !== "degraded") return no(srv.name + " is " + srv.health + ".", "health");
    if (tool.write && srv.writeGate) return { allowed: true, gated: true, reason: tool.name + " writes, so each call waits for the work order's next human gate approval.", rule: "write gate" };
    return { allowed: true, reason: "Allowed by project, repo, agent, station, work class and tool scope.", rule: "scope" };
  };

  /* the policy engine's decision as readable lines: roles in scope, matrix, freeze, policies, deciding rule, how to allow it */
  G.policyTrace = function (personId, action, ctx) {
    ctx = ctx || {};
    var p = G.find.person(personId), act = G.find.action(action), m = G.store.get("matrix");
    if (!p || !act) return ["Unknown person or action."];
    var scoped = act.scope === "project", pid = ctx.project || null;
    var grants = p.roles.filter(function (g) { return g.scope === "factory" || !scoped || !pid || g.scope === pid; });
    var granting = grants.filter(function (g) { return m[g.role] && m[g.role][act.id]; });
    var pols = G.store.get("policies").filter(function (q) { return q.actions.indexOf(act.id) >= 0; });
    var repo = ctx.repo && G.find.repo(ctx.repo), frz = repo ? G.activeFreeze(repo.id, ctx.time || Date.now()) : null;
    var d = G.can(personId, action, ctx);
    var out = [];
    out.push("Roles in scope: " + (grants.length ? grants.map(function (g) { return G.find.role(g.role).name + (g.scope === "factory" ? " (factory)" : ""); }).join(", ") : "none") + ".");
    out.push("Role matrix grants " + act.id + ": " + (granting.length ? "yes, via " + granting.map(function (g) { return G.find.role(g.role).name; }).join(", ") : "no") + ".");
    if (repo) out.push("Freeze on " + repo.name + ": " + (frz ? frz.id + " " + frz.name + " until " + G.fmt.stamp(frz.to) : "none at that time") + ".");
    out.push("Policies on this action: " + (pols.length ? pols.map(function (q) { return q.id + (q.enabled ? "" : " (off)"); }).join(", ") : "none, so the matrix decides") + ".");
    out.push("Deciding rule: " + d.rule.id + " " + (d.rule.name || "") + ". " + d.reason);
    if (d.needs && !d.allowed) out.push("To allow it: " + d.needs + ".");
    var holders = G.ROLES.filter(function (r) { return m[r.id] && m[r.id][act.id]; }).map(function (r) { return r.name; });
    if (!d.allowed && holders.length) out.push("Roles that include it: " + holders.join(", ") + ".");
    return out;
  };

  G.istTime = function (dateStr, timeStr) { return new Date(dateStr + "T" + (timeStr || "12:00") + ":00+05:30").getTime(); };
  G.istToday = function (offsetDays) { return new Date(Date.now() + 330 * 60000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); };
})(window.G);
