/* Access: policy simulator, scoped policies (where/when rule cards), freezes and the
   roles x actions matrix (including kill/restore). One engine, G.can, decides everything. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "policies", sim: null, result: null, hl: null, mxGroup: "all" };

  var LOCKED_ON = { "factory_admin:policy.edit": 1, "factory_admin:people.manage": 1, "factory_admin:security.manage": 1, "factory_admin:audit.view": 1, "factory_admin:restore.factory": 1, "auditor:audit.view": 1 };
  var SPECIAL = { "POL-110": "Freeze rules come from the freeze list; only enable or disable this policy.", "POL-112": "Agent autonomy rule; only enable or disable this policy." };
  function S(k) { return G.store.get(k); }
  function lockd(reason, needs) { return { allowed: false, reason: reason, needs: needs || "" }; }
  function actName(id) { var a = G.find.action(id); return a ? a.name : id; }
  function nowIst() { var d = new Date(Date.now() + 330 * 60000); return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) }; }
  function nextDow(dow) { var t = new Date(Date.now() + 330 * 60000).getUTCDay(); return G.istToday((dow - t + 7) % 7 || 7); }
  function defaultSim() { var n = nowIst(); return { person: "p-kenji", action: "release", project: "payments", repo: "payments-api", date: n.date, time: n.time }; }


  /* ---------- simulator ---------- */
  var PRESETS = [
    { label: "Kenji releases Payments on Friday 22:00", s: function () { return { person: "p-kenji", action: "release", project: "payments", repo: "payments-api", date: nextDow(5), time: "22:00" }; } },
    { label: "Kenji releases Payments on Wednesday 11:00", s: function () { return { person: "p-kenji", action: "release", project: "payments", repo: "payments-api", date: nextDow(3), time: "11:00" }; } },
    { label: "Release payouts-worker during a freeze", s: function () { return { person: "p-kenji", action: "release", project: "payments", repo: "payouts-worker", date: G.istToday(1), time: "11:00" }; } },
    { label: "Priya kills Risk at 02:00", s: function () { return { person: "p-priya", action: "kill.project", project: "risk", repo: "", date: G.istToday(1), time: "02:00" }; } },
    { label: "Lena releases Identity on Sunday 03:00", s: function () { return { person: "p-lena", action: "release", project: "identity", repo: "", date: nextDow(0), time: "03:00" }; } },
    { label: "Tomás approves a gate in Storefront", s: function () { var n = nowIst(); return { person: "p-tomas", action: "gate.approve", project: "storefront", repo: "", date: n.date, time: n.time }; } }
  ];

  function evaluate() {
    var sm = ui.sim;
    if (!sm.date || !sm.time) { G.toast("Pick a date and time.", "error"); return; }
    var act = G.find.action(sm.action);
    var t = G.istTime(sm.date, sm.time);
    var ctx = act.scope === "project" ? { project: sm.project, repo: sm.repo || null, time: t } : { time: t };
    var d = G.can(sm.person, sm.action, ctx);
    ui.result = { d: d, sim: Object.assign({}, sm), t: t };
    ui.hl = d.rule.kind === "matrix" ? "MATRIX" : d.rule.id;
    if (d.rule.kind === "policy" && d.rule.freeze) ui.tab = "freezes";
    else if (d.rule.kind === "policy") ui.tab = "policies";
    else if (d.rule.kind === "matrix") ui.tab = "matrix";
    G.rerender();
    setTimeout(function () {
      var el = document.getElementById(d.rule.freeze ? "acc-frz-" + d.rule.freeze : d.rule.kind === "policy" ? "acc-pol-" + d.rule.id : "acc-mx-row-" + sm.action.replace(".", "_"));
      if (el) el.scrollIntoView({ block: "nearest", behavior: G.reducedMotion() ? "auto" : "smooth" });
    }, 60);
  }

  function trace(r) {
    var p = G.find.person(r.sim.person), act = G.find.action(r.sim.action), m = S("matrix");
    var scoped = act.scope === "project";
    var grants = p.roles.filter(function (g) { return g.scope === "factory" || !scoped || g.scope === r.sim.project; });
    var granting = grants.filter(function (g) { return m[g.role] && m[g.role][act.id]; });
    var pols = S("policies").filter(function (q) { return q.actions.indexOf(act.id) >= 0; });
    var repo = r.sim.repo && G.find.repo(r.sim.repo);
    var frz = repo ? G.activeFreeze(repo.id, r.t) : null;
    var items = [
      ["Roles in scope", grants.length ? grants.map(function (g) { return G.find.role(g.role).name + (g.scope === "factory" ? " (factory)" : ""); }).join(", ") : "none", grants.length ? "ok" : "bad"],
      ["Role matrix grants " + act.id, granting.length ? "yes, via " + granting.map(function (g) { return G.find.role(g.role).name; }).join(", ") : "no", granting.length ? "ok" : "bad"],
      ["Freeze on " + (repo ? repo.name : "this scope"), repo ? (frz ? frz.id + " " + frz.name + " until " + G.fmt.stamp(frz.to) : "none at that time") : "no repo picked", frz && pols.some(function (q) { return q.where.freeze && q.enabled; }) ? "bad" : "ok"],
      ["Policies on this action", pols.length ? pols.map(function (q) { return q.id + (q.enabled ? "" : " (off)"); }).join(", ") : "none: the matrix decides", pols.length ? "warn" : "ok"],
      ["On call", p.oncall ? "yes" : "no", "pending"]
    ];
    return h("ul", { class: "checklist acc-trace" }, items.map(function (x) { return h("li", { class: x[2] }, G.icon(x[2] === "ok" ? "check" : x[2] === "bad" ? "x" : x[2] === "warn" ? "alert" : "dots"), h("span", { class: "strong" }, x[0]), h("span", { class: "muted" }, x[1])); }));
  }

  function weekStrip(r) {
    var act = G.find.action(r.sim.action);
    var start = G.istTime(G.istToday(0), "00:00");
    var rows = [];
    for (var d = 0; d < 7; d++) {
      var cells = [];
      var day0 = start + d * G.DAY;
      var dow = new Date(day0 + 330 * 60000).getUTCDay();
      for (var hr = 0; hr < 24; hr++) {
        var t = day0 + hr * G.HOUR + 30 * G.MIN;
        var ctx = act.scope === "project" ? { project: r.sim.project, repo: r.sim.repo || null, time: t } : { time: t };
        var dd = G.can(r.sim.person, act.id, ctx);
        var isSel = r.t >= day0 + hr * G.HOUR && r.t < day0 + (hr + 1) * G.HOUR;
        cells.push(h("span", { class: "wk-c " + (dd.allowed ? "is-yes" : "is-no") + (isSel ? " is-sel" : ""), title: G.DAYS[dow] + " " + String(hr).padStart(2, "0") + ":00 · " + (dd.allowed ? "Allowed" : "Denied") + " · " + dd.rule.id }));
      }
      rows.push(h("div", { class: "wk-row" }, h("span", { class: "wk-d mono" }, G.fmt.istDate(day0 + 6 * G.HOUR)), h("span", { class: "wk-cells" }, cells)));
    }
    return h("div", { class: "wk", role: "img", "aria-label": "When this is allowed over the next seven days, hour by hour" },
      h("div", { class: "wk-row wk-axis" }, h("span", { class: "wk-d" }), h("span", { class: "wk-cells mono" }, [0, 6, 12, 18].map(function (x) { return h("span", { class: "wk-tick", style: "grid-column:" + (x + 1) + " / span 6" }, String(x).padStart(2, "0")); }))),
      rows,
      h("div", { class: "wk-legend small muted" }, h("span", { class: "wk-c is-yes" }), " allowed ", h("span", { class: "wk-c is-no" }), " denied ", h("span", { class: "wk-c is-sel is-no" }), " the time you picked"));
  }

  function simulator() {
    var s = G.store.get();
    if (!ui.sim) ui.sim = defaultSim();
    var sm = ui.sim;
    var act = G.find.action(sm.action);
    var scoped = act && act.scope === "project";
    var people = s.people.map(function (p) { return { value: p.id, label: p.name + (p.status === "invited" ? " (invited)" : "") }; });
    var actions = G.ACTIONS.map(function (a) { return { value: a.id, label: a.group + ": " + a.name }; });
    var projects = s.projects.map(function (p) { return { value: p.id, label: p.name }; });
    var repos = [{ value: "", label: "Any repo" }].concat(s.repos.filter(function (r) { return r.project === sm.project; }).map(function (r) { return { value: r.id, label: r.name }; }));
    function set(k) { return function (v) { sm[k] = v; if (k === "project") sm.repo = ""; ui.result = null; ui.hl = null; G.rerender(); }; }
    var date = h("input", { id: "acc-sim-date", class: "input mono", type: "date", value: sm.date });
    date.addEventListener("change", function () { sm.date = date.value; });
    var time = h("input", { id: "acc-sim-time", class: "input mono", type: "time", value: sm.time });
    time.addEventListener("change", function () { sm.time = time.value; });
    var form = h("form", { class: "sim-form acc-sim-form", id: "acc-sim-form" },
      G.field("Person", G.select("acc-sim-person", people, sm.person, set("person"))),
      G.field("Action", G.select("acc-sim-action", actions, sm.action, set("action"))),
      G.field("Project", G.select("acc-sim-project", projects, sm.project, set("project"), scoped ? {} : { disabled: true, title: "Factory actions apply everywhere" })),
      G.field("Repo", G.select("acc-sim-repo", repos, sm.repo, set("repo"), scoped ? {} : { disabled: true })),
      G.field("Date (IST)", date), G.field("Time (IST)", time),
      h("div", { class: "sim-go" }, G.btn("Evaluate", { kind: "primary", type: "submit", icon: "play", id: "acc-sim-run" }),
        G.btn("Use now", { kind: "ghost", id: "acc-sim-now", onClick: function () { var n = nowIst(); sm.date = n.date; sm.time = n.time; G.rerender(); } })));
    form.addEventListener("submit", function (e) { e.preventDefault(); evaluate(); });
    var presets = h("div", { class: "chips acc-presets" }, h("span", { class: "kicker" }, "Try"), PRESETS.map(function (pr, i) {
      return h("button", { type: "button", class: "sugg", id: "acc-preset-" + i, onClick: function () { ui.sim = pr.s(); evaluate(); } }, pr.label);
    }));
    var r = ui.result;
    var out;
    if (r) {
      var ract = G.find.action(r.sim.action);
      r.d = G.can(r.sim.person, r.sim.action, ract.scope === "project" ? { project: r.sim.project, repo: r.sim.repo || null, time: r.t } : { time: r.t });
      ui.hl = r.d.rule.kind === "matrix" ? "MATRIX" : r.d.rule.id;
      var ra = G.find.action(r.sim.action);
      var rp = G.find.project(r.sim.project), rr = r.sim.repo && G.find.repo(r.sim.repo);
      out = h("div", { class: "acc-out" },
        h("div", { class: "decision " + (r.d.allowed ? "is-allowed" : "is-denied"), "aria-live": "polite", id: "acc-sim-result" },
          h("div", { class: "decision-v" }, G.icon(r.d.allowed ? "check" : "halt"), r.d.allowed ? "Allowed" : "Denied"),
          h("div", null, h("strong", null, G.actorName(r.sim.person)), " · " + ra.name.toLowerCase() + (ra.scope === "project" ? " · " + rp.name + (rr ? " / " + rr.name : "") : " · factory-wide") + " · " + G.fmt.stamp(r.t)),
          h("div", { class: "decision-rule" }, h("span", { class: "kicker" }, "Deciding rule"), h("span", { class: "mono strong" }, r.d.rule.freeze ? r.d.rule.id + " + " + r.d.rule.freeze : r.d.rule.id), h("span", null, r.d.rule.name),
            r.d.rule.kind !== "policy-missing" ? h("button", { type: "button", class: "linkish", id: "acc-sim-show", onClick: function () { ui.tab = r.d.rule.freeze ? "freezes" : r.d.rule.kind === "policy" ? "policies" : "matrix"; G.rerender(); } }, "Show rule") : null),
          h("p", null, r.d.reason),
          r.d.needs && !r.d.allowed ? h("p", { class: "small" }, h("strong", null, "To allow it: "), r.d.needs + ".") : null,
          !r.d.allowed ? G.explainDenial({ id: "acc-sim-explain", person: r.sim.person, action: r.sim.action, project: ract.scope === "project" ? r.sim.project : null, repo: ract.scope === "project" ? r.sim.repo || null : null, time: r.t, decision: r.d }) : null),
        h("details", { class: "acc-why", open: true }, h("summary", null, "How the engine got there"), trace(r)),
        h("div", { class: "acc-wk-h" }, h("span", { class: "sub-h" }, "Same question, every hour of the next 7 days")), weekStrip(r));
    } else out = h("div", { class: "acc-out" }, h("p", { class: "muted small" }, "Pick a person, action, project or repo and an IST time, then evaluate. The deciding rule is highlighted in the tabs below, and the week strip shows when the answer changes."));
    return G.panel("Policy simulator", h("div", { class: "acc-sim" }, h("div", null, form, presets), out), { cls: "panel-sim" });
  }

  /* ---------- policies ---------- */
  function policyDialog(existing) {
    var perm = G.me("policy.edit");
    var s = G.store.get();
    var d = existing ? JSON.parse(JSON.stringify(existing)) : { name: "", effect: "allow", enabled: true, roles: ["release_manager"], actions: ["release"], where: { projects: [] }, when: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, oncallOnly: false, extend: false, custom: true };
    if (!d.when) d.when = { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "24:00" };
    var preview = h("p", { class: "acc-preview" });
    var err = h("div", { class: "form-err", role: "alert" });
    var warn = h("div", { class: "callout callout-warn acc-warn", role: "status" });
    function upd() {
      try { preview.textContent = G.policyText.sentence(Object.assign({ id: "NEW" }, d)); } catch (e) { preview.textContent = ""; }
      var first = d.extend ? [] : d.actions.filter(function (a) { return !S("policies").some(function (q) { return q !== existing && q.enabled && q.effect === "allow" && !q.extend && q.actions.indexOf(a) >= 0; }); });
      G.clear(warn);
      warn.hidden = !first.length;
      first.forEach(function (a) {
        var losers = G.ROLES.filter(function (r) { return S("matrix")[r.id] && S("matrix")[r.id][a] && d.roles.indexOf(r.id) < 0; }).map(function (r) { return r.name; });
        warn.appendChild(h("p", null, G.icon("alert"), " This is the first narrowing policy for '" + actName(a).toLowerCase() + "'. Once saved, only the roles, projects and hours here allow it" + (losers.length ? "; " + losers.join(", ") + " lose it everywhere else." : ".")));
      });
    }
    function checks(prefix, items, list, onCh) {
      return h("div", { class: "check-grid" }, items.map(function (it) {
        var cb = h("input", { type: "checkbox", id: prefix + it.value, value: it.value, checked: list.indexOf(it.value) >= 0 });
        cb.addEventListener("change", function () { onCh(it.value, cb.checked); upd(); });
        return h("label", { class: "check", for: prefix + it.value }, cb, it.label);
      }));
    }
    function toggler(arr) { return function (v, on) { var i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }; }
    var name = h("input", { id: "acc-pd-name", class: "input", value: d.name, placeholder: "Weekend hotfix window" });
    name.addEventListener("input", function () { d.name = name.value; });
    var mode = G.segmented("acc-pd-mode", [{ id: "narrow", label: "Narrow: only inside this window" }, { id: "extend", label: "Extend: add the right here" }], d.extend ? "extend" : "narrow", function (v) { d.extend = v === "extend"; upd(); }, "Policy kind");
    var groups = []; G.ACTIONS.forEach(function (a) { if (groups.indexOf(a.group) < 0) groups.push(a.group); });
    var acts = h("div", { class: "acc-acts" }, groups.map(function (g) {
      return h("fieldset", { class: "acc-fs" }, h("legend", null, g), checks("acc-pd-a-", G.ACTIONS.filter(function (a) { return a.group === g; }).map(function (a) { return { value: a.id, label: a.name }; }), d.actions, toggler(d.actions)));
    }));
    var roles = checks("acc-pd-r-", G.ROLES.map(function (r) { return { value: r.id, label: r.name + (r.custom ? " (custom)" : "") }; }), d.roles, toggler(d.roles));
    var projs = checks("acc-pd-p-", s.projects.map(function (p) { return { value: p.id, label: p.name }; }), d.where.projects || (d.where.projects = []), toggler(d.where.projects));
    var days = h("div", { class: "check-grid days" }, G.DAYS.map(function (dn, i) {
      var cb = h("input", { type: "checkbox", id: "acc-pd-d-" + i, value: String(i), checked: d.when.days.indexOf(i) >= 0 });
      cb.addEventListener("change", function () { var k = d.when.days.indexOf(i); if (cb.checked && k < 0) d.when.days.push(i); if (!cb.checked && k >= 0) d.when.days.splice(k, 1); d.when.days.sort(); upd(); });
      return h("label", { class: "check", for: "acc-pd-d-" + i }, cb, dn);
    }));
    var from = h("input", { id: "acc-pd-from", class: "input mono", type: "time", value: d.when.from });
    var to = h("input", { id: "acc-pd-to", class: "input mono", type: "time", value: d.when.to === "24:00" ? "00:00" : d.when.to });
    from.addEventListener("change", function () { d.when.from = from.value; upd(); });
    to.addEventListener("change", function () { d.when.to = to.value === "00:00" ? "24:00" : to.value; upd(); });
    var oncall = h("input", { type: "checkbox", id: "acc-pd-oncall", checked: d.oncallOnly });
    oncall.addEventListener("change", function () { d.oncallOnly = oncall.checked; upd(); });
    upd();
    G.dialog({
      title: existing ? "Edit " + existing.id : "Add a policy", kicker: "Access · scoped policy", wide: true,
      sub: "Narrowing policies restrict an action to the roles, projects and hours listed: once one exists for an action, that action needs a matching policy. Extending policies add a right the role matrix does not grant.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Policies"),
        G.field("Name", name),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Kind"), mode),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "What (actions)"), acts),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Who (roles)"), roles),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Where (projects; none ticked means every project)"), projs,
          h("div", { class: "field-hint" }, "For one repo use a freeze; for paths such as /payments use approver conditions in Project config.")),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "When (IST)"), days),
        h("div", { class: "form-row" }, G.field("From", from), G.field("To (00:00 means end of day)", to),
          h("div", { class: "field" }, h("div", { class: "field-label" }, "On call"), h("label", { class: "check", for: "acc-pd-oncall" }, oncall, "Only while on call"))),
        h("div", { class: "callout" }, h("div", { class: "kicker" }, "Reads as"), preview), warn, err),
      actions: [{ label: "Cancel" }, { label: existing ? "Save policy" : "Add policy", kind: "primary", submit: true, id: "acc-pd-save", guard: perm, onClick: function (close) {
        d.name = d.name.trim();
        if (!d.name) { err.textContent = "Name the policy."; return; }
        if (!d.actions.length) { err.textContent = "Pick at least one action."; return; }
        if (!d.roles.length) { err.textContent = "Pick at least one role."; return; }
        if (!d.when.days.length) { err.textContent = "Pick at least one day."; return; }
        if (d.when.to !== "24:00" && d.when.from >= d.when.to) { err.textContent = "'To' must be after 'From'."; return; }
        var before = existing ? G.policyText.sentence(existing) : null;
        var r;
        if (existing) {
          r = G.ops.savePolicy(existing.id, d); G.toast(r.msg, r.ok ? "ok" : "error");
        } else {
          r = G.ops.savePolicy(null, d); G.toast(r.msg, r.ok ? "ok" : "error");
        }
        if (!r.ok) { err.textContent = r.msg; return; }
        close();
      } }]
    });
  }

  function policyCards(s) {
    var perm = G.me("policy.edit");
    var list = s.policies.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    return h("ul", { class: "policy-cards" }, list.map(function (p) {
      var isHl = ui.hl === p.id;
      var kind = p.effect === "deny" ? "Deny" : p.extend ? "Extend" : "Narrow";
      return h("li", { class: "policy-card eff-" + p.effect + (p.extend ? " is-extend" : "") + (p.enabled ? "" : " is-off") + (isHl ? " is-hl" : ""), id: "acc-pol-" + p.id },
        h("div", { class: "pc-top" }, h("span", { class: "mono strong" }, p.id),
          h("span", { class: "pc-effect" }, G.icon(p.effect === "deny" ? "halt" : p.extend ? "plus" : "clock"), kind),
          isHl ? G.chip("deciding rule", "chip-accent") : null,
          h("span", { class: "pc-toggle" }, G.toggle("acc-pol-on-" + p.id, p.enabled, function (v) {
            var r = G.ops.setPolicyEnabled(p.id, v); G.toast(r.msg, r.ok ? "ok" : "error");
          }, perm, "Enable " + p.id))),
        h("h3", { class: "pc-name" }, p.name),
        h("p", { class: "pc-sentence" }, G.policyText.sentence(p)),
        h("dl", { class: "pc-grid" },
          h("div", null, h("dt", null, "Who"), h("dd", null, G.policyText.roles(p))),
          h("div", null, h("dt", null, "What"), h("dd", { class: "mono small" }, p.actions.join(", "))),
          h("div", null, h("dt", null, "Where"), h("dd", null, G.policyText.where(p))),
          h("div", null, h("dt", null, "When"), h("dd", null, p.effect === "deny" ? (p.where.freeze ? "while a freeze is active" : "always") : G.policyText.when(p.when) + (p.oncallOnly ? ", on call" : "")))),
        h("div", { class: "pc-actions" },
          G.btn("Edit", { small: true, kind: "ghost", icon: "page", id: "acc-pol-edit-" + p.id, guard: !perm.allowed ? perm : SPECIAL[p.id] ? lockd(SPECIAL[p.id]) : null, onClick: function () { policyDialog(p); } }),
          G.btn("Simulate", { small: true, kind: "ghost", icon: "play", id: "acc-pol-sim-" + p.id, onClick: function () {
            var proj = p.where.projects && p.where.projects[0] || "payments";
            var who = s.people.find(function (x) { return x.status === "active" && x.roles.some(function (g) { return p.roles.indexOf(g.role) >= 0 && (g.scope === "factory" || g.scope === proj || !p.where.projects || !p.where.projects.length); }); });
            var n = nowIst();
            ui.sim = { person: who ? who.id : "p-kenji", action: p.actions[0] && G.find.action(p.actions[0]) ? p.actions[0] : "release", project: proj, repo: "", date: n.date, time: n.time };
            evaluate(); window.scrollTo({ top: 0, behavior: G.reducedMotion() ? "auto" : "smooth" });
          } }),
          p.custom ? G.btn("Delete", { small: true, kind: "ghost", icon: "x", id: "acc-pol-del-" + p.id, guard: perm, onClick: function () {
            var r = G.ops.deletePolicy(p.id); G.toast(r.msg, r.ok ? "ok" : "error");
          } }) : null));
    }));
  }

  /* ---------- freezes ---------- */
  function freezeDialog() {
    var perm = G.me("policy.edit");
    var name = h("input", { id: "acc-fz-name", class: "input", placeholder: "Quarter-end close" });
    var repos = G.select("acc-fz-repos", [{ value: "all", label: "Every repo in every project" }].concat(S("repos").map(function (r) { return { value: r.id, label: r.name + " · " + (G.find.project(r.project) || {}).name }; })), "all");
    var fromD = h("input", { id: "acc-fz-from", class: "input mono", type: "date", value: G.istToday(1) });
    var fromT = h("input", { id: "acc-fz-fromt", class: "input mono", type: "time", value: "00:00" });
    var toD = h("input", { id: "acc-fz-to", class: "input mono", type: "date", value: G.istToday(3) });
    var toT = h("input", { id: "acc-fz-tot", class: "input mono", type: "time", value: "09:00" });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({
      title: "Schedule a freeze", kicker: "Access · change window",
      sub: "While a freeze is active, POL-110 denies every release on the frozen repos, whatever other policies say.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Freezes"), G.field("Name", name), G.field("Repos", repos),
        h("div", { class: "form-row" }, G.field("From (IST)", fromD), G.field("Time", fromT)), h("div", { class: "form-row" }, G.field("Until (IST)", toD), G.field("Time", toT)), err),
      actions: [{ label: "Cancel" }, { label: "Schedule freeze", kind: "primary", submit: true, id: "acc-fz-save", guard: perm, onClick: function (close) {
        if (!name.value.trim()) { err.textContent = "Name the freeze."; return; }
        var a = G.istTime(fromD.value, fromT.value || "00:00"), b = G.istTime(toD.value, toT.value || "00:00");
        if (!(b > a)) { err.textContent = "The end must be after the start."; return; }
        var r = G.ops.saveFreeze({ name: name.value, repos: repos.value === "all" ? "all" : [repos.value], from: a, to: b }); G.toast(r.msg, r.ok ? "ok" : "error");
        if (!r.ok) { err.textContent = r.msg; return; }
        close();
      } }]
    });
  }
  function freezeList(s) {
    var perm = G.me("policy.edit");
    var now = Date.now();
    if (!s.freezes.length) return G.empty("No freezes", "Schedule one to block releases on chosen repos for a period.");
    return h("ul", { class: "freezes acc-freezes" }, s.freezes.slice().sort(function (a, b) { return a.from - b.from; }).map(function (f) {
      var active = now >= f.from && now < f.to, past = now >= f.to;
      return h("li", { class: "freeze" + (active ? " is-active" : "") + (past ? " is-past" : "") + (ui.hl && ui.result && ui.result.d.rule.freeze === f.id ? " is-hl" : ""), id: "acc-frz-" + f.id },
        h("div", { class: "fz-top" }, h("span", { class: "mono strong" }, f.id), active ? h("span", { class: "chip chip-block" }, G.icon("halt"), "active now") : past ? G.chip("ended") : h("span", { class: "chip" }, G.icon("clock"), "upcoming")),
        h("div", { class: "strong" }, f.name),
        h("div", { class: "mono small" }, G.fmt.stamp(f.from) + " → " + G.fmt.stamp(f.to)),
        h("div", { class: "small muted" }, "Repos: " + (f.repos === "all" ? "every repo" : f.repos.map(function (r) { return (G.find.repo(r) || { name: r }).name; }).join(", ")) + " · set by " + G.actorName(f.by)),
        active || !past ? G.btn(active ? "End freeze now" : "Cancel freeze", { small: true, kind: "ghost", id: "acc-fz-end-" + f.id, guard: perm, onClick: function () {
          var r = G.ops.endFreeze(f.id); G.toast(r.msg, r.ok ? "ok" : "error");
        } }) : null);
    }));
  }

  /* ---------- role matrix ---------- */
  function matrixTable(s) {
    var perm = G.me("policy.edit");
    var r = ui.result;
    var hlAction = ui.hl === "MATRIX" && r ? r.sim.action : null;
    var hlRoles = hlAction ? G.rolesIn(G.find.person(r.sim.person), G.find.action(hlAction).scope === "project" ? r.sim.project : null) : [];
    if (hlAction && G.find.action(hlAction).scope === "factory") hlRoles = G.find.person(r.sim.person).roles.map(function (g) { return g.role; });
    var groups = []; G.ACTIONS.forEach(function (a) { if (groups.indexOf(a.group) < 0) groups.push(a.group); });
    var shown = ui.mxGroup === "all" ? groups : [ui.mxGroup];
    var rows = [];
    shown.forEach(function (g) {
      rows.push(h("tr", { class: "mx-grp" + (g === "Stops" ? " mx-grp-stop" : "") }, h("th", { scope: "rowgroup", colspan: String(G.ROLES.length + 1) }, g === "Stops" ? h("span", null, G.icon("st-kill"), " Stops: kill switches and restore") : g)));
      G.ACTIONS.filter(function (a) { return a.group === g; }).forEach(function (a) {
        rows.push(h("tr", { class: (hlAction === a.id ? "is-hl" : "") + (a.group === "Stops" ? " mx-stop" : ""), id: "acc-mx-row-" + a.id.replace(".", "_") },
          h("th", { scope: "row" }, h("span", null, a.name), h("span", { class: "mono muted mx-aid" }, a.id + (a.scope === "factory" ? " · factory" : ""))),
          G.ROLES.map(function (ro) {
            var on = !!(s.matrix[ro.id] && s.matrix[ro.id][a.id]);
            var key = ro.id + ":" + a.id;
            var d = !perm.allowed ? perm : LOCKED_ON[key] ? lockd(ro.name + " always keeps '" + a.name.toLowerCase() + "' so nobody is locked out.") : null;
            return h("td", { class: "mx-cell" + (on ? " is-on" : "") + (ro.custom ? " is-custom" : "") + (hlAction === a.id && hlRoles.indexOf(ro.id) >= 0 ? " is-hl" : "") }, G.toggle("acc-mx-" + ro.id + "-" + a.id.replace(".", "_"), on, function (v) {
              var r = G.ops.setMatrix(ro.id, a.id, v); G.toast(r.msg, r.ok ? "ok" : "error");
            }, d, ro.name + ": " + a.name));
          })));
      });
    });
    var filter = G.segmented("acc-mx-grp", [{ id: "all", label: "All" }].concat(groups.map(function (g) { return { id: g, label: g }; })), ui.mxGroup, function (v) { ui.mxGroup = v; G.rerender(); }, "Action group");
    return h("div", null,
      h("div", { class: "acc-mx-tools" }, filter),
      h("p", { class: "muted small acc-mx-note" }, "Project roles act only inside the projects where they are held. A factory action granted to a project role applies everywhere, so grant those with care. Policies on the Policies tab narrow or extend these rights by place and time."),
      h("div", { class: "table-scroll acc-mx-scroll", "data-keep-scroll": "acc-matrix" }, h("table", { class: "table table-compact matrix" },
        h("thead", null, h("tr", null, h("th", { scope: "col" }, "Action"), G.ROLES.map(function (r2) { return h("th", { scope: "col", id: "acc-mx-col-" + r2.id, class: "mx-role" + (hlRoles.indexOf(r2.id) >= 0 ? " is-hl" : "") + (r2.custom ? " is-custom" : "") + (ui.newRole === r2.id ? " is-new" : ""), title: r2.desc || null }, r2.name, h("span", { class: "mx-lvl mono" }, (r2.level === "factory" ? "factory" : "project") + (r2.custom ? " · custom" : ""))); }))),
        h("tbody", null, rows))));
  }

  /* explaining a decision (G.explainDenial, ask.js) and the policy trace (G.policyTrace, policy.js) are shared */
  function traceLines(personId, action, ctx) { return G.policyTrace(personId, action, ctx); }
  G.accessSimulate = function (sim) { sim = sim || {}; if (sim.project && sim.repo == null) sim.repo = ""; ui.sim = Object.assign(defaultSim(), sim); ui.result = null; ui.tab = ui.tab || "policies"; if (location.hash === "#access") evaluate(); else { ui.pendingEval = true; location.hash = "access"; } };

  /* ---------- custom roles ---------- */
  function holdersOf(roleId) { return S("people").filter(function (p) { return p.roles.some(function (g) { return g.role === roleId; }); }); }
  function grantsOf(roleId) { var m = S("matrix")[roleId] || {}; return G.ACTIONS.filter(function (a) { return m[a.id]; }); }
  function roleDialog(existing) {
    var perm = G.me("role.edit");
    var name = h("input", { id: "acc-rd-name", class: "input", value: existing ? existing.name : "", placeholder: "Change Advisory Board", autocomplete: "off" });
    var desc = h("textarea", { id: "acc-rd-desc", class: "input", rows: "2", placeholder: "What this role is for" }); desc.value = existing ? existing.desc || "" : "";
    var level = existing ? null : G.segmented("acc-rd-level", [{ id: "project", label: "Project role" }, { id: "factory", label: "Factory role" }], "project", function () { upd(); }, "Scope");
    var base = existing ? null : G.select("acc-rd-base", G.ROLES.map(function (r) { return { value: r.id, label: r.name + (r.custom ? " (custom)" : "") + " · " + grantsOf(r.id).length + " actions" }; }), "viewer", function () { upd(); });
    var info = h("p", { class: "small muted", id: "acc-rd-info" });
    function upd() { if (!base) return; var lv = (level.querySelector("input:checked") || {}).value; info.textContent = "Starts with the " + grantsOf(base.value).length + " actions " + G.find.role(base.value).name + " has. " + (lv === "factory" ? "A factory role applies in every project and lets its holders see every project." : "A project role acts only inside projects where it is granted.") + " Change single rights afterwards in the matrix."; }
    upd();
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: existing ? "Edit " + existing.name : "Add a role", kicker: "Access · roles",
      sub: existing ? "Built-in roles keep their names; custom roles can be renamed. Rights are edited in the matrix." : "A new role is cloned from an existing one. It then appears in the matrix, on People screens, in the simulator and in approver rules.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Roles"), G.field("Name", name), level ? h("div", { class: "field" }, h("div", { class: "field-label" }, "Scope"), level) : null, base ? G.field("Clone rights from", base) : null, G.field("Description", desc), info, err),
      actions: [{ label: "Cancel" }, { label: existing ? "Save role" : "Add role", kind: "primary", submit: true, id: "acc-rd-save", guard: perm, onClick: function (close) {
        var r = existing ? G.ops.updateRole(existing.id, { name: name.value, desc: desc.value }) : G.ops.addRole({ name: name.value, level: (level.querySelector("input:checked") || {}).value || "project", base: base.value, desc: desc.value });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
        if (!existing && r.role) { ui.tab = "matrix"; ui.newRole = r.role.id; G.rerender(); setTimeout(function () { var el = document.getElementById("acc-mx-col-" + r.role.id); if (el) el.scrollIntoView({ block: "nearest", inline: "center" }); }, 80); }
      } }] });
  }
  function removeRole(ro) {
    var perm = G.me("role.edit");
    var holders = holdersOf(ro.id);
    G.dialog({ title: "Remove " + ro.name, kicker: "Access · roles",
      sub: holders.length ? holders.length + " " + (holders.length > 1 ? "people hold" : "person holds") + " this role: " + holders.map(function (p) { return p.name; }).join(", ") + ". Remove it from them first." : "Nobody holds this role. Removing it deletes its matrix row; approver rules that name it must be changed first.",
      body: h("div", null, G.lockNote(perm, "Roles")),
      actions: [{ label: "Cancel" }, { label: "Remove role", kind: "danger", id: "acc-rr-go", guard: perm.allowed && holders.length ? lockd(holders.length + " people still hold " + ro.name + ".") : perm, onClick: function (close) {
        var r = G.ops.removeRole(ro.id); G.toast(r.msg, r.ok ? "ok" : "error"); if (r.ok) close();
      } }] });
  }
  function rolesList() {
    var perm = G.me("role.edit");
    return h("div", { class: "acc-roles" },
      h("p", { class: "muted small acc-mx-note" }, "Built-in roles plus custom roles your organisation adds. Custom roles are cloned from an existing role and then edited in the matrix. Holding a factory role makes every project visible."),
      G.dataTable({ id: "acc-roles-table", caption: "Roles", rowKey: function (r) { return r.id; }, rows: G.ROLES.slice(), columns: [
        { key: "name", label: "Role", sort: true, render: function (r) { return h("span", { class: "acc-role-name" }, h("strong", null, r.name), r.custom ? h("span", { class: "chip chip-accent" }, "custom") : null, h("span", { class: "mono muted small" }, r.id)); } },
        { key: "level", label: "Scope", sort: true, render: function (r) { return r.level === "factory" ? "Factory" : "Project"; } },
        { key: "base", label: "Cloned from", render: function (r) { return r.base ? (G.find.role(r.base) || { name: r.base }).name : h("span", { class: "muted" }, "built in"); } },
        { key: "acts", label: "Actions", sort: function (r) { return grantsOf(r.id).length; }, align: "end", render: function (r) { return h("span", { class: "mono" }, String(grantsOf(r.id).length)); } },
        { key: "holders", label: "Held by", sort: function (r) { return holdersOf(r.id).length; }, render: function (r) { var hs = holdersOf(r.id); return hs.length ? h("span", { class: "small" }, hs.slice(0, 3).map(function (p) { return p.name; }).join(", ") + (hs.length > 3 ? " +" + (hs.length - 3) : "")) : h("span", { class: "muted small" }, "nobody"); } },
        { key: "desc", label: "Description", hideSmall: true, render: function (r) { return h("span", { class: "small" }, r.desc || ""); } },
        { key: "tools", label: "", render: function (r) {
          return h("span", { class: "row gap-sm acc-role-tools" },
            G.btn("Rights", { small: true, kind: "ghost", id: "acc-role-mx-" + r.id, onClick: function () { ui.tab = "matrix"; ui.newRole = r.id; G.rerender(); setTimeout(function () { var el = document.getElementById("acc-mx-col-" + r.id); if (el) el.scrollIntoView({ block: "nearest", inline: "center" }); }, 80); } }),
            G.btn("Edit", { small: true, kind: "ghost", id: "acc-role-edit-" + r.id, guard: !perm.allowed ? perm : !r.custom ? lockd(r.name + " is built in. Edit its rights in the matrix.") : null, onClick: function () { roleDialog(r); } }),
            G.btn("Remove", { small: true, kind: "ghost", id: "acc-role-rm-" + r.id, guard: !perm.allowed ? perm : !r.custom ? lockd(r.name + " is built in and cannot be removed.") : null, onClick: function () { removeRole(r); } }));
        } }
      ] }));
  }

  function render() {
    var s = G.store.get();
    var perm = G.me("policy.edit"), rperm = G.me("role.edit");
    if (ui.pendingEval) { ui.pendingEval = false; setTimeout(evaluate, 0); }
    var activeFz = s.freezes.filter(function (f) { return Date.now() >= f.from && Date.now() < f.to; }).length;
    var custom = G.ROLES.filter(function (r) { return r.custom; }).length;
    var tabs = G.tabBar({ id: "acc-tab", active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); }, items: [{ id: "policies", label: "Policies", count: s.policies.length }, { id: "freezes", label: "Freezes", count: s.freezes.length }, { id: "matrix", label: "Roles × actions" }, { id: "roles", label: "Roles", count: G.ROLES.length }] });
    var body = ui.tab === "matrix" ? matrixTable(s) : ui.tab === "freezes" ? freezeList(s) : ui.tab === "roles" ? rolesList() : policyCards(s);
    var tools = ui.tab === "freezes" ? G.btn("Schedule freeze", { small: true, icon: "clock", id: "acc-add-freeze", guard: perm, onClick: freezeDialog })
      : ui.tab === "policies" ? G.btn("Add policy", { small: true, icon: "plus", id: "acc-add-policy", guard: perm, onClick: function () { policyDialog(null); } })
      : G.btn("Add role", { small: true, icon: "plus", id: "acc-add-role", guard: rperm, onClick: function () { roleDialog(null); } });
    return h("div", { class: "view view-access" },
      G.pageHeader({ id: "acc-head", kicker: "Govern · Access", title: "Access", sub: "Who can do what, where and when. Roles grant actions per project; policies narrow or extend them by project, hour and on-call status; freezes override everything for release.",
        meta: [["Roles", String(G.ROLES.length) + (custom ? " (" + custom + " custom)" : "")], ["Actions", String(G.ACTIONS.length)], ["Policies on", String(s.policies.filter(function (p) { return p.enabled; }).length)], ["Freezes active", String(activeFz)]],
        actions: [G.btn("Add role", { kind: "ghost", icon: "plus", id: "acc-head-role", guard: rperm, onClick: function () { roleDialog(null); } }), G.btn("Add policy", { icon: "plus", id: "acc-head-add", guard: perm, onClick: function () { policyDialog(null); } })] }),
      G.lockNote(perm, "The role matrix, policies and freezes"),
      simulator(),
      h("section", { class: "panel acc-rules", "aria-label": "Rules" }, h("div", { class: "acc-tabbar" }, tabs, tools ? h("div", { class: "acc-tab-tools" }, tools) : null), h("div", { class: "panel-body" + (ui.tab === "matrix" ? " flush" : ""), id: "acc-tab-panel", role: "tabpanel" }, body)));
  }

  G.views.access = { title: "Access", render: render, keys: ["matrix", "policies", "freezes", "people", "projects", "repos"] };
})(window.G);
