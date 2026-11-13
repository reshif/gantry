/* Traveler: the routing sheet that rides with every work order (right-hand drawer), plus the
   work-order dialogs other views call: G.newWODialog, G.sendBackDialog, G.reassignDialog,
   G.parkDialog, G.reclassifyDialog. Every action goes through G.ops. */
(function (G) {
  "use strict";
  var h = G.h;
  var t = { wo: null, tab: "journey", scrub: null, scrubWo: null };

  function res(r) { G.toast(r.msg, r.ok ? "ok" : "error"); return r.ok; }
  function no(reason) { return { allowed: false, reason: reason, needs: "" }; }
  function kv(k, v, cls) { return h("div", { class: "kv" }, h("div", { class: "kv-k" }, k), h("div", { class: "kv-v mono " + (cls || "") }, v)); }
  function tb(k, v) { return h("div", null, h("dt", null, k), h("dd", null, v)); }
  function openEntry(w) { return w.history[w.history.length - 1] || {}; }
  function stageName(id) { var x = G.ONBOARD_STAGES.find(function (s) { return s.id === id; }); return x ? x.name : id === "person" ? "needs a person" : id === "failed" ? "failed" : id; }
  function stName(sid) { var s = G.find.station(sid); return s ? s.name : sid; }

  /* ================= lifecycle (record summary; full renderer lives in views/record.js) ================= */
  function lifecycle(wo) {
    try { return G.renderLifecycle(wo, { compact: true }); }
    catch (e) { console.error(e); return G.empty("Lifecycle unavailable", String(e && e.message || e)); }
  }

  /* ================= journey scrubber (this work order's own event history) ================= */
  function evText(e) {
    var gd = e.gate && G.gateDef(e.gate), st = e.station && G.find.station(e.station);
    switch (e.type) {
      case "wo.submit": return "Submitted by " + G.actorName(e.by) + (e.text ? ": " + e.text : "");
      case "wo.enter": return "Entered " + (st ? st.no + " " + st.name : e.station);
      case "gate.decision": return (gd ? gd.label + " " + gd.name : e.gate) + " decided by " + (e.by ? G.actorName(e.by) : "a person") + (e.trust != null ? ", cell at L" + e.trust : "");
      case "trust.auto": return (gd ? gd.label + " " + gd.name : e.gate) + " passed under trust at L" + e.trust;
      case "wo.bay": return "Moved to " + ((G.bayDef(e.bay) || {}).name || e.bay) + (e.text ? ": " + e.text : "");
      case "release": return "Released " + (e.text || "");
      case "wo.done": return "Finished";
      case "kill": return "Killed by " + G.actorName(e.by) + (e.text ? ": " + e.text : "");
      case "restore": return "Restored by " + G.actorName(e.by) + (e.text ? ": " + e.text : "");
      default: return e.text || e.type;
    }
  }
  function journeyEvents(wo) { return G.replay && G.replay.journey ? G.replay.journey(wo.id).filter(function (e) { return e.type !== "trust.change"; }) : []; }
  function scrubAt(wo) {
    var evs = journeyEvents(wo);
    if (t.scrubWo !== wo.id || t.scrub == null || !evs.length) return null;
    var i = Math.min(t.scrub, evs.length - 1);
    return { i: i, ev: evs[i], at: evs[i].at, n: evs.length };
  }
  function setScrub(wo, i) { t.scrubWo = wo.id; t.scrub = i; G.drawer.refresh(); }
  function scrubber(wo, sc) {
    var evs = journeyEvents(wo);
    if (!evs.length) return null;
    var i = sc ? sc.i : evs.length - 1;
    var label = h("span", { class: "trv-sc-text", id: "trv-scrub-text", "aria-live": "polite" });
    function paint(k) {
      var e = evs[k];
      G.clear(label);
      label.appendChild(h("span", { class: "mono" }, "Step " + (k + 1) + " of " + evs.length + " · " + G.fmt.stamp(e.at)));
      label.appendChild(h("span", null, evText(e)));
    }
    paint(i);
    var range = h("input", { type: "range", class: "trv-sc-range", id: "trv-scrub", min: "0", max: String(evs.length - 1), step: "1", value: String(i), "aria-label": "Step through " + wo.id + "'s history", "aria-valuetext": "Step " + (i + 1) + " of " + evs.length + ": " + evText(evs[i]) });
    var dragging = false;
    range.addEventListener("pointerdown", function () { dragging = true; });
    range.addEventListener("input", function () { paint(+range.value); if (!dragging) setScrub(wo, +range.value); });
    range.addEventListener("change", function () { dragging = false; setScrub(wo, +range.value); });
    var ticks = h("div", { class: "trv-sc-ticks", "aria-hidden": "true" }, evs.map(function (e, k) {
      return h("span", { class: "trv-sc-tick tk-" + e.type.replace(".", "-") + (k <= i ? " is-past" : ""), style: "left:" + (evs.length > 1 ? k / (evs.length - 1) * 100 : 0).toFixed(2) + "%" });
    }));
    return h("section", { class: "trv-scrub" + (sc ? " is-on" : ""), "aria-label": "Journey scrubber" },
      h("div", { class: "trv-sc-head" },
        h("span", { class: "trv-sc-t" }, G.icon("replay"), sc ? "History · step " + (sc.i + 1) : "Journey history"),
        h("span", { class: "trv-sc-btns" },
          G.btn("Previous", { small: true, icon: "back", id: "trv-scrub-prev", disabledReason: i <= 0 ? "Already at the first step." : null, onClick: function () { setScrub(wo, Math.max(0, i - 1)); } }),
          G.btn("Next", { small: true, icon: "chevron", id: "trv-scrub-next", disabledReason: !sc || i >= evs.length - 1 ? (sc ? "Already at the last step." : "Pick an earlier step first.") : null, onClick: function () { setScrub(wo, i + 1); } }),
          sc ? G.btn("Show current", { small: true, kind: "ghost", icon: "x", id: "trv-scrub-live", onClick: function () { t.scrub = null; G.drawer.refresh(); } }) : null)),
      h("div", { class: "trv-sc-track" }, range, ticks),
      label);
  }

  function outcomes(wo) {
    var list = wo.outcomes || [];
    if (wo.state !== "done" && !list.length) return null;
    var icon = { healthy: "check", revert: "undo", incident: "alert", followup: "branch" };
    return h("section", { class: "trv-after" },
      h("h3", { class: "sub-h" }, "After release"),
      wo.pr && wo.pr.releasedAt ? h("p", { class: "small" }, "Released " + (wo.pr.tag || "") + " on " + G.fmt.stamp(wo.pr.releasedAt) + ".") : null,
      list.length ? h("ul", { class: "checklist small" }, list.map(function (o) {
        return h("li", { class: o.kind === "healthy" ? "ok" : o.kind === "followup" ? "pending" : "bad" }, G.icon(icon[o.kind] || "alert"),
          h("span", null, h("strong", null, o.kind === "healthy" ? "Healthy" : o.kind === "revert" ? "Reverted" : o.kind === "incident" ? "Incident" + (o.severity ? " (" + o.severity + ")" : "") : "Follow-up"),
            " · " + G.fmt.stamp(o.at) + " · " + o.text),
          o.wo && G.find.wo(o.wo) ? G.btn("Open " + o.wo, { small: true, kind: "ghost", id: "trv-out-" + o.wo, onClick: function () { G.openTraveler(o.wo); } }) : null);
      })) : h("p", { class: "muted small" }, wo.split ? "Split into child work orders; outcomes are tracked on each child." : "Watching after release. Outcomes appear here."));
  }

  /* ================= journey (station-by-station timeline) ================= */
  function journey(wo, p) {
    var route = G.route(p, wo.cls);
    var sc = scrubAt(wo);
    var scStation = null;
    if (sc) { wo.history.forEach(function (e) { if (e.startedAt <= sc.at) scStation = e.station; }); if (sc.ev.station) scStation = sc.ev.station; if (sc.ev.gate && G.gateDef(sc.ev.gate)) scStation = G.gateDef(sc.ev.gate).after; }
    var rows = G.flowOf(p).stations.map(function (st) {
      var i = st.index;
      var allVisits = wo.history.filter(function (e) { return e.station === st.id; });
      var visits = sc ? allVisits.filter(function (e) { return e.startedAt <= sc.at; }) : allVisits;
      var future = sc && allVisits.length > visits.length && !visits.length;
      var onRoute = route.indexOf(st.id) >= 0;
      var cur = wo.station === i && !wo.bay && wo.state !== "done";
      var g = G.gateAfter(st.id), gs = g && wo.gates[g.id];
      var kind = visits.length ? (cur && !openEntry(wo).endedAt ? "now" : "past") : "next";
      if (cur && wo.state === "waiting") kind = "now";
      if (sc) kind = st.id === scStation ? "now" : visits.length ? "past" : "next";
      var ag = G.find.agent(st.agent);
      var body = [];
      if (!onRoute) body.push(h("div", { class: "trv-line muted small" }, p.flow.stations[st.id].enabled ? "Skipped by the " + G.find.cls(wo.cls).name + " route" : "Off in " + p.name));
      else if (!visits.length) body.push(h("div", { class: "trv-line" }, G.avatar(ag.id, "sm"), h("span", { class: "trv-agent" }, ag.name), h("span", { class: "mono muted small" }, ag.model), h("span", { class: "trv-status muted" }, future ? "not reached yet at this step" : "not reached")));
      visits.forEach(function (e, vi) {
        var a = G.find.agent(e.agent) || ag;
        var skills = (a.skills || []).map(function (s) { var sk = G.find.skill(s); return sk ? sk.name + " " + sk.version : s; });
        var live = !e.endedAt || (sc && e.endedAt > sc.at);
        body.push(h("div", { class: "trv-visit" + (vi < visits.length - 1 ? " is-old" : "") },
          h("div", { class: "trv-line" }, G.avatar(e.agent, "sm"), h("span", { class: "trv-agent" }, G.actorName(e.agent).replace(" (agent)", "")), h("span", { class: "mono muted small" }, e.model + " · v" + a.version),
            live && cur ? G.stateChip(wo.state) : h("span", { class: "trv-status" + (e.outcome && e.outcome !== "passed" ? " warn-text" : " muted") }, e.outcome || (live ? "open" : "passed")),
            visits.length > 1 ? h("span", { class: "chip" }, "visit " + (vi + 1)) : null),
          h("div", { class: "trv-metrics mono" }, h("span", null, G.fmt.dur((e.endedAt || Date.now()) - e.startedAt)), h("span", null, G.fmt.k(e.tokens) + " tok"), h("span", null, G.fmt.money(e.cost)), h("span", { class: "muted" }, G.fmt.ist(e.startedAt) + (e.endedAt ? "–" + G.fmt.ist(e.endedAt) : "") + " IST")),
          skills.length ? h("div", { class: "trv-skills small muted" }, "Skills: " + skills.join(", ")) : null,
          e.note ? h("div", { class: "small" }, "Note: " + e.note) : null));
      });
      if (g && gs && gs.status !== "pending" && !(gcfgAbsent(p, g.id))) {
        var gl = [];
        var dec = gs.decision;
        var lateGate = sc && (dec ? dec.at > sc.at : !visits.length);
        gs.checks.forEach(function (c) { gl.push(h("li", { class: c.ok ? "ok" : "bad" }, G.icon(c.ok ? "check" : "x"), h("span", null, c.name))); });
        gs.approvals.forEach(function (a) { gl.push(h("li", { class: "ok" }, G.icon("check"), h("span", null, (g.id === "G6" ? "Release confirmed by " : "Approved by ") + G.actorName(a.by) + " · " + G.fmt.stamp(a.at) + (a.via && a.via !== "web" ? " · via " + a.via : "")), a.trust != null ? trustTag(a.trust, "cell at ") : null)); });
        gs.rejections.forEach(function (a) { gl.push(h("li", { class: "bad" }, G.icon("x"), h("span", null, "Rejected by " + G.actorName(a.by) + " · " + G.fmt.stamp(a.at) + ": " + a.reason))); });
        if (dec && dec.mode === "trust") gl.push(h("li", { class: "ok trv-dec-trust" }, G.icon("trust"), h("span", null, "Passed under trust, no person needed · " + G.fmt.stamp(dec.at) + (dec.reason ? ". " + dec.reason : "")), trustTag(dec.trust)));
        else if (dec && dec.mode === "auto") gl.push(h("li", { class: "ok" }, G.icon("check"), h("span", null, "Passed automatically on checks · " + G.fmt.stamp(dec.at))));
        else if (dec && dec.mode === "human" && !gs.approvals.length) gl.push(h("li", { class: "ok trv-dec-human" }, G.icon("human"), h("span", null, "Decided by " + (dec.by ? G.actorName(dec.by) : "a person") + (dec.via && dec.via !== "web" ? " via " + dec.via : "") + (dec.trust != null ? "; the cell ran at " + G.trust.level(dec.trust).code + " so a person approved" : ""))));
        if (gs.status === "waiting" && gs.trustNote) gl.push(h("li", { class: "warn" }, G.icon("trust"), h("span", null, "Why trust did not pass it: " + gs.trustNote)));
        var prog = gs.status === "waiting" && G.gateKind(p, g.id) !== "auto" ? G.gateProgress(p, wo, g.id) : null;
        body.push(h("div", { class: "trv-gate trv-gate-" + gs.status + (lateGate ? " trv-future" : "") }, h("span", { class: "trv-gd", "aria-hidden": "true" }),
          h("div", null, h("strong", null, g.label + " " + g.name + ": " + (lateGate ? "not decided yet at this step" : gs.status === "waiting" ? "waiting" + (prog ? " (" + prog.have + " of " + prog.need + ")" : "") : gs.status)),
            dec && !lateGate ? h("span", { class: "trv-mode trv-mode-" + dec.mode }, dec.mode === "trust" ? "under trust" : dec.mode === "auto" ? "automatic" : "by a person") : null,
            prog && prog.unmet.length ? h("div", { class: "small" }, "Still needs: " + prog.unmet.map(function (c) { return c.text; }).join("; ")) : null,
            gl.length && !lateGate ? h("ul", { class: "checklist small" }, gl) : null)));
      }
      return h("li", { class: "trv-row trv-" + kind + (onRoute ? "" : " trv-skip") + (cur && !sc ? " trv-cur" : "") + (sc && st.id === scStation ? " trv-scrub-at" : "") + (sc && !visits.length && onRoute ? " trv-future" : "") },
        h("div", { class: "trv-no" }, h("span", { class: "mono" }, st.no), h("span", { class: "trv-name" }, st.name)),
        h("div", { class: "trv-body" }, body));
    });
    var tot = G.woTotals(wo);
    return h("div", null,
      scrubber(wo, sc),
      wo.bay ? h("div", { class: "callout trv-baynote" }, G.icon("st-park"), h("span", null, "Off the belt in " + G.bayDef(wo.bay).name + " since " + G.fmt.stamp(wo.bayAt || Date.now()) + (wo.bayReason ? ": " + wo.bayReason : "") + ". Returns to " + stName(wo.bayFrom || G.STATIONS[wo.station].id) + ".")) : null,
      h("ol", { class: "trv" }, rows),
      h("div", { class: "trv-total mono" }, h("span", null, "Total"), h("span", null, G.fmt.dur((wo.doneAt || (wo.killed && wo.killed.at) || Date.now()) - wo.createdAt)), h("span", null, G.fmt.k(tot.tokens) + " tok"), h("span", null, G.fmt.money(tot.cost))),
      outcomes(wo));
  }
  function gcfgAbsent(p, gid) { return !!(p.flow.gates[gid] && p.flow.gates[gid].absent); }
  function trustTag(n, pre) {
    var L = G.trust.level(n);
    return h("span", { class: "trv-lv trv-lv-" + n, title: L.code + " " + L.name + ": " + L.desc }, (pre || "") + L.code + " " + L.name);
  }

  /* ================= conversation, brief, artefacts ================= */
  function conversation(wo) {
    if (G.renderConversation) { try { return G.renderConversation(wo.id, { idPrefix: "trv-conv", noActions: true }); } catch (e) { console.error(e); } }
    var c = wo.conv;
    return h("div", { class: "trv-conv" },
      h("ol", { class: "log" }, c.messages.map(function (m) { return h("li", null, h("span", { class: "mono muted" }, G.fmt.ist(m.at)), G.avatar(m.from, "sm"), h("span", null, h("strong", null, G.actorName(m.from).replace(" (agent)", "") + " "), m.text)); })),
      c.misses.length ? h("div", null, h("h3", { class: "sub-h" }, "Misses"), h("ul", { class: "checklist small" }, c.misses.map(function (m) { return h("li", { class: m.resolved ? "ok" : "warn" }, G.icon(m.resolved ? "check" : "alert"), h("span", null, m.text)); }))) : null,
      h("p", { class: "footnote" }, "Answer the intake questions on the Conversations screen. The Intake agent runs on local sample logic."),
      G.btn("Open in Conversations", { small: true, icon: "chat", id: "trv-open-conv", onClick: function () { G.store.update("prefs", function (x) { x.openConversation = wo.id; x.project = wo.project; }); G.drawer.close(); location.hash = "conversations"; } }));
  }

  function list(title, items, empty) {
    return h("section", { class: "trv-sec" }, h("h3", { class: "sub-h" }, title), items && items.length ? h("ul", { class: "art-list trv-ul" }, items.map(function (x) { return h("li", null, x); })) : h("p", { class: "muted small" }, empty || "None."));
  }
  function brief(wo, p) {
    var b = wo.brief || {};
    var confirmed = wo.gates.G0G1 && wo.gates.G0G1.status === "passed";
    return h("div", { class: "trv-brief" },
      h("div", { class: "callout" + (confirmed ? " callout-ok" : " callout-warn") }, G.icon(confirmed ? "check" : "alert"), h("span", null, confirmed ? "Brief confirmed at G0+G1" + (wo.gates.G0G1.approvals[0] ? " by " + G.actorName(wo.gates.G0G1.approvals[0].by) + ", " + G.fmt.stamp(wo.gates.G0G1.approvals[0].at) : "") + "." : "Draft. The brief is confirmed at G0+G1 once the intake conversation is done.")),
      h("section", { class: "trv-sec" }, h("h3", { class: "sub-h" }, "Goal"), h("p", null, b.goal || wo.title)),
      h("div", { class: "trv-2col" }, list("In scope", b.scopeIn), list("Out of scope", b.scopeOut)),
      list("Acceptance criteria", b.ac, "No acceptance criteria yet."),
      h("div", { class: "trv-2col" }, list("Risks", b.risks), list("Open questions", b.open)),
      list("Decisions", b.decisions),
      h("section", { class: "trv-sec" }, h("h3", { class: "sub-h" }, "Estimate and route"),
        h("div", { class: "trv-route" }, h("span", { class: "chip" }, "Estimate " + (b.estimate || "?")),
          (b.route || G.route(p, wo.cls)).map(function (sid, i) { return [i ? G.icon("chevron", "trv-route-sep") : null, h("span", { class: "trv-route-st mono" }, G.find.station(sid).no + " " + G.find.station(sid).name)]; }))),
      (b.children && b.children.length) || wo.children.length ? list("Child work orders", wo.children.length ? wo.children.map(function (id) { var c = G.find.wo(id); return c ? id + " " + c.title : id; }) : b.children.map(function (c) { return c + " (proposed)"; })) : null);
  }

  function artefacts(wo, p) {
    var repo = G.find.repo(wo.repo) || { name: wo.repo, lang: "", config: { defaultBranch: "main" } };
    var passed = function (sid) { return wo.history.some(function (e) { return e.station === sid && e.endedAt && e.outcome !== "killed"; }); };
    var out = [];
    out.push({ k: "Brief", body: h("p", { class: "small" }, (wo.gates.G0G1 && wo.gates.G0G1.status === "passed" ? "Confirmed brief. " : "Draft brief. ") + (wo.brief.goal || wo.title) + " See the Brief tab.") });
    if (passed("research")) out.push({ k: "Research note", body: h("div", { class: "art-doc" }, h("p", null, "Read " + repo.name + " and related tickets. Prior art found in the same module; no blocking unknowns."), h("p", { class: "muted small" }, "research/" + wo.id.toLowerCase() + ".md")) });
    if (passed("spec")) out.push({ k: "Spec", body: h("div", { class: "art-doc" },
      h("p", null, h("strong", null, "Problem. "), wo.title + " in " + repo.name + "."),
      h("p", null, h("strong", null, "Acceptance. "), (wo.brief.ac || []).join("; ") || "Behaviour covered by tests."),
      h("p", null, h("strong", null, "Out of scope. "), (wo.brief.scopeOut || []).join("; ") || "None stated.")) });
    if (passed("design")) out.push({ k: "Design notes", body: h("div", { class: "art-doc" }, h("p", null, "Interfaces stay backwards compatible. New fields are optional; no schema migration without a rollback note.")) });
    if (passed("plan")) out.push({ k: "Plan", body: h("ol", { class: "art-list" }, h("li", null, "Add a failing test that shows the request."), h("li", null, "Implement inside the existing module boundaries."), h("li", null, "Update docs and the changelog."), h("li", null, "Rollback: revert the PR" + (p.overlay && /migration/i.test(p.overlay) ? "; migration rollback note attached." : "."))) });
    if (wo.diff && (wo.diff.plus || wo.diff.minus)) {
      var names = { TypeScript: ["src/lib/api.ts", "src/lib/api.test.ts", "src/components/View.tsx", "CHANGELOG.md"], Python: ["app/service.py", "tests/test_service.py", "pipelines/job.py", "CHANGELOG.md"], Kotlin: ["app/src/main/Feature.kt", "app/src/test/FeatureTest.kt", "CHANGELOG.md"], Rust: ["src/lib.rs", "src/handler.rs", "tests/handler.rs", "CHANGELOG.md"] }[repo.lang] || ["internal/handler.go", "internal/handler_test.go", "pkg/client/client.go", "CHANGELOG.md"];
      var n = Math.min(names.length, Math.max(1, wo.diff.files)), pl = wo.diff.plus, mi = wo.diff.minus, files = [];
      for (var i = 0; i < n; i++) { var fp = i === n - 1 ? pl : Math.round(pl * 0.5), fm = i === n - 1 ? mi : Math.round(mi * 0.5); pl -= fp; mi -= fm; files.push([names[i], fp, fm]); }
      out.push({ k: "Diff summary", body: h("div", null, h("div", { class: "diffstat" }, h("span", { class: "plus mono" }, "+" + wo.diff.plus), h("span", { class: "minus mono" }, "−" + wo.diff.minus), h("span", { class: "muted" }, wo.diff.files + " files")),
        h("ul", { class: "files" }, files.map(function (f) { return h("li", null, h("span", { class: "mono" }, f[0]), h("span", { class: "plus mono" }, "+" + f[1]), h("span", { class: "minus mono" }, "−" + f[2])); }))) });
    }
    if (wo.tests && (wo.tests.passed || wo.tests.failed)) out.push({ k: "Test results", body: h("div", { class: "kv-row" }, kv("Passed", G.fmt.num(wo.tests.passed)), kv("Failed", String(wo.tests.failed), wo.tests.failed ? "neg" : ""), kv("Added", String(wo.tests.added))) });
    if (wo.pr) out.push({ k: "Pull request", body: h("div", null,
      h("div", { class: "mono pr-line" }, repo.name + "#" + wo.pr.number + "  " + wo.pr.branch + " → " + (repo.config.defaultBranch || "main")),
      h("div", { class: "kv-row" }, kv("State", wo.pr.state, wo.pr.state === "draft" ? "neg" : ""), kv("Checks", wo.pr.checks, wo.pr.checks === "green" ? "pos" : wo.pr.checks === "red" ? "neg" : ""), kv("Tag", wo.pr.tag || "none")),
      h("p", { class: "muted small" }, "Simulated. GitHub is not contacted in this demo.")) });
    return h("div", { class: "arts" }, out.map(function (a) { return h("section", { class: "art" }, h("h3", { class: "art-k" }, a.k), a.body); }),
      out.length < 3 ? h("p", { class: "muted small" }, "More artefacts appear as the work order passes Research, Spec, Design, Plan, Build and Verify.") : null);
  }

  function history(wo) {
    return h("div", { class: "trv-hist" },
      h("h3", { class: "sub-h" }, "Audit ledger"), G.historyList({ type: "wo", id: wo.id, limit: 40 }),
      h("h3", { class: "sub-h" }, "Floor log"),
      h("ol", { class: "log" }, wo.log.slice().reverse().map(function (l) { return h("li", null, h("span", { class: "mono muted" }, G.fmt.ist(l.at)), G.avatar(l.who, "sm"), h("span", null, h("strong", null, G.actorName(l.who).replace(" (agent)", "") + " "), l.text)); })));
  }

  /* ================= actions ================= */
  function actions(wo, p) {
    var me = G.viewerId();
    var stop = G.stopState(p.id, wo.repo);
    var halt = G.haltState(p.id, wo.repo);
    var repo = G.find.repo(wo.repo);
    var g = G.gateForWO(p, wo);
    var gs = g && wo.gates[g.id];
    var waiting = !wo.bay && wo.state === "waiting" && gs && gs.status === "waiting";
    var closed = wo.state === "done" || wo.state === "killed";
    var closedWhy = wo.state === "done" ? wo.id + " has shipped." : wo.id + " is killed. Restore it first.";
    var row1 = [], row2 = [];

    if (waiting) {
      var dA = G.gateDecision(me, wo, g.id);
      if (dA.allowed && halt) dA = no(halt.reason + " Resume first.");
      row1.push(G.btn(g.id === "G0G1" ? "Confirm brief" : g.id === "G6" ? "Confirm release" : "Approve " + g.label, { kind: "primary", icon: g.id === "G6" ? "rocket" : "check", id: "trv-approve", guard: dA, onClick: function () { res(G.ops.approveGate(wo.id)); } }));
      var dR = g.id === "G0G1" ? (stop ? no(stop.reason) : G.me("wo.decline", { project: p.id })) : G.gateDecision(me, wo, g.id);
      row1.push(G.btn(g.id === "G0G1" ? "Decline" : "Reject " + g.label, { icon: "x", id: "trv-reject", guard: dR, onClick: function () {
        G.reasonDialog({ title: (g.id === "G0G1" ? "Decline " : "Reject " + g.label + " on ") + wo.id, kicker: g.label + " " + g.name, ok: g.id === "G0G1" ? "Decline" : "Reject", kind: "danger", min: 5,
          sub: g.id === "G0G1" ? "The work order moves to Declined and the submitter is told why." : "The station's agent reworks " + G.STATIONS[wo.station].name + " with your reason.",
          placeholder: g.id === "G0G1" ? "Why will the factory not do this?" : "What must change before this passes?",
          onOk: function (v) { var r = G.ops.rejectGate(wo.id, v); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      } }));
    }
    if (wo.state === "failed" || wo.state === "blocked") row1.push(G.btn("Retry " + G.STATIONS[wo.station].name, { kind: "primary", icon: "refresh", id: "trv-retry", guard: stop ? no(stop.reason) : G.me("wo.sendback", { project: p.id }), onClick: function () { res(G.ops.retry(wo.id)); } }));
    if (wo.bay) {
      var dU = stop ? no(stop.reason) : G.me("wo.park", { project: p.id });
      if (dU.allowed && wo.bay === "sechold" && !G.me("gate.approve", { project: p.id }).allowed) dU = no("Security hold can only be released by someone who may approve gates in " + p.name + ".");
      row1.push(G.btn("Return to " + stName(wo.bayFrom || G.STATIONS[wo.station].id), { kind: "primary", icon: "undo", id: "trv-unpark", guard: dU, onClick: function () {
        G.reasonDialog({ title: "Return " + wo.id + " from " + G.bayDef(wo.bay).name, kicker: "Bay", ok: "Return to belt", min: 3, placeholder: "What changed?", sub: "It goes back to " + stName(wo.bayFrom || G.STATIONS[wo.station].id) + ".",
          onOk: function (v) { var r = G.ops.unpark(wo.id, v); if (r.ok) G.toast(r.msg, "ok"); return r; } });
      } }));
    } else {
      row2.push(G.btn("Move to bay", { icon: "st-park", id: "trv-park", guard: closed ? no(closedWhy) : stop ? no(stop.reason) : G.me("wo.park", { project: p.id }), onClick: function () { G.parkDialog(wo.id); } }));
    }
    var route = G.route(p, wo.cls);
    var first = route.indexOf(G.STATIONS[wo.station].id) <= 0;
    row2.push(G.btn("Send back", { icon: "undo", id: "trv-sendback", guard: closed ? no(closedWhy) : stop ? no(stop.reason) : wo.bay ? no("Return it from " + G.bayDef(wo.bay).name + " first.") : first ? no("Already at the first station on its route.") : G.me("wo.sendback", { project: p.id }), onClick: function () { G.sendBackDialog(wo.id); } }));
    row2.push(G.btn("Reassign agent", { icon: "swap", id: "trv-reassign", guard: closed ? no(closedWhy) : wo.bay ? no("Nobody staffs work in a bay.") : G.me("wo.reassign", { project: p.id }), onClick: function () { G.reassignDialog(wo.id); } }));
    row2.push(G.btn("Reclassify", { icon: "tag", id: "trv-reclass", guard: closed ? no(closedWhy) : wo.station !== 0 || wo.bay ? no("Class can only change at Intake. Send it back to Intake first.") : G.me("wo.classify", { project: p.id }), onClick: function () { G.reclassifyDialog(wo.id); } }));
    if (repo) row2.push(repo.halted
      ? G.btn("Resume " + repo.name, { icon: "play", id: "trv-resume", guard: G.me("line.resume", { project: p.id }), onClick: function () { res(G.ops.resumeRepo(repo.id)); } })
      : G.btn("Halt repo", { kind: "andon", icon: "halt", id: "trv-halt", aria: "Halt " + repo.name + " (andon)", guard: G.me("line.halt", { project: p.id }), onClick: function () { G.haltDialog("repo", repo.id); } }));
    row2.push(wo.state === "killed"
      ? G.btn("Restore " + wo.id, { icon: "power", id: "trv-restore", guard: stop ? no(stop.reason + " Restore the " + stop.level + " first.") : G.me("restore.workorder", { project: p.id }), onClick: function () { G.restoreDialog("workorder", wo.id); } })
      : G.btn("Kill work order", { kind: "danger", icon: "st-kill", id: "trv-kill", guard: wo.state === "done" ? no(closedWhy) : G.me("kill.workorder", { project: p.id }), onClick: function () { G.killDialog("workorder", wo.id); } }));
    return h("div", { class: "trv-actions" }, row1.length ? h("div", { class: "drawer-actions" }, row1) : null, h("div", { class: "drawer-actions trv-actions-2" }, row2));
  }

  /* ================= drawer ================= */
  G.openTraveler = function (woId, tab) {
    var id = String(woId || "").toUpperCase();
    if (!G.find.wo(id)) { G.toast("No work order " + woId + ".", "error"); return; }
    if (tab) t.tab = tab; else if (t.wo !== id) t.tab = "journey";
    if (t.wo !== id) t.scrub = null;
    t.wo = id;
    G.drawer.open("wo:" + id, function (close) { return renderDrawer(id, close); });
  };

  function renderDrawer(woId, close) {
    var wo = G.find.wo(woId); if (!wo) return null;
    var p = G.find.project(wo.project), repo = G.find.repo(wo.repo) || { name: wo.repo };
    var st = G.STATIONS[wo.state === "done" ? 8 : wo.station];
    var tot = G.woTotals(wo);
    var stop = G.stopState(p.id, wo.repo), halt = G.haltState(p.id, wo.repo);
    var tabs = [{ id: "journey", label: "Journey" }, { id: "lifecycle", label: "Lifecycle" }, { id: "conversation", label: "Conversation", count: wo.conv.messages.length }, { id: "brief", label: "Brief" }, { id: "artefacts", label: "Artefacts" }, { id: "history", label: "History" }];
    var body = t.tab === "lifecycle" ? lifecycle(wo) : t.tab === "conversation" ? conversation(wo) : t.tab === "brief" ? brief(wo, p) : t.tab === "artefacts" ? artefacts(wo, p) : t.tab === "history" ? history(wo) : journey(wo, p);
    var where = wo.state === "done" ? (wo.split ? "Split into children" : "Shipped " + G.fmt.stamp(wo.doneAt)) : wo.bay ? G.bayDef(wo.bay).name : st.no + " " + st.name;
    return h("div", { class: "drawer-inner trv-drawer" + (wo.state === "killed" ? " is-killed" : "") },
      h("div", { class: "drawer-head" },
        h("div", { class: "trv-headmain" },
          h("div", { class: "kicker" }, "Traveler · routing sheet · " + p.name),
          h("div", { class: "drawer-id" }, h("span", { class: "mono big-id" }, wo.id), G.stateChip(wo.state), G.classChip(wo.cls), h("span", { class: "chip prio-" + wo.priority }, wo.priority), wo.heldByKill ? h("span", { class: "chip chip-block" }, "held by " + wo.heldByKill + " kill") : null),
          h("h2", { class: "drawer-title" }, wo.title)),
        h("div", { class: "trv-headtools" },
          G.btn("Open full record", { small: true, icon: "record", id: "trv-open-record", onClick: function () { close(); G.openRecord(wo.id); } }),
          h("button", { type: "button", class: "icon-btn drawer-close", id: "trv-close", "aria-label": "Close traveler", onClick: close }, G.icon("x")))),
      h("div", { class: "drawer-scroll" },
        wo.killed ? h("div", { class: "trv-killed", role: "alert" }, G.icon("st-kill"), h("div", null, h("strong", null, "KILLED"), h("span", null, " · " + wo.killed.scope + " kill by " + G.actorName(wo.killed.by) + ", " + G.fmt.stamp(wo.killed.at) + ": " + wo.killed.reason + (wo.pr ? ". PR #" + wo.pr.number + " left as " + wo.pr.state + "." : ".")))) : null,
        !wo.killed && stop ? h("div", { class: "trv-killed", role: "alert" }, G.icon("st-kill"), h("div", null, h("strong", null, "STOPPED"), h("span", null, " · " + stop.reason + (wo.heldByKill ? " This work order is held in place and resumes on restore." : "")))) : null,
        halt ? h("div", { class: "halt-banner" }, G.icon("halt"), h("span", null, halt.reason)) : null,
        wo.blockReason ? h("div", { class: "callout callout-block" }, G.icon("st-block"), h("span", null, wo.blockReason)) : null,
        wo.failReason ? h("div", { class: "callout callout-fail" }, G.icon("st-fail"), h("span", null, wo.failReason)) : null,
        h("dl", { class: "titleblock tb-drawer" },
          tb("Repo", repo.name), tb("Where", where), tb("Class", G.find.cls(wo.cls).name + " · " + Math.round(wo.clsConfidence * 100) + "%" + (wo.clsOverridden ? " (overridden)" : "")), tb("Source", wo.source),
          tb("Requested by", G.actorName(wo.requestedBy)), tb("Created", G.fmt.stamp(wo.createdAt)), tb("SLA due", wo.slaDue ? G.fmt.stamp(wo.slaDue) : "none"), tb("PR", wo.pr ? "#" + wo.pr.number + " " + wo.pr.state : "not yet"),
          tb("Coding slot", wo.slot ? wo.slot + " of " + p.flow.slots : "none"), tb("Tokens", G.fmt.k(tot.tokens)), tb("Spend", G.fmt.money(tot.cost)), tb("Risk", wo.risk || "normal")),
        wo.description ? h("p", { class: "drawer-desc" }, wo.description) : null,
        actions(wo, p),
        G.tabBar({ id: "trv-tab", items: tabs, active: t.tab, onChange: function (x) { t.tab = x; G.drawer.refresh(); var b = document.getElementById("trv-tab-" + x); if (b) b.focus(); } }),
        h("div", { class: "drawer-tabbody", id: "trv-tab-panel", role: "tabpanel", "aria-labelledby": "trv-tab-" + t.tab }, body)));

  }

  /* ================= dialogs ================= */
  G.newWODialog = function (preset) {
    preset = preset || {};
    var me = G.viewerId();
    var projects = G.visibleProjects(me).filter(function (p) { return p.status !== "archived"; });
    if (!projects.length) { G.toast("You have no projects to submit work to.", "warn"); return; }
    var pick = preset.project && G.find.project(preset.project) ? preset.project : (G.currentProject() || projects[0]).id;
    var st = { project: pick, repo: preset.repo || null, title: preset.title || "", desc: preset.description || "", att: "", cls: "", prio: "auto", source: preset.source || "web" };
    var projSel = G.select("nwo-project", projects.map(function (p) { var ok = G.me("wo.submit", { project: p.id }).allowed; return { value: p.id, label: p.name + (ok ? "" : " (not permitted)") }; }), st.project, function (v) { st.project = v; st.repo = null; refresh(); });
    var repoBox = h("div", { class: "nwo-repo" });
    var title = h("input", { id: "nwo-title", class: "input", value: st.title, placeholder: "Add idempotency keys to refund endpoint", autocomplete: "off" });
    var desc = h("textarea", { id: "nwo-desc", class: "input", rows: "4", placeholder: "What should change, and how will we know it is done?" }); desc.value = st.desc;
    var att = h("input", { id: "nwo-att", class: "input", placeholder: "trace.log, screenshot.png", autocomplete: "off" });
    var clsBox = h("div"), prioSel, srcSel = G.select("nwo-source", [{ value: "web", label: "Web" }, { value: "console", label: "Console" }, { value: "slack", label: "Slack message" }, { value: "github", label: "GitHub issue" }], st.source, function (v) { st.source = v; });
    var preview = h("div", { class: "nwo-preview", "aria-live": "polite" });
    var guardBox = h("div");
    var err = h("div", { class: "form-err", role: "alert" });
    prioSel = G.select("nwo-prio", [{ value: "auto", label: "From class" }, { value: "P1", label: "P1 · urgent" }, { value: "P2", label: "P2 · normal" }, { value: "P3", label: "P3 · when free" }], "auto", function (v) { st.prio = v; });
    var dlg;
    function blocked() {
      var p = G.find.project(st.project);
      var d = G.me("wo.submit", { project: p.id });
      if (!d.allowed) return { d: d };
      var why = G.submitGuard(p.id, st.repo);
      return why ? { d: no(why), onboarding: !/refused/.test(why) } : { d: null };
    }
    function refresh() {
      var p = G.find.project(st.project);
      var repos = G.store.get("repos").filter(function (r) { return r.project === p.id; });
      if (!st.repo) { var ready = repos.find(function (r) { return r.onboarding.stage === "ready" || r.onboarding.exception; }); st.repo = ready ? ready.id : repos[0] && repos[0].id; }
      G.clear(repoBox).appendChild(G.field("Repo", repos.length ? G.select("nwo-repo", repos.map(function (r) {
        var ready = r.onboarding.stage === "ready" || r.onboarding.exception;
        return { value: r.id, label: r.name + (ready ? "" : " (not ready: " + stageName(r.onboarding.stage) + ")") };
      }), st.repo, function (v) { st.repo = v; refresh(); }) : h("p", { class: "muted small", id: "nwo-repo" }, "No repos in " + p.name + " yet."), "Only Ready repos accept work orders."));
      var classes = G.classesOf(p);
      G.clear(clsBox).appendChild(G.field("Requested class", G.select("nwo-cls", [{ value: "", label: "Let the Intake agent decide" }].concat(classes.map(function (c) { return { value: c.id, label: c.name }; })), st.cls, function (v) { st.cls = v; classify(); }), "The classifier may disagree; overrides are audited."));
      var b = blocked();
      G.clear(guardBox);
      if (b.d) {
        var link = b.onboarding ? h("a", { href: "#onboarding", class: "linkish", id: "nwo-onb-link", onClick: function () { G.store.update("prefs", function (x) { x.project = st.project; }); if (dlg) dlg.close(); } }, "Open onboarding for " + p.name) : null;
        guardBox.appendChild(h("div", { class: "callout callout-warn", role: "note" }, G.icon("lock"), h("span", null, (b.d.needs ? b.d.needs + ". " : "") + b.d.reason + " ", link)));
      }
      if (dlg) { var ok = document.getElementById("nwo-submit"); if (ok) { ok.classList.toggle("is-locked", !!b.d); if (b.d) { ok.setAttribute("aria-disabled", "true"); ok.setAttribute("data-reason", b.d.reason); } else { ok.removeAttribute("aria-disabled"); ok.removeAttribute("data-reason"); } } }
      classify();
    }
    function classify() {
      var text = (title.value + " " + desc.value).trim();
      G.clear(preview);
      if (text.length < 6) { preview.appendChild(h("p", { class: "muted small" }, "The Intake classifier previews the class as you type.")); return; }
      var c = G.classify(text, st.cls || null);
      var p = G.find.project(st.project);
      preview.appendChild(h("div", { class: "nwo-cls-preview" }, h("span", { class: "muted small" }, "Classifier preview:"), G.classChip(c.cls), h("span", { class: "mono small" }, Math.round(c.confidence * 100) + "%"), h("span", { class: "small" }, c.rationale)));
      preview.appendChild(h("p", { class: "small muted" }, "Route: " + G.route(p, c.cls).map(stName).join(" → ")));
    }
    title.addEventListener("input", classify); desc.addEventListener("input", classify);
    dlg = G.dialog({
      title: "New work order", kicker: "Intake · S0", wide: true,
      sub: "It starts at S0 Intake. The Intake agent classifies it, proposes a route and opens a conversation to complete the brief.",
      body: h("div", { class: "form-grid" },
        h("div", { class: "form-row" }, G.field("Project", projSel), repoBox), guardBox,
        G.field("Title", title), G.field("Description", desc, "Acceptance criteria help the Spec agent."),
        G.field("Attachment names", att, "Names only; files are not uploaded in this demo."),
        h("div", { class: "form-row" }, clsBox, G.field("Priority", prioSel), G.field("Source", srcSel)),
        preview, err),
      actions: [{ label: "Cancel" }, { label: "Submit work order", kind: "primary", submit: true, id: "nwo-submit", onClick: function (close) {
        var b = blocked(); if (b.d) { err.textContent = b.d.reason; return; }
        var r = G.ops.submitWO({ project: st.project, repo: st.repo, title: title.value, description: desc.value, priority: st.prio === "auto" ? null : st.prio, requestedCls: st.cls || null,
          attachments: att.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean), source: st.source }, st.source === "console" ? "console" : "web");
        if (!r.ok) { err.textContent = r.msg; return; }
        close();
        if (G.afterSubmitWO) G.afterSubmitWO(r.wo.id);
        else { G.toast(r.msg, "ok"); G.openTraveler(r.wo.id, "conversation"); }
      } }]
    });
    refresh();
  };

  G.sendBackDialog = function (woId) {
    var wo = G.find.wo(woId); if (!wo) return;
    var p = G.find.project(wo.project);
    var route = G.route(p, wo.cls), cur = route.indexOf(G.STATIONS[wo.station].id);
    var opts = route.slice(0, Math.max(0, cur)).map(function (sid) { return { value: sid, label: G.find.station(sid).no + " " + G.find.station(sid).name }; }).reverse();
    if (!opts.length) { G.toast(wo.id + " is at the first station on its route.", "warn"); return; }
    var to = G.select("sb-to", opts, opts[0].value);
    var note = h("textarea", { id: "sb-note", class: "input", rows: "3", placeholder: "What needs to change?" });
    var err = h("div", { class: "form-err", role: "alert" });
    var d = G.me("wo.sendback", { project: p.id });
    G.dialog({ title: "Send " + wo.id + " back", kicker: "Rework", sub: "The station's agent picks it up again with your note. Gates after that station reset and need approving again.",
      body: h("div", { class: "form-grid" }, G.lockNote(d, "Sending work back"), G.field("Back to station", to, "Only earlier stations on the " + G.find.cls(wo.cls).name + " route."), G.field("Note for the agent", note), err),
      actions: [{ label: "Cancel" }, { label: "Send back", kind: "primary", icon: "undo", submit: true, id: "sb-submit", guard: d, onClick: function (close) {
        var r = G.ops.sendBack(wo.id, to.value, note.value.trim());
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  };

  G.reassignDialog = function (woId) {
    var wo = G.find.wo(woId); if (!wo) return;
    var st = G.STATIONS[wo.station], cur = openEntry(wo).agent;
    var agents = G.store.get("agents").filter(function (a) { return (a.stations || []).indexOf(st.id) >= 0 && (a.projects === "all" || (a.projects || []).indexOf(wo.project) >= 0); });
    if (!agents.some(function (a) { return a.id === cur; }) && G.find.agent(cur)) agents.unshift(G.find.agent(cur));
    var sel = G.select("ra-agent", agents.map(function (a) { return { value: a.id, label: a.name + " " + a.version + " · " + a.model + (a.status && a.status !== "active" ? " (" + a.status + ")" : "") + (a.id === cur ? " (current)" : "") }; }), cur);
    var err = h("div", { class: "form-err", role: "alert" });
    var d = G.me("wo.reassign", { project: wo.project });
    G.dialog({ title: "Reassign " + st.name + " on " + wo.id, kicker: "Staffing",
      sub: "Only agents allowed to staff " + st.name + " in " + G.find.project(wo.project).name + " are listed. The model follows the agent and the project's routing rules.",
      body: h("div", { class: "form-grid" }, G.lockNote(d, "Reassigning agents"), G.field("Agent", sel, agents.length < 2 ? "Only one agent may staff this station here. Allow more on the Agents screen." : null), err),
      actions: [{ label: "Cancel" }, { label: "Reassign", kind: "primary", icon: "swap", submit: true, id: "ra-submit", guard: d, onClick: function (close) {
        if (sel.value === cur) { err.textContent = "Pick a different agent."; return; }
        var r = G.ops.reassign(wo.id, sel.value);
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  };

  G.parkDialog = function (woId) {
    var wo = G.find.wo(woId); if (!wo) return;
    var opts = G.flowOf(G.find.project(wo.project)).bays.map(function (b) { var c = G.moveCheck(wo, b.id); return { value: b.id, label: b.name + (c.allowed ? "" : " (not available)"), disabled: !c.allowed, why: c.reason }; });
    var first = opts.find(function (o) { return !o.disabled; });
    var bay = G.select("park-bay", opts, first ? first.value : opts[0].value);
    var reason = h("textarea", { id: "park-reason", class: "input", rows: "3", placeholder: "Why does it leave the belt?" });
    var err = h("div", { class: "form-err", role: "alert" });
    var d = first ? G.me("wo.park", { project: wo.project }) : no(opts[0].why);
    G.dialog({ title: "Move " + wo.id + " to a bay", kicker: "Off the main belt", sub: "Work in a bay stops. It returns to " + G.STATIONS[wo.station].name + " when someone releases it.",
      body: h("div", { class: "form-grid" }, G.lockNote(d, "Moving work to a bay"), G.field("Bay", bay, "Declined needs Decline rights. Queue is only for work about to build."), G.field("Reason", reason), err),
      actions: [{ label: "Cancel" }, { label: "Move to bay", kind: "primary", icon: "st-park", submit: true, id: "park-submit", guard: d, onClick: function (close) {
        var r = G.ops.park(wo.id, bay.value, reason.value);
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  };

  G.reclassifyDialog = function (woId) {
    var wo = G.find.wo(woId); if (!wo) return;
    var p = G.find.project(wo.project);
    var classes = G.classesOf(p);
    var sel = G.select("rc-cls", classes.map(function (c) { return { value: c.id, label: c.name + (c.id === wo.cls ? " (current)" : "") + (c.id === wo.clsSuggested ? " (classifier)" : "") }; }), wo.cls);
    var reason = h("textarea", { id: "rc-reason", class: "input", rows: "2", placeholder: "Why is the classifier wrong?" });
    var routeP = h("p", { class: "small muted", "aria-live": "polite" });
    function showRoute() { routeP.textContent = "Route: " + G.route(p, sel.value).map(stName).join(" → "); }
    sel.addEventListener("change", showRoute); showRoute();
    var err = h("div", { class: "form-err", role: "alert" });
    var d = G.me("wo.classify", { project: p.id });
    G.dialog({ title: "Reclassify " + wo.id, kicker: "Intake · class override", sub: "Classifier said " + G.find.cls(wo.clsSuggested || wo.cls).name + " (" + Math.round(wo.clsConfidence * 100) + "%): " + wo.clsRationale + " The change is audited with before and after.",
      body: h("div", { class: "form-grid" }, G.lockNote(d, "Changing the class"), G.field("Class", sel), routeP, G.field("Reason", reason), err),
      actions: [{ label: "Cancel" }, { label: "Reclassify", kind: "primary", icon: "tag", submit: true, id: "rc-submit", guard: d, onClick: function (close) {
        if (sel.value === wo.cls) { err.textContent = "Pick a different class."; return; }
        if (reason.value.trim().length < 3) { err.textContent = "Give a reason."; return; }
        var r = G.ops.reclassify(wo.id, sel.value, reason.value.trim());
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  };
})(window.G);
