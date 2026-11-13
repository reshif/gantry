/* Work order record (#record) and G.renderLifecycle(wo, { compact }) for the traveler's Lifecycle tab.
   The whole lifecycle of one work order in eleven sections, summary first: request, clarification,
   agreement, station by station, changes (files tree / commits), verification, merge and release,
   approvals, after release, full timeline. Completeness meter, journey scrubber, "Copy as Markdown",
   "Rewrite summary" through G.ask with a local fallback. With no record selected: a record picker.
   Data comes from G.lc (lifecycle.js), G.replay.journey and the audit ledger. Contract: CONTRACT.md §R3.4. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};

  var SECTIONS = [
    { id: "summary", label: "Summary" }, { id: "request", label: "Request" }, { id: "clarification", label: "Clarification" },
    { id: "agreement", label: "Agreement" }, { id: "stations", label: "Station by station" }, { id: "changes", label: "Changes" },
    { id: "verification", label: "Verification" }, { id: "merge", label: "Merge and release" }, { id: "approvals", label: "Approvals" },
    { id: "after", label: "After release" }, { id: "timeline", label: "Full timeline" }
  ];
  var SOURCES = { ui: "Gantry web", web: "Gantry web", console: "Gantry console", slack: "Slack", github: "GitHub issue trigger", api: "API", issue: "Issue trigger", schedule: "Schedule", ci: "Failing CI" };
  var ui = {
    v: 0,                      // bumps on local UI changes so the render cache refreshes
    group: "file",             // changes: "file" | "commit"
    open: {},                  // <details> open state by key
    scrub: {},                 // woId -> event index
    rw: null,                  // rewrite: { wo, busy, text, mode, error, ctrl }
    timelineAll: {},
    pick: { q: "", project: null, stage: "all", viewer: null, sort: { key: "id", dir: -1 } }
  };
  var cache = { key: null, node: null };
  function bump() { ui.v++; G.rerender(); }

  /* ---------------- small helpers ---------------- */
  function actor(id) { return id ? G.actorName(id).replace(" (agent)", "") : "someone"; }
  function isAgent(id) { return !!(id && G.find.agent(id)); }
  function stName(sid) { var s = G.stationDef(sid) || G.find.station(sid); return s ? s.name : sid; }
  function stNo(sid) { var s = G.stationDef(sid); return s ? s.no : ""; }
  function clsName(id) { var c = G.find.cls(id); return c ? c.name : id; }
  function roleName(id) { var r = G.find.role(id); return r ? r.name : id; }
  function gateName(id) { var g = G.gateDef(id); return g ? g.label + " " + g.name : id; }
  function trustText(n) { if (n == null) return null; var l = G.trust && G.trust.level ? G.trust.level(n) : null; return l ? l.code + " " + l.name : "L" + n; }
  function when(t) { return t ? G.fmt.stamp(t) : "not yet"; }
  function sum(files, k) { return (files || []).reduce(function (t, f) { return t + (f[k] || 0); }, 0); }
  function plural(n, w, p) { return n + " " + (n === 1 ? w : (p || w + "s")); }
  function canSee(wo) { return !!wo && G.visibleProjects(G.viewerId()).some(function (p) { return p.id === wo.project; }); }
  function srcName(s) { return SOURCES[s] || s || "unknown"; }
  function sid(pre, s) { return pre + "sec-" + s; }

  /* provenance tag: who produced the data in a block */
  function prov(kind, text) {
    var map = { system: ["Observed by Gantry", "ledger"], agent: ["Reported by the agent", "agent"], person: ["Written by a person", "human"], mixed: ["Agents and people", "human"] };
    var m = map[kind] || map.system;
    return h("span", { class: "rec-prov rec-prov-" + kind, title: text || m[0] }, G.icon(m[1]), h("span", null, text || m[0]));
  }
  function none(text) { return h("p", { class: "rec-none muted small" }, text); }
  function kv(k, v) { return h("div", { class: "rec-kv" }, h("dt", null, k), h("dd", null, v == null || v === "" ? "–" : v)); }
  function chipLink(label, onClick, id, title) { return h("button", { type: "button", class: "linkish mono", id: id || null, title: title || null, onClick: onClick }, label); }
  function woLink(id, pre) { return chipLink(id, function () { G.openRecord(id); }, pre ? pre + "wo-" + id + "-" + Math.random().toString(36).slice(2, 6) : null, "Open the record for " + id); }

  /* <details> that remembers its open state across re-renders */
  function fold(key, summary, body, defOpen) {
    var open = ui.open[key] == null ? !!defOpen : ui.open[key];
    var d = h("details", { class: "rec-fold", open: open }, h("summary", null, summary), body);
    d.addEventListener("toggle", function () { ui.open[key] = d.open; });
    return d;
  }

  /* ---------------- derived record facts ---------------- */
  function visits(wo) { return (wo.history || []).filter(function (e) { return e.station; }); }
  function routeTaken(wo) {
    var out = [];
    visits(wo).forEach(function (e) { if (out[out.length - 1] !== e.station) out.push(e.station); });
    return out;
  }
  function peopleOf(wo) {
    var ids = [wo.requestedBy];
    Object.keys(wo.gates || {}).forEach(function (g) { (wo.gates[g].approvals || []).forEach(function (a) { ids.push(a.by); }); (wo.gates[g].rejections || []).forEach(function (a) { ids.push(a.by); }); });
    (wo.conv ? wo.conv.messages : []).forEach(function (m) { ids.push(m.from); });
    (wo.sendbacks || []).forEach(function (s) { ids.push(s.by); });
    (wo.briefVersions || []).forEach(function (b) { ids.push(b.by); });
    if (wo.clsOverridden) ids.push(wo.clsOverridden.by);
    (wo.reviewComments || []).forEach(function (c) { ids.push(c.by); });
    return ids.filter(function (x, i, a) { return x && a.indexOf(x) === i && G.find.person(x); });
  }
  function agentsOf(wo) {
    var ids = visits(wo).map(function (e) { return e.agent; }).concat((wo.commits || []).map(function (c) { return c.agent; }), (wo.reviewComments || []).map(function (c) { return c.by; }));
    return ids.filter(function (x, i, a) { return x && a.indexOf(x) === i && G.find.agent(x); });
  }
  function endAt(wo) { return wo.doneAt || (wo.killed && wo.killed.at) || Date.now(); }
  function stateLine(wo) {
    var st = G.STATIONS[wo.station];
    if (wo.state === "done") return "Shipped" + (wo.pr && wo.pr.tag ? " as " + wo.pr.tag : "");
    if (wo.state === "killed") return "Killed";
    if (wo.bay) return "In " + ((G.bayDef(wo.bay) || {}).name || wo.bay);
    return G.STATES[wo.state].label + " at " + (st ? st.name : "a station");
  }
  function summaryOf(wo) { return wo.recordSummary && wo.recordSummary.text ? wo.recordSummary.text : G.lc.summaryText(wo); }
  function qaPairs(wo) {
    var msgs = wo.conv ? wo.conv.messages : [], out = [];
    msgs.forEach(function (m, i) {
      if (!m.qid) return;
      var ans = null;
      for (var k = i + 1; k < msgs.length; k++) { if (msgs[k].qid) break; if (!isAgent(msgs[k].from)) { ans = msgs[k]; break; } }
      out.push({ q: m, a: ans });
    });
    return out;
  }
  function journey(wo) { return G.replay && G.replay.journey ? G.replay.journey(wo.id) : []; }
  function auditFor(wo) {
    return G.store.get("audit").filter(function (e) { return (e.entity && e.entity.type === "wo" && e.entity.id === wo.id) || String(e.target || "").indexOf(wo.id) >= 0; });
  }
  function eventText(e, wo) {
    switch (e.type) {
      case "wo.submit": return "Submitted by " + actor(e.by) + (e.text ? ": " + e.text : "");
      case "wo.enter": return "Entered " + stNo(e.station) + " " + stName(e.station);
      case "gate.decision": return gateName(e.gate) + " " + (e.mode === "auto" ? "passed its automatic checks" : e.mode === "trust" ? "passed under trust " + trustText(e.trust) : "approved by " + actor(e.by) + (e.trust != null ? " (trust in force " + trustText(e.trust) + ")" : ""));
      case "trust.auto": return gateName(e.gate) + " passed under trust " + trustText(e.trust);
      case "wo.bay": return e.bay ? "Moved to " + ((G.bayDef(e.bay) || {}).name || e.bay) + (e.text ? ": " + e.text : "") : "Back on the belt from " + ((G.bayDef(e.from) || {}).name || e.from || "a bay");
      case "wo.state": return e.to === "failed" ? "Failed" + (e.text ? ": " + e.text : "") : e.to === "blocked" ? "Blocked" + (e.text ? ": " + e.text : "") : e.to === "killed" ? "Killed" : "Running again after " + e.from;
      case "outcome": return "Post-release " + (e.mode === "followup" ? "follow-up" : e.mode) + " recorded by " + actor(e.by) + (e.text ? ": " + e.text : "");
      case "release": return "Released" + (e.text ? " " + e.text : wo.pr && wo.pr.tag ? " " + wo.pr.tag : "");
      case "wo.done": return "Closed and shipped";
      case "kill": return "Killed" + (e.scope && e.scope !== "workorder" ? " (" + e.scope + " kill)" : "") + (e.text ? ": " + e.text : "");
      case "restore": return "Restored" + (e.text ? ": " + e.text : "");
      case "halt": return "Andon halt" + (e.text ? ": " + e.text : "");
      case "resume": return "Resumed after halt";
      case "trust.change": return "Trust changed " + trustText(e.from) + " → " + trustText(e.to) + (e.text ? ": " + e.text : "");
      default: return e.type + (e.text ? ": " + e.text : "");
    }
  }
  function decisionText(g) {
    var d = g.decision;
    if (!d) return null;
    if (d.mode === "trust") { var r = d.reason ? String(d.reason).replace(/\.+$/, "") : ""; var tt = trustText(d.trust); return r && tt && r.indexOf(tt) === 0 ? "Passed under trust " + r : "Passed under trust " + tt + (r ? ". " + r : ""); }
    if (d.mode === "auto") return "Automatic: checks passed" + (d.trust != null ? " (trust in force " + trustText(d.trust) + ")" : "");
    return "Approved by " + actor(d.by) + (d.via ? " via " + d.via : "") + (d.trust != null ? ", trust in force " + trustText(d.trust) : "");
  }
  function ruleText(project, gid) {
    var gd = G.gateDef(gid) || {};
    var fg = G.flowOf(project).gates.find(function (x) { return x.id === gid; });
    var mode = fg ? fg.mode : gd.kind;
    if (mode === "auto") return "Automatic checks" + (gd.purpose ? ": " + String(gd.purpose).replace(/\.+$/, "") : "");
    var r = project.approvers[gid];
    if (!r) return gid === "G0G1" ? "The submitter or a permitted confirmer confirms the brief" : "No approver rule";
    var who = (r.roles || []).map(roleName).concat((r.people || []).map(actor));
    var parts = [(r.required || 1) + " of " + (who.join(" or ") || "the project approvers")];
    if (mode === "mixed") parts.unshift("Checks, then");
    if (r.sod) parts.push("the author cannot approve");
    (r.conditions || []).forEach(function (c) { parts.push(c.text); });
    if (r.escalateH) parts.push("escalates after " + r.escalateH + "h" + (r.fallback ? " to " + actor(r.fallback) : ""));
    return parts.join("; ");
  }
  function gatesOf(wo, project) {
    var ids = G.routeGates(project, wo.cls).slice();
    Object.keys(wo.gates || {}).forEach(function (g) { if (ids.indexOf(g) < 0) ids.push(g); });
    var order = G.flowOf(project).gates.map(function (g) { return g.id; });
    return ids.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
  }

  /* ================= Markdown export ================= */
  function toMarkdown(wo) {
    G.lc.sync(wo);
    var p = G.find.project(wo.project), L = [];
    function line(s) { L.push(s == null ? "" : String(s)); }
    function list(items) { items.forEach(function (x) { line("- " + x); }); }
    var c = G.lc.completeness(wo);
    line("# " + wo.id + " " + wo.title); line();
    line("Project: " + (p ? p.name : wo.project) + " · Repo: " + wo.repo + " · Class: " + clsName(wo.cls) + " · State: " + stateLine(wo));
    line("Record completeness: " + c.done + " of " + c.total + " sections. Exported " + G.fmt.stamp(Date.now()) + " by " + actor(G.viewerId()) + ".");
    line(); line("## 1. Summary"); line(); line(summaryOf(wo)); line();
    var t = G.woTotals(wo);
    list(["Route taken: " + routeTaken(wo).map(stName).join(" → "), "Duration: " + G.fmt.dur(endAt(wo) - wo.createdAt), "Cost: " + G.fmt.money(t.cost) + " (" + G.fmt.k(t.tokens) + " tokens)",
      "People: " + (peopleOf(wo).map(actor).join(", ") || "none"), "Agents: " + (agentsOf(wo).map(actor).join(", ") || "none"),
      "PR: " + (wo.pr && wo.pr.number ? "#" + wo.pr.number + " (" + wo.pr.state + ")" : "none"), "Release: " + (wo.pr && wo.pr.tag && wo.pr.releasedAt ? wo.pr.tag + ", " + when(wo.pr.releasedAt) : "not released")]);
    line(); line("## 2. Request"); line();
    var rq = wo.request || {};
    line("> " + String(rq.text || wo.description || wo.title).split("\n").join("\n> ")); line();
    list(["Source: " + srcName(rq.source || wo.source), "Requested by: " + actor(rq.by || wo.requestedBy) + (rq.via ? " (submitted by " + actor(rq.via) + ")" : ""), "When: " + when(rq.at || wo.createdAt),
      "Attachments: " + ((rq.attachments || []).join(", ") || "none"), rq.requestedCls ? "Requested class: " + clsName(rq.requestedCls) : "Requested class: none"]);
    line(); line("## 3. Clarification"); line();
    qaPairs(wo).forEach(function (x) { line("- **Q** (" + actor(x.q.from) + "): " + x.q.text); line("  **A**: " + (x.a ? x.a.text + " (" + actor(x.a.from) + ", " + when(x.a.at) + ")" : "not answered yet")); });
    ((wo.conv && wo.conv.raised) || []).forEach(function (r) { line("- **Raised at " + stName(r.station) + "**: " + r.text + " → " + (r.answered ? r.answer : "open")); });
    if (wo.conv && wo.conv.misses.length) { line(); line("Misses found:"); list(wo.conv.misses.map(function (m) { return m.text + (m.resolved ? " (answered)" : " (open)"); })); }
    if (wo.clsOverridden) { line(); line("Class override: " + clsName(wo.clsOverridden.from) + " → " + clsName(wo.cls) + " by " + actor(wo.clsOverridden.by) + ": " + wo.clsOverridden.reason); }
    line(); line("## 4. Agreement"); line();
    var bv = wo.briefVersions || [];
    var b = bv.length ? bv[bv.length - 1].brief : wo.brief;
    if (!bv.length) line("Draft brief, not yet confirmed at G0+G1.");
    else line("Confirmed by " + actor(bv[0].by) + ", " + when(bv[0].at) + (bv.length > 1 ? ". " + (bv.length - 1) + " later change(s)." : "."));
    if (b) { line(); line("Goal: " + b.goal); line("Scope in: " + (b.scopeIn || []).join("; ")); line("Scope out: " + (b.scopeOut || []).join("; ")); line("Acceptance criteria:"); list((wo.criteria || []).length ? wo.criteria.map(function (x) { return x.id + " " + x.text; }) : b.ac || []); line("Decisions:"); list(b.decisions || []); line("Risks: " + ((b.risks || []).join("; ") || "none")); }
    bv.slice(1).forEach(function (v, i) { var d = briefDiff(bv[i].brief, v.brief); line(); line("Change v" + v.v + " by " + actor(v.by) + ", " + when(v.at) + ": " + (v.note || "")); d.forEach(function (x) { line("  " + (x.t === "+" ? "+ " : "- ") + x.field + ": " + x.text); }); });
    line(); line("## 5. Station by station"); line();
    visits(wo).forEach(function (e) {
      line("### " + stNo(e.station) + " " + stName(e.station) + (e.endedAt ? "" : " (in progress)"));
      if (e.summary) line(e.summary);
      list([actor(e.agent) + " v" + (e.agentVersion || "?") + " on " + e.model + (e.skills && e.skills.length ? ", skills " + e.skills.map(function (s) { return s.name + " " + s.v; }).join(", ") : ""),
        "Duration " + G.fmt.dur((e.endedAt || Date.now()) - e.startedAt) + ", " + G.fmt.k(e.tokens || 0) + " tokens, " + G.fmt.money(e.cost || 0) + (e.outcome ? ", outcome " + e.outcome : "")]);
      (e.artefacts || []).forEach(function (a) { line("- Artefact: " + a.title); });
      line();
    });
    (wo.sendbacks || []).forEach(function (s) { line("- Sent back " + stName(s.from) + " → " + stName(s.to) + " by " + actor(s.by) + ": " + s.note); });
    line(); line("## 6. Changes"); line();
    if ((wo.plan || []).length) { line("Plan:"); list(wo.plan.map(function (s) { return s.id + " " + s.text + " (serves " + s.ac.join(", ") + ")"; })); line(); }
    if ((wo.commits || []).length) { line("Commits:"); list(wo.commits.map(function (cm) { return "`" + cm.hash + "` " + cm.message + " (" + actor(cm.agent) + ", " + stName(cm.station) + ")"; })); line(); }
    if ((wo.files || []).length) {
      line("Files (" + wo.files.length + ", +" + sum(wo.files, "plus") + " −" + sum(wo.files, "minus") + "):");
      line(); line("| File | Status | + | − | Step | Criteria | Protected |"); line("| --- | --- | --- | --- | --- | --- | --- |");
      wo.files.forEach(function (f) { line("| `" + f.path + "`" + (f.from ? " (from `" + f.from + "`)" : "") + " | " + f.status + " | " + f.plus + " | " + f.minus + " | " + f.step + " | " + f.ac.join(", ") + " | " + (f.protected ? "yes" : "no") + " |"); });
      if (wo.guardrail) { line(); line("Change size " + wo.guardrail.size + " lines against a guardrail of " + wo.guardrail.maxDiff + (wo.guardrail.over ? " (over)" : "") + ". Protected paths touched: " + (wo.guardrail.protectedTouched.join(", ") || "none") + "."); }
    } else line("No files planned yet.");
    line(); line("## 7. Verification"); line();
    (wo.criteria || []).forEach(function (x) { line("- " + x.id + " " + x.text + ": **" + critStatus(x).label + "**" + (x.tests.length ? " (" + x.tests.map(function (tt) { return tt.name + " " + tt.result; }).join(", ") + ")" : "")); });
    if (!(wo.criteria || []).length) line("No acceptance criteria yet.");
    if ((wo.checks || []).length) { line(); line("Checks: " + wo.checks.map(function (k) { return k.name + " " + k.status; }).join(", ")); }
    if (wo.security) line("Security scan: " + wo.security.findings + " finding(s), " + wo.security.note);
    if (wo.coverage) line("Coverage: " + wo.coverage.before + "% → " + wo.coverage.after + "% (" + (wo.coverage.after - wo.coverage.before >= 0 ? "+" : "") + (wo.coverage.after - wo.coverage.before) + ")");
    line(); line("## 8. Merge and release"); line();
    if (wo.pr && wo.pr.number) {
      list(["PR #" + wo.pr.number + " " + (wo.pr.title || "") + " (" + wo.pr.state + ", checks " + wo.pr.checks + ")", "Branch " + wo.pr.branch + ", merge strategy " + (wo.pr.mergeStrategy || "–"), "Reviewers: " + ((wo.pr.reviewers || []).map(actor).join(", ") || "–"),
        "Merged: " + (wo.pr.mergedAt ? when(wo.pr.mergedAt) + " by " + actor(wo.pr.mergedBy) : "not yet"), "Tag: " + (wo.pr.tag || "–") + (wo.pr.releasedAt ? ", released " + when(wo.pr.releasedAt) : "")]);
      (wo.reviewComments || []).forEach(function (rc) { line("- Review: " + actor(rc.by) + " on `" + rc.file + ":" + rc.line + "`: " + rc.text + " → " + (rc.resolved ? rc.resolution : "open")); });
      if (wo.pr.releaseNotes) { line(); line("Release notes:"); line(); wo.pr.releaseNotes.trim().split("\n").forEach(function (x) { line("> " + x); }); }
    } else line("No pull request yet.");
    line(); line("## 9. Approvals"); line();
    if (p) gatesOf(wo, p).forEach(function (gid) {
      var g = wo.gates[gid] || { status: "pending", approvals: [], rejections: [] };
      line("- " + gateName(gid) + ": " + g.status + ". Rule: " + ruleText(p, gid) + "." + (decisionText(g) ? " " + decisionText(g) + (g.decision.at ? ", " + when(g.decision.at) : "") + "." : "") + (g.trustNote ? " " + g.trustNote : ""));
      (g.rejections || []).forEach(function (r) { line("  - Rejected by " + actor(r.by) + ": " + (r.reason || "")); });
    });
    line(); line("## 10. After release"); line();
    if ((wo.outcomes || []).length) list(wo.outcomes.map(function (o) { return (o.kind === "followup" ? "follow-up" : o.kind) + (o.severity ? " (" + o.severity + ")" : "") + ", " + when(o.at) + ": " + o.text + (o.superseded ? " (superseded by " + o.superseded + ")" : "") + (o.attribution ? " Attributed to " + ((G.find.agent(o.attribution.agent) || {}).name || o.attribution.agent) + " at " + stName(o.attribution.station) + "." : "") + (o.by ? " Reported by " + actor(o.by) + "." : "") + ((o.followup || o.wo) ? " → " + (o.followup || o.wo) : ""); }));
    else line(wo.state === "done" ? "Watching after release." : "Not released yet.");
    line(); line("## 11. Full timeline"); line();
    timelineRows(wo).forEach(function (r) { line("- " + G.fmt.iso(r.at) + " IST · " + r.who + " · " + r.text); });
    return L.join("\n");
  }
  G.recordMarkdown = function (woId) { var wo = G.find.wo(woId); return wo ? toMarkdown(wo) : ""; };

  function copyMarkdown(wo) {
    var md = toMarkdown(wo);
    function fallback(why) {
      var ta = h("textarea", { id: "rec-md-text", class: "input mono rec-md-text", rows: "18", readonly: true, "aria-label": "Record as Markdown" });
      ta.value = md;
      G.dialog({ title: "Record " + wo.id + " as Markdown", kicker: "Record · copy", wide: true, sub: why + " Select the text below and copy it with your keyboard.",
        body: h("div", null, ta), actions: [{ label: "Select all", id: "rec-md-select", onClick: function () { ta.focus(); ta.select(); } }, { label: "Close", kind: "primary", id: "rec-md-close" }] });
      setTimeout(function () { ta.focus(); ta.select(); }, 40);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).then(function () { G.toast("Copied " + wo.id + " as Markdown (" + md.split("\n").length + " lines).", "ok"); }, function () { fallback("The clipboard is not available in this frame."); });
      } else fallback("The clipboard is not available in this frame.");
    } catch (e) { fallback("The clipboard is not available in this frame."); }
    return md;
  }

  /* ================= rewrite summary (G.ask with local fallback) ================= */
  function localRewrite(wo) {
    var p = G.find.project(wo.project);
    var met = (wo.criteria || []).filter(function (c) { return c.status === "met"; }).length;
    var asked = actor(wo.requestedBy) + " asked the " + (p ? p.name : wo.project) + " team for: " + wo.title.charAt(0).toLowerCase() + wo.title.slice(1) + ".";
    var did = wo.commits && wo.commits.length ? " The factory changed " + plural(wo.files.length, "file") + " in " + wo.repo + (wo.pr && wo.pr.number ? " (PR #" + wo.pr.number + ")" : "") + " and " + met + " of " + wo.criteria.length + " acceptance criteria are met." : wo.criteria ? " The brief is agreed; no code has been written yet." : " The request is still being clarified.";
    var now = wo.state === "done" ? " It is live" + (wo.pr && wo.pr.tag ? " in " + wo.pr.tag : "") + "." + (wo.outcomes.some(function (o) { return o.kind === "revert" || o.kind === "incident"; }) ? " After release there was a " + wo.outcomes.find(function (o) { return o.kind !== "healthy"; }).kind + ", which is linked in the record." : " Nothing has gone wrong since release.")
      : wo.state === "killed" ? " Work stopped: it was killed (" + (wo.killed ? wo.killed.reason : "no reason recorded") + ")."
      : " Right now it is " + stateLine(wo).toLowerCase() + ".";
    return asked + did + now + " Total spend " + G.fmt.money(G.woTotals(wo).cost) + " over " + G.fmt.dur(endAt(wo) - wo.createdAt) + ".";
  }
  function compactData(wo) {
    return { id: wo.id, title: wo.title, project: (G.find.project(wo.project) || {}).name, repo: wo.repo, cls: clsName(wo.cls), state: stateLine(wo), request: wo.request && wo.request.text,
      route: routeTaken(wo).map(stName), criteria: (wo.criteria || []).map(function (c) { return c.id + " " + c.text + ": " + c.status; }), files: (wo.files || []).length, plus: sum(wo.files, "plus"), minus: sum(wo.files, "minus"),
      pr: wo.pr && wo.pr.number ? { number: wo.pr.number, state: wo.pr.state, tag: wo.pr.tag } : null, outcomes: (wo.outcomes || []).map(function (o) { return o.kind + ": " + o.text; }),
      cost: G.woTotals(wo).cost, durationH: Math.round((endAt(wo) - wo.createdAt) / G.HOUR), currentSummary: summaryOf(wo) };
  }
  function startRewrite(wo) {
    if (ui.rw && ui.rw.busy) return;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    ui.rw = { wo: wo.id, busy: true, text: "", mode: null, error: null, ctrl: ctrl };
    bump();
    G.ask({
      instructions: "Rewrite the plain-language summary of one work order record for a manager. One paragraph, at most 90 words, no lists or headings. Say what was asked, what was delivered and the current state. Use only the data given.",
      data: compactData(wo), question: "Rewrite the summary for " + wo.id + ".", signal: ctrl ? ctrl.signal : undefined, modelTier: "fast",
      onText: function (full) { if (!ui.rw || ui.rw.wo !== wo.id) return; ui.rw.text = full; var ta = document.getElementById("rec-rw-text"); if (ta) ta.value = full; },
      fallback: function () { return localRewrite(wo); }
    }).then(function (r) {
      if (!ui.rw || ui.rw.wo !== wo.id) return;
      ui.rw.busy = false; ui.rw.mode = r.mode; ui.rw.error = r.error || null;
      ui.rw.text = (r.text || ui.rw.text || "").trim();
      if (r.error === "aborted" && !ui.rw.text) ui.rw = null;
      bump();
    });
  }
  function rewriteBox(wo) {
    var rw = ui.rw && ui.rw.wo === wo.id ? ui.rw : null;
    if (!rw) return null;
    var dec = G.me("wo.answer", { project: wo.project, repo: wo.repo });
    var ta = h("textarea", { id: "rec-rw-text", class: "input rec-rw-text", rows: "4", "aria-label": "Rewritten summary", readonly: rw.busy ? true : null });
    ta.value = rw.text;
    ta.addEventListener("input", function () { rw.text = ta.value; });
    var note = rw.busy ? "Writing…" : rw.mode === "claude" ? "Drafted by Claude from this record. Edit it, then save." :
      rw.error === "not_granted" ? "Claude was not granted, so Gantry drafted this from the record with local logic." : rw.error === "rate_limited" ? "Claude is rate limited; this draft comes from local logic." : rw.error === "aborted" ? "Stopped. Keep what was written or discard it." : "Drafted with local logic from the record.";
    return h("div", { class: "rec-rw", role: "group", "aria-label": "Rewrite summary" },
      h("div", { class: "rec-rw-head" }, h("strong", null, "New summary"), h("span", { class: "small muted", "aria-live": "polite" }, note)),
      ta,
      h("div", { class: "rec-rw-act" },
        rw.busy ? G.btn("Stop", { small: true, icon: "x", id: "rec-rw-stop", onClick: function () { if (rw.ctrl) rw.ctrl.abort(); } }) : null,
        G.btn("Discard", { small: true, kind: "ghost", id: "rec-rw-discard", onClick: function () { if (rw.ctrl && rw.busy) rw.ctrl.abort(); ui.rw = null; bump(); } }),
        G.btn("Save summary", { small: true, kind: "primary", icon: "check", id: "rec-rw-save", guard: dec, disabledReason: dec.allowed && rw.busy ? "Wait for the draft to finish" : null, onClick: function () {
          var r = G.ops.setRecordSummary(wo.id, rw.text);
          G.toast(r.msg, r.ok ? "ok" : "error");
          if (r.ok) { ui.rw = null; bump(); }
        } })));
  }

  /* ================= sections ================= */
  function secSummary(wo, project, pre, compact) {
    var t = G.woTotals(wo);
    var route = routeTaken(wo), planned = G.route(project, wo.cls);
    var skipped = G.flowOf(project).stations.filter(function (s) { return planned.indexOf(s.id) < 0; }).map(function (s) { return s.name; });
    var rs = wo.recordSummary;
    var dec = G.me("wo.answer", { project: wo.project, repo: wo.repo });
    var busy = ui.rw && ui.rw.busy;
    return h("div", { class: "rec-summary" },
      h("div", { class: "rec-sum-text" },
        h("p", { class: "rec-lede", id: pre + "summary-text" }, summaryOf(wo)),
        h("div", { class: "rec-sum-meta" }, rs ? prov("person", "Summary saved by " + actor(rs.by) + ", " + when(rs.at)) : prov("system", "Written by Gantry from the record"),
          compact ? null : G.ask && G.ask.badge ? G.ask.badge(pre + "ask-badge") : null,
          compact ? null : G.btn("Rewrite summary", { small: true, icon: "sparkle", id: pre + "rewrite", guard: dec, disabledReason: dec.allowed && busy ? "A rewrite is in progress" : null, onClick: function () { startRewrite(wo); } })),
        compact ? null : rewriteBox(wo)),
      h("dl", { class: "rec-facts" },
        kv("Class", G.classChip(wo.cls, { small: true })),
        kv("State", h("span", null, G.stateChip(wo.state, true), " " + stateLine(wo))),
        kv("Route taken", h("span", { class: "small" }, route.map(stName).join(" → ") || "Not started", skipped.length ? h("span", { class: "muted" }, " · skips " + skipped.join(", ")) : null)),
        kv("Duration", h("span", { class: "mono" }, G.fmt.dur(endAt(wo) - wo.createdAt))),
        kv("Cost", h("span", { class: "mono" }, G.fmt.money(t.cost) + " · " + G.fmt.k(t.tokens) + " tok")),
        kv("People", h("span", { class: "small" }, peopleOf(wo).map(actor).join(", ") || "–")),
        kv("Agents", h("span", { class: "small" }, agentsOf(wo).map(actor).join(", ") || "–")),
        kv("PR", wo.pr && wo.pr.number ? h("span", { class: "mono" }, "#" + wo.pr.number + " · " + wo.pr.state) : "none yet"),
        kv("Release", wo.pr && wo.pr.tag && wo.pr.releasedAt ? h("span", { class: "mono" }, wo.pr.tag + " · " + G.fmt.istDate(wo.pr.releasedAt)) : "not released")));
  }

  function secRequest(wo, project, pre) {
    var rq = wo.request || { text: wo.description, source: wo.source, by: wo.requestedBy, at: wo.createdAt, attachments: wo.attachments || [] };
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small muted" }, "Original submission, verbatim"), prov("system", "Recorded at submission")),
      h("blockquote", { class: "rec-quote" }, h("div", { class: "rec-quote-t" }, rq.title || wo.title), h("p", null, rq.text || "(no description)")),
      h("dl", { class: "rec-kvs" },
        kv("Source", srcName(rq.source)), kv("Requested by", actor(rq.by)), rq.via && rq.via !== rq.by ? kv("Submitted by", actor(rq.via)) : null, kv("When", when(rq.at)),
        kv("Attachments", (rq.attachments || []).length ? h("span", { class: "mono small" }, rq.attachments.join(", ")) : "none"),
        kv("Requested class", rq.requestedCls ? G.classChip(rq.requestedCls, { small: true }) : "none (left to the classifier)")));
  }

  function secClarification(wo, project, pre, compact) {
    var conv = wo.conv;
    if (!conv) return none("No intake conversation was recorded.");
    var pairs = qaPairs(wo);
    var cls = conv.messages.find(function (m) { return m.from === "ag-classifier"; });
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small muted" }, plural(pairs.length, "question") + " from the Intake agent, " + pairs.filter(function (x) { return x.a; }).length + " answered"), prov("system", "Conversation log")),
      cls ? h("p", { class: "small rec-cls-line" }, G.icon("agent"), " " + cls.text) : null,
      pairs.length ? h("ol", { class: "rec-qa" }, pairs.map(function (x) {
        return h("li", null, h("div", { class: "rec-q" }, h("span", { class: "rec-qa-tag mono" }, "Q"), h("span", null, x.q.text), h("span", { class: "muted small mono" }, actor(x.q.from) + " · " + G.fmt.ist(x.q.at))),
          h("div", { class: "rec-a" + (x.a ? "" : " is-open") }, h("span", { class: "rec-qa-tag mono" }, "A"), x.a ? h("span", null, x.a.text) : h("span", { class: "muted" }, "Not answered yet"), x.a ? h("span", { class: "muted small mono" }, actor(x.a.from) + " · " + when(x.a.at)) : null));
      })) : none("No questions asked yet."),
      (conv.raised || []).length ? h("div", null, h("h4", { class: "rec-h4" }, "Questions raised by later stations"), h("ul", { class: "rec-list" }, conv.raised.map(function (r) {
        return h("li", null, h("strong", null, stName(r.station) + ": "), r.text, h("span", { class: "muted small" }, " · " + when(r.at) + " · "), r.answered ? h("span", null, "answered: " + r.answer) : h("span", { class: "chip chip-warn" }, "open"));
      }))) : null,
      h("h4", { class: "rec-h4" }, "Misses found"),
      conv.misses.length ? h("ul", { class: "rec-list rec-misses" }, conv.misses.map(function (m) { return h("li", { class: m.resolved ? "is-ok" : "is-open" }, G.icon(m.resolved ? "check" : "alert"), h("span", null, m.text), h("span", { class: "muted small" }, m.resolved ? " answered" : " open")); })) : none("None found."),
      h("h4", { class: "rec-h4" }, "Overrides"),
      wo.clsOverridden ? h("p", { class: "small" }, G.icon("swap"), " Class changed from ", G.classChip(wo.clsOverridden.from, { small: true }), " to ", G.classChip(wo.cls, { small: true }), " by " + actor(wo.clsOverridden.by) + ", " + when(wo.clsOverridden.at) + ". Reason: " + (wo.clsOverridden.reason || "none given") + ".")
        : wo.requestedCls && wo.requestedCls !== wo.clsSuggested ? h("p", { class: "small" }, "Submitter asked for " + clsName(wo.requestedCls) + "; the classifier suggested " + clsName(wo.clsSuggested) + " at " + Math.round(wo.clsConfidence * 100) + "%.") : none("No overrides."),
      compact ? null : h("p", { class: "small" }, G.btn("Open the conversation", { small: true, kind: "ghost", icon: "chat", id: pre + "open-conv", onClick: function () { G.openConversation(wo.id); } })));
  }

  function briefDiff(a, b) {
    var out = [];
    a = a || {}; b = b || {};
    if (a.goal !== b.goal && b.goal) { out.push({ t: "-", field: "Goal", text: a.goal || "" }); out.push({ t: "+", field: "Goal", text: b.goal }); }
    [["scopeIn", "Scope in"], ["scopeOut", "Scope out"], ["ac", "Acceptance"], ["risks", "Risk"], ["decisions", "Decision"]].forEach(function (f) {
      var x = a[f[0]] || [], y = b[f[0]] || [];
      x.forEach(function (v) { if (y.indexOf(v) < 0) out.push({ t: "-", field: f[1], text: v }); });
      y.forEach(function (v) { if (x.indexOf(v) < 0) out.push({ t: "+", field: f[1], text: v }); });
    });
    if (a.estimate !== b.estimate && b.estimate) out.push({ t: "+", field: "Estimate", text: (a.estimate || "–") + " → " + b.estimate });
    return out;
  }
  function secAgreement(wo) {
    var bv = wo.briefVersions || [];
    var b = bv.length ? bv[bv.length - 1].brief : wo.brief;
    if (!b) return none("No brief yet.");
    function ul(items, empty) { return items && items.length ? h("ul", { class: "rec-list" }, items.map(function (x) { return h("li", null, x); })) : h("p", { class: "muted small" }, empty); }
    return h("div", null,
      h("div", { class: "rec-subhead" }, bv.length ? h("span", { class: "small" }, G.icon("check"), " Confirmed by " + actor(bv[0].by) + ", " + when(bv[0].at) + " · version " + bv[bv.length - 1].v + " in force") : h("span", { class: "chip chip-warn" }, "Draft, not yet confirmed at G0+G1"), prov("person", "Agreed by a person")),
      h("div", { class: "rec-brief" },
        h("div", { class: "rec-brief-goal" }, h("div", { class: "kicker" }, "Goal"), h("p", null, b.goal)),
        h("div", null, h("div", { class: "kicker" }, "Scope in"), ul(b.scopeIn, "Not set")),
        h("div", null, h("div", { class: "kicker" }, "Scope out"), ul(b.scopeOut, "Nothing excluded")),
        h("div", null, h("div", { class: "kicker" }, "Acceptance criteria"), (wo.criteria || []).length ? h("ul", { class: "rec-list" }, wo.criteria.map(function (c) { return h("li", null, h("span", { class: "mono rec-ac" }, c.id), " " + c.text); })) : ul(b.ac, "Not set")),
        h("div", null, h("div", { class: "kicker" }, "Decisions"), ul(b.decisions, "None")),
        h("div", null, h("div", { class: "kicker" }, "Risks"), ul(b.risks, "None recorded"))),
      bv.length > 1 ? h("div", null, h("h4", { class: "rec-h4" }, "Changes after confirmation"), bv.slice(1).map(function (v, i) {
        var d = briefDiff(bv[i].brief, v.brief);
        return h("div", { class: "rec-bdiff" }, h("div", { class: "small" }, h("strong", null, "v" + v.v), " by " + actor(v.by) + ", " + when(v.at) + (v.note ? ": " + v.note : "")),
          h("pre", { class: "rec-diff" }, d.length ? d.map(function (x) { return h("span", { class: "rec-dl rec-dl-" + (x.t === "+" ? "add" : "del") }, x.t + " " + x.field + ": " + x.text + "\n"); }) : "No field changed."));
      })) : null);
  }

  function secStations(wo, project, pre, compact) {
    var vs = visits(wo);
    if (!vs.length) return none("No station visits yet.");
    var raised = (wo.conv && wo.conv.raised) || [];
    /* each send-back belongs to the visit of its station that started last before it (or the last visit there) */
    var sbVisit = (wo.sendbacks || []).map(function (s) {
      var best = -1;
      vs.forEach(function (e, i) { if (e.station === s.from && (best < 0 || e.startedAt <= s.at)) best = i; });
      return best < 0 ? vs.length - 1 : best;
    });
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small muted" }, plural(vs.length, "station visit") + " · " + plural((wo.sendbacks || []).length, "send-back")), prov("agent", "Summaries and artefacts reported by the agents")),
      h("ol", { class: "rec-visits" }, vs.map(function (e, i) {
        var ag = G.find.agent(e.agent);
        var q = raised.filter(function (r) { return r.station === e.station && r.at >= e.startedAt && (!e.endedAt || r.at <= e.endedAt + 60000); });
        var sb = (wo.sendbacks || []).filter(function (s) { return sbVisit[(wo.sendbacks || []).indexOf(s)] === i; });
        var st = G.stationDef(e.station) || {};
        return h("li", { class: "rec-visit" + (e.endedAt ? "" : " is-now") + (st.custom ? " is-custom" : ""), "data-at": String(e.startedAt) },
          h("div", { class: "rec-visit-no mono" }, st.no || ""),
          h("div", { class: "rec-visit-body" },
            h("div", { class: "rec-visit-head" }, h("strong", null, stName(e.station)), st.custom ? h("span", { class: "chip" }, "custom station") : null,
              e.endedAt ? h("span", { class: "chip rec-out rec-out-" + String(e.outcome || "done").replace(/\W+/g, "-") }, e.outcome || "done") : h("span", { class: "chip chip-accent" }, "in progress"),
              h("span", { class: "muted small mono" }, G.fmt.istDate(e.startedAt) + " " + G.fmt.ist(e.startedAt) + " · " + G.fmt.dur((e.endedAt || Date.now()) - e.startedAt))),
            e.summary ? h("p", { class: "rec-visit-sum" }, e.summary) : h("p", { class: "muted small" }, e.endedAt ? "No summary reported." : "Working now. The agent reports a summary when it finishes."),
            h("div", { class: "rec-visit-meta small" },
              h("span", null, G.icon("agent"), " " + (ag ? ag.name : actor(e.agent)) + (e.agentVersion ? " v" + e.agentVersion : "")),
              h("span", { class: "mono" }, e.model || ""),
              e.skills && e.skills.length ? h("span", null, "skills " + e.skills.map(function (s) { return s.name + " " + s.v; }).join(", ")) : null,
              h("span", { class: "mono" }, G.fmt.k(e.tokens || 0) + " tok · " + G.fmt.money(e.cost || 0))),
            q.length ? h("ul", { class: "rec-list small" }, q.map(function (r) { return h("li", null, G.icon("human"), " Asked: " + r.text + (r.answered ? " → " + r.answer : " (open)")); })) : null,
            sb.length ? h("ul", { class: "rec-list small rec-sb" }, sb.map(function (s) { return h("li", null, G.icon("back"), " Sent back to " + stName(s.to) + " by " + actor(s.by) + ": " + s.note); })) : null,
            e.note && !e.summary ? h("p", { class: "small muted" }, e.note) : null,
            (e.artefacts || []).length ? h("div", { class: "rec-arts" }, e.artefacts.map(function (a, k) {
              return fold(pre + "art-" + wo.id + "-" + i + "-" + k, h("span", null, G.icon("page"), " " + a.title, h("span", { class: "muted small" }, " · " + a.kind)), h("pre", { class: "rec-art" }, a.body || ""), false);
            })) : null));
      })),
      bayTimes(wo));
  }
  function bayTimes(wo) {
    var list = (wo.bayTime || []).slice();
    if (wo.bay) list.push({ bay: wo.bay, from: wo.bayFrom, reason: wo.bayReason, at: null, open: true });
    if (!list.length) return null;
    return h("div", null, h("h4", { class: "rec-h4" }, "Time in bays"), h("ul", { class: "rec-list small" }, list.map(function (b) {
      return h("li", null, G.bayChip(b.bay), " from " + stName(b.from || "intake") + (b.reason ? ": " + b.reason : "") + (b.open ? " (there now)" : b.ms ? " · " + G.fmt.dur(b.ms) : ""));
    })));
  }

  /* files tree: directories collapse single-child chains */
  function buildTree(files) {
    var root = { dirs: {}, files: [] };
    files.forEach(function (f) {
      var parts = f.path.split("/"), node = root;
      parts.slice(0, -1).forEach(function (d) { node = node.dirs[d] = node.dirs[d] || { dirs: {}, files: [] }; });
      node.files.push(f);
    });
    function compress(name, node) {
      var keys = Object.keys(node.dirs);
      while (!node.files.length && keys.length === 1) { name = name + "/" + keys[0]; node = node.dirs[keys[0]]; keys = Object.keys(node.dirs); }
      return { name: name, node: node };
    }
    return { root: root, compress: compress };
  }
  function allFiles(node) { var out = node.files.slice(); Object.keys(node.dirs).forEach(function (k) { out = out.concat(allFiles(node.dirs[k])); }); return out; }
  var STATUS = { added: ["A", "Added"], modified: ["M", "Modified"], deleted: ["D", "Deleted"], renamed: ["R", "Renamed"] };
  function statusMark(s) { var x = STATUS[s] || ["?", s]; return h("span", { class: "rec-fst rec-fst-" + s, title: x[1], "aria-label": x[1] }, x[0]); }
  function fileRow(wo, f, pre, compact) {
    var step = (wo.plan || []).find(function (p) { return p.id === f.step; });
    var key = pre + "diff-" + wo.id + "-" + f.path;
    return h("li", { class: "rec-file" + (f.protected ? " is-protected" : "") },
      h("div", { class: "rec-file-row" },
        statusMark(f.status),
        h("span", { class: "rec-file-name mono", title: f.path }, f.path.split("/").pop(), f.from ? h("span", { class: "muted" }, " ← " + f.from.split("/").pop()) : null),
        h("span", { class: "rec-pm mono" }, h("span", { class: "rec-plus" }, "+" + f.plus), " ", h("span", { class: "rec-minus" }, "−" + f.minus)),
        h("span", { class: "chip mono", title: step ? step.id + " " + step.text : "" }, f.step),
        f.ac.map(function (a) { return h("span", { class: "chip mono rec-ac-chip", title: ((wo.criteria || []).find(function (c) { return c.id === a; }) || {}).text || a }, a); }),
        f.protected ? h("span", { class: "rec-prot", title: "Matches a protected path for this repo; needs the extra approval" }, G.icon("lock"), "protected") : null,
        h("span", { class: "rec-fstate rec-fstate-" + f.state }, f.state)),
      step ? h("div", { class: "rec-file-why small muted" }, step.id + " " + step.text + " · serves " + f.ac.join(", ")) : null,
      (f.preview || []).length ? fold(key, h("span", { class: "small" }, "Diff preview"), h("pre", { class: "rec-diff" }, f.preview.map(function (l) { return h("span", { class: "rec-dl rec-dl-" + (l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx") }, (l.t === " " ? "  " : l.t + " ") + l.s + "\n"); })), false) : null);
  }
  function treeNode(wo, name, node, pre, compact, depth, T) {
    var c = T.compress(name, node);
    var fs = allFiles(c.node);
    var kids = Object.keys(c.node.dirs).sort().map(function (k) { return treeNode(wo, k, c.node.dirs[k], pre, compact, depth + 1, T); });
    return h("li", { class: "rec-dir" },
      h("div", { class: "rec-dir-row" }, G.icon("project"), h("span", { class: "mono" }, c.name + "/"), h("span", { class: "rec-pm mono small" }, h("span", { class: "rec-plus" }, "+" + sum(fs, "plus")), " ", h("span", { class: "rec-minus" }, "−" + sum(fs, "minus")))),
      h("ul", { class: "rec-tree" }, kids, c.node.files.map(function (f) { return fileRow(wo, f, pre, compact); })));
  }
  function secChanges(wo, project, pre, compact) {
    var files = wo.files || [];
    if (!files.length) return none(wo.criteria ? "Nothing planned yet. Plan lists the files before Build." : "No changes yet. Files are planned once the brief is confirmed.");
    var plus = sum(files, "plus"), minus = sum(files, "minus");
    var g = wo.guardrail;
    var T = buildTree(files);
    var rootKids = Object.keys(T.root.dirs).sort().map(function (k) { return treeNode(wo, k, T.root.dirs[k], pre, compact, 0, T); });
    var byFile = h("ul", { class: "rec-tree rec-tree-root", "aria-label": "Files changed" }, rootKids, T.root.files.map(function (f) { return fileRow(wo, f, pre, compact); }));
    var byCommit = (wo.commits || []).length ? h("ol", { class: "rec-commits" }, wo.commits.map(function (cm) {
      return h("li", { class: "rec-commit" },
        h("div", { class: "rec-commit-head" }, h("span", { class: "mono rec-hash" }, cm.hash), h("span", { class: "rec-commit-msg" }, cm.message)),
        h("div", { class: "small muted" }, actor(cm.agent) + " · " + stName(cm.station) + " · " + when(cm.at) + (cm.step ? " · " + cm.step : "")),
        h("ul", { class: "rec-tree rec-tree-flat" }, cm.files.map(function (p) { var f = files.find(function (x) { return x.path === p; }); return f ? fileRow(wo, f, pre + "c" + cm.hash + "-", compact) : h("li", { class: "mono small" }, p); })));
    })) : none("No commits yet. Files below are planned; Build commits them.");
    var committed = (wo.commits || []).length > 0;
    return h("div", null,
      h("div", { class: "rec-subhead" },
        h("span", { class: "small" }, h("strong", { class: "mono" }, plural(files.length, "file")), " · ", h("span", { class: "rec-plus mono" }, "+" + plus), " ", h("span", { class: "rec-minus mono" }, "−" + minus), " · " + plural((wo.commits || []).length, "commit")),
        prov("system", committed ? "From the repository" : "Planned by the Planner agent")),
      (wo.plan || []).length ? fold(pre + "plan-" + wo.id, h("span", { class: "small" }, h("strong", null, "Plan"), " · " + plural(wo.plan.length, "step") + ", each tied to an acceptance criterion"),
        h("ol", { class: "rec-plan" }, wo.plan.map(function (s) { return h("li", null, h("span", { class: "mono chip" }, s.id), " " + s.text, h("span", { class: "muted small" }, " · " + plural(s.files.length, "file") + " · serves " + s.ac.join(", "))); })), !compact) : null,
      g ? h("div", { class: "rec-guard" + (g.over ? " is-over" : "") },
        h("div", { class: "small" }, h("strong", null, "Change size "), h("span", { class: "mono" }, g.size + " of " + g.maxDiff + " lines"), g.over ? h("span", { class: "chip chip-block" }, G.icon("alert"), "over the guardrail") : h("span", { class: "muted" }, " within the Builder's guardrail")),
        h("div", { class: "rec-guard-bar" }, G.meter(g.size, g.maxDiff, "Change size against guardrail", 0.9)),
        g.protectedTouched.length ? h("div", { class: "small rec-prot-line" }, G.icon("lock"), " Protected paths touched: ", h("span", { class: "mono" }, g.protectedTouched.join(", "))) : h("div", { class: "small muted" }, "No protected paths touched.")) : null,
      committed ? h("div", { class: "rec-toggle" }, G.segmented(pre + "group", [{ id: "file", label: "By file" }, { id: "commit", label: "By commit" }], ui.group, function (v) { ui.group = v; bump(); }, "Group changes")) : null,
      ui.group === "commit" && committed ? byCommit : byFile);
  }

  function critStatus(c) {
    var s = c.status;
    if (s === "met") return { id: "met", label: "Met", icon: "check" };
    if (s === "not met" || s === "failed") return { id: "failed", label: "Not met", icon: "x" };
    if (s === "pending") return { id: "pending", label: "Pending", icon: "st-wait" };
    return { id: "untested", label: "Not tested", icon: "dots" };
  }
  function secVerification(wo) {
    var cr = wo.criteria || [];
    if (!cr.length) return none("No acceptance criteria yet. They are fixed when the brief is confirmed.");
    var tested = cr.some(function (c) { return c.tests.length; });
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small muted" }, cr.filter(function (c) { return c.status === "met"; }).length + " of " + cr.length + " criteria met"), prov("system", "Test runs and checks from CI")),
      h("ul", { class: "rec-crit" }, cr.map(function (c) {
        var s = critStatus(c);
        return h("li", { class: "rec-crit-" + s.id },
          h("div", { class: "rec-crit-head" }, h("span", { class: "rec-crit-st" }, G.icon(s.icon), s.label), h("span", { class: "mono rec-ac" }, c.id), h("span", null, c.text)),
          c.tests.length ? h("ul", { class: "rec-tests mono small" }, c.tests.map(function (t) { return h("li", { class: "is-" + t.result }, h("span", { class: "rec-tres" }, t.result === "pass" ? "✓ pass" : "✗ fail"), " " + t.name, h("span", { class: "muted" }, " " + (t.ms / 1000).toFixed(1) + "s")); })) : h("div", { class: "small muted" }, tested ? "No automated test maps to this criterion." : "Not run yet. Verify runs the tests."));
      })),
      (wo.checks || []).length ? h("div", { class: "rec-checks" }, h("h4", { class: "rec-h4" }, "Checks"), h("ul", { class: "rec-list" }, wo.checks.map(function (k) { return h("li", { class: "is-" + k.status }, G.icon(k.status === "passed" ? "check" : k.status === "failed" ? "x" : "st-wait"), h("span", { class: "mono" }, " " + k.name), " " + k.status); }))) : null,
      wo.security || wo.coverage ? h("dl", { class: "rec-kvs" },
        wo.security ? kv("Security scan", wo.security.findings + " finding" + (wo.security.findings === 1 ? "" : "s") + " (" + wo.security.severity + "). " + wo.security.note) : null,
        wo.coverage ? kv("Coverage", h("span", { class: "mono" }, wo.coverage.before + "% → " + wo.coverage.after + "% (" + (wo.coverage.after >= wo.coverage.before ? "+" : "") + (wo.coverage.after - wo.coverage.before) + ")")) : null,
        wo.tests && (wo.tests.passed || wo.tests.failed) ? kv("Suite", h("span", { class: "mono" }, wo.tests.passed + " passed · " + wo.tests.failed + " failed · " + wo.tests.added + " added")) : null) : null);
  }

  function secMerge(wo, project, pre, compact) {
    var pr = wo.pr;
    if (!pr || !pr.number) return none("No pull request yet. Build opens one on " + (pr ? pr.branch : "gantry/" + wo.id.toLowerCase()) + ".");
    var merged = (wo.files || []).filter(function (f) { return f.state === "merged"; });
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small" }, h("strong", { class: "mono" }, "PR #" + pr.number), " " + (pr.title || "")), h("span", { class: "chip" + (pr.state === "merged" ? " chip-accent" : "") }, pr.state)),
      h("dl", { class: "rec-kvs" },
        kv("Branch", h("span", { class: "mono" }, pr.branch)), kv("Checks", pr.checks), kv("Reviewers", (pr.reviewers || []).map(actor).join(", ") || "–"),
        kv("Merge strategy", pr.mergeStrategy || "–"), kv("Merged", pr.mergedAt ? when(pr.mergedAt) + " by " + actor(pr.mergedBy) : "not yet"),
        kv("Tag", pr.tag ? h("span", { class: "mono" }, pr.tag) : "–"), kv("Released", pr.releasedAt ? when(pr.releasedAt) : "not yet")),
      pr.body ? fold(pre + "prbody-" + wo.id, h("span", { class: "small" }, "PR description as generated ", prov("agent", "Written by the Builder agent")), h("pre", { class: "rec-art" }, pr.body), false) : null,
      h("h4", { class: "rec-h4" }, "Review comments"),
      (wo.reviewComments || []).length ? h("ul", { class: "rec-list rec-rc" }, wo.reviewComments.map(function (c) {
        return h("li", null, h("div", null, h("strong", null, actor(c.by)), h("span", { class: "mono small muted" }, " " + c.file + ":" + c.line), " " + c.text), h("div", { class: "small " + (c.resolved ? "" : "muted") }, G.icon(c.resolved ? "check" : "st-wait"), " " + (c.resolved ? c.resolution : "Open")));
      })) : none("No review comments."),
      h("h4", { class: "rec-h4" }, "What is merged"),
      merged.length ? h("p", { class: "small" }, h("span", { class: "mono" }, plural(merged.length, "file") + " · +" + sum(merged, "plus") + " −" + sum(merged, "minus")), h("span", { class: "muted" }, " · " + merged.map(function (f) { return f.path; }).join(", "))) : none("Nothing merged yet; " + plural((wo.files || []).length, "file") + " on the PR."),
      pr.releaseNotes ? fold(pre + "notes-" + wo.id, h("span", { class: "small" }, "Release notes " + (pr.tag || "") + " ", prov("agent", "Written by the Release agent")), h("pre", { class: "rec-art" }, pr.releaseNotes), !compact) : null);
  }

  function secApprovals(wo, project, pre) {
    var ids = gatesOf(wo, project);
    if (!ids.length) return none("This route has no gates.");
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small muted" }, plural(ids.length, "gate") + " on this route"), prov("system", "Gate decisions recorded by Gantry")),
      h("ol", { class: "rec-gates" }, ids.map(function (gid) {
        var g = wo.gates[gid] || { status: "pending", approvals: [], rejections: [] };
        var d = g.decision;
        var mode = d ? d.mode : null;
        var lv = null;
        if (g.status === "waiting" && G.trust && G.trust.levelFor) { try { lv = G.trust.levelFor(wo, gid); } catch (e) { lv = null; } }
        var gd = G.gateDef(gid) || { label: gid, name: "" };
        return h("li", { class: "rec-gate rec-gate-" + g.status + (mode ? " rec-gmode-" + mode : "") },
          h("div", { class: "rec-gate-head" },
            G.gateDiamond({ gateId: gid, state: g.status === "waiting" ? "waiting" : g.status === "failed" || g.status === "rejected" ? "failing" : g.status === "passed" ? "clear" : "off", count: 1, size: "sm" }),
            h("strong", null, gd.label + " " + gd.name), gd.custom ? h("span", { class: "chip" }, "custom gate") : null,
            h("span", { class: "chip rec-gst" }, g.status),
            mode ? h("span", { class: "chip rec-mode rec-mode-" + mode }, mode === "trust" ? G.icon("trust") : mode === "auto" ? G.icon("refresh") : G.icon("human"), mode === "trust" ? "trust " + (trustText(d.trust) || "") : mode === "auto" ? "automatic" : "person") : null),
          h("div", { class: "small" }, h("span", { class: "muted" }, "Rule in force: "), ruleText(project, gid) + "."),
          d ? h("div", { class: "small" }, decisionText(g) + (d.at ? ", " + when(d.at) : "") + ".") : null,
          (g.approvals || []).length > 1 || ((g.approvals || []).length && (!d || d.mode !== "human")) ? h("ul", { class: "rec-list small" }, g.approvals.map(function (a) { return h("li", null, G.icon("check"), " " + actor(a.by) + " via " + (a.via || "web") + ", " + when(a.at) + (a.trust != null ? " (trust in force " + trustText(a.trust) + ")" : "")); })) : null,
          (g.rejections || []).length ? h("ul", { class: "rec-list small rec-sb" }, g.rejections.map(function (r) { return h("li", null, G.icon("x"), " Rejected by " + actor(r.by) + ", " + when(r.at) + (r.reason ? ": " + r.reason : "")); })) : null,
          g.status === "waiting" ? h("div", { class: "small rec-wait" }, G.icon("st-wait"), " Waiting since " + when(g.waitingSince) + ". " + (g.trustNote || (lv && lv.effective != null ? "Trust in force for this cell is " + trustText(lv.effective) + "; a person decides." : "A person decides."))) : null,
          (g.checks || []).length ? h("div", { class: "small muted" }, "Checks: " + g.checks.map(function (c) { return (c.ok ? "✓ " : "✗ ") + c.name; }).join(" · ")) : null);
      })),
      h("p", { class: "small" }, h("a", { href: "#trust", id: pre + "to-trust" }, "Trust ladder for this project")));
  }

  function secAfter(wo, pre) {
    var oc = wo.outcomes || [];
    var findings = ((G.store.get("learning") || {}).findings || []).filter(function (f) { return (f.evidence || []).indexOf(wo.id) >= 0; });
    var cells = ((G.store.get("trust") || {}).cells || []).filter(function (c) { return c.history.some(function (x) { return x.cause && x.cause.wo === wo.id; }); });
    var follow = G.store.get("workOrders").filter(function (w) { return w.parent === wo.id || (w.request && w.request.text && w.request.text.indexOf(wo.id) >= 0 && w.id !== wo.id); });
    var shipped = wo.state === "done" && !wo.split;
    var perm = G.me("outcome.record", { project: wo.project });
    var recBtn = shipped ? h("div", { class: "rec-after-acts" }, G.btn("Record an outcome", { small: true, icon: "alert", id: pre + "oc-add", guard: perm, onClick: function () { outcomeDialog(wo); } })) : null;
    if (!oc.length && !findings.length && !follow.length) return h("div", null, none(shipped ? "Watching after release. Nothing observed yet." : "Not released yet. Outcomes are watched for 30 minutes after release."), recBtn);
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small muted" }, plural(oc.length, "outcome") + " observed"), prov("system", "Observed after release, or reported by a person")),
      oc.length ? h("ul", { class: "rec-outcomes" }, oc.map(function (o) {
        var att = o.attribution ? " Attributed to " + ((G.find.agent(o.attribution.agent) || {}).name || o.attribution.agent) + " at " + stName(o.attribution.station) + "." : "";
        var link = o.followup || o.wo;
        return h("li", { class: "rec-oc rec-oc-" + o.kind + (o.superseded ? " is-superseded" : "") }, h("span", { class: "rec-oc-k" }, G.icon(o.kind === "healthy" ? "st-done" : o.kind === "followup" ? "plus" : "alert"), (o.kind === "followup" ? "follow-up" : o.kind) + (o.severity ? " · " + o.severity : "")),
          h("span", null, o.text + (o.superseded ? " (superseded by " + o.superseded + ")" : "") + att, o.by ? h("span", { class: "muted small" }, " Reported by " + actor(o.by) + (o.via && o.via !== "web" ? " via " + o.via : "") + ".") : null, link ? [" ", woLink(link, pre)] : null), h("span", { class: "muted small mono" }, when(o.at)));
      })) : null,
      recBtn,
      follow.length ? h("div", null, h("h4", { class: "rec-h4" }, "Follow-up work orders"), h("ul", { class: "rec-list" }, follow.map(function (w) { return h("li", null, woLink(w.id, pre), " " + w.title + " · " + stateLine(w)); }))) : null,
      cells.length ? h("div", null, h("h4", { class: "rec-h4" }, "Trust demotions caused"), h("ul", { class: "rec-list small" }, cells.map(function (c) { var x = c.history.filter(function (y) { return y.cause && y.cause.wo === wo.id; }).pop(); return h("li", null, (G.trustCellLabel ? G.trustCellLabel(c) : c.id) + ": " + trustText(x.from) + " → " + trustText(x.to) + ". " + x.reason); })), h("a", { href: "#trust", class: "small", id: pre + "after-trust" }, "Open the trust ladder")) : null,
      findings.length ? h("div", null, h("h4", { class: "rec-h4" }, "Learning findings that cite this record"), h("ul", { class: "rec-list small" }, findings.map(function (f) { return h("li", null, h("span", { class: "mono" }, f.id), " " + f.title + " (" + f.status + ")"); })), h("a", { href: "#learning", class: "small", id: pre + "after-learning" }, "Open learning")) : null);
  }

  /* record a post-release outcome (G.ops.recordOutcome): revert or incident demote trust and feed learning; a follow-up opens a work order */
  function outcomeDialog(wo) {
    var kind = "incident", sev = "medium";
    var stations = (wo.history || []).map(function (e) { return e.station; }).filter(function (v, i, a) { return a.indexOf(v) === i && v !== "intake"; });
    var att = stations.indexOf("build") >= 0 ? "build" : stations[stations.length - 1];
    var ta = h("textarea", { id: "rec-oc-text", class: "input", rows: "3", placeholder: "What happened after release, and how it was handled" });
    var ft = h("input", { id: "rec-oc-ftitle", class: "input", value: "Follow-up: " + wo.title });
    var err = h("div", { class: "form-err", role: "alert" });
    var impact = h("p", { class: "small", id: "rec-oc-impact" });
    var ftField = G.field("Follow-up work order title", ft, null, "rec-oc-ftitle");
    function paint() {
      ftField.hidden = kind !== "followup";
      var n = ((G.store.get("trust") || {}).cells || []).filter(function (c) { return c.project === wo.project && c.cls === wo.cls && c.level >= 2; });
      impact.textContent = kind === "followup" ? "Opens a linked work order in " + ((G.find.project(wo.project) || {}).name || wo.project) + ". Trust is not changed." :
        (n.length ? n.length + " trust cell" + (n.length === 1 ? "" : "s") + " for " + (G.find.cls(wo.cls) || { name: wo.cls }).name + " drop one level. " : "No cell for this class is at L2 or above, so trust does not change. ") + "The learning loop gets the signal and drafts a proposal.";
    }
    var kindSel = G.select("rec-oc-kind", [{ value: "incident", label: "Incident" }, { value: "revert", label: "Revert" }, { value: "followup", label: "Follow-up work" }], kind, function (v) { kind = v; paint(); });
    var sevSel = G.select("rec-oc-sev", [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }], sev, function (v) { sev = v; });
    var attSel = G.select("rec-oc-att", stations.map(function (sid) { var d = G.stationDef(sid) || {}; return { value: sid, label: stName(sid) + " · " + ((G.find.agent(d.agent) || {}).name || d.agent || "") }; }), att, function (v) { att = v; });
    paint();
    G.dialog({ title: "Record a post-release outcome on " + wo.id, kicker: "Record · after release", sub: "Recorded with your name and the station it is attributed to. Audited.",
      body: h("div", { class: "form-grid" }, h("div", { class: "form-row" }, G.field("Kind", kindSel, null, "rec-oc-kind"), G.field("Severity", sevSel, null, "rec-oc-sev")), G.field("Attributed to", attSel, null, "rec-oc-att"), G.field("What happened", ta, null, "rec-oc-text"), ftField, impact, err),
      actions: [{ label: "Cancel" }, { label: "Record outcome", kind: "primary", submit: true, id: "rec-oc-ok", guard: G.me("outcome.record", { project: wo.project }), onClick: function (close) {
        var st = G.stationDef(att) || {};
        var r = G.ops.recordOutcome(wo.id, { kind: kind, text: ta.value, severity: sev, attribution: { station: att, agent: st.agent }, followupTitle: ft.value });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, kind === "followup" ? "ok" : "warn"); close(); bump();
      } }] });
  }

  function timelineRows(wo) {
    var rows = [];
    journey(wo).forEach(function (e) { rows.push({ at: e.at, kind: "event", who: e.by ? actor(e.by) : "Gantry", text: eventText(e, wo), type: e.type }); });
    (wo.log || []).forEach(function (l) { if (/^Entered |^Submitted from | approved\.$|^Approved \S+ \(/.test(l.text)) return; rows.push({ at: l.at, kind: "log", who: actor(l.who), text: l.text }); });
    auditFor(wo).forEach(function (a) { rows.push({ at: a.at, kind: "audit", who: actor(a.actor), text: a.action + " · " + a.target + (a.outcome && a.outcome !== "ok" ? " (" + a.outcome + ")" : ""), outcome: a.outcome }); });
    return rows.sort(function (a, b) { return a.at - b.at; });
  }
  function secTimeline(wo, pre, compact) {
    var rows = timelineRows(wo);
    if (!rows.length) return none("No events yet.");
    var limit = compact ? 12 : 40, all = ui.timelineAll[pre + wo.id];
    var shown = all || rows.length <= limit ? rows : rows.slice(rows.length - limit);
    return h("div", null,
      h("div", { class: "rec-subhead" }, h("span", { class: "small muted" }, plural(rows.length, "entry", "entries") + ": events, work order log and audit"), prov("system", "Event log and audit ledger")),
      shown.length < rows.length ? h("p", { class: "small" }, G.btn("Show all " + rows.length, { small: true, kind: "ghost", id: pre + "tl-all", onClick: function () { ui.timelineAll[pre + wo.id] = true; bump(); if (G.drawer.isOpen()) G.drawer.refresh(); } }), h("span", { class: "muted" }, " Showing the latest " + shown.length + ".")) : null,
      h("ol", { class: "rec-tl" }, shown.map(function (r) {
        return h("li", { class: "rec-tl-" + r.kind + (r.outcome === "denied" ? " is-denied" : "") }, h("span", { class: "mono muted rec-tl-t" }, G.fmt.istDate(r.at) + " " + G.fmt.ist(r.at)), h("span", { class: "rec-tl-k mono" }, r.kind), h("span", { class: "rec-tl-who" }, r.who), h("span", { class: "rec-tl-x" }, r.text));
      })));
  }

  /* ================= journey scrubber ================= */
  function scrubber(wo, project, pre) {
    var ev = journey(wo);
    if (!ev.length) return null;
    var box = h("div", { class: "rec-scrub", id: pre + "scrub" });
    var idx = ui.scrub[wo.id] == null || ui.scrub[wo.id] >= ev.length ? ev.length - 1 : ui.scrub[wo.id];
    var timer = null;
    function stateAt(t) {
      var vs = visits(wo).filter(function (e) { return e.startedAt <= t; });
      var cur = vs.length ? vs[vs.length - 1] : null;
      return { seen: vs.map(function (e) { return e.station; }), cur: cur && (!cur.endedAt || cur.endedAt > t || wo.state !== "done") ? cur.station : null };
    }
    function paint() {
      G.clear(box);
      var e = ev[idx], t = e.at, s = stateAt(t);
      var live = idx === ev.length - 1;
      var range = h("input", { type: "range", id: pre + "scrub-range", class: "rec-scrub-range", min: "0", max: String(ev.length - 1), step: "1", value: String(idx), "aria-label": "Journey position", "aria-valuetext": "Step " + (idx + 1) + " of " + ev.length + ": " + eventText(e, wo) });
      range.addEventListener("input", function () { idx = +range.value; ui.scrub[wo.id] = idx; paint(); var r = document.getElementById(pre + "scrub-range"); if (r) r.focus(); });
      var marks = h("div", { class: "rec-scrub-marks", "aria-hidden": "true" }, ev.map(function (x, i) {
        var span = ev[ev.length - 1].at - ev[0].at || 1;
        return h("span", { class: "rec-mark rec-mark-" + x.type.replace(".", "-") + (i === idx ? " is-on" : ""), style: "left:" + (((x.at - ev[0].at) / span) * 100).toFixed(2) + "%", title: eventText(x, wo) });
      }));
      var strip = h("ol", { class: "rec-scrub-strip", "aria-label": "Stations reached at this point" }, G.flowOf(project).stations.filter(function (st) { return G.route(project, wo.cls).indexOf(st.id) >= 0 || s.seen.indexOf(st.id) >= 0; }).map(function (st) {
        var on = s.cur === st.id, seen = s.seen.indexOf(st.id) >= 0;
        return h("li", { class: (on ? "is-now" : seen ? "is-done" : "") + (st.custom ? " is-custom" : ""), title: st.name + (on ? ": here" : seen ? ": visited" : ": not yet") }, h("span", { class: "mono" }, st.no), h("span", { class: "rec-ss-n" }, st.name));
      }));
      G.append(box, [h("div", { class: "rec-scrub-top" },
        h("div", { class: "rec-scrub-btns" },
          G.btn("", { small: true, icon: "back", aria: "Previous event", id: pre + "scrub-prev", disabledReason: idx === 0 ? "This is the first event" : null, onClick: function () { idx = Math.max(0, idx - 1); ui.scrub[wo.id] = idx; paint(); focus("prev"); } }),
          G.btn(timer ? "Pause" : "Play", { small: true, icon: timer ? "pause" : "play", id: pre + "scrub-play", onClick: function () {
            if (timer) { clearInterval(timer); timer = null; paint(); focus("play"); return; }
            if (idx >= ev.length - 1) idx = 0;
            timer = setInterval(function () { if (!document.body.contains(box)) { clearInterval(timer); timer = null; return; } idx++; ui.scrub[wo.id] = idx; if (idx >= ev.length - 1) { clearInterval(timer); timer = null; } paint(); }, G.reducedMotion && G.reducedMotion() ? 1200 : 700);
            paint(); focus("play");
          } }),
          G.btn("", { small: true, icon: "chevron", aria: "Next event", id: pre + "scrub-next", disabledReason: live ? "This is the latest event" : null, onClick: function () { idx = Math.min(ev.length - 1, idx + 1); ui.scrub[wo.id] = idx; paint(); focus("next"); } }),
          live ? null : G.btn("Latest", { small: true, kind: "ghost", id: pre + "scrub-live", onClick: function () { idx = ev.length - 1; ui.scrub[wo.id] = idx; paint(); focus("range"); } })),
        h("div", { class: "rec-scrub-read", "aria-live": "polite" }, h("span", { class: "mono rec-scrub-n" }, (idx + 1) + "/" + ev.length), h("span", { class: "mono muted" }, G.fmt.stamp(t)), h("span", { class: "rec-scrub-ev" }, eventText(e, wo)))),
        h("div", { class: "rec-scrub-track" }, marks, range), strip]);
      /* dim station visits that had not started yet */
      var root = box.closest(".rec, .lc") || document;
      Array.prototype.forEach.call(root.querySelectorAll(".rec-visit[data-at]"), function (el) { el.classList.toggle("is-future", +el.getAttribute("data-at") > t); });
    }
    function focus(which) { var el = document.getElementById(pre + "scrub-" + which); if (el) el.focus(); }
    paint();
    setTimeout(function () { if (document.body.contains(box)) paint(); }, 0);
    return box;
  }

  /* ================= completeness meter ================= */
  function meter(wo, pre, onJump) {
    var c = G.lc.completeness(wo);
    return h("nav", { class: "rec-meter", "aria-label": "Record sections, " + c.done + " of " + c.total + " with data" },
      h("div", { class: "rec-meter-top" }, h("span", { class: "kicker" }, "Completeness"), h("span", { class: "mono rec-meter-n" }, c.done + "/" + c.total)),
      h("div", { class: "rec-meter-bar", "aria-hidden": "true" }, SECTIONS.map(function (s) { return h("span", { class: c.sections[s.id] ? "is-on" : "" }); })),
      h("ol", { class: "rec-meter-list" }, SECTIONS.map(function (s, i) {
        var on = c.sections[s.id];
        return h("li", null, h("button", { type: "button", class: "rec-meter-item" + (on ? " is-on" : ""), id: pre + "jump-" + s.id, onClick: function () { onJump(s.id); } },
          h("span", { class: "rec-meter-mark", "aria-hidden": "true" }, on ? "■" : "□"), h("span", { class: "mono muted" }, String(i + 1).padStart(2, "0")), h("span", null, s.label), h("span", { class: "sr-only" }, on ? " (has data)" : " (no data yet)")));
      })));
  }

  /* ================= assembled record ================= */
  function sections(wo, project, pre, compact) {
    var c = G.lc.completeness(wo);
    var R = {
      summary: function () { return secSummary(wo, project, pre, compact); },
      request: function () { return secRequest(wo, project, pre); },
      clarification: function () { return secClarification(wo, project, pre, compact); },
      agreement: function () { return secAgreement(wo); },
      stations: function () { return secStations(wo, project, pre, compact); },
      changes: function () { return secChanges(wo, project, pre, compact); },
      verification: function () { return secVerification(wo); },
      merge: function () { return secMerge(wo, project, pre, compact); },
      approvals: function () { return secApprovals(wo, project, pre); },
      after: function () { return secAfter(wo, pre); },
      timeline: function () { return secTimeline(wo, pre, compact); }
    };
    return SECTIONS.map(function (s, i) {
      var head = h("span", { class: "rec-sec-h" }, h("span", { class: "rec-sec-no mono" }, String(i + 1).padStart(2, "0")), h("span", { class: "rec-sec-t" }, s.label), c.sections[s.id] ? null : h("span", { class: "rec-sec-empty mono" }, "no data yet"));
      if (compact && s.id !== "summary") {
        return h("section", { class: "rec-sec is-compact", id: sid(pre, s.id) }, fold(pre + "fold-" + s.id, head, h("div", { class: "rec-sec-body" }, R[s.id]()), false));
      }
      return h("section", { class: "rec-sec" + (compact ? " is-compact" : ""), id: sid(pre, s.id), "aria-labelledby": sid(pre, s.id) + "-h" },
        h("h2", { class: "rec-sec-title", id: sid(pre, s.id) + "-h" }, head), h("div", { class: "rec-sec-body" }, R[s.id]()));
    });
  }
  function killBanner(wo) {
    if (wo.state !== "killed") return null;
    var k = wo.killed || {};
    return h("div", { class: "callout callout-fail rec-killed", role: "status" }, G.icon("st-kill"), h("div", null, h("strong", null, "Killed. "), (k.reason || "No reason recorded") + " · " + actor(k.by) + ", " + when(k.at) + (k.scope && k.scope !== "workorder" ? " (" + k.scope + " kill)" : "") + ". In-flight work was cancelled" + (wo.pr && wo.pr.number && wo.pr.state !== "merged" ? "; PR #" + wo.pr.number + " is left as a draft." : ".")));
  }

  /* compact (traveler tab) or full (#record body) */
  G.renderLifecycle = function (woOrId, opts) {
    opts = opts || {};
    var wo = typeof woOrId === "string" ? G.find.wo(woOrId) : woOrId;
    if (!wo) return G.emptyState({ title: "No such work order", text: "It may have been removed." });
    var project = G.find.project(wo.project);
    if (!canSee(wo) || !project) return G.emptyState({ icon: "lock", title: "Not visible to you", text: "This work order belongs to a project you cannot see." });
    G.lc.sync(wo);
    var compact = !!opts.compact;
    var pre = opts.idPrefix || (compact ? "lc-" : "rec-");
    if (compact) {
      var c = G.lc.completeness(wo);
      return h("div", { class: "lc lc-stub rec is-compact" },
        h("div", { class: "lc-top" },
          h("div", { class: "lc-meter" }, h("span", { class: "kicker" }, "Record"), h("span", { class: "mono" }, c.done + "/" + c.total + " sections"), h("div", { class: "rec-meter-bar", "aria-hidden": "true" }, SECTIONS.map(function (s) { return h("span", { class: c.sections[s.id] ? "is-on" : "", title: s.label }); }))),
          h("div", { class: "lc-btns" },
            G.btn("Copy as Markdown", { small: true, icon: "copy", id: pre + "copy-" + wo.id, onClick: function () { copyMarkdown(wo); } }),
            G.btn("Open full record", { small: true, kind: "primary", icon: "record", id: pre + "open-" + wo.id, onClick: function () { if (G.drawer.isOpen()) G.drawer.close(); G.openRecord(wo.id); } }))),
        killBanner(wo), scrubber(wo, project, pre), sections(wo, project, pre, true));
    }
    return h("div", { class: "rec-body" }, killBanner(wo), sections(wo, project, pre, false));
  };

  /* ================= record picker ================= */
  function picker(note) {
    var me = G.viewerId();
    if (ui.pick.viewer !== me) { ui.pick = { q: "", project: null, stage: "all", viewer: me, sort: { key: "id", dir: -1 } }; }
    var vis = G.visibleProjects(me);
    var vids = vis.map(function (p) { return p.id; });
    var cur = G.currentProject();
    if (ui.pick.project == null) ui.pick.project = cur && vids.indexOf(cur.id) >= 0 ? cur.id : "all";
    var q = ui.pick.q.trim().toLowerCase();
    var all = G.store.get("workOrders").filter(function (w) { return vids.indexOf(w.project) >= 0; });
    var rows = all.filter(function (w) {
      if (ui.pick.project !== "all" && w.project !== ui.pick.project) return false;
      var st = ui.pick.stage;
      if (st === "flight" && (w.state === "done" || w.state === "killed")) return false;
      if (st === "intake" && !(w.station === 0 && w.state !== "killed")) return false;
      if (st === "done" && w.state !== "done") return false;
      if (st === "killed" && w.state !== "killed") return false;
      if (st === "issues" && !(w.outcomes || []).some(function (o) { return o.kind === "revert" || o.kind === "incident"; })) return false;
      if (q && (w.id + " " + w.title + " " + w.repo + " " + (w.pr && w.pr.number ? "#" + w.pr.number : "") + " " + (w.pr && w.pr.tag || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var search = h("input", { id: "rec-pick-q", class: "input", type: "search", placeholder: "Id, title, repo, PR or tag", value: ui.pick.q, autocomplete: "off" });
    search.addEventListener("input", function () { ui.pick.q = search.value; bump(); });
    var cols;
    var table = G.dataTable({ id: "rec-pick-table", idPrefix: "rec-pick-sort-", caption: "Work order records", rows: rows, rowKey: function (w) { return w.id; }, pageSize: 40,
      sort: { key: ui.pick.sort.key, dir: ui.pick.sort.dir }, sortState: ui.pick.sort,
      onRow: function (w) { G.store.update("prefs", function (x) { x.project = w.project; }); G.openRecord(w.id); },
      empty: { title: "No records match", text: "Clear the search or pick another project or stage." },
      columns: cols = [
        { key: "id", label: "Work order", sort: function (w) { return +w.id.slice(3); }, render: function (w) { return h("button", { type: "button", class: "linkish mono strong", id: "rec-pick-" + w.id, onClick: function () { G.store.update("prefs", function (x) { x.project = w.project; }); G.openRecord(w.id); } }, w.id); } },
        { key: "title", label: "Title", sort: function (w) { return w.title.toLowerCase(); } },
        { key: "project", label: "Project", hideSmall: true, sort: function (w) { return w.project; }, render: function (w) { return (G.find.project(w.project) || {}).name || w.project; } },
        { key: "cls", label: "Class", sort: function (w) { return w.cls; }, render: function (w) { return G.classChip(w.cls, { small: true }); } },
        { key: "where", label: "Where", sort: function (w) { return w.state === "done" ? 99 : w.station; }, render: function (w) { return h("span", { class: "small" }, stateLine(w)); } },
        { key: "state", label: "State", sort: function (w) { return w.state; }, render: function (w) { return G.stateChip(w.state); } },
        { key: "comp", label: "Record", align: "end", sort: function (w) { return G.lc.completeness(w).done; }, render: function (w) { var c = G.lc.completeness(w); return h("span", { class: "mono" }, c.done + "/" + c.total); } },
        { key: "age", label: "Updated", align: "end", hideSmall: true, sort: function (w) { return -lastAt(w); }, render: function (w) { return h("span", { class: "mono small" }, G.fmt.ago(lastAt(w))); } }
      ] });
    return h("div", { class: "view rec-view rec-picker" },
      G.pageHeader({ id: "rec-head", kicker: "Project · Work order record", title: "Work order records", sub: "The whole lifecycle of a work order in one place: request, clarification, agreement, every station, the change itself, tests, merge, approvals and what happened after release. Pick one to open.",
        meta: [["Records", String(all.length)], ["Shipped", String(all.filter(function (w) { return w.state === "done"; }).length)], ["In flight", String(all.filter(function (w) { return w.state !== "done" && w.state !== "killed"; }).length)]] }),
      note ? h("div", { class: "callout callout-warn", role: "status" }, G.icon("lock"), h("div", null, note)) : null,
      h("div", { class: "toolbar rec-pick-bar" },
        G.field("Search", search),
        G.field("Project", G.select("rec-pick-project", [{ value: "all", label: "All my projects" }].concat(vis.map(function (p) { return { value: p.id, label: p.name + (p.status === "archived" ? " (archived)" : "") }; })), ui.pick.project, function (v) { ui.pick.project = v; bump(); })),
        h("div", { class: "field" }, h("span", { class: "field-label", id: "rec-pick-stage-l" }, "Stage"),
          G.segmented("rec-pick-stage", [{ id: "all", label: "All" }, { id: "intake", label: "Intake" }, { id: "flight", label: "In flight" }, { id: "done", label: "Shipped" }, { id: "issues", label: "Incidents" }, { id: "killed", label: "Killed" }], ui.pick.stage, function (v) { ui.pick.stage = v; bump(); }, "Stage")),
        h("span", { class: "muted small rec-pick-count" }, rows.length + " of " + all.length)),
      table);
  }
  function lastAt(w) { var e = w.history[w.history.length - 1] || {}; return Math.max(e.endedAt || 0, e.startedAt || 0, w.doneAt || 0, w.createdAt); }

  /* ================= view ================= */
  function sigOf(wo) {
    var a = G.store.get("audit"), n = 0;
    for (var i = a.length - 1, k = 0; i >= 0 && k < 400; i--, k++) if (String(a[i].target || "").indexOf(wo.id) >= 0) n += a[i].id;
    return JSON.stringify([wo.state, wo.station, wo.bay, wo.history.length, (wo.commits || []).length, (wo.outcomes || []).length, wo.recordSummary && wo.recordSummary.at, Object.keys(wo.gates).map(function (g) { return wo.gates[g].status + (wo.gates[g].approvals || []).length; }), wo.conv && wo.conv.messages.length, (wo.briefVersions || []).length, wo.pr && wo.pr.state, n, (G.store.get("events") || []).length]);
  }
  function render() {
    var prefs = G.store.get("prefs");
    var id = prefs.record, wo = id && G.find.wo(id);
    if (!wo) return picker(id ? id + " was not found." : null);
    if (!canSee(wo)) return picker("You cannot see " + wo.id + ": it belongs to a project outside your access. Pick a record you can see.");
    var key = [wo.id, G.viewerId(), ui.v, sigOf(wo), document.documentElement.getAttribute("data-theme")].join("|");
    if (cache.key === key && cache.node) return cache.node;
    G.lc.sync(wo);
    var project = G.find.project(wo.project);
    var c = G.lc.completeness(wo);
    function jump(s) { var el = document.getElementById(sid("rec-", s)); if (el) { el.scrollIntoView({ behavior: G.reducedMotion && G.reducedMotion() ? "auto" : "smooth", block: "start" }); var hd = el.querySelector(".rec-sec-title"); if (hd) { hd.setAttribute("tabindex", "-1"); hd.focus({ preventScroll: true }); } } }
    var st = G.STATIONS[wo.station];
    var node = h("div", { class: "view rec-view" },
      G.pageHeader({ id: "rec-head", kicker: "Project · " + project.name + " · Work order record", title: wo.id + " " + wo.title,
        crumbs: [{ label: project.name, href: "#work-orders" }, { label: "Records" }, { label: wo.id }],
        sub: wo.repo + " · " + clsName(wo.cls) + " · requested by " + actor(wo.requestedBy) + " via " + srcName(wo.source) + ", " + when(wo.createdAt),
        meta: [["State", G.STATES[wo.state].label], ["Where", wo.state === "done" ? "Shipped" : wo.bay ? (G.bayDef(wo.bay) || {}).name || wo.bay : st.no + " " + st.name], ["Record", c.done + " of " + c.total], ["PR", wo.pr && wo.pr.number ? "#" + wo.pr.number : "none"]],
        actions: [
          G.btn("Copy as Markdown", { icon: "copy", id: "rec-copy", onClick: function () { copyMarkdown(wo); } }),
          G.btn("Open traveler", { icon: "page", id: "rec-traveler", onClick: function () { G.openTraveler(wo.id); } }),
          G.btn("All records", { kind: "ghost", icon: "list", id: "rec-all", onClick: function () { G.store.update("prefs", function (p) { p.record = null; }); } })] }),
      h("div", { class: "rec rec-layout" },
        h("aside", { class: "rec-side" }, meter(wo, "rec-", jump)),
        h("div", { class: "rec-main" },
          h("div", { class: "rec-journey" }, h("div", { class: "rec-journey-h" }, h("span", { class: "kicker" }, "Journey"), h("span", { class: "small muted" }, "Step through this work order's own history.")), scrubber(wo, project, "rec-")),
          G.renderLifecycle(wo, { compact: false }))));
    cache = { key: key, node: node };
    return node;
  }

  G.views["record"] = { title: "Work order record", render: render, keys: ["workOrders", "prefs", "audit", "learning", "trust"] };
})(window.G);
