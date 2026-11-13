/* Agents: roster and deep configuration. Layered instructions with an effective preview,
   ordered skills, model chain, autonomy, tools, MCP servers allowed, staffing, budget,
   guardrails, per-project overrides, versions with diff summary, rollback and eval-gated
   promotion, plus the create-agent flow. Every change goes through G.ops. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { sel: null, draft: null, draftFor: null, tab: "config", ctxProject: null, ctxRepo: null, newVer: "", newNote: "" };

  var TOOLS = [
    ["readRepo", "Read repo", "Clone and read files on any branch."],
    ["writeBranch", "Write to a branch", "Push commits to its own gantry/ branch."],
    ["runTests", "Run tests", "Run the repo test command in the sandbox."],
    ["openPR", "Open pull requests", "Open or update PRs from its branch."],
    ["merge", "Merge pull requests", "Merge after G5 passes. High risk."],
    ["postSlack", "Post to Slack", "Post updates to configured channels."],
    ["sendEmail", "Send email", "Send mail through the factory sender."],
    ["readSecrets", "Read CI secrets", "Read masked CI secrets at run time. High risk."]
  ];
  var AUTONOMY = [
    ["suggest", "Suggest", "Proposes output; a human applies it."],
    ["gate", "Act with gate", "Acts, then stops at the next human gate."],
    ["auto", "Act autonomously", "Acts and moves work on without a human."]
  ];
  var TEMPLATES = [
    { id: "builder", name: "Builder", station: "build", tools: { writeBranch: true, runTests: true, openPR: true }, skills: ["sk-testdesign"], budget: 10, autonomy: "gate", instructions: "Implement the approved plan on a branch. Keep diffs small and add tests." },
    { id: "reviewer", name: "Reviewer", station: "review", tools: {}, skills: ["sk-security"], budget: 3, autonomy: "suggest", instructions: "Review the diff against the spec and plan. Recommend; a human decides." },
    { id: "docs", name: "Docs Writer", station: "close", tools: { writeBranch: true, openPR: true }, skills: ["sk-relnotes"], budget: 2, autonomy: "gate", instructions: "Update READMEs, runbooks and changelogs to match the change." },
    { id: "migrations", name: "Migration Specialist", station: "plan", tools: {}, skills: ["sk-migration"], budget: 4, autonomy: "suggest", instructions: "Plan schema and data migrations with explicit rollback and backfill steps." },
    { id: "blank", name: "Blank agent", station: "intake", tools: {}, skills: [], budget: 1, autonomy: "suggest", instructions: "" }
  ];
  var EDIT_KEYS = ["name", "model", "fallbacks", "autonomy", "tools", "skills", "mcp", "stations", "projects", "budget", "guardrails", "instructions", "overrides", "suite"];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pick(a) { var o = {}; EDIT_KEYS.forEach(function (k) { o[k] = clone(a[k] == null ? null : a[k]); }); return o; }
  function same(x, y) { return JSON.stringify(x) === JSON.stringify(y); }
  function enabledModels() {
    var out = [];
    G.store.get("vendors").forEach(function (v) { v.models.forEach(function (m) { if (m.enabled && v.connected) out.push({ id: m.id, name: m.name, vendor: v.name }); }); });
    return out;
  }
  function modelName(id) { var m = G.find.model(id); return m ? m.name : id; }
  function modelUsable(id) { var m = G.find.model(id); var v = m && G.find.vendor(m.vendor); return !!(m && m.enabled && v && v.connected); }
  function stationLabel(id) { var s = G.find.station(id); return s ? s.no + " " + s.name + (s.custom ? " (" + ((G.find.project(s.project) || {}).name || s.project) + ")" : "") : "Off-belt"; }
  /* every station in the catalogue, custom ones labelled with their project */
  function allStations() { return G.STATIONS.slice(); }
  function liveVersion(a) { return a.versions.find(function (v) { return v.live; }) || a.versions[a.versions.length - 1]; }
  function words(t) { return String(t || "").trim() ? String(t).trim().split(/\s+/).length : 0; }
  function nextVersion(a) {
    var p = String(a.version).replace(/-.*/, "").split(".").map(Number);
    var c = p[0] + "." + (p[1] + 1) + ".0-rc";
    var n = 1; while (a.versions.some(function (v) { return v.v === c + n; })) n++;
    return c + n;
  }
  function rowKeys(el, fn) { el.addEventListener("click", fn); el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } }); return el; }

  /* other views (evals, skills, palette) can ask for an agent */
  G.agentsSelect = function (id, tab) { ui.sel = id; ui.draft = null; if (tab) ui.tab = tab; };

  /* ---------- roster ---------- */
  function roster(s) {
    return h("div", { class: "table-scroll", "data-keep-scroll": "agents-roster" }, h("table", { class: "table ag-roster" },
      h("thead", null, h("tr", null, ["Agent", "Status", "Station", "Model chain", "Version", "Eval", "7-day success", "Spend 7d"].map(function (x, i) { return h("th", { scope: "col", class: i >= 5 ? "num" : "" }, x); }))),
      h("tbody", null, s.agents.map(function (a) {
        var suite = G.find.suite(a.suite);
        var below = suite && a.evalScore < suite.threshold;
        var rc = a.versions.filter(function (v) { return v.rc; }).length;
        var tr = h("tr", { class: "row-link" + (ui.sel === a.id ? " is-selected" : ""), tabindex: "0", id: "ag-row-" + a.id, "aria-current": ui.sel === a.id ? "true" : null },
          h("td", null, h("span", { class: "who" }, G.avatar(a.id, "sm"), h("strong", null, a.name))),
          h("td", null, h("span", { class: "dot-status s-" + a.status }, a.status === "paused" ? "Paused" : "Active")),
          h("td", { class: "nowrap" }, h("span", { class: "mono muted" }, a.station ? G.find.station(a.station).no + " " : ""), a.station ? G.find.station(a.station).name : "Off-belt",
            a.stations.length > 1 ? h("span", { class: "muted small" }, " +" + (a.stations.length - 1)) : null),
          h("td", null, h("span", { class: "mono small" }, a.model), a.fallbacks.length ? h("span", { class: "muted small" }, " +" + a.fallbacks.length + " fallback" + (a.fallbacks.length > 1 ? "s" : "")) : null),
          h("td", null, h("span", { class: "mono" }, a.version), rc ? h("span", { class: "chip ag-rc" }, rc + " candidate") : null),
          h("td", { class: "num mono" + (below ? " neg" : "") }, below ? G.icon("alert", "ag-below") : null, G.fmt.pct(a.evalScore)),
          h("td", { class: "num" }, G.spark(a.spark, { min: 0.5, max: 1, label: "7-day success, latest " + G.fmt.pct(a.spark[a.spark.length - 1]) })),
          h("td", { class: "num mono" }, G.fmt.money0(a.spend7d)));
        return rowKeys(tr, function () {
          ui.sel = a.id; ui.draft = null; G.rerender();
          setTimeout(function () { var d = document.getElementById("agent-detail"); if (d && d.getBoundingClientRect().top > window.innerHeight * 0.6) d.scrollIntoView({ block: "start", behavior: G.reducedMotion() ? "auto" : "smooth" }); }, 40);
        });
      }))));
  }

  /* ---------- small editors used inside the detail ---------- */
  function textDialog(o) {
    var ta = h("textarea", { id: "ag-txt-edit", class: "input mono", rows: "8" }); ta.value = o.text || "";
    var note = o.note ? h("input", { id: "ag-txt-note", class: "input", placeholder: "What changed?" }) : null;
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: o.title, kicker: o.kicker, sub: o.sub, wide: true,
      body: h("div", { class: "form-grid" }, G.lockNote(o.guard, o.what), G.field(o.label || "Text", ta), note ? G.field("Change note", note) : null, err),
      actions: [{ label: "Cancel" }, { label: o.ok || "Save", kind: "primary", submit: true, id: "ag-txt-ok", guard: o.guard, onClick: function (close) {
        var r = o.save(ta.value, note ? note.value.trim() : "");
        if (r && !r.ok) { err.textContent = r.msg; return; }
        if (r) G.toast(r.msg, "ok");
        close();
      } }] });
    if (o.guard && !o.guard.allowed) { ta.disabled = true; if (note) note.disabled = true; }
  }

  function effectiveText(a, d, project, repo) {
    var base = G.store.get("instructions");
    var parts = [];
    parts.push("# 1 Factory base (v" + base.baseVersion + ")\n" + base.base);
    if (project) parts.push("# 2 Project overlay: " + project.name + "\n" + (project.overlay || "(none)"));
    var ov = project && d.overrides && d.overrides[project.id];
    var agentPart = "# 3 Agent: " + d.name + " " + a.version + "\n" + (d.instructions || "(none)");
    if (ov) agentPart += "\n\nOn " + project.name + ":" + (ov.model ? " model " + ov.model + "." : "") + (ov.autonomy ? " autonomy " + ov.autonomy + "." : "") + (ov.budget ? " budget $" + ov.budget + " per work order." : "");
    if (d.guardrails && d.guardrails.paths.length) agentPart += "\n\nNever modify: " + d.guardrails.paths.join(", ") + "." + (d.guardrails.maxDiff ? " Keep diffs under " + d.guardrails.maxDiff + " lines." : "");
    parts.push(agentPart);
    if (d.skills.length) parts.push("## Skills, in order\n" + d.skills.map(function (id, i) { var sk = G.find.skill(id); return (i + 1) + ". " + (sk ? sk.name + " v" + sk.version + ": " + sk.when : id); }).join("\n"));
    if (repo) parts.push("# 4 Repo guidelines: " + repo.name + "\n" + (repo.guidelines || "(none)"));
    return parts.join("\n\n");
  }

  function instructionsTab(a, d, ro, perm, markDirty) {
    var s = G.store.get();
    var projects = G.visibleProjects(G.viewerId()).filter(function (p) { return p.status !== "archived"; });
    if (!ui.ctxProject || !G.find.project(ui.ctxProject)) ui.ctxProject = projects[0] ? projects[0].id : null;
    var project = G.find.project(ui.ctxProject);
    var repos = s.repos.filter(function (r) { return project && r.project === project.id; });
    if (ui.ctxRepo && !repos.some(function (r) { return r.id === ui.ctxRepo; })) ui.ctxRepo = null;
    if (!ui.ctxRepo && repos[0]) ui.ctxRepo = repos[0].id;
    var repo = G.find.repo(ui.ctxRepo);
    var base = s.instructions;
    var pre = h("pre", { class: "ag-effective mono", id: "ag-effective", tabindex: "0", "aria-label": "Effective instructions" }, effectiveText(a, d, project, repo));
    var count = h("span", { class: "mono small muted", id: "ag-eff-count" });
    function refresh() { pre.textContent = effectiveText(a, d, project, repo); count.textContent = words(pre.textContent) + " words, about " + G.fmt.k(Math.round(pre.textContent.length / 4)) + " tokens"; }
    refresh();

    var instr = h("textarea", { id: "ag-instr", class: "input", rows: "5", disabled: ro }); instr.value = d.instructions || "";
    instr.addEventListener("input", function () { d.instructions = instr.value; markDirty(); refresh(); });

    function layer(no, title, meta, body, action) {
      return h("li", { class: "ag-layer" }, h("div", { class: "ag-layer-head" }, h("span", { class: "ag-layer-no mono" }, String(no)), h("strong", null, title), h("span", { class: "muted small" }, meta), action ? h("span", { class: "ag-layer-act" }, action) : null), body);
    }
    var baseGuard = G.me("agent.edit");
    var ovGuard = project ? G.me("project.config", { project: project.id }) : { allowed: false, reason: "Pick a project.", needs: "" };
    var repoGuard = repo ? G.me("repo.onboard", { project: repo.project }) : { allowed: false, reason: "Pick a repo.", needs: "" };

    var layers = h("ol", { class: "ag-layers" },
      layer(1, "Factory base", "v" + base.baseVersion + " · applies to every agent", h("p", { class: "ag-layer-text" }, base.base),
        G.btn("Edit base", { small: true, icon: "page", id: "ag-edit-base", guard: baseGuard, onClick: function () {
          textDialog({ title: "Factory base instructions", kicker: "Instructions · layer 1", label: "Base instructions (v" + base.baseVersion + ")", text: base.base, guard: baseGuard, what: "Factory base instructions",
            sub: "Every agent receives these first. Saving creates v" + (base.baseVersion + 1) + ".",
            save: function (v) {
              if (!v.trim()) return { ok: false, msg: "Base instructions cannot be empty." };
              var before = base.base;
              return G.ops.saveInstructions(v);
            } });
        } })),
      layer(2, "Project overlay", project ? project.name + (project.regulated ? " · regulated" : "") : "no project",
        h("div", null, G.field("Preview for project", G.select("ag-ctx-project", projects.map(function (p) { return { value: p.id, label: p.name }; }), ui.ctxProject, function (v) { ui.ctxProject = v; ui.ctxRepo = null; G.rerender(); })),
          h("p", { class: "ag-layer-text" }, project ? project.overlay || "No overlay for this project." : "")),
        project ? G.btn("Edit overlay", { small: true, icon: "page", id: "ag-edit-overlay", guard: ovGuard, onClick: function () {
          textDialog({ title: project.name + " overlay", kicker: "Instructions · layer 2", label: "Overlay text", text: project.overlay, guard: ovGuard, what: "Project overlay",
            sub: "Added after the factory base for every agent working on " + project.name + ".",
            save: function (v) { return G.ops.setProject(project.id, "overlay", v.trim()); } });
        } }) : null),
      layer(3, "Agent", d.name + " · this agent only", G.field("Agent instructions", instr, "Saved with the agent. Unsaved edits show in the preview.")),
      layer(4, "Repo guidelines", repo ? repo.name : "no repo in this project",
        h("div", null, repos.length ? G.field("Preview for repo", G.select("ag-ctx-repo", repos.map(function (r) { return { value: r.id, label: r.name }; }), ui.ctxRepo, function (v) { ui.ctxRepo = v; G.rerender(); })) : null,
          h("pre", { class: "ag-layer-text mono small" }, repo ? repo.guidelines || "No AGENTS.md yet." : "")),
        repo ? G.btn("Edit guidelines", { small: true, icon: "page", id: "ag-edit-guidelines", guard: repoGuard, onClick: function () {
          textDialog({ title: repo.name + " AGENTS.md", kicker: "Instructions · layer 4", label: "Repo guidelines", text: repo.guidelines, guard: repoGuard, what: "Repo guidelines",
            save: function (v) { return G.ops.configureRepo(repo.id, { guidelines: v }); } });
        } }) : null));

    return h("div", { class: "ag-instr-grid" },
      h("section", { class: "cfg-sec" }, h("h3", { class: "cfg-h" }, "Layers, applied in order"), h("p", { class: "muted small" }, "Later layers add to earlier ones. A repo's guidelines never override the factory base."), layers),
      h("section", { class: "cfg-sec ag-eff-sec" }, h("div", { class: "ag-eff-head" }, h("h3", { class: "cfg-h" }, "Effective instructions"), count),
        h("p", { class: "muted small" }, "Exactly what " + d.name + " receives for " + (repo ? repo.name : project ? project.name : "this context") + ", including skills and guardrails."), pre));
  }

  function skillsTab(a, d, ro, perm) {
    var s = G.store.get();
    var list = h("ol", { class: "chain ag-skill-chain" }, d.skills.map(function (id, i) {
      var sk = G.find.skill(id);
      var enabledHere = sk && (sk.projects === "all" || sk.projects.length);
      return h("li", null, h("span", { class: "mono chain-n" }, String(i + 1)),
        h("span", { class: "ag-sk-main" }, h("strong", null, sk ? sk.name : id), h("span", { class: "mono small muted" }, sk ? " v" + sk.version : " missing"), sk ? h("span", { class: "small muted ag-sk-when" }, sk.when) : null),
        sk && !enabledHere ? h("span", { class: "chip chip-warn" }, "not enabled in any project") : null,
        h("span", { class: "chain-tools" },
          G.btn("", { icon: "up", small: true, id: "ag-sk-up-" + id, aria: "Move " + (sk ? sk.name : id) + " up", disabledReason: ro ? perm.reason : i === 0 ? "Already first." : null, onClick: function () { d.skills.splice(i, 1); d.skills.splice(i - 1, 0, id); G.rerender(); } }),
          G.btn("", { icon: "down", small: true, id: "ag-sk-down-" + id, aria: "Move " + (sk ? sk.name : id) + " down", disabledReason: ro ? perm.reason : i === d.skills.length - 1 ? "Already last." : null, onClick: function () { d.skills.splice(i, 1); d.skills.splice(i + 1, 0, id); G.rerender(); } }),
          G.btn("", { icon: "x", small: true, id: "ag-sk-rm-" + id, aria: "Detach " + (sk ? sk.name : id), disabledReason: ro ? perm.reason : null, onClick: function () { d.skills.splice(i, 1); G.rerender(); } })));
    }));
    var addable = s.skills.filter(function (sk) { return d.skills.indexOf(sk.id) < 0; });
    var add = G.select("ag-sk-add", [{ value: "", label: "Attach a skill…" }].concat(addable.map(function (sk) { return { value: sk.id, label: sk.name + " v" + sk.version }; })), "", function (v) { if (v) { d.skills.push(v); G.rerender(); } }, { disabled: ro || !addable.length, "aria-label": "Attach a skill" });

    var mcpRows = s.mcp.map(function (m) {
      var on = d.mcp.indexOf(m.id) >= 0;
      var scoped = m.agents === "all" || (m.agents || []).indexOf(a.id) >= 0;
      var writes = m.tools.filter(function (t) { return t.write && t.allowed; }).length;
      return h("tr", null,
        h("td", null, h("div", null, h("strong", null, m.name)), h("div", { class: "mono small muted" }, m.id)),
        h("td", null, h("span", { class: "health h-" + (m.health === "healthy" ? "healthy" : m.health === "degraded" ? "degraded" : "offline") }, h("span", { class: "health-shape", "aria-hidden": "true" }), m.health)),
        h("td", { class: "small" }, m.sensitivity),
        h("td", { class: "num mono small" }, m.tools.length + (writes ? " (" + writes + " write" + (m.writeGate ? ", gated" : "") + ")" : "")),
        h("td", { class: "small" }, on && !scoped ? h("span", { class: "warn-text" }, G.icon("alert"), " Not scoped to this agent in MCP") : scoped ? "Scoped in MCP" : h("span", { class: "muted" }, "Not scoped")),
        h("td", null, G.toggle("ag-mcp-" + m.id, on, function (v) { if (v) d.mcp.push(m.id); else d.mcp = d.mcp.filter(function (x) { return x !== m.id; }); G.rerender(); }, perm, "Allow " + m.name)));
    });

    return h("div", { class: "cfg" },
      h("section", { class: "cfg-sec" }, h("h3", { class: "cfg-h" }, "Skills, in order"), h("p", { class: "muted small" }, "Earlier skills win when two give conflicting advice. Edit skill text in Skills."),
        d.skills.length ? list : h("p", { class: "muted small" }, "No skills attached."), add,
        h("a", { href: "#skills", class: "linkish small", id: "ag-goto-skills" }, "Open the skills library")),
      h("section", { class: "cfg-sec" }, h("h3", { class: "cfg-h" }, "MCP servers allowed"), h("p", { class: "muted small" }, "The agent may call a server only when it is allowed here and the server is scoped to it in MCP. Write tools still need a gate."),
        h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
          h("thead", null, h("tr", null, ["Server", "Health", "Data", "Tools", "MCP scope", "Allowed"].map(function (x, i) { return h("th", { scope: "col", class: i === 3 ? "num" : "" }, x); }))),
          h("tbody", null, mcpRows)))));
  }

  function overridesTab(a, d, ro, perm) {
    var s = G.store.get();
    var models = enabledModels();
    var rows = s.projects.filter(function (p) { return p.status !== "archived"; }).map(function (p) {
      var ov = d.overrides[p.id] || {};
      var staffs = d.projects === "all" || d.projects.indexOf(p.id) >= 0;
      function set(k, v) { var o = d.overrides[p.id] || {}; if (v === "" || v == null) delete o[k]; else o[k] = v; if (Object.keys(o).length) d.overrides[p.id] = o; else delete d.overrides[p.id]; G.rerender(); }
      var modelSel = G.select("ag-ov-model-" + p.id, [{ value: "", label: "Inherit (" + d.model + ")" }].concat(models.map(function (m) { return { value: m.id, label: m.name }; })), ov.model || "", function (v) { set("model", v); }, { disabled: ro || !staffs, "aria-label": "Model on " + p.name });
      var autSel = G.select("ag-ov-aut-" + p.id, [{ value: "", label: "Inherit (" + d.autonomy + ")" }].concat(AUTONOMY.map(function (o) {
        var chk = G.agentAutonomyCheck(Object.assign({}, a, d), o[0], p.id);
        return { value: o[0], label: o[1] + (chk.allowed ? "" : " (blocked by POL-112)"), disabled: !chk.allowed };
      })), ov.autonomy || "", function (v) { set("autonomy", v); }, { disabled: ro || !staffs, "aria-label": "Autonomy on " + p.name });
      var bud = h("input", { id: "ag-ov-budget-" + p.id, class: "input mono", type: "number", min: "0", step: "0.5", value: ov.budget != null ? String(ov.budget) : "", placeholder: "$" + d.budget, disabled: ro || !staffs, "aria-label": "Budget per work order on " + p.name });
      bud.addEventListener("change", function () { set("budget", bud.value === "" ? "" : +bud.value); });
      var effAut = ov.autonomy || d.autonomy;
      var chkEff = G.agentAutonomyCheck(Object.assign({}, a, d), effAut, p.id);
      return h("tr", { class: staffs ? "" : "ag-ov-off" },
        h("td", null, h("strong", null, p.name), p.regulated ? h("span", { class: "tag" }, "regulated") : null, staffs ? null : h("div", { class: "small muted" }, "Not staffed by this agent")),
        h("td", null, modelSel), h("td", null, autSel), h("td", null, bud),
        h("td", { class: "small" }, staffs ? h("span", null, h("span", { class: "mono" }, ov.model || d.model), " · " + effAut + " · $" + (ov.budget != null ? ov.budget : d.budget), chkEff.allowed ? null : h("div", { class: "neg" }, G.icon("lock"), " " + chkEff.reason)) : "–"));
    });
    return h("div", { class: "cfg" }, h("section", { class: "cfg-sec ag-wide" }, h("h3", { class: "cfg-h" }, "Per-project overrides"),
      h("p", { class: "muted small" }, "Change the model, autonomy or budget on one project without a new agent. Overrides are part of the agent and save with it. Routing rules in Models still apply on top: a regulated repo is never sent to a vendor its rule forbids."),
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact ag-ov" },
        h("thead", null, h("tr", null, ["Project", "Model", "Autonomy", "Budget / WO", "Effective"].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, rows)))));
  }

  function configTab(a, d, ro, perm, markDirty) {
    var s = G.store.get();
    var models = enabledModels();
    function sec(title, body, hint, cls) { return h("section", { class: "cfg-sec" + (cls ? " " + cls : "") }, h("h3", { class: "cfg-h" }, title), hint ? h("p", { class: "muted small" }, hint) : null, body); }

    var name = h("input", { id: "ag-name", class: "input", value: d.name, disabled: ro });
    name.addEventListener("input", function () { d.name = name.value; markDirty(); });

    var primary = G.select("ag-model", models.map(function (m) { return { value: m.id, label: m.name + " · " + m.vendor }; }).concat(models.some(function (m) { return m.id === d.model; }) ? [] : [{ value: d.model, label: modelName(d.model) + " (not available)" }]), d.model,
      function (v) { d.model = v; d.fallbacks = d.fallbacks.filter(function (x) { return x !== v; }); G.rerender(); }, { disabled: ro });
    var chain = h("ol", { class: "chain" }, d.fallbacks.map(function (f, i) {
      var en = modelUsable(f);
      return h("li", null, h("span", { class: "mono chain-n" }, String(i + 1)), h("span", { class: "mono" }, f), en ? null : h("span", { class: "chip chip-warn" }, G.icon("alert"), "vendor or model off, skipped"),
        h("span", { class: "chain-tools" },
          G.btn("", { icon: "up", small: true, id: "ag-fb-up-" + i, aria: "Move " + f + " up", disabledReason: ro ? perm.reason : i === 0 ? "Already first." : null, onClick: function () { d.fallbacks.splice(i, 1); d.fallbacks.splice(i - 1, 0, f); G.rerender(); } }),
          G.btn("", { icon: "down", small: true, id: "ag-fb-down-" + i, aria: "Move " + f + " down", disabledReason: ro ? perm.reason : i === d.fallbacks.length - 1 ? "Already last." : null, onClick: function () { d.fallbacks.splice(i, 1); d.fallbacks.splice(i + 1, 0, f); G.rerender(); } }),
          G.btn("", { icon: "x", small: true, id: "ag-fb-rm-" + i, aria: "Remove " + f, disabledReason: ro ? perm.reason : null, onClick: function () { d.fallbacks.splice(i, 1); G.rerender(); } })));
    }));
    var addable = models.filter(function (m) { return m.id !== d.model && d.fallbacks.indexOf(m.id) < 0; });
    var addSel = G.select("ag-fb-add", [{ value: "", label: "Add fallback model…" }].concat(addable.map(function (m) { return { value: m.id, label: m.name + " · " + m.vendor }; })), "", function (v) { if (v) { d.fallbacks.push(v); G.rerender(); } }, { disabled: ro || !addable.length, "aria-label": "Add fallback model" });

    var autonomy = h("div", { class: "radio-cards", role: "radiogroup", "aria-label": "Autonomy level" }, AUTONOMY.map(function (o) {
      var chk = G.agentAutonomyCheck(Object.assign({}, a, d), o[0]);
      var dis = ro || !chk.allowed;
      var input = h("input", { type: "radio", name: "ag-autonomy", id: "ag-aut-" + o[0], value: o[0], checked: d.autonomy === o[0], disabled: dis });
      input.addEventListener("change", function () { d.autonomy = o[0]; G.rerender(); });
      return h("label", { class: "radio-card" + (d.autonomy === o[0] ? " is-on" : "") + (dis ? " is-locked" : ""), for: "ag-aut-" + o[0], "data-reason": !chk.allowed ? chk.reason : ro ? perm.reason : null },
        input, h("span", { class: "rc-t" }, o[1]), h("span", { class: "rc-d muted small" }, o[2]), !chk.allowed ? h("span", { class: "rc-why small neg" }, G.icon("lock"), " Blocked by " + chk.rule) : null);
    }));

    var toolGrid = h("div", { class: "toggle-grid" }, TOOLS.map(function (t) {
      return h("div", { class: "toggle-row" }, h("label", { for: "ag-tool-" + t[0] }, h("span", null, t[1]), h("span", { class: "muted small ag-tool-d" }, t[2])), G.toggle("ag-tool-" + t[0], !!d.tools[t[0]], function (v) { d.tools[t[0]] = v; markDirty(); }, perm));
    }));

    var stationsBox = h("div", { class: "check-grid" }, allStations().map(function (st) {
      var cb = h("input", { type: "checkbox", id: "ag-st-" + st.id, checked: d.stations.indexOf(st.id) >= 0, disabled: ro });
      cb.addEventListener("change", function () { if (cb.checked) d.stations.push(st.id); else d.stations = d.stations.filter(function (x) { return x !== st.id; }); markDirty(); });
      return h("label", { class: "check", for: "ag-st-" + st.id }, cb, h("span", { class: "mono muted" }, st.no), st.name, st.custom ? h("span", { class: "tag" }, (G.find.project(st.project) || {}).name || st.project) : null);
    }));
    var allProj = d.projects === "all";
    var allCb = h("input", { type: "checkbox", id: "ag-proj-all", checked: allProj, disabled: ro });
    allCb.addEventListener("change", function () { d.projects = allCb.checked ? "all" : s.projects.map(function (p) { return p.id; }); G.rerender(); });
    var projBox = h("div", null, h("label", { class: "check", for: "ag-proj-all" }, allCb, "All projects, including new ones"),
      allProj ? null : h("div", { class: "check-grid" }, s.projects.filter(function (p) { return p.status !== "archived"; }).map(function (p) {
        var cb = h("input", { type: "checkbox", id: "ag-proj-" + p.id, checked: d.projects.indexOf(p.id) >= 0, disabled: ro });
        cb.addEventListener("change", function () { if (cb.checked) d.projects.push(p.id); else d.projects = d.projects.filter(function (x) { return x !== p.id; }); G.rerender(); });
        return h("label", { class: "check", for: "ag-proj-" + p.id }, cb, p.name, p.regulated ? h("span", { class: "tag" }, "regulated") : null);
      })));

    var budget = h("input", { id: "ag-budget", class: "input mono", type: "number", min: "0", step: "0.1", value: String(d.budget), disabled: ro });
    budget.addEventListener("input", function () { d.budget = +budget.value || 0; markDirty(); });
    var maxDiff = h("input", { id: "ag-maxdiff", class: "input mono", type: "number", min: "0", step: "50", value: String(d.guardrails.maxDiff), disabled: ro });
    maxDiff.addEventListener("input", function () { d.guardrails.maxDiff = +maxDiff.value || 0; markDirty(); });
    var paths = h("textarea", { id: "ag-paths", class: "input mono", rows: "3", disabled: ro, placeholder: "infra/prod/**" }); paths.value = d.guardrails.paths.join("\n");
    paths.addEventListener("input", function () { d.guardrails.paths = paths.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean); markDirty(); });
    var suiteSel = G.select("ag-suite", s.suites.map(function (x) { return { value: x.id, label: x.id + " · " + x.name + " (≥ " + G.fmt.pct(x.threshold) + ")" }; }), d.suite, function (v) { d.suite = v; G.rerender(); }, { disabled: ro });

    return h("div", { class: "cfg" },
      sec("Identity", h("div", { class: "form-grid" }, G.field("Name", name),
        h("dl", { class: "kv-row ag-ident" }, h("div", { class: "kv" }, h("dt", { class: "kv-k" }, "Id"), h("dd", { class: "kv-v mono" }, a.id)), h("div", { class: "kv" }, h("dt", { class: "kv-k" }, "Home station"), h("dd", { class: "kv-v" }, stationLabel(a.station))),
          h("div", { class: "kv" }, h("dt", { class: "kv-k" }, "Live version"), h("dd", { class: "kv-v mono" }, a.version))))),
      sec("Model chain", h("div", { class: "form-grid" }, G.field("Primary model", primary, "Only enabled models on connected vendors are listed."),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Fallbacks, tried in order"), d.fallbacks.length ? chain : h("p", { class: "muted small" }, "No fallbacks. If the primary fails, the work order blocks."), addSel))),
      sec("Autonomy", autonomy, "POL-112 limits agents from Plan onward on regulated projects to act with gate."),
      sec("Tool permissions", toolGrid),
      sec("Staffing", h("div", { class: "form-grid" }, h("div", { class: "field" }, h("div", { class: "field-label" }, "Stations it may staff"), stationsBox), h("div", { class: "field" }, h("div", { class: "field-label" }, "Projects it may work on"), projBox))),
      sec("Budget and guardrails", h("div", { class: "form-grid" }, h("div", { class: "form-row" }, G.field("Budget per work order (USD)", budget), G.field("Max diff size (lines)", maxDiff, "0 means no limit.")), G.field("Paths it must not touch", paths, "One glob per line."))),
      sec("Promotion gate", G.field("Required eval suite", suiteSel, "A version reaches the floor only when its latest run of this suite meets the threshold."), null, "ag-wide"));
  }

  function versionsTab(a, dirty, perm) {
    var suite = G.find.suite(a.suite);
    var live = liveVersion(a);
    if (!ui.newVer || a.versions.some(function (v) { return v.v === ui.newVer; })) ui.newVer = nextVersion(a);
    var verIn = h("input", { id: "ag-newver", class: "input mono", value: ui.newVer, disabled: !perm.allowed });
    verIn.addEventListener("input", function () { ui.newVer = verIn.value; });
    var noteIn = h("input", { id: "ag-newnote", class: "input", value: ui.newNote, placeholder: "What changed, in one line", disabled: !perm.allowed });
    noteIn.addEventListener("input", function () { ui.newNote = noteIn.value; });
    var createGuard = !perm.allowed ? perm : dirty ? { allowed: false, needs: "", reason: "Save or discard your changes first. A version snapshots the saved configuration." } : null;
    var form = h("div", { class: "ag-newver" }, G.field("New version", verIn), G.field("Note", noteIn),
      G.btn("Create candidate", { icon: "plus", id: "ag-newver-go", guard: createGuard, onClick: function () {
        var r = G.ops.newAgentVersion(a.id, ui.newVer.trim(), ui.newNote.trim());
        G.toast(r.msg, r.ok ? "ok" : "error"); if (r.ok) { ui.newNote = ""; ui.newVer = ""; }
      } }));

    var list = h("ol", { class: "ag-vers" }, a.versions.slice().reverse().map(function (ver) {
      var el = G.agentEligibility(a, ver);
      var runs = G.store.get("evalRuns").filter(function (r) { return r.agent === a.id && r.version === ver.v; });
      var snap = ver.snapshot ? JSON.parse(ver.snapshot) : null;
      var deltas = [];
      if (snap) Object.keys(snap).forEach(function (k) { if (!same(snap[k], a[k])) deltas.push(k); });
      var state = ver.live ? "live" : ver.rc ? "candidate" : "retired";
      var vid = ver.v.replace(/\W/g, "");
      var promoteGuard = !perm.allowed ? perm : !el.ok ? { allowed: false, needs: "Needs a passing run of " + (suite ? suite.id : "its suite"), reason: el.text + "." } : null;
      return h("li", { class: "ag-ver is-" + state },
        h("div", { class: "ag-ver-rail", "aria-hidden": "true" }, h("span", { class: "ag-ver-dot" })),
        h("div", { class: "ag-ver-body" },
          h("div", { class: "ag-ver-top" }, h("span", { class: "mono strong ag-ver-v" }, ver.v),
            h("span", { class: "chip ag-ver-state ag-st-" + state }, state === "live" ? "On the floor" : state === "candidate" ? "Candidate" : "Retired"),
            h("span", { class: "muted small" }, G.fmt.istDate(ver.at)), h("span", { class: "small" }, ver.note)),
          h("div", { class: "mono small ag-diff" }, h("span", { class: "muted" }, "Diff: "), ver.diff || "no summary",
            deltas.length ? h("span", { class: "muted" }, " · differs from current in " + deltas.join(", ")) : null),
          h("div", { class: "elig " + (el.ok ? "pos" : "neg") }, G.icon(el.ok ? "check" : "lock"), h("span", null, el.text), runs.length ? h("span", { class: "muted small" }, " · " + runs.length + " run" + (runs.length > 1 ? "s" : "")) : null),
          h("div", { class: "ag-ver-actions" },
            !ver.rc ? null : G.btn("Promote " + ver.v, { small: true, kind: el.ok ? "primary" : null, icon: "rocket", id: "ag-promote-" + vid, guard: promoteGuard, onClick: function () {
              var r = G.ops.promoteAgent(a.id, ver.v); G.toast(r.msg, r.ok ? "ok" : "error");
            } }),
            ver.live || ver.rc ? null : G.btn("Roll back to " + ver.v, { small: true, icon: "undo", id: "ag-rollback-" + vid, guard: perm, onClick: function () { rollbackDialog(a, ver, live); } }),
            G.btn("Run suite", { small: true, kind: "ghost", icon: "eval", id: "ag-runsuite-" + vid, onClick: function () { if (G.evalsFocus) G.evalsFocus({ agent: a.id, suite: a.suite, version: ver.v }); location.hash = "evals"; } }))));
    }));
    return h("div", { class: "cfg" },
      h("section", { class: "cfg-sec ag-wide" }, h("h3", { class: "cfg-h" }, "Versions"),
        h("p", { class: "muted small" }, "Promotion needs the latest run of " + (suite ? suite.id + " (" + suite.name + ") at " + G.fmt.pct(suite.threshold) + " or better" : "its suite") + ". Rollback skips the gate: the old version already passed."),
        form, list));
  }

  function rollbackDialog(a, ver, live) {
    var perm = G.me("agent.edit");
    var snap = ver.snapshot ? JSON.parse(ver.snapshot) : null;
    G.dialog({ title: "Roll back " + a.name + " to " + ver.v, kicker: "Agent · rollback",
      sub: "The floor switches from " + live.v + " to " + ver.v + " immediately. Work already at a station finishes on the version it started with.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Rollback"),
        h("dl", { class: "titleblock" }, h("div", null, h("dt", null, "From"), h("dd", { class: "mono" }, live.v)), h("div", null, h("dt", null, "To"), h("dd", { class: "mono" }, ver.v)), h("div", null, h("dt", null, "Suite score"), h("dd", { class: "mono" }, G.fmt.pct(ver.suiteScore || 0)))),
        snap ? h("p", { class: "small" }, "Restores the saved configuration: " + Object.keys(snap).join(", ") + ".") : h("p", { class: "small muted" }, "This version has no saved configuration snapshot, so only the live version number changes.")),
      actions: [{ label: "Cancel" }, { label: "Roll back", kind: "danger", icon: "undo", id: "ag-rollback-ok", guard: perm, onClick: function (close) {
        var r = G.ops.rollbackAgent(a.id, ver.v); G.toast(r.msg, r.ok ? "ok" : "error"); if (r.ok) { ui.draft = null; close(); }
      } }] });
  }

  /* ---------- trust by class ---------- */
  function trustTab(a) {
    var tr = G.store.get("trust");
    var gate = G.GATES.find(function (g) { return g.id !== "G0G1" && G.trustAgentFor(g.id) === a.id; });
    var vis = G.visibleProjects(G.viewerId()).filter(function (p) { return p.status !== "archived"; });
    if (!gate) return h("div", { class: "cfg" }, h("section", { class: "cfg-sec ag-wide" }, h("h3", { class: "cfg-h" }, "Trust by class"),
      G.emptyState({ id: "ag-trust-none", icon: "trust", title: "Not judged at a gate", text: a.name + " does not staff the station before a human gate, so it has no trust level. Its work is checked by the agents and people after it." })));
    var cells = tr.cells.filter(function (c) { return c.agent === a.id && vis.some(function (p) { return p.id === c.project; }); });
    var pend = tr.proposals.filter(function (x) { return x.status === "pending" && cells.some(function (c) { return c.id === x.cell; }); });
    var since = Date.now() - 14 * G.DAY;
    var dem = []; cells.forEach(function (c) { c.history.forEach(function (e) { if (e.kind === "demote" && e.at >= since) dem.push({ c: c, e: e }); }); });
    var by = [0, 0, 0, 0, 0]; cells.forEach(function (c) { by[c.level]++; });
    function open(c) { if (G.trustFocus) G.trustFocus({ cell: c.id }); location.hash = "trust"; }
    var rows = vis.filter(function (p) { return cells.some(function (c) { return c.project === p.id && !c.repo; }); }).map(function (p) {
      return h("tr", null, h("th", { scope: "row" }, p.name, p.regulated ? h("span", { class: "tag" }, "regulated") : null),
        h("td", null, h("span", { class: "ag-trust-cells" }, G.flowOf(p).classes.map(function (k) {
          var c = cells.find(function (x) { return x.project === p.id && x.cls === k.id && !x.repo; });
          if (!c) return null;
          var ceil = G.trust.cellCeiling(c), eff = Math.min(c.level, ceil.max);
          var pp = pend.find(function (x) { return x.cell === c.id; });
          return h("button", { type: "button", class: "ag-trust-cell lvl-" + eff, id: "ag-trust-" + p.id + "-" + k.id, title: G.trustCellLabel(c) + ": L" + c.level + " " + G.trust.level(c.level).name + (eff < c.level ? ", runs at L" + eff : "") + (pp ? ", promotion to L" + pp.to + " proposed" : ""), onclick: function () { open(c); } },
            h("span", { class: "ag-trust-k" }, k.name), h("span", { class: "mono strong" }, "L" + c.level), eff < c.level ? h("span", { class: "mono small warn-text" }, "→L" + eff) : null, pp ? h("span", { class: "mono small ag-trust-up" }, "▲L" + pp.to) : null);
        }))));
    });
    return h("div", { class: "cfg" }, h("section", { class: "cfg-sec ag-wide" }, h("h3", { class: "cfg-h" }, "Trust by class"),
      h("p", { class: "muted small" }, a.name + " is judged at " + gate.label + " " + gate.name + ". Levels are earned per class and project; select one to see its evidence in Trust."),
      h("dl", { class: "kv-row ag-ident" }, [0, 1, 2, 3, 4].map(function (L) { return h("div", { class: "kv" }, h("dt", { class: "kv-k" }, "L" + L + " " + G.trust.level(L).name), h("dd", { class: "kv-v mono" }, String(by[L]))); }),
        h("div", { class: "kv" }, h("dt", { class: "kv-k" }, "Pending proposals"), h("dd", { class: "kv-v mono" }, String(pend.length))), h("div", { class: "kv" }, h("dt", { class: "kv-k" }, "Demotions 14d"), h("dd", { class: "kv-v mono" + (dem.length ? " neg" : "") }, String(dem.length)))),
      rows.length ? h("div", { class: "table-scroll" }, h("table", { class: "table table-compact ag-trust" }, h("thead", null, h("tr", null, h("th", { scope: "col" }, "Project"), h("th", { scope: "col" }, "Level by class"))), h("tbody", null, rows)))
        : G.emptyState({ id: "ag-trust-empty", icon: "trust", title: "No trust cells yet", text: "Cells appear once this agent has worked on a project you can see." }),
      dem.length ? h("div", null, h("h3", { class: "sub-h" }, "Recent demotions"), h("ul", { class: "plain-list small" }, dem.map(function (x, i) { return h("li", null, h("span", { class: "mono" }, G.fmt.istDate(x.e.at) + " "), h("button", { type: "button", class: "linkish", id: "ag-trust-dem-" + i, onclick: function () { open(x.c); } }, G.trustCellLabel(x.c)), " L" + x.e.from + " ▼ L" + x.e.to + ": " + x.e.reason); }))) : null));
  }

  /* ---------- detail ---------- */
  function detail(s) {
    var a = G.find.agent(ui.sel) || s.agents[0];
    ui.sel = a.id;
    var saved = pick(a);
    if (!ui.draft || ui.draftFor !== a.id) { ui.draft = clone(saved); ui.draftFor = a.id; }
    var d = ui.draft;
    var perm = G.me("agent.edit");
    var ro = !perm.allowed;
    var dirty = !same(d, saved);
    var autoChk = G.agentAutonomyCheck(Object.assign({}, a, d), d.autonomy);

    function markDirty() { var bar = document.getElementById("ag-savebar"); if (bar) { bar.classList.toggle("is-dirty", !same(d, pick(a))); } }
    function save() {
      if (!d.name.trim()) { G.toast("The agent needs a name.", "error"); return; }
      if (!d.stations.length) { G.toast("Pick at least one station the agent may staff.", "error"); return; }
      var patch = {}, changed = [];
      EDIT_KEYS.forEach(function (k) { if (!same(d[k], a[k])) { patch[k] = clone(d[k]); changed.push(k); } });
      if (!changed.length) return;
      if (patch.name) patch.name = patch.name.trim();
      var r = G.ops.saveAgent(a.id, patch, changed.join(", "));
      G.toast(r.msg, r.ok ? "ok" : "error");
      if (r.ok) ui.draft = null;
    }
    var saveGuard = !perm.allowed ? perm : !autoChk.allowed ? { allowed: false, needs: "", reason: autoChk.reason } : !dirty ? { allowed: false, needs: "", reason: "No changes to save." } : null;

    var statusBtn = G.btn(a.status === "paused" ? "Resume agent" : "Pause agent", { small: true, icon: a.status === "paused" ? "play" : "pause", id: "ag-pause", guard: perm,
      onClick: function () { var r = G.ops.saveAgent(a.id, { status: a.status === "paused" ? "active" : "paused" }, a.status === "paused" ? "resumed" : "paused"); G.toast(r.ok ? a.name + (a.status === "paused" ? " is paused. Its stations queue work until it resumes." : " is active.") : r.msg, r.ok ? "ok" : "error"); } });
    var running = G.store.get("workOrders").filter(function (w) { var e = w.history[w.history.length - 1]; return e && e.agent === a.id && ["done", "killed"].indexOf(w.state) < 0; }).length;
    var suite = G.find.suite(a.suite);
    var tabs = [{ id: "config", label: "Configuration" }, { id: "instructions", label: "Instructions" }, { id: "skills", label: "Skills and MCP", count: d.skills.length },
      { id: "overrides", label: "Per-project", count: Object.keys(d.overrides || {}).length }, { id: "versions", label: "Versions", count: a.versions.length }, { id: "trust", label: "Trust" }, { id: "history", label: "History" }];
    var body = ui.tab === "instructions" ? instructionsTab(a, d, ro, perm, markDirty)
      : ui.tab === "skills" ? skillsTab(a, d, ro, perm)
      : ui.tab === "overrides" ? overridesTab(a, d, ro, perm)
      : ui.tab === "versions" ? versionsTab(a, dirty, perm)
      : ui.tab === "trust" ? trustTab(a)
      : ui.tab === "history" ? h("div", { class: "ag-hist" }, G.historyList({ type: "agent", id: a.id, limit: 40 }))
      : configTab(a, d, ro, perm, markDirty);
    var showSave = ["config", "instructions", "skills", "overrides"].indexOf(ui.tab) >= 0;

    return h("section", { class: "agent-detail panel", id: "agent-detail", "aria-label": a.name + " configuration" },
      h("div", { class: "ad-head" },
        G.avatar(a.id, "lg"),
        h("div", { class: "ad-main" }, h("div", { class: "kicker" }, "Agent · " + stationLabel(a.station)), h("h2", { class: "ad-title" }, a.name),
          h("div", { class: "ad-meta mono" }, a.version + " · " + a.model + " · " + running + " work order" + (running === 1 ? "" : "s") + " now · " + (suite ? suite.id + " " + G.fmt.pct(a.evalScore) : ""))),
        h("div", { class: "ad-tools" }, h("span", { class: "dot-status s-" + a.status }, a.status === "paused" ? "Paused" : "Active"), statusBtn)),
      G.lockNote(perm, "Agent configuration"),
      G.tabBar({ id: "ag-tab", items: tabs, active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      body,
      showSave ? h("div", { class: "savebar" + (dirty ? " is-dirty" : ""), id: "ag-savebar" },
        h("span", { class: "muted small savebar-text" }, "Edits stay in a draft while you switch tabs or screens. Saving writes one audited change."),
        G.btn("Discard", { id: "ag-discard", guard: !perm.allowed ? perm : null, onClick: function () { ui.draft = null; G.rerender(); } }),
        G.btn("Save agent", { kind: "primary", id: "ag-save", guard: saveGuard, onClick: save })) : null);
  }

  /* ---------- create agent ---------- */
  function createAgentDialog() {
    var perm = G.me("agent.edit");
    var s = G.store.get();
    var step = 0, err = h("div", { class: "form-err", role: "alert" });
    var d = { tpl: "builder", name: "", station: "build", model: s.routing.defaultModel, fallbacks: [], autonomy: "gate", tools: {}, stations: [], projects: "all", budget: 5, instructions: "", skills: [] };
    function applyTpl() {
      var t = TEMPLATES.find(function (x) { return x.id === d.tpl; });
      d.name = t.id === "blank" ? "" : t.name + " " + (s.agents.filter(function (a) { return a.name.indexOf(t.name) === 0; }).length + 1);
      d.station = t.station; d.stations = [t.station]; d.autonomy = t.autonomy; d.skills = t.skills.slice();
      d.tools = { readRepo: true, writeBranch: !!t.tools.writeBranch, runTests: !!t.tools.runTests, openPR: !!t.tools.openPR, merge: false, postSlack: true, sendEmail: false, readSecrets: false };
      d.budget = t.budget; d.instructions = t.instructions;
      d.model = s.routing.overrides[t.station] || s.routing.defaultModel;
    }
    applyTpl();
    var STEPS = ["Template", "Model", "Permissions", "Staffing", "Review"];
    var box = h("div", { class: "ag-create" });
    var dlg;
    function check() { return G.agentAutonomyCheck({ station: d.station, projects: d.projects }, d.autonomy); }
    function draw() {
      G.clear(box); err.textContent = "";
      G.append(box, G.lockNote(perm, "Creating agents"));
      box.appendChild(h("ol", { class: "stepper" }, STEPS.map(function (n, i) { return h("li", { class: i === step ? "is-on" : i < step ? "is-done" : "" }, h("span", { class: "mono" }, String(i + 1)), n); })));
      var models = enabledModels();
      if (step === 0) {
        box.appendChild(h("div", { class: "radio-cards", role: "radiogroup", "aria-label": "Template" }, TEMPLATES.map(function (t) {
          var r = h("input", { type: "radio", name: "ca-tpl", id: "ca-tpl-" + t.id, checked: d.tpl === t.id });
          r.addEventListener("change", function () { d.tpl = t.id; applyTpl(); draw(); });
          return h("label", { class: "radio-card" + (d.tpl === t.id ? " is-on" : ""), for: "ca-tpl-" + t.id }, r, h("span", { class: "rc-t" }, t.name), h("span", { class: "rc-d muted small" }, stationLabel(t.station) + ". " + (t.instructions || "Start from nothing.")));
        })));
        var nm = h("input", { id: "ca-name", class: "input", value: d.name, placeholder: "Agent name" });
        nm.addEventListener("input", function () { d.name = nm.value; });
        var st = G.select("ca-station", allStations().map(function (x) { return { value: x.id, label: stationLabel(x.id) }; }), d.station, function (v) { d.station = v; if (d.stations.indexOf(v) < 0) d.stations.unshift(v); });
        var ins = h("textarea", { id: "ca-instr", class: "input", rows: "3" }); ins.value = d.instructions;
        ins.addEventListener("input", function () { d.instructions = ins.value; });
        box.appendChild(h("div", { class: "form-row" }, G.field("Name", nm), G.field("Home station", st)));
        box.appendChild(G.field("Agent instructions", ins, "Layer 3. The factory base and project overlays are added automatically."));
      } else if (step === 1) {
        box.appendChild(G.field("Primary model", G.select("ca-model", models.map(function (m) { return { value: m.id, label: m.name + " · " + m.vendor }; }), d.model, function (v) { d.model = v; d.fallbacks = d.fallbacks.filter(function (x) { return x !== v; }); draw(); }), "Routing suggests " + (s.routing.overrides[d.station] || s.routing.defaultModel) + " for " + stationLabel(d.station) + "."));
        box.appendChild(h("div", { class: "field" }, h("div", { class: "field-label" }, "Fallbacks, tick in order of preference"), h("div", { class: "check-grid" }, models.filter(function (m) { return m.id !== d.model; }).map(function (m) {
          var cb = h("input", { type: "checkbox", id: "ca-fb-" + m.id, checked: d.fallbacks.indexOf(m.id) >= 0 });
          cb.addEventListener("change", function () { if (cb.checked) d.fallbacks.push(m.id); else d.fallbacks = d.fallbacks.filter(function (x) { return x !== m.id; }); draw(); });
          var pos = d.fallbacks.indexOf(m.id);
          return h("label", { class: "check", for: "ca-fb-" + m.id }, cb, m.name, pos >= 0 ? h("span", { class: "mono chip" }, "#" + (pos + 1)) : null);
        }))));
      } else if (step === 2) {
        box.appendChild(h("div", { class: "radio-cards", role: "radiogroup", "aria-label": "Autonomy" }, AUTONOMY.map(function (o) {
          var chk = G.agentAutonomyCheck({ station: d.station, projects: d.projects }, o[0]);
          var r = h("input", { type: "radio", name: "ca-aut", id: "ca-aut-" + o[0], checked: d.autonomy === o[0], disabled: !chk.allowed });
          r.addEventListener("change", function () { d.autonomy = o[0]; draw(); });
          return h("label", { class: "radio-card" + (d.autonomy === o[0] ? " is-on" : "") + (chk.allowed ? "" : " is-locked"), for: "ca-aut-" + o[0], "data-reason": chk.allowed ? null : chk.reason }, r, h("span", { class: "rc-t" }, o[1]), h("span", { class: "rc-d muted small" }, o[2]), chk.allowed ? null : h("span", { class: "rc-why small neg" }, G.icon("lock"), " Blocked by POL-112"));
        })));
        box.appendChild(h("div", { class: "toggle-grid ag-create-tools" }, TOOLS.map(function (t) {
          return h("div", { class: "toggle-row" }, h("label", { for: "ca-tool-" + t[0] }, t[1]), G.toggle("ca-tool-" + t[0], !!d.tools[t[0]], function (v) { d.tools[t[0]] = v; }));
        })));
        var b = h("input", { id: "ca-budget", class: "input mono", type: "number", min: "0", step: "0.5", value: String(d.budget) });
        b.addEventListener("input", function () { d.budget = +b.value || 0; });
        box.appendChild(G.field("Budget per work order (USD)", b));
      } else if (step === 3) {
        box.appendChild(h("div", { class: "field" }, h("div", { class: "field-label" }, "Stations it may staff"), h("div", { class: "check-grid" }, allStations().map(function (st) {
          var cb = h("input", { type: "checkbox", id: "ca-st-" + st.id, checked: d.stations.indexOf(st.id) >= 0 });
          cb.addEventListener("change", function () { if (cb.checked) d.stations.push(st.id); else d.stations = d.stations.filter(function (x) { return x !== st.id; }); });
          return h("label", { class: "check", for: "ca-st-" + st.id }, cb, h("span", { class: "mono muted" }, st.no), st.name, st.custom ? h("span", { class: "tag" }, (G.find.project(st.project) || {}).name || st.project) : null);
        }))));
        box.appendChild(G.field("Projects", G.select("ca-projects", [{ value: "all", label: "All projects" }].concat(s.projects.filter(function (p) { return p.status !== "archived"; }).map(function (p) { return { value: p.id, label: "Only " + p.name + (p.regulated ? " (regulated)" : "") }; })), d.projects === "all" ? "all" : d.projects[0], function (v) { d.projects = v === "all" ? "all" : [v]; draw(); })));
        box.appendChild(h("div", { class: "field" }, h("div", { class: "field-label" }, "Skills"), h("div", { class: "check-grid" }, s.skills.map(function (sk) {
          var cb = h("input", { type: "checkbox", id: "ca-sk-" + sk.id, checked: d.skills.indexOf(sk.id) >= 0 });
          cb.addEventListener("change", function () { if (cb.checked) d.skills.push(sk.id); else d.skills = d.skills.filter(function (x) { return x !== sk.id; }); });
          return h("label", { class: "check", for: "ca-sk-" + sk.id }, cb, sk.name);
        }))));
        var chk = check();
        if (!chk.allowed) box.appendChild(h("div", { class: "callout callout-block" }, G.icon("lock"), h("span", null, chk.reason)));
      } else {
        var chk2 = check();
        box.appendChild(h("dl", { class: "titleblock ag-review" },
          [["Name", d.name || "(none)"], ["Station", stationLabel(d.station)], ["Model", d.model], ["Fallbacks", d.fallbacks.join(", ") || "none"], ["Autonomy", d.autonomy], ["Budget / WO", "$" + d.budget],
            ["Stations", d.stations.map(stationLabel).join(", ") || "none"], ["Projects", d.projects === "all" ? "All" : d.projects.map(function (p) { return G.find.project(p).name; }).join(", ")],
            ["Tools", TOOLS.filter(function (t) { return d.tools[t[0]]; }).map(function (t) { return t[1]; }).join(", ")], ["Skills", d.skills.map(function (x) { return G.find.skill(x).name; }).join(", ") || "none"]]
            .map(function (r) { return h("div", null, h("dt", null, r[0]), h("dd", null, r[1])); })));
        box.appendChild(h("p", { class: "callout" }, G.icon("lock"), h("span", null, "The agent starts paused at 0.1.0 with its own eval suite. It staffs the floor only after a version passes that suite and someone promotes it.")));
        if (!chk2.allowed) box.appendChild(h("div", { class: "callout callout-block" }, G.icon("lock"), h("span", null, chk2.reason)));
      }
      box.appendChild(err);
      if (dlg) {
        var back = dlg.footer.querySelector("#ca-back"), next = dlg.footer.querySelector("#ca-next span");
        if (back) { if (step === 0) { back.setAttribute("aria-disabled", "true"); back.setAttribute("data-reason", "This is the first step."); back.classList.add("is-locked"); } else { back.removeAttribute("aria-disabled"); back.removeAttribute("data-reason"); back.classList.remove("is-locked"); } }
        if (next) next.textContent = step === STEPS.length - 1 ? "Create agent" : "Next";
      }
    }
    draw();
    dlg = G.dialog({ title: "Create agent", kicker: "Agents · new", wide: true, body: box,
      actions: [{ label: "Cancel", id: "ca-cancel" }, { label: "Back", id: "ca-back", onClick: function () { if (step > 0) { step--; draw(); } } },
        { label: "Next", kind: "primary", submit: true, id: "ca-next", guard: perm, onClick: function (close) {
          if (step === 0 && !d.name.trim()) { err.textContent = "Give the agent a name."; return; }
          if (step === 3 && !d.stations.length) { err.textContent = "Pick at least one station."; return; }
          if (step < STEPS.length - 1) { step++; draw(); return; }
          var chk = check(); if (!chk.allowed) { err.textContent = chk.reason; return; }
          if (d.stations.indexOf(d.station) < 0) d.stations.unshift(d.station);
          var r = G.ops.createAgent({ name: d.name.trim(), station: d.station, model: d.model, fallbacks: d.fallbacks, autonomy: d.autonomy, tools: d.tools, stations: d.stations, projects: d.projects, budget: d.budget, instructions: d.instructions, skills: d.skills });
          if (!r.ok) { err.textContent = r.msg; return; }
          ui.sel = r.agent.id; ui.draft = null; ui.tab = "config";
          G.toast(r.msg, "ok"); close();
        } }] });
    draw();
  }

  function render() {
    var s = G.store.get();
    if (s.prefs.agent && G.find.agent(s.prefs.agent)) {
      var want = s.prefs.agent;
      if (ui.sel !== want) { ui.sel = want; ui.draft = null; }
      setTimeout(function () { G.store.update("prefs", function (p) { p.agent = null; }); }, 0);
    }
    if (!ui.sel || !G.find.agent(ui.sel)) ui.sel = s.agents[0].id;
    var perm = G.me("agent.edit");
    var active = s.agents.filter(function (a) { return a.status === "active"; }).length;
    var cands = s.agents.reduce(function (n, a) { return n + a.versions.filter(function (v) { return v.rc; }).length; }, 0);
    var below = s.agents.filter(function (a) { var su = G.find.suite(a.suite); return su && a.evalScore < su.threshold; }).length;
    return h("div", { class: "view view-agents" },
      G.pageHeader({ id: "ag-head", kicker: "Agents · Sheet 13", title: "Agents", sub: "Who staffs each station, on which model, with which instructions, skills and permissions.",
        meta: [["Agents", String(s.agents.length)], ["Active", active + " / " + s.agents.length], ["Candidates", String(cands)], ["Below threshold", String(below)], ["Spend 7d", G.fmt.money0(s.agents.reduce(function (t, a) { return t + a.spend7d; }, 0))]],
        actions: [G.btn("Create agent", { kind: "primary", icon: "plus", id: "agent-create", guard: perm, onClick: createAgentDialog })] }),
      G.panel("Roster", roster(s), { flush: true, tools: h("span", { class: "muted small" }, "Select a row to configure") }),
      detail(s));
  }

  G.views.agents = { title: "Agents", render: render, keys: ["agents", "skills", "vendors", "suites", "evalRuns", "mcp", "projects", "repos", "instructions", "routing", "trust"] };
})(window.G);
