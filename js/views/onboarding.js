/* Onboarding (#onboarding): repo readiness pipeline for the current project, onboarding PR drawer,
   connect-repo wizard, per-repo settings, and the Onboarding agent tab with versioned guidelines. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "pipeline", filter: "all", dtab: {}, gl: null, glNote: "" };

  var LANG_TEST = { Go: "go test ./...", TypeScript: "npm test", Python: "pytest -q", Kotlin: "./gradlew test", Java: "mvn -q test", Rust: "cargo test", Terraform: "terraform validate", MDX: "npm run build" };

  /* ---------- catalogue lookups: integrations, events, card templates ---------- */
  function typeOf(inst) { return (inst && G.find.integrationType(inst.type)) || {}; }
  function isSource(inst) { var t = typeOf(inst); return t.category === "source" || (!!t.custom && !!t.source && t.category === "source"); }
  function sourcesFor(project) { return G.sourceInstances(project.id); }
  function destsFor(project) { return G.integrationsFor(project.id).filter(function (i) { return !!typeOf(i).destination; }); }
  function instLabel(i) { return i.name + (i.status !== "healthy" ? " (" + i.status + ")" : ""); }
  function defaultSource(project) { return G.sourceIntegrationFor(project.id); }
  function repoSource(r) { return G.sourceIntegrationFor(r); }
  function sourceName(r) { var i = repoSource(r); return i ? i.name : "source control"; }
  function eventList() { return G.NOTIFY_EVENTS.map(function (e) { return { value: e.id, label: e.name }; }); }
  function templateList(cur) {
    var out = Object.keys(G.CARD_TEMPLATES || {}).map(function (k) { return { value: k, label: G.CARD_TEMPLATES[k].name }; })
      .concat((G.store.get("cardTemplates") || []).map(function (t) { return { value: t.id, label: t.name + " (custom)" }; }));
    if (cur && !out.some(function (o) { return o.value === cur; })) out.push({ value: cur, label: cur + " (older template)" });
    return out;
  }
  function defaultTemplate(ev) { return (G.CARD_DEFAULTS && G.CARD_DEFAULTS[ev]) || "submitted"; }
  function orgOf(inst) { var c = (inst && inst.config) || {}; return c.org || c.group || c.workspace || "acme"; }

  function stageIds() { return G.ONBOARD_STAGES.map(function (s) { return s.id; }); }
  function stageName(id) { var s = G.ONBOARD_STAGES.find(function (x) { return x.id === id; }); return s ? s.name : id === "person" ? "Needs a person" : id === "failed" ? "Failed" : id; }
  /* index of the stage reached; for person/failed, the stage where it stopped */
  function stageIndex(r) {
    var o = r.onboarding, i = stageIds().indexOf(o.stage);
    if (i >= 0) return i;
    if (o.pr && o.pr.state === "merged") return 4;
    if (o.pr) return o.pr.checks === "pending" ? 2 : 3;
    if (o.findings.length) return 1;
    return 0;
  }
  function isStopped(r) { return r.onboarding.stage === "person" || r.onboarding.stage === "failed"; }
  function needsMerge(r) { var o = r.onboarding; return o.pr && o.pr.state === "open" && o.pr.checks === "green" && o.stage === "pr_checks"; }
  function status(r) {
    var o = r.onboarding;
    if (o.stage === "ready") return o.exception ? { id: "exception", label: "Ready by exception", glyph: "shield" } : { id: "ready", label: "Ready", glyph: "st-done" };
    if (o.stage === "person") return { id: "person", label: "Needs a person", glyph: "human" };
    if (o.stage === "failed") return { id: "failed", label: "Failed", glyph: "st-fail" };
    if (needsMerge(r)) return { id: "merge", label: "Waiting for merge", glyph: "st-wait" };
    return { id: "progress", label: "In progress", glyph: "st-run" };
  }
  function statusChip(r) { var s = status(r); return h("span", { class: "onb-status onb-st-" + s.id }, G.icon(s.glyph), h("span", null, s.label)); }
  function gaps(r) { return r.onboarding.findings.filter(function (f) { return !f.ok; }); }
  function teamName(id) { var t = G.find.team(id); return t ? t.name : id; }

  /* ---------- stepper cells ---------- */
  function steps(r, big) {
    var idx = stageIndex(r), stop = isStopped(r), ready = r.onboarding.stage === "ready";
    return h("ol", { class: "onb-steps" + (big ? " is-big" : ""), "aria-label": "Onboarding stage: " + stageName(r.onboarding.stage) + " (" + (idx + 1) + " of 7)" },
      G.ONBOARD_STAGES.map(function (s, i) {
        var cls = i < idx || (ready && i === idx) ? "is-done" : i === idx ? (stop ? "is-stop" : "is-now") : "";
        return h("li", { class: cls, title: s.name + (cls === "is-done" ? ": done" : cls === "is-now" ? ": current" : cls === "is-stop" ? ": stopped here" : "") },
          h("span", { class: "onb-step-mark mono", "aria-hidden": "true" }, cls === "is-done" ? "✓" : cls === "is-stop" ? "!" : String(i + 1)),
          big ? h("span", { class: "onb-step-l" }, s.name) : null);
      }));
  }

  /* ---------- view ---------- */
  function render() {
    var project = G.currentProject();
    if (!project) return h("div", { class: "view" }, G.emptyState({ title: "No project", text: "You do not have a project to show." }));
    var repos = G.store.get("repos").filter(function (r) { return r.project === project.id; });
    var ready = repos.filter(function (r) { return r.onboarding.stage === "ready"; }).length;
    var attention = repos.filter(function (r) { return isStopped(r) || needsMerge(r); }).length;
    var connectD = G.me("repo.onboard", { project: project.id });
    var stop = G.stopState(project.id);
    return h("div", { class: "view onb-view" },
      G.pageHeader({ id: "onb-head", kicker: "Project · " + project.name, title: "Onboarding",
        sub: "A repo must reach Ready before anyone can submit work orders to it. The Onboarding agent assesses each repo and opens a PR with the changes it needs.",
        meta: [["Repos", String(repos.length)], ["Ready", ready + " / " + repos.length], ["In progress", String(repos.length - ready)], ["Needs action", String(attention)]],
        actions: [G.btn("Connect repo", { kind: "primary", icon: "plus", id: "onb-connect", guard: connectD, disabledReason: !connectD.allowed ? null : stop ? stop.reason : null, onClick: function () { connectWizard(project); } })] }),
      G.tabBar({ id: "onb-tab", items: [{ id: "pipeline", label: "Pipeline", count: repos.length }, { id: "agent", label: "Onboarding agent and guidelines" }], active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      ui.tab === "pipeline" ? pipeline(project, repos) : agentTab());
  }

  function pipeline(project, repos) {
    var ids = stageIds();
    var counts = ids.map(function (id) { return repos.filter(function (r) { return r.onboarding.stage === id; }).length; });
    var stopped = repos.filter(isStopped).length;
    var strip = h("ol", { class: "onb-strip", "aria-label": "Repos per onboarding stage" },
      G.ONBOARD_STAGES.map(function (s, i) {
        return h("li", { class: counts[i] ? "has-n" : "" }, h("span", { class: "onb-strip-no mono" }, "STAGE " + (i + 1)), h("span", { class: "onb-strip-n" }, String(counts[i])), h("span", { class: "onb-strip-l" }, s.name));
      }),
      h("li", { class: "onb-strip-off" + (stopped ? " has-n" : "") }, h("span", { class: "onb-strip-no mono" }, "OFF BELT"), h("span", { class: "onb-strip-n" }, String(stopped)), h("span", { class: "onb-strip-l" }, "Stopped")));

    var list = repos.filter(function (r) {
      var s = status(r).id;
      return ui.filter === "all" || (ui.filter === "attention" ? (s === "person" || s === "failed" || s === "merge") : ui.filter === "ready" ? (s === "ready" || s === "exception") : s === "progress" || s === "merge");
    });
    var filt = G.segmented("onb-filter", [{ id: "all", label: "All" }, { id: "attention", label: "Needs action" }, { id: "progress", label: "In progress" }, { id: "ready", label: "Ready" }], ui.filter, function (v) { ui.filter = v; G.rerender(); }, "Filter repos");

    var rows = list.map(function (r) {
      var o = r.onboarding;
      var tr = h("tr", { class: "row-link", tabindex: "0", id: "onb-row-" + r.id, "aria-label": "Open onboarding detail for " + r.name },
        h("td", null, h("div", { class: "onb-repo" }, h("span", { class: "mono strong" }, r.name), h("span", { class: "muted small" }, r.lang + " · " + teamName(r.team) + " · " + sourceName(r) + (r.tags.length ? " · " + r.tags.join(", ") : "")))),
        h("td", null, steps(r)),
        h("td", null, h("div", { class: "onb-stage-cell" }, h("span", { class: "strong" }, stageName(o.stage)), statusChip(r))),
        h("td", null, o.pr ? h("span", { class: "mono" }, "#" + o.pr.number, h("span", { class: "muted" }, " · " + (o.pr.state === "merged" ? "merged" : "checks " + o.pr.checks))) : h("span", { class: "muted" }, "none yet")),
        h("td", { class: "num mono" }, String(gaps(r).length)),
        h("td", { class: "mono small" }, o.stage === "ready" ? (o.readyAt ? "ready " + G.fmt.ago(o.readyAt) : "ready") : "started " + G.fmt.ago(o.startedAt || (o.timeline[0] || {}).at || Date.now())));
      function open() { openRepo(r.id); }
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      return tr;
    });
    var waiting = repos.filter(needsMerge);
    return h("div", { class: "onb-pipe" },
      strip,
      waiting.length ? h("div", { class: "callout callout-warn" }, G.icon("st-wait"), h("div", null, h("strong", null, waiting.length + " onboarding PR" + (waiting.length > 1 ? "s are" : " is") + " green and waiting for a person to approve and merge: "), waiting.map(function (r, i) {
        return [i ? ", " : "", h("button", { type: "button", class: "linkish mono", id: "onb-wait-" + r.id, onClick: function () { openRepo(r.id, "pr"); } }, r.name + "#" + r.onboarding.pr.number)];
      }))) : null,
      h("div", { class: "toolbar" }, filt, h("span", { class: "muted small" }, list.length + " of " + repos.length + " repos")),
      list.length ? h("div", { class: "table-scroll", "data-keep-scroll": "onb-table" }, h("table", { class: "table onb-table" },
        h("thead", null, h("tr", null, ["Repo", "Pipeline", "Stage", "Onboarding PR", "Gaps", "Time"].map(function (c, i) { return h("th", { scope: "col", class: i === 4 ? "num" : "" }, c); }))),
        h("tbody", null, rows)))
        : G.emptyState({ id: "onb-empty", icon: "branch", title: repos.length ? "No repos match" : "No repos yet", text: repos.length ? "Pick another filter." : "Connect a repo from one of this project's source-control integrations to start onboarding.", action: repos.length ? G.btn("Show all", { id: "onb-filter-clear", onClick: function () { ui.filter = "all"; G.rerender(); } }) : null }),
      h("p", { class: "footnote" }, "Source control, CI and the Onboarding agent are simulated. Repos advance on simulation ticks; a person must approve and merge each onboarding PR."));
  }

  /* ---------- repo drawer ---------- */
  function openRepo(repoId, tab) {
    if (tab) ui.dtab[repoId] = tab;
    G.drawer.open("onb:" + repoId, function (close) { return drawer(repoId, close); });
  }
  G.openOnboardingRepo = openRepo;

  function drawer(repoId, close) {
    var r = G.find.repo(repoId); if (!r) return null;
    var o = r.onboarding, pid = r.project;
    var tab = ui.dtab[repoId] || (o.pr && o.stage !== "ready" ? "pr" : "findings");
    var manage = G.me("onboarding.manage", { project: pid });
    var merge = G.me("onboarding.merge", { project: pid });
    var exc = G.me("onboarding.exception", { project: pid });
    var stop = G.stopState(pid, r.id);
    function run(fn) { var res = fn(); G.toast(res.msg, res.ok ? "ok" : "error"); }
    var prOpen = o.pr && o.pr.state === "open";
    var acts = [
      G.btn("Re-run assessment", { icon: "refresh", small: true, id: "onb-act-rerun", guard: manage, disabledReason: manage.allowed && o.stage === "ready" ? "Already ready; re-assessing would restart onboarding" : null,
        onClick: function () { run(function () { return G.ops.rerunAssessment(r.id); }); } }),
      !o.pr ? G.btn("Open onboarding PR", { icon: "branch", small: true, id: "onb-act-openpr", guard: manage,
        disabledReason: manage.allowed && o.stage !== "assessed" ? (o.stage === "connected" ? "Assessment has not finished yet" : "Resolve the blocker first, then re-run the assessment") : null,
        onClick: function () { run(function () { return G.ops.openOnboardingPR(r.id, G.viewerId()); }); } }) : null,
      o.pr ? G.btn("Simulate checks pass", { icon: "check", small: true, id: "onb-act-checks", guard: manage,
        disabledReason: manage.allowed ? (!prOpen ? "The PR is already merged" : o.pr.checks === "green" ? "Checks are already green" : null) : null,
        onClick: function () { run(function () { return G.ops.simulateChecksPass(r.id); }); } }) : null,
      o.pr ? G.btn("Approve and merge", { kind: "primary", icon: "check", small: true, id: "onb-act-merge", guard: merge,
        disabledReason: merge.allowed ? (!prOpen ? "The PR is already merged" : o.pr.checks !== "green" ? "Checks are not green yet" : stop ? stop.reason : null) : null,
        onClick: function () { run(function () { return G.ops.mergeOnboardingPR(r.id); }); } }) : null,
      o.stage === "pr_merged" || o.stage === "verified" ? G.btn("Verify now", { kind: "primary", icon: "check", small: true, id: "onb-act-verify", guard: manage,
        onClick: function () { run(function () { return G.ops.verifyNow(r.id); }); } }) : null,
      o.pr ? G.btn("Request changes", { small: true, icon: "undo", id: "onb-act-changes", guard: manage, disabledReason: manage.allowed && !prOpen ? "The PR is already merged" : null,
        onClick: function () { G.reasonDialog({ title: "Request changes on " + r.name + "#" + o.pr.number, kicker: "Onboarding PR", label: "What should the agent change?", ok: "Request changes", min: 5, placeholder: "For example: keep CODEOWNERS to the /internal directory only.",
          onOk: function (v) { var x = G.ops.requestChanges(r.id, v); if (x.ok) G.toast(x.msg, "ok"); return x; } }); } }) : null,
      G.btn("Mark exception", { small: true, icon: "shield", id: "onb-act-exception", guard: exc, disabledReason: exc.allowed && o.stage === "ready" ? (o.exception ? "Already ready by exception" : "Already ready") : null,
        onClick: function () { G.reasonDialog({ title: "Mark " + r.name + " ready by exception", kicker: "Onboarding exception", label: "Why is it safe to accept work without finishing onboarding?", ok: "Mark ready", kind: "danger", min: 10,
          sub: "The repo becomes Ready now. Open gaps stay listed on the repo and the exception is written to the audit ledger.",
          onOk: function (v) { var x = G.ops.markException(r.id, v); if (x.ok) G.toast(x.msg, "warn"); return x; } }); } }),
      G.btn("Repo settings", { small: true, icon: "tool", id: "onb-act-settings", guard: manage, onClick: function () { settingsDialog(r); } })
    ];
    var paused = G.store.get("prefs").paused;
    var auto = o.stage === "pr_merged" || o.stage === "verified" || o.stage === "connected" || o.stage === "pr_opened" || (o.stage === "pr_checks" && o.pr && o.pr.checks === "running");
    var tabs = [{ id: "findings", label: "Findings", count: gaps(r).length }, { id: "pr", label: "Pull request" }, { id: "timeline", label: "Timeline", count: o.timeline.length }, { id: "settings", label: "Settings" }, { id: "history", label: "History" }];
    var body = tab === "findings" ? findingsTab(r) : tab === "pr" ? prTab(r) : tab === "timeline" ? timelineTab(r) : tab === "settings" ? settingsTab(r) : G.historyList({ type: "repo", id: r.id });
    return h("div", { class: "drawer-inner onb-drawer" },
      h("div", { class: "drawer-head" },
        h("div", null, h("div", { class: "kicker" }, "Onboarding · " + (G.find.project(pid) || {}).name),
          h("div", { class: "drawer-id" }, h("span", { class: "mono big-id" }, r.name), statusChip(r)),
          h("p", { class: "muted small" }, r.lang + " · owned by " + teamName(r.team) + " · stage " + stageName(o.stage))),
        h("button", { type: "button", class: "icon-btn drawer-close", "aria-label": "Close", onClick: close }, G.icon("x"))),
      h("div", { class: "drawer-scroll" },
        steps(r, true),
        o.blocker && o.stage === "person" ? h("div", { class: "callout callout-block" }, G.icon("human"), h("div", null, h("strong", null, "Needs a person. "), o.blocker, " Fix it in " + sourceName(r) + ", then re-run the assessment, or mark an exception.")) : null,
        o.stage === "failed" ? h("div", { class: "callout callout-fail" }, G.icon("st-fail"), h("div", null, h("strong", null, "Onboarding failed. "), o.blocker || "Re-run the assessment after fixing the cause.")) : null,
        o.exception ? h("div", { class: "callout callout-warn" }, G.icon("shield"), h("div", null, h("strong", null, "Ready by exception. "), o.exception.reason, h("span", { class: "muted" }, " · " + G.actorName(o.exception.by) + ", " + G.fmt.stamp(o.exception.at)))) : null,
        auto && o.stage !== "ready" ? h("div", { class: "callout" + (paused ? " callout-warn" : "") }, G.icon("clock"), h("div", null, "The Onboarding agent moves this repo to the next stage on its own. ",
          paused ? [h("strong", null, "The simulation is paused. "), G.btn("Resume simulation", { small: true, id: "onb-resume-sim", onClick: function () { G.store.update("prefs", function (p) { p.paused = false; }); G.toast("Simulation resumed.", "ok"); } })] : null)) : null,
        needsMerge(r) ? h("div", { class: "callout callout-warn" }, G.icon("st-wait"), h("div", null, "Checks are green. A person with merge rights on this project must approve and merge PR #" + o.pr.number + ".")) : null,
        h("div", { class: "onb-acts" }, acts),
        G.lockNote(!manage.allowed ? manage : null, "Onboarding actions on this repo"),
        G.tabBar({ id: "onb-dtab", items: tabs, active: tab, onChange: function (t) { ui.dtab[repoId] = t; G.drawer.refresh(); } }),
        h("div", { class: "onb-dbody" }, body)));
  }

  function sevMark(sev) { return h("span", { class: "onb-sev onb-sev-" + sev, title: "Severity " + sev }, h("span", { class: "onb-sev-shape", "aria-hidden": "true" }), sev); }
  function findingsTab(r) {
    var f = r.onboarding.findings;
    if (!f.length) return G.emptyState({ title: "Not assessed yet", text: "The Onboarding agent lists findings once the assessment finishes." });
    var order = { high: 0, medium: 1, low: 2 };
    var list = f.slice().sort(function (a, b) { return (a.ok - b.ok) || (order[a.sev] - order[b.sev]); });
    return h("ul", { class: "onb-findings" }, list.map(function (x) {
      var inPR = r.onboarding.pr && r.onboarding.pr.files.some(function (p) { return p.finding === x.id; });
      return h("li", { class: x.ok ? "is-ok" : "is-gap" },
        h("span", { class: "onb-f-ic" }, G.icon(x.ok ? "check" : x.manual ? "human" : "alert")),
        h("div", { class: "onb-f-main" }, h("div", { class: "onb-f-t" }, h("strong", null, x.check), x.ok ? h("span", { class: "muted small" }, "passes") : sevMark(x.sev)),
          x.ok ? null : h("div", { class: "small" }, x.fix, x.file ? [" · ", h("span", { class: "mono" }, x.file)] : null),
          x.ok ? null : h("div", { class: "muted small" }, x.manual ? "Cannot be fixed by the PR. Needs a person with access." : inPR ? "Fixed in the onboarding PR." : x.file ? "Will be fixed in the onboarding PR." : "Documented in AGENTS.md by the PR.")));
    }));
  }

  function diffLines(r, file) {
    var p = file.path, test = LANG_TEST[r.lang] || "make test";
    if (p === "AGENTS.md") return ["# AGENTS.md", "## Test command", "Run `" + test + "` before opening a PR.", "## Conventions", "- Branches start with " + r.config.branchPrefix + "; merge by " + r.config.merge + "."];
    if (p === "CODEOWNERS") return ["# Owners for agent work", "*            @acme/" + r.team, "/.gantry/    @acme/platform"];
    if (p === ".gantry/factory.yml") return ["project: " + r.project, "repo: " + r.name, "mcp:", (r.mcp.length ? r.mcp : ["mcp-issues"]).map(function (m) { return "  - " + m; }).join("\n"), "protected_paths: " + JSON.stringify(r.config.protectedPaths)];
    if (/workflows/.test(p)) return ["name: gantry-ci", "on: [pull_request, push]", "jobs:", "  test:", "    run: " + test];
    if (/lint|ruff|eslint|golangci/.test(p)) return ["# Lint config committed by the Onboarding agent", "extends: acme-standard"];
    return ["# Pinned toolchain for reproducible builds", r.lang.toLowerCase() + " = latest-stable"];
  }
  function prTab(r) {
    var pr = r.onboarding.pr;
    if (!pr) return G.emptyState({ title: "No PR yet", text: r.onboarding.stage === "person" ? "A person must fix the blocker before the agent can open a PR." : "The Onboarding agent opens a PR after the assessment." });
    var plus = pr.files.reduce(function (s, f) { return s + f.plus; }, 0), minus = pr.files.reduce(function (s, f) { return s + f.minus; }, 0);
    var checks = r.config.requiredChecks.map(function (c) { return { name: c, st: pr.state === "merged" || pr.checks === "green" ? "ok" : pr.checks === "red" ? "bad" : pr.checks === "running" ? "warn" : "pending" }; });
    return h("div", { class: "onb-pr" },
      h("div", { class: "onb-pr-head" }, h("span", { class: "mono strong" }, "#" + pr.number), h("strong", null, pr.title),
        h("span", { class: "chip " + (pr.state === "merged" ? "chip-accent" : "") }, pr.state === "merged" ? "Merged by " + G.actorName(pr.mergedBy) : "Open")),
      h("div", { class: "kv-row" },
        h("div", { class: "kv" }, h("div", { class: "kv-k" }, "Branch"), h("div", { class: "kv-v mono" }, pr.branch + " → " + r.config.defaultBranch)),
        h("div", { class: "kv" }, h("div", { class: "kv-k" }, "Files"), h("div", { class: "kv-v mono" }, pr.files.length + " ", h("span", { class: "pos" }, "+" + plus), " ", h("span", { class: "neg" }, "−" + minus))),
        h("div", { class: "kv" }, h("div", { class: "kv-k" }, "Checks"), h("div", { class: "kv-v" }, pr.checks))),
      h("h3", { class: "sub-h" }, "Checks"),
      h("ul", { class: "checklist" }, checks.map(function (c) {
        return h("li", { class: c.st }, G.icon(c.st === "ok" ? "check" : c.st === "bad" ? "x" : c.st === "warn" ? "clock" : "dots"), h("span", { class: "mono" }, c.name), h("span", { class: "muted small" }, c.st === "ok" ? "passed" : c.st === "bad" ? "failed" : c.st === "warn" ? "running" : "waiting to start"));
      })),
      h("h3", { class: "sub-h" }, "Reviewers from project approvers"),
      pr.reviewers.length ? h("div", { class: "onb-revs" }, pr.reviewers.map(function (id) { return G.who(id); })) : h("p", { class: "muted small" }, "None assigned. Anyone with merge rights on onboarding PRs in this project can approve."),
      h("h3", { class: "sub-h" }, "Files changed"),
      h("ul", { class: "onb-files" }, pr.files.map(function (f) {
        var lines = diffLines(r, f).join("\n").split("\n");
        return h("li", null, h("details", { id: "onb-file-" + f.path.replace(/[^a-z0-9]/gi, "-") },
          h("summary", null, h("span", { class: "mono" }, f.path), h("span", { class: "mono small" }, h("span", { class: "pos" }, "+" + f.plus), " ", h("span", { class: "neg" }, "−" + f.minus))),
          h("pre", { class: "onb-diff mono" }, lines.map(function (l) { return h("span", { class: "onb-add" }, "+ " + l + "\n"); }), f.plus > lines.length ? h("span", { class: "muted" }, "… " + (f.plus - lines.length) + " more lines") : null)));
      })),
      h("p", { class: "footnote" }, "Diff previews are generated from sample data. Guideline: ", G.store.get("guidelines").mayNot));
  }
  function timelineTab(r) {
    var t = r.onboarding.timeline.slice().sort(function (a, b) { return b.at - a.at; });
    return h("ol", { class: "onb-timeline" }, t.map(function (e) {
      return h("li", null, h("span", { class: "mono small muted" }, G.fmt.stamp(e.at)), e.who === "ci" ? h("span", { class: "who" }, G.icon("tool"), h("span", null, "CI (simulated)")) : G.who(e.who), h("span", null, e.text));
    }));
  }
  function settingsTab(r) {
    var c = r.config;
    var mcp = r.mcp.map(function (id) { var m = G.find.mcp(id); return m ? m.name : id; });
    function kv(k, v) { return h("div", { class: "onb-kv" }, h("dt", null, k), h("dd", null, v)); }
    return h("div", null,
      h("dl", { class: "onb-kvs" },
        kv("Owning team", teamName(r.team)),
        kv("Source", repoSource(r) ? instLabel(repoSource(r)) + " · " + (typeOf(repoSource(r)).name || repoSource(r).type) : "none"),
        kv("Default branch", h("span", { class: "mono" }, c.defaultBranch)),
        kv("Branch prefix", h("span", { class: "mono" }, c.branchPrefix)),
        kv("Merge method", c.merge),
        kv("Release tagging", c.tagging),
        kv("Required checks", h("span", { class: "mono" }, c.requiredChecks.join(", ") || "none")),
        kv("Protected paths", h("span", { class: "mono" }, c.protectedPaths.join(", ") || "none")),
        kv("MCP servers", mcp.join(", ") || "none"),
        kv("Issue triggers", r.triggers ? "On (project trigger rules apply)" : "Off"),
        kv("Notification overrides", r.notifyOverrides.length ? h("ul", { class: "plain-list small" }, r.notifyOverrides.map(function (n) { return h("li", null, eventName(n.event) + " → " + n.dest.map(function (d) { var i = G.integrationFor(d, r.project); return (i ? i.name : d.channel) + " " + d.target; }).join(", ") + " (" + tplName(n.template) + ")"); })) : "Project routes")),
      G.btn("Edit settings", { icon: "tool", id: "onb-settings-edit", guard: G.me("onboarding.manage", { project: r.project }), onClick: function () { settingsDialog(r); } }));
  }
  function eventName(id) { return G.notifyEventName(id); }
  function tplName(id) { var b = G.CARD_TEMPLATES && G.CARD_TEMPLATES[id]; if (b) return b.name; var c = (G.store.get("cardTemplates") || []).find(function (t) { return t.id === id; }); return c ? c.name : id || "standard"; }

  /* ---------- settings form, shared by the wizard and the edit dialog ---------- */
  function draftFrom(r, project) {
    var c = r ? r.config : { defaultBranch: "main", branchPrefix: "gantry/", merge: project.regulated ? "merge" : "squash", tagging: "semver-patch", requiredChecks: ["ci/test"], protectedPaths: [".github/workflows/**"] };
    var dests = destsFor(project);
    var chat = dests.find(function (i) { return i.type === "slack" && i.status === "healthy"; }) || dests.find(function (i) { return i.status === "healthy"; }) || dests[0] || null;
    var src = r ? repoSource(r) : defaultSource(project);
    return { name: "", source: src ? src.id : null, team: r ? r.team : project.teams[0] || "platform", mcp: r ? r.mcp.slice() : project.mcp.slice(0, 2),
      triggers: r ? !!r.triggers : true,
      notify: r ? r.notifyOverrides.map(function (n) { var d0 = n.dest[0] || {}; var inst = d0.channel ? G.integrationFor(d0, project.id) : null; return { event: n.event, integration: inst ? inst.id : null, channel: d0.channel || (inst ? inst.type : "slack"), target: d0.target || "", template: n.template || defaultTemplate(n.event), mode: n.mode }; })
        : chat ? [{ event: "onboarding.pr", integration: chat.id, channel: chat.type, target: chat.type === "email" ? "project admins" : "#" + (project.teams[0] || "platform") + "-eng", template: "onboarding" }] : [],
      defaultBranch: c.defaultBranch, branchPrefix: c.branchPrefix, merge: c.merge, tagging: c.tagging, requiredChecks: c.requiredChecks.join(", "), protectedPaths: c.protectedPaths.join("\n") };
  }
  function patchFrom(d) {
    return { team: d.team, mcp: d.mcp.slice(), triggers: d.triggers, source: d.source || null,
      notifyOverrides: d.notify.filter(function (n) { return n.target.trim() && n.integration; }).map(function (n, i) { return { id: "RO-" + (i + 1), event: n.event, dest: [{ channel: n.channel, target: n.target.trim(), integration: n.integration }], template: n.template, mode: n.mode || "also" }; }),
      config: { defaultBranch: d.defaultBranch.trim() || "main", branchPrefix: d.branchPrefix.trim(), merge: d.merge, tagging: d.tagging,
        requiredChecks: d.requiredChecks.split(",").map(function (s) { return s.trim(); }).filter(Boolean),
        protectedPaths: d.protectedPaths.split("\n").map(function (s) { return s.trim(); }).filter(Boolean) } };
  }
  function inp(id, d, key, attrs) {
    var el = h(attrs && attrs.rows ? "textarea" : "input", Object.assign({ id: id, class: "input" + (attrs && attrs.mono ? " mono" : ""), value: d[key], autocomplete: "off" }, attrs && attrs.rows ? { rows: attrs.rows } : {}, attrs && attrs.placeholder ? { placeholder: attrs.placeholder } : {}));
    if (attrs && attrs.rows) el.value = d[key];
    el.addEventListener("input", function () { d[key] = el.value; });
    return el;
  }
  function secOwnership(d, rerender, project) {
    var dests = destsFor(project);
    var rows = d.notify.map(function (n, i) {
      var opts = dests.map(function (x) { return { value: x.id, label: instLabel(x) }; });
      if (!n.integration) opts.unshift({ value: "", label: "Pick a destination" });
      var inst = n.integration ? G.find.integration(n.integration) : null;
      var tt = typeOf(inst);
      return h("div", { class: "onb-nrow" },
        G.select("onb-n-ev-" + i, eventList(), n.event, function (v) { var wasDefault = n.template === defaultTemplate(n.event); n.event = v; if (wasDefault) { n.template = defaultTemplate(v); rerender(); } }, { "aria-label": "Event" }),
        G.select("onb-n-ch-" + i, opts, n.integration || "", function (v) { var x = G.find.integration(v); n.integration = x ? x.id : null; n.channel = x ? x.type : n.channel; rerender(); }, { "aria-label": "Destination integration" }),
        (function () { var t = h("input", { id: "onb-n-tg-" + i, class: "input mono", value: n.target, placeholder: tt.targetLabel || "#channel or address", "aria-label": tt.targetLabel || "Destination" }); t.addEventListener("input", function () { n.target = t.value; }); return t; })(),
        G.select("onb-n-tp-" + i, templateList(n.template), n.template, function (v) { n.template = v; }, { "aria-label": "Card template" }),
        h("button", { type: "button", class: "icon-btn icon-btn-sm", id: "onb-n-rm-" + i, "aria-label": "Remove route", onClick: function () { d.notify.splice(i, 1); rerender(); } }, G.icon("x")));
    });
    return h("div", { class: "form-grid" },
      G.field("Owning team", G.select("onb-w-team", G.store.get("teams").map(function (t) { return { value: t.id, label: t.name }; }), d.team, function (v) { d.team = v; }), "Gets CODEOWNERS entries and is asked first about this repo."),
      h("div", { class: "field" }, h("div", { class: "field-label" }, "Notification routes for this repo (override project routes)"),
        rows.length ? h("div", { class: "onb-nrows" }, rows) : h("p", { class: "muted small" }, "No overrides. The project's routes apply."),
        G.btn("Add route", { small: true, icon: "plus", id: "onb-n-add", disabledReason: dests.length ? null : "No notification integration is connected for this project. Add one under Integrations", onClick: function () { var x = dests.find(function (i) { return i.status === "healthy"; }) || dests[0]; d.notify.push({ event: "question", integration: x.id, channel: x.type, target: "", template: defaultTemplate("question") }); rerender(); } }),
        h("div", { class: "field-hint" }, "Destinations are this project's connected integrations, custom ones included. Card templates come from Notifications. Delivery is simulated.")));
  }
  function secMCP(d) {
    var all = G.store.get("mcp");
    return h("div", { class: "form-grid" },
      h("p", { class: "muted small" }, "Servers the agents need on this repo. They are declared in .gantry/factory.yml by the onboarding PR."),
      h("div", { class: "check-grid" }, all.map(function (m) {
        var cb = h("input", { type: "checkbox", id: "onb-w-mcp-" + m.id, checked: d.mcp.indexOf(m.id) >= 0 });
        cb.addEventListener("change", function () { if (cb.checked) { if (d.mcp.indexOf(m.id) < 0) d.mcp.push(m.id); } else d.mcp = d.mcp.filter(function (x) { return x !== m.id; }); });
        return h("label", { class: "check", for: "onb-w-mcp-" + m.id }, cb, h("span", null, m.name, h("span", { class: "muted small" }, " · " + m.sensitivity + (m.health !== "healthy" ? " · " + m.health : ""))));
      })));
  }
  function secTriggers(d, project) {
    var rules = G.store.get("triggers").filter(function (t) { return t.project === project.id; });
    return h("div", { class: "form-grid" },
      h("div", { class: "toggle-row" }, G.toggle("onb-w-trig", d.triggers, function (v) { d.triggers = v; }, null, "Issue triggers"), h("label", { for: "onb-w-trig" }, "Let issues and comments from this project's trigger sources create work orders for this repo")),
      rules.length ? h("ul", { class: "plain-list small" }, rules.map(function (t) { var src = t.source === "schedule" ? { name: "Schedule" } : G.find.integration(t.source) || { name: t.source || "unknown source" }; return h("li", null, h("span", { class: "mono" }, t.id), " " + t.name + " · from " + src.name + (t.label ? " (label " + t.label + ")" : "") + (t.enabled ? "" : " · disabled")); }))
        : h("p", { class: "muted small" }, "This project has no trigger rules yet. Add them under API and triggers."),
      h("p", { class: "field-hint" }, "Issues only create work orders once the repo is Ready."));
  }
  function secConventions(d) {
    return h("div", { class: "form-grid onb-conv" },
      h("div", { class: "form-row" },
        G.field("Default branch", inp("onb-w-branch", d, "defaultBranch", { mono: true })),
        G.field("Agent branch prefix", inp("onb-w-prefix", d, "branchPrefix", { mono: true }))),
      h("div", { class: "form-row" },
        G.field("Merge method", G.select("onb-w-merge", [{ value: "squash", label: "Squash" }, { value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase" }], d.merge, function (v) { d.merge = v; })),
        G.field("Release tagging", G.select("onb-w-tag", [{ value: "semver-patch", label: "Semver, patch bump" }, { value: "semver-minor", label: "Semver, minor bump" }, { value: "calver", label: "Calendar version" }, { value: "none", label: "No tags" }], d.tagging, function (v) { d.tagging = v; }))),
      G.field("Required checks", inp("onb-w-checks", d, "requiredChecks", { mono: true, placeholder: "ci/test, ci/lint" }), "Comma separated. Gate G4 waits for these."),
      G.field("Protected paths", inp("onb-w-paths", d, "protectedPaths", { mono: true, rows: "3", placeholder: "infra/prod/**" }), "One per line. Agents may not change these without an extra approval."));
  }

  function settingsDialog(r) {
    var project = G.find.project(r.project);
    var d = draftFrom(r, project);
    var dec = G.me("onboarding.manage", { project: r.project });
    var holder = h("div");
    var err = h("div", { class: "form-err", role: "alert" });
    function paint() {
      G.clear(holder);
      holder.appendChild(h("div", { class: "onb-settings" }, G.lockNote(dec, "Repo settings"),
        h("h3", { class: "sub-h" }, "Source"), secSource(d, project, paint, false),
        h("h3", { class: "sub-h" }, "Ownership and notifications"), secOwnership(d, paint, project),
        h("h3", { class: "sub-h" }, "MCP servers"), secMCP(d),
        h("h3", { class: "sub-h" }, "Issue triggers"), secTriggers(d, project),
        h("h3", { class: "sub-h" }, "Branch, merge and release conventions"), secConventions(d), err));
    }
    paint();
    G.dialog({ title: "Settings for " + r.name, kicker: "Onboarding · repo settings", wide: true, body: holder,
      actions: [{ label: "Cancel" }, { label: "Save settings", kind: "primary", submit: true, id: "onb-set-save", guard: dec, onClick: function (close) {
        var x = G.ops.configureRepo(r.id, patchFrom(d));
        if (!x.ok) { err.textContent = x.msg; return; }
        G.toast(x.msg, "ok"); close();
      } }] });
  }

  /* ---------- connect-repo wizard ---------- */
  var WSTEPS = ["Repo", "Ownership", "MCP", "Triggers", "Conventions", "Review"];
  /* source picker: the project's source-control instances (GitHub cloud and Enterprise, GitLab, Bitbucket, custom) */
  /* repos the source instance offers that are not connected yet (null when it lists none, so the name is typed) */
  function ghAvailable(inst) { if (!inst || !inst.available) return null; return G.availableRepos(inst.id); }
  function secSource(d, project, rerender, wizard) {
    var list = sourcesFor(project);
    if (!list.length) return h("div", { class: "callout callout-warn" }, G.icon("plug"), h("div", null, "No source-control integration is connected for " + project.name + ". Add GitHub, GitLab, Bitbucket or a custom source under ", h("a", { href: "#integrations", id: "onb-to-int" }, "Integrations"), " first."));
    return h("div", { class: "radio-cards onb-src" }, list.map(function (i) {
      var t = typeOf(i);
      var rb = h("input", { type: "radio", name: "onb-w-src", id: "onb-w-src-" + i.id, value: i.id, checked: d.source === i.id });
      rb.addEventListener("change", function () { d.source = i.id; if (wizard) { var av = ghAvailable(i); d.name = av && av[0] ? av[0].repo : ""; } rerender(); });
      return h("label", { class: "radio-card", for: "onb-w-src-" + i.id }, rb, h("span", { class: "rc-t" }, i.name), h("span", { class: "rc-d" }, (t.name || i.type) + " · " + (i.config.host || i.config.site || i.config.url || orgOf(i)) + (i.status !== "healthy" ? " · " + i.status : "")));
    }));
  }
  function connectWizard(project) {
    var d = draftFrom(null, project);
    var src0 = d.source && G.find.integration(d.source);
    var av0 = ghAvailable(src0);
    d.name = av0 && av0[0] ? av0[0].repo : "";
    var step = 0;
    var dec = G.me("repo.onboard", { project: project.id });
    var holder = h("div");
    var err = h("div", { class: "form-err", role: "alert" });
    var dlg;
    function fullName() { var n = d.name.trim(); return n.indexOf("/") < 0 ? orgOf(G.find.integration(d.source)) + "/" + n : n; }
    function validate() {
      if (step === 0) {
        if (!d.source) return "Pick where the repo lives. Connect a source-control integration first if none is listed.";
        var si = G.find.integration(d.source);
        if (si && (si.status === "offline" || !si.connected)) return si.name + " is offline. Pick another source or fix it under Integrations.";
        var n = d.name.trim();
        if (!n) return "Pick or type a repo.";
        if (!/^[\w.-]+(\/[\w.-]+)?$/.test(n)) return "Use the form org/name.";
        var id = n.indexOf("/") < 0 ? n : n.split("/")[1];
        var ex = G.find.repo(id);
        if (ex) return fullName() + " is already connected to " + (G.visibleProjects(G.viewerId()).some(function (x) { return x.id === ex.project; }) ? G.find.project(ex.project).name : "another project") + ".";
      }
      return null;
    }
    function paint() {
      G.clear(holder); err.textContent = "";
      var sec;
      if (step === 0) {
        var si = d.source && G.find.integration(d.source);
        var av = ghAvailable(si);
        var name = inp("onb-w-name", d, "name", { mono: true, placeholder: orgOf(si) + "/repo-name" });
        sec = h("div", { class: "form-grid" },
          h("div", { class: "field" }, h("div", { class: "field-label" }, "Where the repo lives"), secSource(d, project, paint, true)),
          av ? h("div", { class: "field" }, h("div", { class: "field-label" }, "Available from " + si.name + " (simulated)"),
            av.length ? h("div", { class: "radio-cards onb-avail" }, av.map(function (a, i) {
              var rb = h("input", { type: "radio", name: "onb-w-avail", id: "onb-w-av-" + i, checked: d.name === a.repo });
              rb.addEventListener("change", function () { d.name = a.repo; name.value = a.repo; });
              return h("label", { class: "radio-card", for: "onb-w-av-" + i }, rb, h("span", { class: "rc-t mono" }, a.repo), h("span", { class: "rc-d" }, a.lang));
            })) : h("p", { class: "muted small" }, "Every repo this integration can see is already connected.")) : null,
          si ? G.field("Repo", name, av ? "Or type any repo " + si.name + " can reach." : "Type the repo as " + orgOf(si) + "/name. " + si.name + " lists repos on connection (simulated).") : null,
          h("p", { class: "muted small" }, "It joins " + project.name + ". The Onboarding agent assesses it as soon as it is connected."));
      } else if (step === 1) sec = secOwnership(d, paint, project);
      else if (step === 2) sec = secMCP(d);
      else if (step === 3) sec = secTriggers(d, project);
      else if (step === 4) sec = secConventions(d);
      else {
        var p = patchFrom(d);
        sec = h("dl", { class: "onb-kvs" },
          [["Repo", h("span", { class: "mono" }, fullName())], ["Source", (G.find.integration(d.source) || { name: "none" }).name], ["Project", project.name], ["Owning team", teamName(d.team)],
            ["Notification overrides", String(p.notifyOverrides.length)], ["MCP servers", d.mcp.map(function (id) { return (G.find.mcp(id) || { name: id }).name; }).join(", ") || "none"],
            ["Issue triggers", d.triggers ? "On" : "Off"], ["Branches", h("span", { class: "mono" }, p.config.branchPrefix + "* → " + p.config.defaultBranch + ", " + p.config.merge)],
            ["Required checks", h("span", { class: "mono" }, p.config.requiredChecks.join(", ") || "none")], ["Protected paths", h("span", { class: "mono" }, p.config.protectedPaths.join(", ") || "none")]
          ].map(function (x) { return h("div", { class: "onb-kv" }, h("dt", null, x[0]), h("dd", null, x[1])); }));
      }
      holder.appendChild(h("div", null,
        h("ol", { class: "stepper onb-wsteps", "aria-label": "Steps" }, WSTEPS.map(function (s, i) { return h("li", { class: i === step ? "is-on" : i < step ? "is-done" : "", "aria-current": i === step ? "step" : null }, h("span", { class: "mono" }, i < step ? "✓" : String(i + 1)), s); })),
        G.lockNote(dec, "Connecting repos"), sec, err));
      if (dlg) {
        var nx = dlg.footer.querySelector("#onb-w-next span"); if (nx) nx.textContent = step === WSTEPS.length - 1 ? "Connect repo" : "Next";
        var bk = dlg.footer.querySelector("#onb-w-back"); if (bk) { if (step === 0) { bk.setAttribute("aria-disabled", "true"); bk.classList.add("is-locked"); bk.setAttribute("data-reason", "This is the first step"); } else { bk.removeAttribute("aria-disabled"); bk.classList.remove("is-locked"); bk.removeAttribute("data-reason"); } }
      }
      setTimeout(function () { var f = holder.querySelector("input:not([type=radio]):not([type=checkbox]),select"); if (f && step > 0) f.focus(); }, 10);
    }
    paint();
    dlg = G.dialog({ title: "Connect a repo to " + project.name, kicker: "Onboarding · connect", wide: true, body: holder,
      actions: [{ label: "Cancel" }, { label: "Back", id: "onb-w-back", onClick: function () { if (step > 0) { step--; paint(); } } },
        { label: "Next", kind: "primary", submit: true, id: "onb-w-next", guard: dec, onClick: function (close) {
          var v = validate(); if (v) { err.textContent = v; return; }
          if (step < WSTEPS.length - 1) { step++; paint(); return; }
          var x = G.ops.connectRepo(project.id, fullName(), d.team, d.source);
          if (!x.ok) { err.textContent = x.msg; return; }
          var y = G.ops.configureRepo(x.repo.id, patchFrom(d));
          G.toast(x.msg + (y.ok ? " Settings saved." : " Settings not saved: " + y.msg), y.ok ? "ok" : "warn");
          close(); ui.tab = "pipeline"; G.rerender(); openRepo(x.repo.id, "timeline");
        } }] });
    paint();
  }

  /* ---------- project additions to the guidelines (onboarding.guidelines, per project) ---------- */
  function projectGuidelines() {
    var p = G.currentProject(); if (!p) return null;
    var pg = p.guidelines || { items: [], notes: "", version: 0, history: [] };
    var dec = G.me("onboarding.guidelines", { project: p.id });
    var key = p.id + ":" + (pg.version || 0);
    if (!ui.pg || ui.pg.key !== key) ui.pg = { key: key, items: pg.items.map(function (x) { return { id: x.id, text: x.text, required: x.required }; }), notes: pg.notes || "", note: "" };
    var d = ui.pg, locked = !dec.allowed;
    var err = h("div", { class: "form-err", role: "alert", id: "onb-pg-err" });
    var list = h("ol", { class: "onb-gl-items" }, d.items.map(function (it, i) {
      var t = h("input", { id: "onb-pg-t-" + it.id, class: "input", value: it.text, disabled: locked, "aria-label": "Project guideline " + (i + 1) });
      t.addEventListener("input", function () { it.text = t.value; });
      return h("li", null, h("span", { class: "onb-gl-no mono" }, "P" + (i + 1)), t,
        h("span", { class: "onb-gl-req" }, G.toggle("onb-pg-r-" + it.id, it.required, function (v) { it.required = v; }, locked ? dec : null, "Required for Ready"), h("span", { class: "small muted" }, it.required ? "Required" : "Advisory")),
        G.btn("", { kind: "ghost", small: true, icon: "x", id: "onb-pg-rm-" + it.id, aria: "Remove project guideline " + (i + 1), guard: dec, onClick: function () { d.items.splice(i, 1); G.rerender(); } }));
    }));
    var notes = h("textarea", { id: "onb-pg-notes", class: "input", rows: "2", disabled: locked, placeholder: "Anything the Onboarding agent must know about this project" }); notes.value = d.notes;
    notes.addEventListener("input", function () { d.notes = notes.value; });
    var cn = h("input", { id: "onb-pg-note", class: "input", value: d.note, disabled: locked, placeholder: "What changed and why" });
    cn.addEventListener("input", function () { d.note = cn.value; });
    return G.panel(h("span", null, "Additions for " + p.name + " ", h("span", { class: "mono small muted" }, pg.version ? "v" + pg.version : "none yet")), h("div", { class: "onb-gl" },
      G.lockNote(dec, p.name + " onboarding additions"),
      h("p", { class: "muted small" }, "Project Admins add rules on top of the factory guidelines for repos in " + p.name + ". The factory list above still applies."),
      d.items.length ? list : h("p", { class: "muted small" }, "No project-specific items."),
      G.btn("Add item", { small: true, icon: "plus", id: "onb-pg-add", guard: dec, onClick: function () { d.items.push({ id: "pg-n" + Date.now(), text: "", required: true }); G.rerender(); } }),
      G.field("Notes for the agent", notes), G.field("Change note (audited)", cn), err,
      h("div", { class: "form-actions" }, G.btn("Save project additions", { kind: "primary", id: "onb-pg-save", guard: dec, onClick: function () {
        var e = document.getElementById("onb-pg-err");
        var clean = d.items.map(function (x) { return { id: x.id, text: x.text.trim(), required: x.required }; });
        if (clean.some(function (x) { return !x.text; })) { if (e) e.textContent = "Every item needs text, or remove it."; return; }
        if (d.note.trim().length < 3) { if (e) e.textContent = "Add a short change note."; return; }
        var r = G.ops.saveGuidelines({ items: clean, notes: d.notes.trim() }, d.note.trim(), p.id);
        G.toast(r.msg, r.ok ? "ok" : "error"); if (r.ok) ui.pg = null;
      } })),
      h("h3", { class: "sub-h" }, "Audit"), G.historyList({ type: "guidelines", id: p.id, limit: 6 })), { cls: "onb-gl-panel" });
  }

  /* ---------- Onboarding agent and guidelines ---------- */
  function agentTab() {
    var a = G.find.agent("ag-onboard");
    var g = G.store.get("guidelines");
    var dec = G.me("agent.edit");
    if (!ui.gl || ui.gl.v !== g.version) ui.gl = { v: g.version, items: g.items.map(function (x) { return { id: x.id, text: x.text, required: x.required }; }), may: g.may, mayNot: g.mayNot, dirty: false };
    var d = ui.gl;
    var locked = !dec.allowed;
    function mark() { if (!d.dirty) { d.dirty = true; G.rerender(); } }
    var items = h("ol", { class: "onb-gl-items" }, d.items.map(function (it, i) {
      var t = h("input", { id: "onb-gl-t-" + it.id, class: "input", value: it.text, disabled: locked, "aria-label": "Guideline " + (i + 1) });
      t.addEventListener("input", function () { it.text = t.value; mark(); });
      return h("li", null, h("span", { class: "onb-gl-no mono" }, String(i + 1).padStart(2, "0")), t,
        h("span", { class: "onb-gl-req" }, G.toggle("onb-gl-r-" + it.id, it.required, function (v) { it.required = v; mark(); }, locked ? dec : null, "Required for Ready"), h("span", { class: "small muted" }, it.required ? "Required" : "Advisory")),
        G.btn("", { kind: "ghost", small: true, icon: "x", id: "onb-gl-rm-" + it.id, aria: "Remove guideline " + (i + 1), guard: dec, onClick: function () { d.items.splice(i, 1); d.dirty = true; G.rerender(); } }));
    }));
    var may = h("textarea", { id: "onb-gl-may", class: "input", rows: "2", disabled: locked }); may.value = d.may;
    may.addEventListener("input", function () { d.may = may.value; mark(); });
    var mayNot = h("textarea", { id: "onb-gl-maynot", class: "input", rows: "2", disabled: locked }); mayNot.value = d.mayNot;
    mayNot.addEventListener("input", function () { d.mayNot = mayNot.value; mark(); });
    var note = h("input", { id: "onb-gl-note", class: "input", value: ui.glNote, placeholder: "What changed and why", disabled: locked });
    note.addEventListener("input", function () { ui.glNote = note.value; });
    var err = h("div", { class: "form-err", role: "alert", id: "onb-gl-err" });
    var skills = a ? a.skills.map(function (id) { return G.find.skill(id); }).filter(Boolean) : [];

    var agentPanel = a ? G.panel("Onboarding agent", h("div", { class: "onb-agent" },
      h("div", { class: "onb-agent-id" }, G.avatar(a.id, "lg"), h("div", null, h("strong", null, a.name), h("div", { class: "mono small muted" }, a.id + " · v" + a.version + " · " + ((G.find.model(a.model) || {}).name || a.model)), h("div", { class: "small" }, "Autonomy: " + a.autonomy + " · status " + a.status))),
      h("h3", { class: "sub-h" }, "Instructions"), h("p", { class: "onb-instr" }, a.instructions),
      h("h3", { class: "sub-h" }, "Skills, in order"),
      skills.length ? h("ol", { class: "onb-skills" }, skills.map(function (s) { return h("li", null, h("strong", null, s.name), h("span", { class: "mono small muted" }, " v" + s.version), h("div", { class: "small muted" }, s.when)); })) : h("p", { class: "muted small" }, "No skills attached."),
      h("p", { class: "small" }, "Instructions, model and skills are edited on the agent. ", h("a", { href: "#agents", id: "onb-agent-link", onClick: function () { G.store.update("prefs", function (p) { p.agent = a.id; }); } }, "Open the Onboarding agent"))
    )) : G.panel("Onboarding agent", G.emptyState({ title: "Agent missing", text: "No Onboarding agent is configured." }));

    var glPanel = G.panel(h("span", null, "Onboarding guidelines ", h("span", { class: "mono small muted" }, "v" + g.version)), h("div", { class: "onb-gl" },
      G.lockNote(dec, "The onboarding guidelines"),
      h("p", { class: "muted small" }, "What Ready means. The Onboarding agent checks every required item and the PR may only touch what is allowed below. Last saved by " + G.actorName(g.by) + ", " + G.fmt.stamp(g.at) + "."),
      items,
      G.btn("Add item", { small: true, icon: "plus", id: "onb-gl-add", guard: dec, onClick: function () { d.items.push({ id: "gl-n" + Date.now(), text: "", required: true }); d.dirty = true; G.rerender(); } }),
      G.field("The PR may change", may), G.field("The PR may never change", mayNot),
      G.field("Change note (written to the audit ledger)", note),
      err,
      h("div", { class: "form-actions" },
        G.btn("Discard changes", { id: "onb-gl-reset", disabledReason: !d.dirty ? "No unsaved changes" : null, onClick: function () { ui.gl = null; ui.glNote = ""; G.rerender(); } }),
        G.btn("Save as v" + (g.version + 1), { kind: "primary", id: "onb-gl-save", guard: dec, disabledReason: dec.allowed && !d.dirty ? "No unsaved changes" : null, onClick: function () {
          var e = document.getElementById("onb-gl-err");
          var clean = d.items.map(function (x) { return { id: x.id, text: x.text.trim(), required: x.required }; });
          if (clean.some(function (x) { return !x.text; })) { if (e) e.textContent = "Every item needs text, or remove it."; return; }
          if (ui.glNote.trim().length < 3) { if (e) e.textContent = "Add a short change note."; return; }
          var r = G.ops.saveGuidelines({ items: clean, may: d.may.trim(), mayNot: d.mayNot.trim() }, ui.glNote.trim());
          G.toast(r.msg, r.ok ? "ok" : "error");
          if (r.ok) { ui.gl = null; ui.glNote = ""; }
        } }))), { cls: "onb-gl-panel" });

    var hist = G.panel("Guideline versions", h("div", null,
      h("ol", { class: "onb-vers" }, g.history.slice().reverse().map(function (v) { return h("li", null, h("span", { class: "mono strong" }, "v" + v.v), h("span", null, v.note), h("span", { class: "muted small" }, G.actorName(v.by) + ", " + G.fmt.stamp(v.at))); })),
      h("h3", { class: "sub-h" }, "Audit"), G.historyList({ type: "guidelines", id: "onboarding", limit: 10 })));
    return h("div", { class: "onb-agent-grid" }, h("div", { class: "onb-col" }, agentPanel, hist), h("div", { class: "onb-col" }, glPanel, projectGuidelines()));
  }

  G.views["onboarding"] = { title: "Onboarding", render: render, keys: ["repos", "guidelines", "agents", "integrations", "mcp", "triggers", "audit", "projects"] };
})(window.G);
