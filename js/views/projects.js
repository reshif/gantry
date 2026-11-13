/* Projects (#projects): projects list with state, the New project wizard (template, basics, repos,
   approvers, notifications, review, create) and the Templates tab (mini-belt previews, duplicate,
   edit basics, save current project as template). Mutations go through G.ops. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "projects", q: "", status: "all" };

  function res(r) { G.toast(r.msg, r.ok ? "ok" : "error"); return r; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function roleName(id) { var r = G.find.role(id); return r ? r.name : id; }
  function evName(id) { return G.notifyEventName(id); }
  function tplClassesText(t) {
    var keys = Object.keys(t.classesSkip || {});
    if (!keys.length) return "Default class routes";
    return keys.map(function (k) { var c = G.find.cls(k); var sk = t.classesSkip[k]; return (c ? c.name : k) + (sk.length ? " skips " + sk.map(function (s) { return G.find.station(s).name; }).join(", ") : " travels every station"); }).join("; ");
  }
  function tplBelt(t) { return G.miniBelt({ project: G.cfgKit.tplFlowProject(t), wos: [], stationsOff: t.stationsOff, gatesOff: t.gatesOff }); }
  function builtOff(list, kind) { return (list || []).filter(function (id) { var d = kind === "s" ? G.stationDef(id) : G.gateDef(id); return d && !d.custom; }); }
  var PRESET = { standard: "Standard: one approver per human gate, author cannot approve, hotfix needs an on-call Release Manager.", light: "Light: engineers may approve reviews, no path conditions.", strict: "Strict: two approvers on Spec and Review, high-risk changes need Security, compliance copy of every decision." };

  /* ---------- projects list: the portfolio (shared with Home, built in home.js) ---------- */
  function projectsTab() {
    var all = G.visibleProjects(G.viewerId());
    if (G.isFactoryAdmin(G.viewerId()) || G.viewer().roles.some(function (g) { return g.scope === "factory"; })) {
      G.store.get("projects").forEach(function (p) { if (all.indexOf(p) < 0) all = all.concat([p]); });
    }
    return h("div", { class: "prj-stack" }, G.portfolio.render({ ctx: "prj-pf", projects: all, card: G.portfolio.card, roles: true, defaultLayout: "rows" }));
  }

  /* ---------- templates ---------- */
  function templatesTab() {
    var d = G.me("template.edit");
    var cur = G.currentProject();
    var used = {}; G.store.get("projects").forEach(function (p) { used[p.template] = (used[p.template] || 0) + 1; });
    return h("div", { class: "prj-stack" },
      G.lockNote(d, "Templates"),
      h("div", { class: "toolbar" }, h("p", { class: "muted small" }, "A template sets stations, gates, coding slots, class routes, approver preset and notification preset for new projects. Changing a template does not change projects already created from it."),
        cur ? G.btn("Save " + cur.name + " as template", { icon: "copy", id: "prj-tpl-from-cur", guard: d, onClick: function () { saveFromProject(cur); } }) : null),
      h("div", { class: "prj-tpl-grid" }, G.store.get("templates").map(function (t) {
        return h("article", { class: "prj-tpl", "aria-label": t.name },
          h("div", { class: "prj-tpl-head" }, h("h3", null, t.name), t.builtIn ? h("span", { class: "tag" }, "built-in") : h("span", { class: "tag prj-tag-custom" }, "custom")),
          h("p", { class: "small" }, t.desc),
          tplBelt(t),
          h("dl", { class: "prj-tpl-facts small" },
            h("div", null, h("dt", null, "Stations off"), h("dd", null, builtOff(t.stationsOff, "s").length ? builtOff(t.stationsOff, "s").map(function (s) { return G.find.station(s).name; }).join(", ") : "none")),
            h("div", null, h("dt", null, "Gates off"), h("dd", null, builtOff(t.gatesOff, "g").length ? builtOff(t.gatesOff, "g").map(function (g) { return G.gateDef(g).label; }).join(", ") : "none")),
            G.cfgKit.tplCustomCount(t) ? h("div", { class: "prj-tpl-custom" }, h("dt", null, "Custom entries"), h("dd", null, G.cfgKit.tplCustomText(t))) : null,
            h("div", null, h("dt", null, "Slots"), h("dd", null, String(t.slots))),
            h("div", null, h("dt", null, "Approvers"), h("dd", null, t.approverPreset)),
            h("div", null, h("dt", null, "Routes"), h("dd", null, tplClassesText(t))),
            h("div", null, h("dt", null, "Used by"), h("dd", null, (used[t.id] || 0) + " project" + ((used[t.id] || 0) === 1 ? "" : "s")))),
          h("div", { class: "prj-tpl-acts" },
            G.btn("Use", { small: true, kind: "primary", id: "prj-tpl-use-" + t.id, guard: G.me("project.create"), aria: "New project from " + t.name, onClick: function () { openWizard(t.id); } }),
            G.btn("Duplicate", { small: true, id: "prj-tpl-dup-" + t.id, guard: d, aria: "Duplicate " + t.name, onClick: function () { res(G.ops.saveTemplate({ fromTemplate: t.id })); } }),
            G.btn("Edit", { small: true, kind: "ghost", id: "prj-tpl-edit-" + t.id, aria: "Edit " + t.name, guard: d, disabledReason: d.allowed && t.builtIn ? "Built-in templates are read-only. Duplicate it to change it." : null, onClick: function () { editTemplate(t); } })));
      })));
  }
  function saveFromProject(p) {
    var name = h("input", { id: "prj-tplp-name", class: "input", value: p.name + " template" });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: "Save " + p.name + " as a template", kicker: "Templates", sub: "Copies its stations, gates, bays, slots and class routes, custom entries included (" + (G.cfgKit.tplCustomText({ custom: G.cfgKit.tplCustomFromProject(p) }) || "none here") + "). Members, repos and budgets are not copied.",
      body: h("div", { class: "form-grid" }, G.field("Template name", name), err),
      actions: [{ label: "Cancel" }, { label: "Save template", kind: "primary", submit: true, id: "prj-tplp-ok", guard: G.me("template.edit"), onClick: function (close) {
        if (name.value.trim().length < 3) { err.textContent = "Name the template (3+ characters)."; return; }
        var r = G.cfgKit.saveProjectTemplate(p, name.value.trim()); if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }
  function editTemplate(t) {
    var dr = { name: t.name, desc: t.desc, stationsOff: t.stationsOff.slice(), gatesOff: t.gatesOff.slice(), slots: t.slots, classesSkip: clone(t.classesSkip || {}), custom: clone(G.cfgKit.tplCustom(t)) };
    function tplNow() { return Object.assign({}, t, { stationsOff: dr.stationsOff, gatesOff: dr.gatesOff, classesSkip: dr.classesSkip, custom: dr.custom }); }
    var holder = h("div", { class: "form-grid" });
    var err = h("div", { class: "form-err", role: "alert" });
    function classes() { return G.CLASSES.filter(function (c) { return !c.custom; }).map(function (c) { var x = clone(c); if (dr.classesSkip[c.id]) x.skips = dr.classesSkip[c.id].slice(); return x; }); }
    function draw() {
      G.clear(holder);
      var name = h("input", { id: "prj-te-name", class: "input", value: dr.name }); name.addEventListener("input", function () { dr.name = name.value; });
      var desc = h("input", { id: "prj-te-desc", class: "input", value: dr.desc }); desc.addEventListener("input", function () { dr.desc = desc.value; });
      var slots = G.select("prj-te-slots", ["1", "2", "3", "4", "6"], String(dr.slots), function (v) { dr.slots = parseInt(v, 10); });
      G.append(holder, [
        h("div", { class: "form-row" }, G.field("Name", name), G.field("Coding slots", slots)),
        G.field("Description", desc),
        h("div", { class: "prj-te-preview" }, h("span", { class: "kicker" }, "Preview"), tplBelt(tplNow())),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Stations on"), h("div", { class: "check-grid" }, G.STATIONS.filter(function (s) { return !s.custom; }).map(function (s) {
          var id = "prj-te-st-" + s.id;
          return h("label", { class: "check", for: id, "data-tip": s.id === "intake" ? "Intake is always on." : null }, h("input", { type: "checkbox", id: id, checked: dr.stationsOff.indexOf(s.id) < 0, disabled: s.id === "intake", onChange: function (e) { dr.stationsOff = e.target.checked ? dr.stationsOff.filter(function (x) { return x !== s.id; }) : dr.stationsOff.concat([s.id]); draw(); focus(id); } }), s.no + " " + s.name);
        }))),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Gates on"), h("div", { class: "check-grid" }, G.GATES.filter(function (g) { return !g.custom; }).map(function (g) {
          var id = "prj-te-g-" + g.id;
          return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: dr.gatesOff.indexOf(g.id) < 0, disabled: g.id === "G0G1", onChange: function (e) { dr.gatesOff = e.target.checked ? dr.gatesOff.filter(function (x) { return x !== g.id; }) : dr.gatesOff.concat([g.id]); draw(); focus(id); } }), g.label + " " + g.name);
        }))),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Default class routes"),
          G.cfgKit.routeMatrix({ project: G.cfgKit.tplFlowProject(tplNow()), classes: classes(), stationsOff: dr.stationsOff, idp: "prj-te-rm", onToggle: function (cid, sid, travels) {
            var base = (dr.classesSkip[cid] || G.find.cls(cid).skips).slice();
            base = travels ? base.filter(function (x) { return x !== sid; }) : base.concat([sid]);
            if (JSON.stringify(base.slice().sort()) === JSON.stringify(G.find.cls(cid).skips.slice().sort())) delete dr.classesSkip[cid]; else dr.classesSkip[cid] = base;
            draw(); focus("prj-te-rm-" + cid + "-" + sid);
          } })),
        customEditor(),
        err]);
    }
    function customEditor() {
      var c = dr.custom, rows = [];
      [["stations", "Station", function (x) { return x.name + " after " + (G.find.station(x.after) || { name: x.after }).name; }], ["gates", "Gate", function (x) { return x.label + " " + x.name + " after " + (G.find.station(x.after) || { name: x.after }).name; }], ["bays", "Bay", function (x) { return x.name; }], ["classes", "Class", function (x) { return x.name; }]].forEach(function (k) {
        c[k[0]].forEach(function (x) {
          rows.push(h("li", { class: "prj-te-cust" }, h("span", { class: "tag" }, k[1]), h("span", null, k[2](x)),
            G.btn("Drop", { small: true, kind: "ghost", icon: "x", id: "prj-te-cx-" + k[0] + "-" + x.id, aria: "Drop " + k[1].toLowerCase() + " " + x.name + " from the template", onClick: function () {
              c[k[0]] = c[k[0]].filter(function (y) { return y.id !== x.id; });
              if (k[0] === "stations") c.gates = c.gates.filter(function (g) { return g.after !== x.id; });
              draw(); focus("prj-te-name");
            } })));
        });
      });
      return h("div", { class: "field" }, h("div", { class: "field-label" }, "Custom flow entries"), rows.length ? h("ul", { class: "plain-list" }, rows) : h("p", { class: "small muted" }, "None. Save a project with custom stations, gates, bays or classes as a template to carry them."));
    }
    function focus(id) { var el = document.getElementById(id); if (el) el.focus(); }
    draw();
    G.dialog({ title: "Edit template " + t.name, kicker: "Templates", wide: true, body: holder,
      actions: [{ label: "Cancel" }, { label: "Save template", kind: "primary", submit: true, id: "prj-te-ok", guard: G.me("template.edit"), onClick: function (close) {
        if (dr.name.trim().length < 3) { err.textContent = "Name the template (3+ characters)."; return; }
        var r = G.ops.updateTemplate(t.id, { name: dr.name.trim(), desc: dr.desc.trim(), stationsOff: dr.stationsOff, gatesOff: dr.gatesOff, slots: dr.slots, classesSkip: dr.classesSkip, custom: dr.custom });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }

  /* ---------- new project wizard ---------- */
  var STEPS = [["template", "Template"], ["basics", "Name and owner"], ["repos", "Repos"], ["approvers", "Approvers"], ["notify", "Notifications"], ["review", "Review"]];
  function openWizard(tplId) {
    var me = G.viewer();
    var tpl = G.find.template(tplId) || G.store.get("templates")[0];
    var wz = { step: 0, tpl: tpl.id, name: "", key: "", desc: "", owner: me.id, teams: [], budget: 2000, repos: {}, extraRepo: "", approverPreset: tpl.approverPreset, fallback: "", notifyPreset: tpl.notify, routesOff: {} };
    var holder = h("div", { class: "prj-wz" });
    var dlg;
    function T() { return G.find.template(wz.tpl); }
    function idFor(n) { return n.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
    function check(step) {
      if (step === 1) {
        if (wz.name.trim().length < 3) return "Name the project (3+ characters).";
        if (G.find.project(idFor(wz.name))) return "A project called " + wz.name.trim() + " already exists.";
        if (!wz.teams.length) return "Pick at least one owning team.";
      }
      if (step === 2) {
        var bad = Object.keys(wz.repos).filter(function (n) { return !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(n); });
        if (bad.length) return "Repo names look like acme/name: " + bad.join(", ");
        var taken = Object.keys(wz.repos).filter(function (n) { return G.find.repo(n); });
        if (taken.length) return taken.join(", ") + " already belongs to a project.";
      }
      return null;
    }
    function routes() { return G.routesPreset(wz.notifyPreset).filter(function (r) { return !wz.routesOff[r.event]; }); }
    function approvers() {
      var a = G.approversPreset(wz.approverPreset);
      if (wz.fallback) Object.keys(a).forEach(function (k) { if (a[k].roles.length) a[k].fallback = wz.fallback; });
      return a;
    }
    function go(n) { var e = n > wz.step ? check(wz.step) : null; if (e) { wz.err = e; draw(); return; } wz.err = null; wz.step = n; draw(); var f = holder.querySelector("input,select,button.prj-wz-focus"); if (f) f.focus(); }
    function draw() {
      if (G.tip) G.tip.hide();
      G.clear(holder);
      var step = STEPS[wz.step][0];
      var stepper = h("ol", { class: "stepper prj-wz-steps" }, STEPS.map(function (s, i) { return h("li", { class: i === wz.step ? "is-on" : i < wz.step ? "is-done" : "", "aria-current": i === wz.step ? "step" : null }, h("span", null, i < wz.step ? "✓" : String(i + 1)), s[1]); }));
      var body;
      if (step === "template") {
        body = h("div", { class: "radio-cards prj-wz-tpls", role: "radiogroup", "aria-label": "Template" }, G.store.get("templates").map(function (t) {
          var id = "prj-wz-tpl-" + t.id;
          return h("label", { class: "radio-card prj-wz-tpl" + (wz.tpl === t.id ? " is-on" : ""), for: id },
            h("input", { type: "radio", name: "prj-wz-tpl", id: id, checked: wz.tpl === t.id, onChange: function () { wz.tpl = t.id; wz.approverPreset = t.approverPreset; wz.notifyPreset = t.notify; draw(); focus(id); } }),
            h("span", { class: "rc-t" }, t.name), h("span", { class: "rc-d" }, t.desc), tplBelt(t), h("span", { class: "rc-d mono" }, t.slots + " slot" + (t.slots > 1 ? "s" : "") + " · " + t.approverPreset + " approvers"));
        }));
      } else if (step === "basics") {
        var name = h("input", { id: "prj-wz-name", class: "input", value: wz.name, placeholder: "Checkout Platform", autocomplete: "off" });
        name.addEventListener("input", function () { wz.name = name.value; keyEl.placeholder = (idFor(wz.name).replace(/-/g, "").slice(0, 3) || "KEY").toUpperCase(); });
        var keyEl = h("input", { id: "prj-wz-key", class: "input mono", value: wz.key, maxlength: "5", placeholder: (idFor(wz.name).replace(/-/g, "").slice(0, 3) || "KEY").toUpperCase() });
        keyEl.addEventListener("input", function () { wz.key = keyEl.value.toUpperCase(); });
        var desc = h("input", { id: "prj-wz-desc", class: "input", value: wz.desc, placeholder: "What this project builds" });
        desc.addEventListener("input", function () { wz.desc = desc.value; });
        var people = G.store.get("people").filter(function (x) { return x.status === "active"; });
        body = h("div", { class: "form-grid" },
          h("div", { class: "form-row" }, G.field("Project name", name), G.field("Key", keyEl, "Short prefix, 2 to 5 letters.")),
          G.field("Description", desc),
          h("div", { class: "form-row" },
            G.field("Owner", G.select("prj-wz-owner", people.map(function (x) { return { value: x.id, label: x.name + " · " + x.title }; }), wz.owner, function (v) { wz.owner = v; }), "Becomes Project Admin unless they hold a factory role."),
            G.field("Monthly budget (USD)", (function () { var b = h("input", { id: "prj-wz-budget", type: "number", min: "100", class: "input mono", value: String(wz.budget) }); b.addEventListener("input", function () { wz.budget = parseInt(b.value, 10) || 0; }); return b; })())),
          h("div", { class: "field" }, h("div", { class: "field-label" }, "Owning teams"), h("div", { class: "check-grid" }, G.store.get("teams").map(function (t) {
            var id = "prj-wz-team-" + t.id;
            return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: wz.teams.indexOf(t.id) >= 0, onChange: function (e) { wz.teams = e.target.checked ? wz.teams.concat([t.id]) : wz.teams.filter(function (x) { return x !== t.id; }); } }), t.name);
          }))));
      } else if (step === "repos") {
        /* a new project can use the source-control integrations open to all projects */
        var srcs = G.sourceInstances(null).filter(function (i) { return i.projects === "all" && i.connected !== false; });
        var avail = []; srcs.forEach(function (i) { G.availableRepos(i.id).forEach(function (a) { avail.push(a); }); });
        var srcText = srcs.length ? srcs.map(function (i) { return i.name; }).join(" or ") : "a source-control integration";
        var extra = h("input", { id: "prj-wz-repo-add", class: "input mono", value: wz.extraRepo, placeholder: "acme/new-service" });
        extra.addEventListener("input", function () { wz.extraRepo = extra.value; });
        var teamOpts = G.store.get("teams").map(function (t) { return { value: t.id, label: t.name }; });
        var picked = Object.keys(wz.repos);
        body = h("div", { class: "form-grid" },
          h("p", { class: "small muted" }, "Each repo is connected through " + srcText + " (simulated) and starts onboarding: the Onboarding agent assesses it and opens a PR. Work orders can target a repo once it is Ready. You can also add repos later."),
          avail.length ? h("ul", { class: "plain-list prj-wz-repos" }, avail.map(function (r) {
            var id = "prj-wz-repo-" + r.repo.replace(/[^a-z0-9]/gi, "-");
            var on = !!wz.repos[r.repo];
            return h("li", { class: "prj-wz-repo" }, h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: on, onChange: function (e) { if (e.target.checked) wz.repos[r.repo] = wz.teams[0] || "platform"; else delete wz.repos[r.repo]; draw(); focus(id); } }), h("span", { class: "mono" }, r.repo), h("span", { class: "muted small" }, r.lang)),
              on ? G.select(id + "-team", teamOpts, wz.repos[r.repo], function (v) { wz.repos[r.repo] = v; }, { "aria-label": "Owning team for " + r.repo }) : null);
          })) : h("p", { class: "muted small" }, "Every repo " + srcText + " offers is already connected."),
          h("div", { class: "inline-form" }, G.field("Another repo", extra), G.btn("Add repo", { small: true, icon: "plus", id: "prj-wz-repo-go", onClick: function () { var n = wz.extraRepo.trim(); if (!n) return; wz.repos[n] = wz.teams[0] || "platform"; wz.extraRepo = ""; draw(); focus("prj-wz-repo-add"); } })),
          picked.filter(function (n) { return !avail.some(function (a) { return a.repo === n; }); }).length ? h("ul", { class: "plain-list" }, picked.filter(function (n) { return !avail.some(function (a) { return a.repo === n; }); }).map(function (n) {
            return h("li", { class: "prj-wz-repo" }, h("span", { class: "mono" }, n), G.btn("Remove", { small: true, kind: "ghost", icon: "x", id: "prj-wz-rm-" + n.replace(/[^a-z0-9]/gi, "-"), onClick: function () { delete wz.repos[n]; draw(); } }));
          })) : null,
          h("p", { class: "small" }, picked.length + " repo" + (picked.length === 1 ? "" : "s") + " selected."));
      } else if (step === "approvers") {
        var a = approvers();
        body = h("div", { class: "form-grid" },
          h("div", { class: "radio-cards", role: "radiogroup", "aria-label": "Approver preset" }, ["standard", "light", "strict"].map(function (k) {
            var id = "prj-wz-ap-" + k;
            return h("label", { class: "radio-card" + (wz.approverPreset === k ? " is-on" : ""), for: id }, h("input", { type: "radio", name: "prj-wz-ap", id: id, checked: wz.approverPreset === k, onChange: function () { wz.approverPreset = k; draw(); focus(id); } }), h("span", { class: "rc-t" }, k.charAt(0).toUpperCase() + k.slice(1)), h("span", { class: "rc-d" }, PRESET[k].split(": ")[1]));
          })),
          G.field("Escalation fallback", G.select("prj-wz-fallback", [{ value: "", label: "Project owner" }].concat(G.store.get("people").filter(function (x) { return x.status === "active"; }).map(function (x) { return { value: x.id, label: x.name }; })), wz.fallback, function (v) { wz.fallback = v; }), "Who gets a gate when it waits past its SLA."),
          h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" }, h("thead", null, h("tr", null, h("th", null, "Gate"), h("th", null, "Who"), h("th", { class: "num" }, "Needs"), h("th", null, "Author can approve"), h("th", null, "Conditions"))),
            h("tbody", null, G.flowOf(G.cfgKit.tplFlowProject(T())).gates.filter(function (g) { return g.kind !== "auto" && T().gatesOff.indexOf(g.id) < 0; }).map(function (g) {
              var cg = G.cfgKit.tplCustom(T()).gates.find(function (x) { return x.id === g.id; });
              var r = cg ? { roles: cg.roles, required: cg.required, sod: true, conditions: [] } : a[g.id];
              if (!r) return null;
              return h("tr", null, h("td", { class: "mono" }, g.label), h("td", { class: "small" }, r.roles.map(roleName).join(", ")), h("td", { class: "num mono" }, String(r.required)), h("td", null, r.sod ? "no" : "yes"), h("td", { class: "small" }, r.conditions.map(function (c) { return c.text; }).join("; ") || h("span", { class: "muted" }, "none")));
            })))),
          h("p", { class: "small muted" }, "Named approvers, N of M and conditions can be edited per gate in Project config after creation."));
      } else if (step === "notify") {
        var all = G.routesPreset(wz.notifyPreset);
        body = h("div", { class: "form-grid" },
          G.field("Preset", G.segmented("prj-wz-np", [{ id: "standard", label: "Standard" }, { id: "light", label: "Light" }, { id: "strict", label: "Strict" }], wz.notifyPreset, function (v) { wz.notifyPreset = v; draw(); focus("prj-wz-np-" + v); }, "Notification preset")),
          h("ul", { class: "plain-list prj-wz-routes" }, all.map(function (r) {
            var locked = r.event === "kill" || r.event === "restore";
            return h("li", { class: "toggle-row" }, h("span", null, h("strong", null, evName(r.event)), h("span", { class: "muted small mono" }, " → " + r.dest.map(function (x) { return x.channel + " " + x.target; }).join(", "))),
              G.toggle("prj-wz-nr-" + r.event.replace(".", "-"), !wz.routesOff[r.event], function (v) { if (v) delete wz.routesOff[r.event]; else wz.routesOff[r.event] = true; }, locked ? { allowed: false, reason: "Kill and restore notices are always on.", needs: "" } : null, evName(r.event)));
          })),
          h("p", { class: "small muted" }, "Deliveries are simulated. Destinations and card templates can be changed later in Notifications."));
      } else {
        var t = T();
        var rp = Object.keys(wz.repos);
        var flowPreview = G.cfgKit.tplFlowProject(t);
        body = h("div", { class: "form-grid" },
          h("dl", { class: "titleblock prj-wz-review" },
            h("div", null, h("dt", null, "Name"), h("dd", null, wz.name.trim() || "missing")),
            h("div", null, h("dt", null, "Key"), h("dd", { class: "mono" }, (wz.key || idFor(wz.name).slice(0, 3)).toUpperCase())),
            h("div", null, h("dt", null, "Template"), h("dd", null, t.name)),
            h("div", null, h("dt", null, "Owner"), h("dd", null, G.actorName(wz.owner))),
            h("div", null, h("dt", null, "Teams"), h("dd", null, wz.teams.map(function (x) { return G.find.team(x).name; }).join(", "))),
            h("div", null, h("dt", null, "Budget"), h("dd", null, G.fmt.money0(wz.budget))),
            h("div", null, h("dt", null, "Approvers"), h("dd", null, wz.approverPreset)),
            h("div", null, h("dt", null, "Routes"), h("dd", null, routes().length + " notification routes"))),
          h("div", null, h("div", { class: "sub-h" }, "Flow"), tplBelt(t), h("p", { class: "small muted" }, "Feature route: " + G.route(flowPreview, "feature").map(function (s) { return G.find.station(s).name; }).join(" → ")),
            G.cfgKit.tplCustomCount(t) ? h("p", { class: "small" }, h("span", { class: "kv-k" }, "Custom entries carried "), G.cfgKit.tplCustomText(t), ". They are added through the flow ops after the project is created; people still need any custom approver roles granted.") : null),
          h("div", null, h("div", { class: "sub-h" }, "Repos to onboard"), rp.length ? h("ul", { class: "plain-list small" }, rp.map(function (n) { return h("li", { class: "mono" }, n + " · " + (G.find.team(wz.repos[n]) || { name: wz.repos[n] }).name); })) : h("p", { class: "small muted" }, "None. The project starts as New until a repo is connected.")),
          G.lockNote(G.me("project.create"), "Creating projects"));
      }
      var last = wz.step === STEPS.length - 1;
      G.append(holder, [stepper, h("div", { class: "prj-wz-body" }, body),
        wz.err ? h("div", { class: "form-err", role: "alert" }, wz.err) : null,
        h("div", { class: "prj-wz-nav" },
          wz.step ? G.btn("Back", { kind: "ghost", icon: "back", id: "prj-wz-back", onClick: function () { go(wz.step - 1); } }) : h("span"),
          last ? G.btn("Create project", { kind: "primary", icon: "check", id: "prj-wz-create", guard: G.me("project.create"), onClick: create })
            : G.btn("Next: " + STEPS[wz.step + 1][1], { kind: "primary", icon: "chevron", id: "prj-wz-next", cls: "prj-wz-focus", onClick: function () { go(wz.step + 1); } }))]);
    }
    function focus(id) { var el = document.getElementById(id); if (el) el.focus(); }
    function create() {
      for (var i = 1; i < 3; i++) { var e = check(i); if (e) { wz.err = e; wz.step = i; draw(); return; } }
      var r = G.ops.createProject({ name: wz.name.trim(), key: wz.key || null, templateId: wz.tpl, owner: wz.owner, teams: wz.teams, desc: wz.desc.trim() || null, budget: wz.budget || 1000,
        repos: Object.keys(wz.repos).map(function (n) { return { name: n, team: wz.repos[n] }; }), approvers: approvers(), notifications: routes() });
      if (!r.ok) { wz.err = r.msg; draw(); return; }
      var cx = r.custom || { done: [], failed: [] };
      G.toast(r.msg + " " + Object.keys(wz.repos).length + " repos onboarding.", cx.failed.length ? "warn" : "ok");
      dlg.close();
      G.homeKit.goProject(r.project.id, "project-config");
    }
    draw();
    dlg = G.dialog({ title: "New project", kicker: "Projects · from a template", wide: true, body: holder, actions: [{ label: "Cancel", id: "prj-wz-cancel" }], onClose: function () { if (G.tip) G.tip.hide(); } });
  }

  function render() {
    if (G.homeKit && G.homeKit.openWizard) { G.homeKit.openWizard = false; setTimeout(function () { if (G.me("project.create").allowed) openWizard(); }, 30); }
    var all = G.visibleProjects(G.viewerId());
    if (G.viewer().roles.some(function (g) { return g.scope === "factory"; })) all = G.store.get("projects");
    return h("div", { class: "view prj" },
      G.pageHeader({ id: "prj-head", kicker: "Factory · Projects", title: "Projects", sub: "Each project is a line in the factory: its own repos, flow, approvers, budget and kill switch.",
        meta: [["Projects", String(all.filter(function (p) { return p.status !== "archived"; }).length)], ["Archived", String(all.filter(function (p) { return p.status === "archived"; }).length)], ["Templates", String(G.store.get("templates").length)], ["Killed", String(all.filter(function (p) { return p.killed; }).length)]],
        actions: [G.btn("New project", { kind: "primary", icon: "plus", id: "prj-new", guard: G.me("project.create"), onClick: function () { openWizard(); } })] }),
      G.tabBar({ id: "prj-tab", items: [{ id: "projects", label: "Portfolio", count: all.length }, { id: "templates", label: "Templates", count: G.store.get("templates").length }], active: ui.tab, onChange: function (id) { ui.tab = id; if (G.tip) G.tip.hide(); G.rerender(); } }),
      h("div", { role: "tabpanel", id: "prj-tab-panel", "aria-labelledby": "prj-tab-" + ui.tab }, ui.tab === "templates" ? templatesTab() : projectsTab()));
  }

  G.views["projects"] = {
    title: "Projects",
    render: render,
    keys: ["projects", "templates", "repos", "workOrders", "people", "trust", "teams"]
  };
})(window.G);
