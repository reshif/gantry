/* Learning loop (#learning): outcomes come back as proposed improvements. Signals from work orders
   (gate rejections, send-backs, reverts, incidents, classification overrides, intake misses) are
   grouped into findings; each finding can carry proposals (skill edit shown as a diff, guideline,
   eval case, guardrail, approver rule, route change) with evidence links to records, expected effect,
   owner and a status pipeline. Accepting applies the change through the matching op (audited twice).
   "Draft with Claude" uses G.ask with a scripted fallback. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "proposals", status: "open", sigType: "all", hi: null, hiFinding: null };
  var KINDS = {
    skill: { name: "Skill edit", icon: "skill" }, guideline: { name: "Guideline change", icon: "page" }, eval: { name: "New eval case", icon: "eval" },
    guardrail: { name: "Guardrail", icon: "shield" }, approver: { name: "Approver rule", icon: "gate" }, route: { name: "Route change", icon: "branch" }
  };
  var SIGNALS = { rejection: ["Gate rejection", "x"], sendback: ["Send-back", "undo"], revert: ["Revert", "alert"], incident: ["Incident", "alert"], override: ["Class override", "swap"], miss: ["Intake miss", "chat"] };
  var STATUS = { proposed: "Proposed", accepted: "Accepted and applied", verified: "Verified", declined: "Declined" };

  /* other views deep-link here: G.learningFocus({ finding, proposal, tab }) */
  G.learningFocus = function (o) {
    o = o || {};
    if (o.proposal) { var p = G.find.proposal(o.proposal); ui.tab = "proposals"; ui.hi = o.proposal; ui.status = p && p.status === "proposed" ? "open" : "all"; }
    else if (o.finding) { ui.tab = "findings"; ui.hiFinding = o.finding; }
    else if (o.tab) ui.tab = o.tab;
  };

  function S() { return G.store.get(); }
  function vis() { return G.viewer() ? G.visibleProjects(G.viewerId()).map(function (p) { return p.id; }) : []; }
  function seesProject(pid) { return !pid || vis().indexOf(pid) >= 0; }
  function projName(id) { return id ? (G.find.project(id) || { name: id }).name : "All projects"; }
  function agName(id) { return (G.find.agent(id) || { name: id || "agent" }).name; }
  function scopeOf(lp) { return lp.change && lp.change.project ? { project: lp.change.project } : undefined; }
  function chipList(ids, max) {
    max = max || 8;
    var shown = ids.slice(0, max).filter(function (id) { return G.find.wo(id); });
    return h("span", { class: "ln-chips" }, shown.map(function (id) { return G.entityChip({ type: "wo", id: id }); }), ids.length > max ? h("span", { class: "small muted" }, "+" + (ids.length - max) + " more") : null);
  }

  /* word-level diff between two strings: common prefix and suffix kept, middle shown removed / added */
  function wordDiff(a, b) {
    var x = String(a || "").split(/(\s+)/), y = String(b || "").split(/(\s+)/);
    var i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
    var j = 0; while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
    var pre = x.slice(0, i).join(""), del = x.slice(i, x.length - j).join(""), ins = y.slice(i, y.length - j).join(""), post = x.slice(x.length - j).join("");
    return h("div", { class: "ln-diff mono small", role: "group", "aria-label": "Skill text change" },
      h("div", { class: "ln-diff-line is-del" }, h("span", { class: "ln-diff-sign", "aria-hidden": "true" }, "−"), h("span", { class: "sr-only" }, "Before: "), pre, del ? h("del", null, del) : null, post),
      h("div", { class: "ln-diff-line is-ins" }, h("span", { class: "ln-diff-sign", "aria-hidden": "true" }, "+"), h("span", { class: "sr-only" }, "After: "), pre, ins ? h("ins", null, ins) : null, post));
  }

  /* what a proposal changes, in plain terms */
  function changeView(lp) {
    var c = lp.change || {};
    if (lp.kind === "skill") {
      var sk = G.find.skill(c.skill);
      return h("div", null, h("div", { class: "small" }, "Skill ", h("strong", null, sk ? sk.name : c.skill), sk ? h("span", { class: "mono muted" }, " v" + sk.version + (lp.status === "proposed" ? " → next minor version" : "")) : null), wordDiff(c.before, c.after));
    }
    if (lp.kind === "eval") { var su = G.find.suite(c.suite); return h("p", { class: "small" }, "Add case ", h("strong", null, "“" + ((c.case || {}).name || lp.title) + "”"), " to ", h("span", { class: "mono" }, c.suite), su ? " (" + su.cases.length + " cases now, gate " + G.fmt.pct(su.threshold) + ")" : ""); }
    if (lp.kind === "guideline") return h("p", { class: "small" }, "Add to " + projName(c.project) + " onboarding guidelines" + (c.item && c.item.required ? " (required)" : "") + ": ", h("strong", null, "“" + ((c.item || {}).text || "") + "”"));
    if (lp.kind === "guardrail") { var a = G.find.agent(c.agent); return h("p", { class: "small" }, agName(c.agent) + " must not touch ", h("span", { class: "mono" }, c.path), a && a.guardrails ? h("span", { class: "muted" }, " (now: " + (a.guardrails.paths.join(", ") || "none") + ")") : null); }
    if (lp.kind === "approver") { var g = G.gateDef(c.gate); return h("p", { class: "small" }, projName(c.project) + " " + (g ? g.label : c.gate) + ": add condition ", h("strong", null, "“" + ((c.condition || {}).text || "") + "”")); }
    if (lp.kind === "route") { var st = G.find.station(c.addSkip); return h("p", { class: "small" }, (G.find.cls(c.cls) || { name: c.cls }).name + " on " + projName(c.project) + " skips ", h("strong", null, st ? st.name : c.addSkip)); }
    return h("p", { class: "small muted" }, "No change details.");
  }

  function pipeline(lp) {
    var steps = lp.status === "declined" ? ["proposed", "declined"] : ["proposed", "accepted", "verified"];
    var at = steps.indexOf(lp.status);
    return h("ol", { class: "ln-pipe", "aria-label": "Status: " + STATUS[lp.status] }, steps.map(function (s, i) {
      return h("li", { class: (i < at ? "is-done" : i === at ? "is-on" : "") + (s === "declined" ? " is-declined" : "") }, h("span", { class: "ln-pipe-dot", "aria-hidden": "true" }, i < at ? "✓" : s === "declined" ? "×" : String(i + 1)), STATUS[s]);
    }));
  }

  /* ---------------- proposals ---------------- */
  function proposalsTab() {
    var L = S().learning;
    var all = L.proposals.filter(function (lp) { return seesProject(lp.change && lp.change.project) && seesProject((G.find.finding(lp.finding) || {}).project); }).slice().reverse();
    var counts = { open: 0, accepted: 0, verified: 0, declined: 0 };
    all.forEach(function (lp) { counts[lp.status === "proposed" ? "open" : lp.status]++; });
    var shown = all.filter(function (lp) { return ui.status === "all" || (ui.status === "open" ? lp.status === "proposed" : lp.status === ui.status); });
    var strip = h("ol", { class: "ln-strip", "aria-label": "Proposals by status" },
      [["open", "Proposed"], ["accepted", "Accepted and applied"], ["verified", "Verified"], ["declined", "Declined"]].map(function (x) {
        return h("li", null, h("button", { type: "button", class: "ln-strip-b" + (ui.status === x[0] ? " is-on" : ""), id: "ln-st-" + x[0], "aria-pressed": ui.status === x[0] ? "true" : "false", onclick: function () { ui.status = x[0]; G.rerender(); } }, h("span", { class: "ln-strip-n" }, String(counts[x[0]])), h("span", null, x[1])));
      }).concat([h("li", null, h("button", { type: "button", class: "ln-strip-b" + (ui.status === "all" ? " is-on" : ""), id: "ln-st-all", "aria-pressed": ui.status === "all" ? "true" : "false", onclick: function () { ui.status = "all"; G.rerender(); } }, h("span", { class: "ln-strip-n" }, String(all.length)), h("span", null, "All")))]));
    return h("div", { class: "ln-props" }, strip,
      shown.length ? h("ul", { class: "ln-list" }, shown.map(proposalCard)) : G.emptyState({ id: "ln-props-empty", icon: "learn", title: "Nothing here", text: ui.status === "open" ? "No proposals are waiting. Draft one from a finding." : "No proposals with this status." }));
  }
  function proposalCard(lp) {
    var f = G.find.finding(lp.finding);
    var perm = G.me("learning.apply", scopeOf(lp));
    var acts = [];
    if (lp.status === "proposed") {
      acts.push(G.btn("Accept and apply", { small: true, kind: "primary", icon: "check", id: "ln-accept-" + lp.id, guard: perm, onClick: function () { acceptDialog(lp); } }));
      acts.push(G.btn("Decline", { small: true, icon: "x", id: "ln-decline-" + lp.id, guard: perm, onClick: function () {
        G.reasonDialog({ title: "Decline " + lp.id, kicker: "Learning · " + KINDS[lp.kind].name, sub: lp.title + ". Nothing changes; the finding stays open.", label: "Reason (required)", ok: "Decline", kind: "danger", min: 4, guard: perm,
          onOk: function (t) { var r = G.ops.declineLearning(lp.id, t); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      } }));
    }
    if (lp.status === "accepted") acts.push(G.btn("Mark verified", { small: true, icon: "eval", id: "ln-verify-" + lp.id, guard: G.me("learning.apply"), onClick: function () { verifyDialog(lp); } }));
    if (lp.kind === "skill" && lp.status !== "proposed" && lp.status !== "declined" && G.find.skill(lp.change.skill)) {
      var sk = G.find.skill(lp.change.skill);
      acts.push(h("a", { href: "#skills", class: "btn btn-sm btn-ghost", id: "ln-open-skill-" + lp.id, onclick: function () { if (G.skillsSelect) G.skillsSelect(sk.id, "versions"); } }, G.icon("skill"), h("span", null, "Open " + sk.name + " v" + sk.version)));
    }
    var last = lp.history[lp.history.length - 1];
    return h("li", { class: "panel ln-card is-" + lp.status + (ui.hi === lp.id ? " is-hi" : ""), id: "ln-prop-" + lp.id },
      h("div", { class: "ln-card-top" }, h("span", { class: "mono strong" }, lp.id), h("span", { class: "chip ln-kind" }, G.icon(KINDS[lp.kind].icon), KINDS[lp.kind].name), h("h3", { class: "ln-title" }, lp.title)),
      pipeline(lp),
      h("div", { class: "ln-card-grid" },
        h("div", { class: "ln-change" }, h("div", { class: "kicker" }, "Change"), changeView(lp)),
        h("dl", { class: "ln-kv" },
          h("div", null, h("dt", null, "Expected effect"), h("dd", null, lp.expected || "–")),
          h("div", null, h("dt", null, "Owner"), h("dd", null, G.actorName(lp.owner))),
          h("div", null, h("dt", null, "From finding"), h("dd", null, f ? h("button", { type: "button", class: "linkish", id: "ln-goto-f-" + lp.id, onclick: function () { G.learningFocus({ finding: f.id }); G.rerender(); } }, f.id + " " + f.title) : lp.finding)),
          f ? h("div", null, h("dt", null, "Evidence (" + f.evidence.length + ")"), h("dd", null, chipList(f.evidence, 6))) : null,
          lp.status === "declined" && lp.reason ? h("div", null, h("dt", null, "Declined because"), h("dd", null, lp.reason)) : null)),
      h("div", { class: "ln-card-foot" }, h("span", { class: "small muted" }, last ? G.fmt.stamp(last.at) + " · " + G.actorName(last.by) + ": " + last.text : ""), acts.length ? h("span", { class: "ln-acts" }, acts) : null));
  }
  function acceptDialog(lp) {
    var perm = G.me("learning.apply", scopeOf(lp));
    var note = h("input", { id: "ln-acc-note", class: "input", placeholder: "Optional note for the audit entry" });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: "Accept " + lp.id, kicker: "Learning · " + KINDS[lp.kind].name, wide: true,
      sub: "Applies the change now through the normal operation, with its own permission check and audit entry, then marks the finding addressed.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Applying learning proposals"), h("div", { class: "ln-change" }, changeView(lp)), h("p", { class: "small" }, h("strong", null, "Expected: "), lp.expected), G.field("Note", note, null, "ln-acc-note"), err),
      actions: [{ label: "Cancel" }, { label: "Accept and apply", kind: "primary", submit: true, id: "ln-acc-ok", guard: perm, onClick: function (close) {
        var r = G.ops.acceptLearning(lp.id, note.value.trim());
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); ui.status = "accepted"; ui.hi = lp.id; close();
      } }] });
  }
  function verifyDialog(lp) {
    var perm = G.me("learning.apply");
    G.dialog({ title: "Verify " + lp.id, kicker: "Learning · verification", sub: "Record that the expected effect showed up. In this demo the eval check is simulated.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Verifying proposals"), h("p", { class: "small" }, h("strong", null, "Expected: "), lp.expected)),
      actions: [{ label: "Cancel" }, { label: "Mark verified", kind: "primary", submit: true, id: "ln-ver-ok", guard: perm, onClick: function (close) { var r = G.ops.verifyLearning(lp.id); G.toast(r.msg, r.ok ? "ok" : "error"); if (r.ok) { ui.status = "verified"; close(); } } }] });
  }

  /* ---------------- findings ---------------- */
  function findingsTab() {
    var L = S().learning;
    var list = L.findings.filter(function (f) { return seesProject(f.project); }).slice().sort(function (a, b) { return (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.lastAt - a.lastAt; });
    var refreshGuard = G.me("learning.apply");
    return h("div", { class: "ln-findings" },
      h("div", { class: "toolbar" }, h("span", { class: "small muted" }, "Findings group repeated signals by agent and project. Refreshing recounts evidence from live work orders."),
        G.btn("Refresh findings", { small: true, icon: "refresh", id: "ln-refresh", guard: refreshGuard, onClick: function () { var r = G.ops.refreshFindings(); G.toast(r.msg, r.ok ? "ok" : "error"); } })),
      list.length ? h("ul", { class: "ln-list" }, list.map(findingCard)) : G.emptyState({ id: "ln-f-empty", icon: "learn", title: "No findings", text: "Findings appear when the same kind of signal repeats." }));
  }
  function findingCard(f) {
    var props = S().learning.proposals.filter(function (lp) { return lp.finding === f.id; });
    var perm = G.me("learning.apply", f.project ? { project: f.project } : undefined);
    var sg = SIGNALS[f.signal] || [f.signal, "alert"];
    var thin = f.count < 3;
    return h("li", { class: "panel ln-card ln-finding is-" + f.status + (ui.hiFinding === f.id ? " is-hi" : ""), id: "ln-f-" + f.id },
      h("div", { class: "ln-card-top" }, h("span", { class: "mono strong" }, f.id), h("span", { class: "chip ln-sig ln-sig-" + f.signal }, G.icon(sg[1]), sg[0]), h("h3", { class: "ln-title" }, f.title),
        h("span", { class: "chip" + (f.status === "open" ? " chip-warn" : "") }, f.status === "open" ? "Open" : "Addressed")),
      h("dl", { class: "ln-kv ln-kv-row" },
        h("div", null, h("dt", null, "Agent"), h("dd", null, agName(f.agent))),
        h("div", null, h("dt", null, "Project"), h("dd", null, projName(f.project))),
        h("div", null, h("dt", null, "Signals"), h("dd", { class: "mono" }, String(f.count), thin ? h("span", { class: "small muted" }, " · small sample") : null)),
        h("div", null, h("dt", null, "Seen"), h("dd", { class: "small" }, G.fmt.istDate(f.firstAt) + (f.lastAt !== f.firstAt ? " to " + G.fmt.istDate(f.lastAt) : "")))),
      h("div", null, h("div", { class: "kicker" }, "Evidence: work order records"), chipList(f.evidence, 10)),
      h("div", { class: "ln-card-foot" },
        h("span", { class: "small" }, props.length ? h("span", null, "Proposals: ", props.map(function (lp) { return h("button", { type: "button", class: "linkish ln-plink", id: "ln-f-p-" + lp.id, onclick: function () { G.learningFocus({ proposal: lp.id }); G.rerender(); } }, lp.id + " (" + STATUS[lp.status].toLowerCase() + ")"); })) : h("span", { class: "muted" }, "No proposal yet.")),
        h("span", { class: "ln-acts" }, G.btn("Draft proposal", { small: true, icon: "plus", id: "ln-draft-" + f.id, guard: perm, onClick: function () { draftDialog(f); } }))));
  }

  /* ---------------- draft dialog (with Claude or by hand) ---------------- */
  function defaultKind(f) { return { rejection: "skill", sendback: "guardrail", revert: "guideline", incident: "approver", override: "eval", miss: "skill" }[f.signal] || "skill"; }
  function draftDialog(f) {
    var perm = G.me("learning.apply", f.project ? { project: f.project } : undefined);
    var visP = G.visibleProjects(G.viewerId()).filter(function (p) { return p.status !== "archived"; });
    var ag = G.find.agent(f.agent);
    var d = { kind: defaultKind(f), title: "", expected: "", skill: ag && ag.skills[0] || (S().skills[0] || {}).id, after: "", suite: ag ? ag.suite : S().suites[0].id, caseName: "",
      project: f.project || (visP[0] || {}).id, text: "", required: true, agent: f.agent || "ag-build", path: "", gate: "", condText: "", condPath: "", condRole: "reviewer", cls: "", skip: "" };
    function skillBody() { var sk = G.find.skill(d.skill); return sk ? sk.body : ""; }
    d.after = skillBody();
    var err = h("div", { class: "form-err", role: "alert" });
    var form = h("div", { class: "form-grid", id: "ln-draft-form" });
    var stream = h("div", { class: "ln-stream small", id: "ln-draft-stream", "aria-live": "polite" });
    var askCtl = null;
    function inp(id, key, ph, rows) {
      var el = rows ? h("textarea", { id: id, class: "input" + (key === "after" ? " mono" : ""), rows: String(rows), placeholder: ph || "" }) : h("input", { id: id, class: "input", placeholder: ph || "" });
      el.value = d[key] || ""; el.addEventListener("input", function () { d[key] = el.value; }); if (!perm.allowed) el.disabled = true; return el;
    }
    function sel(id, opts, key, after) { var s = G.select(id, opts, d[key], function (v) { d[key] = v; if (after) after(); }); if (!perm.allowed) s.disabled = true; return s; }
    function paint() {
      G.clear(form);
      var p = G.find.project(d.project);
      var flow = p ? G.flowOf(p) : null;
      G.append(form, G.lockNote(perm, "Drafting proposals"));
      form.appendChild(h("div", { class: "form-row" }, G.field("Kind of change", sel("ln-d-kind", Object.keys(KINDS).map(function (k) { return { value: k, label: KINDS[k].name }; }), "kind", paint), null, "ln-d-kind"), G.field("Title", inp("ln-d-title", "title", "What the change does"), null, "ln-d-title")));
      if (d.kind === "skill") {
        form.appendChild(G.field("Skill", sel("ln-d-skill", S().skills.map(function (s) { return { value: s.id, label: s.name + " v" + s.version }; }), "skill", function () { d.after = skillBody(); paint(); }), null, "ln-d-skill"));
        form.appendChild(G.field("New skill text", inp("ln-d-after", "after", "", 4), "Accepting saves this as the next version of the skill.", "ln-d-after"));
        form.appendChild(wordDiff(skillBody(), d.after));
      } else if (d.kind === "eval") {
        form.appendChild(h("div", { class: "form-row" }, G.field("Suite", sel("ln-d-suite", S().suites.map(function (s) { return { value: s.id, label: s.id + " · " + s.name }; }), "suite"), null, "ln-d-suite"), G.field("Case name", inp("ln-d-case", "caseName", "e.g. Regression described as a feature"), null, "ln-d-case")));
      } else if (d.kind === "guideline") {
        var req = h("input", { type: "checkbox", id: "ln-d-req", checked: d.required, disabled: !perm.allowed }); req.addEventListener("change", function () { d.required = req.checked; });
        form.appendChild(G.field("Project", sel("ln-d-proj", visP.map(function (x) { return { value: x.id, label: x.name }; }), "project", paint), null, "ln-d-proj"));
        form.appendChild(G.field("Guideline text", inp("ln-d-text", "text", "What every repo must have", 2), null, "ln-d-text"));
        form.appendChild(h("label", { class: "check", for: "ln-d-req" }, req, "Required for Ready"));
      } else if (d.kind === "guardrail") {
        form.appendChild(h("div", { class: "form-row" }, G.field("Agent", sel("ln-d-agent", S().agents.map(function (a) { return { value: a.id, label: a.name }; }), "agent"), null, "ln-d-agent"), G.field("Path it must not touch", inp("ln-d-path", "path", "e.g. infra/prod/**"), null, "ln-d-path")));
      } else if (d.kind === "approver") {
        var gates = flow ? flow.gates.filter(function (g) { return g.enabled && g.mode !== "auto"; }) : [];
        if (!gates.some(function (g) { return g.id === d.gate; })) d.gate = gates[0] ? gates[0].id : "";
        var roles = G.ROLES.filter(function (r) { return r.level === "project" && (!r.custom || !r.project || r.project === d.project); });
        form.appendChild(h("div", { class: "form-row" }, G.field("Project", sel("ln-d-proj", visP.map(function (x) { return { value: x.id, label: x.name }; }), "project", paint), null, "ln-d-proj"),
          G.field("Gate", sel("ln-d-gate", gates.map(function (g) { return { value: g.id, label: g.label + " " + g.name }; }), "gate"), null, "ln-d-gate")));
        form.appendChild(h("div", { class: "form-row" }, G.field("When the change touches path", inp("ln-d-cpath", "condPath", "e.g. ingest/"), null, "ln-d-cpath"), G.field("Also needs", sel("ln-d-role", roles.map(function (r) { return { value: r.id, label: r.name }; }), "condRole"), null, "ln-d-role")));
        form.appendChild(G.field("Condition in words", inp("ln-d-ctext", "condText", "e.g. Ingest changes need a Reviewer"), null, "ln-d-ctext"));
      } else if (d.kind === "route") {
        var classes = p ? G.classesOf(p) : [];
        if (!classes.some(function (c) { return c.id === d.cls; })) d.cls = classes[0] ? classes[0].id : "";
        var sts = flow ? flow.stations.filter(function (s) { return s.id !== "intake" && s.id !== "close"; }) : [];
        if (!sts.some(function (s) { return s.id === d.skip; })) d.skip = sts[0] ? sts[0].id : "";
        form.appendChild(h("div", { class: "form-row" }, G.field("Project", sel("ln-d-proj", visP.map(function (x) { return { value: x.id, label: x.name }; }), "project", paint), null, "ln-d-proj"),
          G.field("Class", sel("ln-d-cls", classes.map(function (c) { return { value: c.id, label: c.name }; }), "cls"), null, "ln-d-cls"),
          G.field("Skip station", sel("ln-d-skip", sts.map(function (s) { return { value: s.id, label: s.no + " " + s.name }; }), "skip"), null, "ln-d-skip")));
      }
      form.appendChild(G.field("Expected effect", inp("ln-d-exp", "expected", "What should change, and how you will know", 2), null, "ln-d-exp"));
    }
    function changeObj() {
      if (d.kind === "skill") return { skill: d.skill, before: skillBody(), after: d.after };
      if (d.kind === "eval") return { suite: d.suite, case: { name: d.caseName || d.title } };
      if (d.kind === "guideline") return { project: d.project, item: { text: d.text, required: !!d.required } };
      if (d.kind === "guardrail") return { agent: d.agent, path: d.path };
      if (d.kind === "approver") return { project: d.project, gate: d.gate, condition: { when: { type: "path", value: d.condPath }, needs: { roles: [d.condRole], people: [], oncall: false }, text: d.condText || "Changes under " + d.condPath + " need " + ((G.find.role(d.condRole) || {}).name || d.condRole) } };
      return { project: d.project, cls: d.cls, addSkip: d.skip };
    }
    function validate() {
      if (!d.title.trim()) return "Give the proposal a title.";
      if (d.kind === "skill" && d.after.trim() === skillBody().trim()) return "Change the skill text.";
      if (d.kind === "guideline" && d.text.trim().length < 6) return "Write the guideline.";
      if (d.kind === "guardrail" && !d.path.trim()) return "Name the path.";
      if (d.kind === "approver" && (!d.gate || !d.condPath.trim())) return "Pick a gate and a path.";
      if (d.kind === "route" && (!d.cls || !d.skip)) return "Pick a class and a station.";
      return null;
    }
    /* scripted draft from the finding: used when Claude is unavailable */
    function localDraft() {
      var sig = (SIGNALS[f.signal] || [f.signal])[0].toLowerCase();
      var out = { kind: d.kind, title: "", expected: "Fewer " + sig + " signals like " + f.id + " (" + f.count + " in the window).", note: "Drafted locally from " + f.id + "." };
      if (d.kind === "skill") { var sk = G.find.skill(d.skill); out.title = (sk ? sk.name : "Skill") + ": address " + f.title.toLowerCase(); out.after = skillBody().replace(/\s*$/, "") + " Check for this before finishing: " + f.title.replace(/^[A-Z]/, function (c) { return c.toLowerCase(); }) + "."; }
      else if (d.kind === "eval") { out.title = "Eval case for " + f.title.toLowerCase(); out.caseName = f.title; }
      else if (d.kind === "guideline") { out.title = projName(d.project) + " guideline: " + f.title.toLowerCase(); out.text = "Repos must cover this before work starts: " + f.title.toLowerCase() + "."; }
      else if (d.kind === "guardrail") { out.title = agName(d.agent) + " guardrail from " + f.id; out.path = d.path || ".github/workflows/**"; }
      else if (d.kind === "approver") { out.title = projName(d.project) + ": second approver for " + f.title.toLowerCase(); out.condText = "Changes like " + f.id + " need a " + ((G.find.role(d.condRole) || {}).name || "Reviewer"); }
      else { out.title = "Route change from " + f.id; }
      return out;
    }
    function applyDraft(o) {
      ["title", "expected", "after", "caseName", "text", "path", "condText", "condPath"].forEach(function (k) { if (o[k] && typeof o[k] === "string") d[k] = o[k]; });
      paint();
    }
    function draftWithClaude() {
      if (askCtl) return;
      var local = localDraft();
      var sigs = G.learning.signals().filter(function (x) { return f.evidence.indexOf(x.wo) >= 0 && x.signal === f.signal; }).slice(0, 12).map(function (x) { return x.wo + ": " + x.text; });
      askCtl = new AbortController();
      stream.textContent = "Drafting…"; paintBtn();
      G.ask({
        instructions: "You draft one improvement proposal for a software factory's learning loop. Reply with a single JSON object only, no prose, with keys: title (under 70 characters), expected (one sentence: the measurable effect), and for kind skill: after (the full new skill text); for eval: caseName; for guideline: text; for guardrail: path; for approver: condText and condPath. Keep the existing skill text and add to it.",
        data: { finding: { id: f.id, title: f.title, signal: f.signal, agent: agName(f.agent), project: projName(f.project), count: f.count }, kind: d.kind, signals: sigs, currentSkill: d.kind === "skill" ? { name: (G.find.skill(d.skill) || {}).name, body: skillBody() } : undefined },
        question: "Draft the " + KINDS[d.kind].name.toLowerCase() + " proposal for finding " + f.id + ".",
        signal: askCtl.signal,
        onText: function (full) { stream.textContent = full.slice(-400); },
        fallback: function () { return { text: JSON.stringify(local) }; }
      }).then(function (r) {
        askCtl = null;
        var o = null, m = String(r.text || "").match(/\{[\s\S]*\}/);
        try { o = m ? JSON.parse(m[0]) : null; } catch (e) { o = null; }
        if (r.error === "aborted") { stream.textContent = "Stopped. Nothing was filled in."; paintBtn(); return; }
        if (!o) { o = local; stream.textContent = "Claude's reply was not a draft I could read, so the fields use the local draft."; }
        else stream.textContent = r.mode === "claude" ? "Drafted by Claude. Review every field before saving." : "Filled in from the local draft. " + G.ask.reason();
        applyDraft(o); paintBtn();
      });
    }
    var askBtnBox = h("span", { class: "ln-askbtn" });
    function paintBtn() {
      G.clear(askBtnBox);
      askBtnBox.appendChild(askCtl ? G.btn("Stop", { small: true, icon: "x", id: "ln-d-stop", onClick: function () { if (askCtl) askCtl.abort(); } })
        : G.btn("Draft with Claude", { small: true, icon: "sparkle", id: "ln-d-ask", guard: perm, onClick: draftWithClaude }));
    }
    paint(); paintBtn();
    G.dialog({ title: "Draft a proposal from " + f.id, kicker: "Learning · " + f.title, wide: true,
      sub: "Evidence: " + f.count + " " + (SIGNALS[f.signal] || [f.signal])[0].toLowerCase() + " signals. A draft is only a proposal; accepting it later applies the change.",
      body: h("div", { class: "ln-draft" }, h("div", { class: "ln-askbar" }, askBtnBox, G.ask.badge("ln-d-badge"), stream), form, err),
      onClose: function () { if (askCtl) askCtl.abort(); },
      actions: [{ label: "Cancel" }, { label: "Save draft", kind: "primary", submit: true, id: "ln-d-ok", guard: perm, onClick: function (close) {
        var v = validate(); if (v) { err.textContent = v; return; }
        var r = G.ops.draftLearning(f.id, { kind: d.kind, title: d.title, change: changeObj(), expected: d.expected });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); ui.tab = "proposals"; ui.status = "open"; ui.hi = r.proposal.id; close();
      } }] });
  }

  /* ---------------- signals ---------------- */
  function signalsTab() {
    var all = G.learning.signals().filter(function (x) { return seesProject(x.project); });
    var counts = {}; all.forEach(function (x) { counts[x.signal] = (counts[x.signal] || 0) + 1; });
    var rows = all.filter(function (x) { return ui.sigType === "all" || x.signal === ui.sigType; });
    var since = Date.now() - 7 * G.DAY, week = all.filter(function (x) { return x.at >= since; }).length;
    return h("div", { class: "ln-signals" },
      h("div", { class: "toolbar" }, G.segmented("ln-sig", [{ id: "all", label: "All " + all.length }].concat(Object.keys(SIGNALS).map(function (k) { return { id: k, label: SIGNALS[k][0] + " " + (counts[k] || 0) }; })), ui.sigType, function (v) { ui.sigType = v; G.rerender(); }, "Signal type"),
        h("span", { class: "small muted" }, week + " in the last 7 days. Signals come from the work order records.")),
      G.dataTable({ id: "ln-sig-table", caption: "Learning signals", rows: rows, pageSize: 25, sort: { key: "at", dir: -1 }, rowKey: function (x) { return x.wo + x.signal + x.at; },
        empty: { title: "No signals", text: "Nothing of this type has been recorded." },
        columns: [
          { key: "at", label: "When", sort: true, render: function (x) { return h("span", { class: "mono small" }, G.fmt.istDate(x.at)); } },
          { key: "signal", label: "Signal", sort: true, render: function (x) { var sg = SIGNALS[x.signal] || [x.signal, "alert"]; return h("span", { class: "chip ln-sig ln-sig-" + x.signal }, G.icon(sg[1]), sg[0]); } },
          { key: "wo", label: "Record", sort: true, render: function (x) { return G.entityChip({ type: "wo", id: x.wo }); } },
          { key: "project", label: "Project", sort: true, hideSmall: true, render: function (x) { return projName(x.project); } },
          { key: "agent", label: "Agent", sort: true, render: function (x) { return x.agent ? agName(x.agent) : "–"; } },
          { key: "text", label: "What happened", render: function (x) { return h("span", { class: "small" }, x.text + (x.gate ? " (" + ((G.gateDef(x.gate) || {}).label || x.gate) + ")" : "")); } }
        ] }));
  }

  function render() {
    var L = S().learning;
    var findings = L.findings.filter(function (f) { return seesProject(f.project); });
    var props = L.proposals.filter(function (lp) { return seesProject(lp.change && lp.change.project); });
    var open = props.filter(function (lp) { return lp.status === "proposed"; }).length;
    var signals = G.learning.signals().filter(function (x) { return seesProject(x.project) && x.at >= Date.now() - 7 * G.DAY; }).length;
    var tabs = [{ id: "proposals", label: "Proposals", count: open }, { id: "findings", label: "Findings", count: findings.filter(function (f) { return f.status === "open"; }).length }, { id: "signals", label: "Signals" }];
    var body = ui.tab === "findings" ? findingsTab() : ui.tab === "signals" ? signalsTab() : proposalsTab();
    var perm = G.me("learning.apply");
    return h("div", { class: "view view-learning" },
      G.pageHeader({ id: "ln-head", kicker: "Agents · Sheet 18", title: "Learning", sub: "What the factory learns from its own outcomes: repeated rejections, send-backs, reverts and misses become proposed changes to skills, guidelines, evals, guardrails, approver rules and routes.",
        meta: [["Open findings", String(findings.filter(function (f) { return f.status === "open"; }).length)], ["To review", String(open)], ["Applied", String(props.filter(function (lp) { return lp.status === "accepted"; }).length)], ["Verified", String(props.filter(function (lp) { return lp.status === "verified"; }).length)], ["Signals 7d", String(signals)]] }),
      perm.allowed ? null : G.lockNote(perm, "Applying learning proposals"),
      G.tabBar({ id: "ln-tab", items: tabs, active: ui.tab, onChange: function (t) { ui.tab = t; ui.hi = null; ui.hiFinding = null; G.rerender(); } }),
      h("div", { id: "ln-tab-panel", role: "tabpanel", class: "ln-panel" }, body));
  }

  G.views.learning = { title: "Learning", render: render, keys: ["learning", "skills", "suites", "agents", "projects", "workOrders"] };
})(window.G);
