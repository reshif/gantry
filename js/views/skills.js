/* Skills: the library agents draw on. Name, description, when to use, body, resources,
   version history, owner, used-by agents, eval coverage. Create, edit (each save is a new
   version), attach to agents and enable per project. Every change goes through G.ops. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { sel: null, tab: "def", draft: null, draftFor: null, note: "", q: "", filter: "all" };

  /* other views (learning, agents) open a skill: G.skillsSelect(id, tab?) */
  G.skillsSelect = function (id, tab) { ui.sel = id; ui.draft = null; if (tab) ui.tab = tab; };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function usedBy(id) { return G.store.get("agents").filter(function (a) { return a.skills.indexOf(id) >= 0; }); }
  function covPct(sk) { return sk.coverage.cases ? sk.coverage.pass / sk.coverage.cases : 0; }
  function coverSuites(sk) {
    var agents = usedBy(sk.id);
    return G.store.get("suites").filter(function (su) { return agents.some(function (a) { return a.suite === su.id; }); });
  }
  function rowKeys(el, fn) { el.addEventListener("click", fn); el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } }); return el; }

  function covCell(sk) {
    var p = covPct(sk);
    var cls = !sk.coverage.cases ? "sk-cov-none" : p >= 0.9 ? "sk-cov-good" : p >= 0.8 ? "sk-cov-ok" : "sk-cov-low";
    return h("span", { class: "sk-cov " + cls, "data-tip": sk.coverage.cases ? sk.coverage.pass + " of " + sk.coverage.cases + " cases pass" : "No eval cases exercise this skill" },
      h("span", { class: "sk-cov-bar", "aria-hidden": "true" }, h("span", { style: "width:" + (p * 100).toFixed(0) + "%" })),
      h("span", { class: "mono small" }, sk.coverage.cases ? sk.coverage.pass + "/" + sk.coverage.cases : "none"));
  }

  function library(s) {
    var q = ui.q.trim().toLowerCase();
    var list = s.skills.filter(function (sk) {
      if (q && (sk.name + " " + sk.desc + " " + sk.when).toLowerCase().indexOf(q) < 0) return false;
      if (ui.filter === "unused" && usedBy(sk.id).length) return false;
      if (ui.filter === "lowcov" && covPct(sk) >= 0.85 && sk.coverage.cases) return false;
      return true;
    });
    var search = h("input", { id: "sk-search", class: "input", type: "search", placeholder: "Filter by name or purpose", value: ui.q, "aria-label": "Filter skills" });
    search.addEventListener("input", function () { ui.q = search.value; G.rerender(); });
    var bar = h("div", { class: "toolbar sk-toolbar" }, search,
      G.segmented("sk-filter", [{ id: "all", label: "All" }, { id: "unused", label: "Unused" }, { id: "lowcov", label: "Low coverage" }], ui.filter, function (v) { ui.filter = v; G.rerender(); }, "Show"));
    var table = h("div", { class: "table-scroll", "data-keep-scroll": "sk-lib" }, h("table", { class: "table sk-table" },
      h("thead", null, h("tr", null, ["Skill", "Version", "Used by", "Eval coverage"].map(function (x, i) { return h("th", { scope: "col", class: i === 2 ? "num" : "" }, x); }))),
      h("tbody", null, list.length ? list.map(function (sk) {
        var n = usedBy(sk.id).length;
        var tr = h("tr", { class: "row-link" + (ui.sel === sk.id ? " is-selected" : ""), tabindex: "0", id: "sk-row-" + sk.id, "aria-current": ui.sel === sk.id ? "true" : null },
          h("td", null, h("div", null, h("strong", null, sk.name)), h("div", { class: "small muted sk-desc" }, sk.desc),
            h("div", { class: "small sk-meta" }, G.actorName(sk.owner) + " · ", sk.projects === "all" ? "all projects" : sk.projects.length ? sk.projects.length + " project" + (sk.projects.length > 1 ? "s" : "") : h("span", { class: "warn-text" }, "no projects"))),
          h("td", { class: "mono" }, "v" + sk.version),
          h("td", { class: "num mono" + (n ? "" : " muted") }, String(n)),
          h("td", null, covCell(sk)));
        return rowKeys(tr, function () { ui.sel = sk.id; ui.draft = null; G.rerender(); });
      }) : h("tr", null, h("td", { colspan: "4" }, G.emptyState({ id: "sk-empty", icon: "skill", title: "No skills match", text: "Clear the filter to see the whole library." }))))));
    return h("div", null, bar, table);
  }

  function defTab(sk, perm) {
    var ro = !perm.allowed;
    if (!ui.draft || ui.draftFor !== sk.id) { ui.draft = { name: sk.name, desc: sk.desc, when: sk.when, body: sk.body, resources: sk.resources.join("\n") }; ui.draftFor = sk.id; ui.note = ""; }
    var d = ui.draft;
    var saved = { name: sk.name, desc: sk.desc, when: sk.when, body: sk.body, resources: sk.resources.join("\n") };
    var dirty = JSON.stringify(d) !== JSON.stringify(saved);
    function inp(id, key, rows, ph) {
      var el = rows ? h("textarea", { id: id, class: "input" + (key === "body" || key === "resources" ? " mono" : ""), rows: String(rows), disabled: ro, placeholder: ph || "" }) : h("input", { id: id, class: "input", disabled: ro, value: d[key], placeholder: ph || "" });
      if (rows) el.value = d[key];
      el.addEventListener("input", function () { d[key] = el.value; var bar = document.getElementById("sk-savebar"); if (bar) bar.classList.toggle("is-dirty", JSON.stringify(d) !== JSON.stringify(saved)); });
      return el;
    }
    var note = h("input", { id: "sk-note", class: "input", value: ui.note, disabled: ro, placeholder: "What changed, in one line" });
    note.addEventListener("input", function () { ui.note = note.value; });
    var next = sk.version.split(".").map(Number); next[1]++; next[2] = 0;
    return h("div", { class: "sk-def" },
      h("div", { class: "form-grid" },
        G.field("Name", inp("sk-name", "name")),
        G.field("Description", inp("sk-desc", "desc", 2), "One sentence. Shown to agents when they choose a skill."),
        G.field("When to use", inp("sk-when", "when", 2)),
        G.field("Body", inp("sk-body", "body", 7), "The instructions the agent loads when the skill applies."),
        G.field("Resources", inp("sk-res", "resources", 3, "checklist.md"), "One file name per line. Files ship with the skill."),
        G.field("Change note", note, "Saving creates v" + next.join(".") + ". Agents pick up the new version on their next work order.")),
      h("div", { class: "savebar" + (dirty ? " is-dirty" : ""), id: "sk-savebar" },
        h("span", { class: "muted small savebar-text" }, "Every save is a new version with your note."),
        G.btn("Discard", { id: "sk-discard", guard: ro ? perm : null, onClick: function () { ui.draft = null; G.rerender(); } }),
        G.btn("Save as v" + next.join("."), { kind: "primary", id: "sk-save", guard: ro ? perm : null, onClick: function () {
          var cur = ui.draft;
          if (JSON.stringify(cur) === JSON.stringify(saved)) { G.toast("Nothing changed.", "info"); return; }
          if (!cur.name.trim()) { G.toast("Name the skill.", "error"); return; }
          var patch = {};
          ["name", "desc", "when", "body"].forEach(function (k) { if (cur[k] !== sk[k]) patch[k] = k === "name" ? cur[k].trim() : cur[k]; });
          var res = cur.resources.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
          if (JSON.stringify(res) !== JSON.stringify(sk.resources)) patch.resources = res;
          var r = G.ops.saveSkill(sk.id, patch, ui.note.trim() || "Edited " + Object.keys(patch).join(", "));
          G.toast(r.msg, r.ok ? "ok" : "error");
          if (r.ok) ui.draft = null;
        } })));
  }

  function agentsTab(sk) {
    var perm = G.me("agent.edit");
    var agents = G.store.get("agents");
    return h("div", null, G.lockNote(perm, "Attaching skills to agents"),
      h("p", { class: "muted small sk-p" }, "Attaching adds the skill at the end of the agent's skill order. Reorder in Agents. Each change is saved on the agent and audited."),
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
        h("thead", null, h("tr", null, ["Agent", "Station", "Position", "Suite", "Attached"].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, agents.map(function (a) {
          var pos = a.skills.indexOf(sk.id);
          return h("tr", null,
            h("td", null, h("a", { href: "#agents", class: "linkish", id: "sk-ag-link-" + a.id, onClick: function () { if (G.agentsSelect) G.agentsSelect(a.id, "skills"); } }, a.name)),
            h("td", { class: "small" }, a.station ? G.find.station(a.station).no + " " + G.find.station(a.station).name : "Off-belt"),
            h("td", { class: "mono small" }, pos >= 0 ? (pos + 1) + " of " + a.skills.length : "–"),
            h("td", { class: "mono small" }, a.suite),
            h("td", null, G.toggle("sk-att-" + a.id, pos >= 0, function (v) { var r = G.ops.attachSkill(a.id, sk.id, v); G.toast(r.ok ? (v ? "Attached " : "Detached ") + sk.name + (v ? " to " : " from ") + a.name + "." : r.msg, r.ok ? "ok" : "error"); }, perm, "Attach " + sk.name + " to " + a.name)));
        })))));
  }

  function projectsTab(sk) {
    var perm = G.me("skill.edit");
    var projects = G.store.get("projects").filter(function (p) { return p.status !== "archived"; });
    var all = sk.projects === "all";
    function setProjects(v, what) {
      var r = G.ops.setSkillProjects(sk.id, v);
      G.toast(r.msg, r.ok ? "ok" : "error");
    }
    return h("div", null, G.lockNote(perm, "Where this skill is enabled"),
      h("p", { class: "muted small sk-p" }, "An attached skill is loaded only on projects where it is enabled. Changing this does not create a new version."),
      h("div", { class: "toggle-row sk-all" }, h("label", { for: "sk-proj-all" }, h("strong", null, "All projects"), h("span", { class: "muted small" }, " including projects created later")),
        G.toggle("sk-proj-all", all, function (v) { setProjects(v ? "all" : projects.map(function (p) { return p.id; }), v ? "enabled on all projects" : "enabled per project"); }, perm)),
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
        h("thead", null, h("tr", null, ["Project", "Agents using it there", "Enabled"].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, projects.map(function (p) {
          var on = all || sk.projects.indexOf(p.id) >= 0;
          var users = usedBy(sk.id).filter(function (a) { return a.projects === "all" || a.projects.indexOf(p.id) >= 0; });
          var lock = !perm.allowed ? perm : all ? { allowed: false, needs: "", reason: "Enabled on all projects. Turn off All projects to choose." } : null;
          return h("tr", null, h("td", null, p.name, p.regulated ? h("span", { class: "tag" }, "regulated") : null),
            h("td", { class: "small" }, users.length ? users.map(function (a) { return a.name; }).join(", ") : h("span", { class: "muted" }, "none")),
            h("td", null, G.toggle("sk-proj-" + p.id, on, function (v) {
              var list = sk.projects === "all" ? [] : sk.projects.slice();
              if (v) list.push(p.id); else list = list.filter(function (x) { return x !== p.id; });
              setProjects(list, (v ? "enabled on " : "disabled on ") + p.name);
            }, lock, "Enable on " + p.name)));
        })))));
  }

  function versionsTab(sk) {
    var hist = sk.versions.slice().reverse();
    return h("div", null,
      h("ol", { class: "sk-vers" }, hist.map(function (v, i) {
        return h("li", { class: i === 0 ? "is-current" : "" }, h("span", { class: "mono strong" }, "v" + v.v), i === 0 ? G.chip("current", "chip-accent") : null,
          h("span", { class: "muted small" }, G.fmt.stamp(v.at)), G.who(v.by), h("span", { class: "small" }, v.note));
      })),
      learningFor(sk),
      h("h3", { class: "sub-h" }, "Audit history"), G.historyList({ type: "skill", id: sk.id, limit: 30 }));
  }

  /* learning proposals that edit this skill */
  function learningFor(sk) {
    var L = G.store.get("learning"); if (!L) return null;
    var list = L.proposals.filter(function (lp) { return lp.kind === "skill" && lp.change && lp.change.skill === sk.id; });
    if (!list.length) return null;
    return h("div", null, h("h3", { class: "sub-h" }, "From the learning loop"), h("ul", { class: "plain-list small" }, list.map(function (lp) {
      return h("li", null, h("a", { href: "#learning", class: "linkish", id: "sk-lp-" + lp.id, onclick: function () { if (G.learningFocus) G.learningFocus({ proposal: lp.id }); } }, lp.id + " " + lp.title), " · " + lp.status);
    })));
  }

  function detail(s) {
    var sk = G.find.skill(ui.sel) || s.skills[0];
    if (!sk) return G.emptyState({ icon: "skill", title: "No skills yet", text: "Create the first skill." });
    ui.sel = sk.id;
    var perm = G.me("skill.edit");
    var agents = usedBy(sk.id);
    var suites = coverSuites(sk);
    var tabs = [{ id: "def", label: "Definition" }, { id: "agents", label: "Agents", count: agents.length }, { id: "projects", label: "Projects" }, { id: "versions", label: "Versions", count: sk.versions.length }];
    var body = ui.tab === "agents" ? agentsTab(sk) : ui.tab === "projects" ? projectsTab(sk) : ui.tab === "versions" ? versionsTab(sk) : defTab(sk, perm);
    return h("section", { class: "panel sk-detail", id: "sk-detail", "aria-label": sk.name },
      h("div", { class: "sk-head" },
        h("div", { class: "sk-head-main" }, h("div", { class: "kicker" }, "Skill · " + sk.id), h("h2", { class: "sk-title" }, sk.name), h("p", { class: "small" }, sk.desc)),
        h("dl", { class: "titleblock sk-tb" },
          h("div", null, h("dt", null, "Version"), h("dd", { class: "mono" }, "v" + sk.version)),
          h("div", null, h("dt", null, "Owner"), h("dd", null, G.actorName(sk.owner))),
          h("div", null, h("dt", null, "Used by"), h("dd", null, agents.length + " agent" + (agents.length === 1 ? "" : "s"))),
          h("div", null, h("dt", null, "Coverage"), h("dd", null, covCell(sk))),
          h("div", null, h("dt", null, "Suites"), h("dd", { class: "mono small" }, suites.map(function (x) { return x.id; }).join(", ") || "none")))),
      G.lockNote(perm, "Skill text"),
      G.tabBar({ id: "sk-tab", items: tabs, active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      h("div", { class: "sk-body" }, body));
  }

  function newSkillDialog() {
    var perm = G.me("skill.edit");
    var f = { name: h("input", { id: "sk-new-name", class: "input", placeholder: "e.g. API contract review" }), desc: h("input", { id: "sk-new-desc", class: "input" }), when: h("input", { id: "sk-new-when", class: "input", placeholder: "e.g. At Design when an endpoint changes" }),
      body: h("textarea", { id: "sk-new-body", class: "input mono", rows: "5" }), res: h("textarea", { id: "sk-new-res", class: "input mono", rows: "2", placeholder: "one file per line" }) };
    var attach = G.select("sk-new-attach", [{ value: "", label: "Do not attach yet" }].concat(G.store.get("agents").map(function (a) { return { value: a.id, label: "Attach to " + a.name }; })), "", null);
    var attachGuard = G.me("agent.edit");
    if (!attachGuard.allowed) attach.disabled = true;
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: "New skill", kicker: "Build · skills", wide: true, sub: "Skills start at v1.0.0, enabled on all projects. Add eval cases in the agent's suite to cover them.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Creating skills"), G.field("Name", f.name), G.field("Description", f.desc), G.field("When to use", f.when), G.field("Body", f.body), G.field("Resources", f.res),
        G.field("Attach", attach, attachGuard.allowed ? null : "Attaching needs Configure agents: " + attachGuard.reason), err),
      actions: [{ label: "Cancel" }, { label: "Create skill", kind: "primary", submit: true, id: "sk-new-ok", guard: perm, onClick: function (close) {
        if (!f.name.value.trim()) { err.textContent = "Name the skill."; return; }
        var r = G.ops.saveSkill(null, { name: f.name.value, desc: f.desc.value.trim(), when: f.when.value.trim(), body: f.body.value, resources: f.res.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean) });
        if (!r.ok) { err.textContent = r.msg; return; }
        if (attach.value) { var r2 = G.ops.attachSkill(attach.value, r.skill.id, true); if (!r2.ok) G.toast(r2.msg, "error"); }
        ui.sel = r.skill.id; ui.tab = "def"; ui.draft = null;
        G.toast(r.msg, "ok"); close();
      } }] });
  }

  function render() {
    var s = G.store.get();
    if (!ui.sel || !G.find.skill(ui.sel)) ui.sel = s.skills[0] && s.skills[0].id;
    var perm = G.me("skill.edit");
    var unused = s.skills.filter(function (sk) { return !usedBy(sk.id).length; }).length;
    var cases = s.skills.reduce(function (t, sk) { return t + sk.coverage.cases; }, 0), pass = s.skills.reduce(function (t, sk) { return t + sk.coverage.pass; }, 0);
    return h("div", { class: "view view-skills" },
      G.pageHeader({ id: "sk-head", kicker: "Agents · Sheet 14", title: "Skills", sub: "Reusable know-how that agents load when a task calls for it. Versioned, owned and covered by evals.",
        meta: [["Skills", String(s.skills.length)], ["Unused", String(unused)], ["Eval cases", String(cases)], ["Pass rate", cases ? G.fmt.pct(pass / cases) : "–"]],
        actions: [G.btn("New skill", { kind: "primary", icon: "plus", id: "sk-new", guard: perm, onClick: newSkillDialog })] }),
      h("div", { class: "sk-grid" }, G.panel("Library", library(s), { flush: true, cls: "sk-lib" }), detail(s)));
  }

  G.views.skills = { title: "Skills", render: render, keys: ["skills", "agents", "suites", "projects", "learning"] };
})(window.G);
