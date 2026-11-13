/* Conversations (#conversations): inbox of intake conversations for the current project, the thread with
   quick-reply chips and free text, classification with override, and a live brief panel.
   Exports G.renderConversation(woId, { idPrefix, head }) and G.renderBriefPanel(woId, { idPrefix }) for the traveler;
   head: true adds the id/title header (the traveler has its own). */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: null, sel: null, mobileThread: false };
  var drafts = {}, lastCount = {}, savedScroll = {}, lastBrief = {};
  var fu = {};   // woId -> { busy, text, chips[], mode, error, ctrl }

  /* ---------- follow-up questions (G.ask drafts them, with a local fallback; G.ops.addFollowup adds one) ---------- */
  var FU_MAX = 3;
  function followupOp(woId, q) { return G.ops.addFollowup(woId, q); }

  /* local drafting: the gaps the classifier could not close, then the usual checks */
  function localFollowup(wo) {
    var asked = wo.conv.questions.map(function (q) { return q.id + " " + q.text.toLowerCase(); }).join("\n");
    var cands = [
      { key: "rollback", text: "If this has to be undone after release, how should we roll it back?", chips: ["Revert the PR", "Turn the feature flag off", "Needs a migration rollback"] },
      { key: "testdata", text: "What test data can the agents use to prove this works?", chips: ["Fixtures already in the repo", "Generate synthetic data", "I will attach a sample"] },
      { key: "version", text: "Which release should this land in?", chips: ["Next patch release", "Next minor release", "Internal only, no release"] },
      { key: "owner", text: "Besides the owning team, who should review this change?", chips: ["Nobody else", "Security", "The on-call engineer"] },
      { key: "metric", text: "Which metric or alert tells us this is working in production?", chips: ["Error rate on the endpoint", "A new dashboard panel", "No metric needed"] },
      { key: "deadline", text: "Is there a date this must ship by?", chips: ["No fixed date", "This week", "Before the next release"] }
    ];
    var pick = cands.find(function (c) { return asked.indexOf(c.key) < 0 && asked.indexOf(c.text.toLowerCase()) < 0; }) || cands[cands.length - 1];
    return pick.text + "\n" + pick.chips.map(function (c) { return "- " + c; }).join("\n");
  }
  function parseFollowup(text) {
    var lines = String(text || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var q = (lines.find(function (l) { return !/^[-*•]/.test(l); }) || "").replace(/^(question|q)\s*[:.]\s*/i, "");
    var chips = lines.filter(function (l) { return /^[-*•]/.test(l); }).map(function (l) { return l.replace(/^[-*•]\s*/, ""); }).slice(0, 3);
    return { text: q, chips: chips };
  }
  function draftFollowup(wo, pre) {
    if (fu[wo.id] && fu[wo.id].busy) return;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var st = fu[wo.id] = { busy: true, text: "", chips: [], mode: null, error: null, ctrl: ctrl, raw: "" };
    refresh();
    var b = wo.brief || {};
    G.ask({
      instructions: "You are the Intake agent for a software factory. Read the request and the conversation so far and draft ONE more clarifying question that would most improve the brief. Do not repeat a question already asked. Reply with the question on the first line, then two or three short suggested answers, each on its own line starting with '- '. No other text.",
      data: { id: wo.id, title: wo.title, request: wo.description, cls: (G.find.cls(wo.cls) || {}).name, repo: wo.repo, asked: wo.conv.questions.map(function (q) { return q.text; }), answers: wo.conv.answers, misses: wo.conv.misses.map(function (m) { return m.text + (m.resolved ? " (answered)" : ""); }), brief: { scopeIn: b.scopeIn, scopeOut: b.scopeOut, ac: b.ac, risks: b.risks } },
      question: "Draft a follow-up question for " + wo.id + ".", signal: ctrl ? ctrl.signal : undefined, modelTier: "fast",
      onText: function (full) { st.raw = full; var p = parseFollowup(full); st.text = p.text; var el = document.getElementById(pre + "fu-text-" + wo.id); if (el) el.value = p.text; },
      fallback: function () { return localFollowup(wo); }
    }).then(function (r) {
      if (fu[wo.id] !== st) return;
      var p = parseFollowup(r.text || st.raw);
      if (!p.text && r.error === "aborted") { delete fu[wo.id]; refresh(); return; }
      if (!p.text) p = parseFollowup(localFollowup(wo));
      st.busy = false; st.mode = r.mode; st.error = r.error || null; st.text = p.text; st.chips = p.chips;
      refresh();
    });
  }
  function refresh() { if (G.drawer.isOpen()) G.drawer.refresh(); G.rerender(); }
  function followupBox(wo, pre, canAnswer) {
    var st = fu[wo.id];
    var used = wo.conv.questions.filter(function (q) { return q.followup; }).length;
    var full = used >= FU_MAX;
    var busy = st && st.busy;
    var head = h("div", { class: "conv-fu-head" },
      G.btn("Suggest a follow-up question", { small: true, kind: "ghost", icon: "sparkle", id: pre + "fu-" + wo.id, guard: canAnswer.allowed ? null : canAnswer,
        disabledReason: canAnswer.allowed ? (busy ? "A suggestion is being drafted" : full ? "This conversation already has " + FU_MAX + " follow-up questions" : null) : null,
        onClick: function () { draftFollowup(wo, pre); } }),
      G.ask && G.ask.badge ? G.ask.badge(pre + "fu-badge-" + wo.id) : null,
      used ? h("span", { class: "small muted" }, used + " of " + FU_MAX + " follow-ups used") : null);
    if (!st) return h("div", { class: "conv-fu" }, head);
    var ta = h("textarea", { id: pre + "fu-text-" + wo.id, class: "input", rows: "2", "aria-label": "Follow-up question", readonly: busy ? true : null });
    ta.value = st.text;
    ta.addEventListener("input", function () { st.text = ta.value; });
    var chipIn = h("input", { id: pre + "fu-chips-" + wo.id, class: "input", value: st.chips.join("; "), placeholder: "Suggested answers, separated by ;", "aria-label": "Suggested answers", readonly: busy ? true : null });
    chipIn.addEventListener("input", function () { st.chips = chipIn.value.split(";").map(function (x) { return x.trim(); }).filter(Boolean); });
    var note = busy ? "Drafting…" : st.mode === "claude" ? "Drafted by Claude. Edit it before asking." : st.error === "not_granted" ? "Claude was not granted; drafted with local logic." : st.error === "rate_limited" ? "Claude is rate limited; drafted with local logic." : "Drafted with local logic.";
    return h("div", { class: "conv-fu is-open" }, head,
      h("div", { class: "conv-fu-card" },
        h("div", { class: "small muted", "aria-live": "polite" }, note),
        G.field("Question", ta), G.field("Suggested answers", chipIn),
        h("div", { class: "conv-fu-act" },
          busy ? G.btn("Stop", { small: true, icon: "x", id: pre + "fu-stop-" + wo.id, onClick: function () { if (st.ctrl) st.ctrl.abort(); } }) : null,
          G.btn("Discard", { small: true, kind: "ghost", id: pre + "fu-discard-" + wo.id, onClick: function () { if (st.busy && st.ctrl) st.ctrl.abort(); delete fu[wo.id]; refresh(); } }),
          G.btn("Ask this", { small: true, kind: "primary", icon: "send", id: pre + "fu-ask-" + wo.id, guard: canAnswer.allowed ? null : canAnswer, disabledReason: canAnswer.allowed && busy ? "Wait for the draft to finish" : null, onClick: function () {
            var r = followupOp(wo.id, { text: st.text, chips: st.chips, mode: st.mode });
            G.toast(r.msg, r.ok ? "ok" : "error");
            if (r.ok) { delete fu[wo.id]; refresh(); }
          } }))));
  }

  /* ---------- status ---------- */
  function atIntake(wo) { return wo.station === 0 && !wo.bay && wo.state !== "killed" && wo.gates.G0G1 && wo.gates.G0G1.status !== "passed"; }
  function raisedOpen(wo) { return (wo.conv.raised || []).filter(function (q) { return !q.answered; }); }
  function isOpen(wo) { return wo.state !== "killed" && wo.bay !== "declined" && (atIntake(wo) || raisedOpen(wo).length > 0 || (wo.bay === "person" && wo.bayFrom === "intake")); }
  function convStatus(wo) {
    if (wo.state === "killed") return { id: "killed", text: "Killed", glyph: "st-kill" };
    if (wo.bay === "declined") return { id: "declined", text: "Declined", glyph: "x" };
    var r = raisedOpen(wo);
    if (r.length) return { id: "raised", text: "Question from " + ((G.find.station(r[0].station) || {}).name || r[0].station), glyph: "human" };
    if (wo.bay === "person" && wo.bayFrom === "intake") return { id: "raised", text: "Needs a person at Intake", glyph: "human" };
    if (atIntake(wo)) return wo.conv.done ? { id: "ready", text: "Brief ready to confirm", glyph: "gate" } : { id: "asking", text: "Question " + Math.min(wo.conv.qi + 1, wo.conv.questions.length) + " of " + wo.conv.questions.length, glyph: "chat" };
    return { id: "confirmed", text: "Brief confirmed", glyph: "check" };
  }
  function statusChip(wo) { var s = convStatus(wo); return h("span", { class: "conv-st conv-st-" + s.id }, G.icon(s.glyph), h("span", null, s.text)); }
  function lastAt(wo) { var m = wo.conv.messages; return m.length ? m[m.length - 1].at : wo.createdAt; }
  function answerDecision(wo) {
    var d = G.me("wo.answer", { project: wo.project });
    if (d.allowed || wo.requestedBy === G.viewerId()) return { allowed: true };
    return d;
  }

  /* ---------- thread ---------- */
  function msgNode(wo, m, i, isCurrent, canAnswer, pre) {
    var agent = G.find.agent(m.from);
    var mine = m.from === G.viewerId();
    var sys = m.from === "ag-classifier";
    var who = agent ? agent.name : G.actorName(m.from);
    var chips = isCurrent && m.chips && m.chips.length ? h("div", { class: "conv-chips", role: "group", "aria-label": "Quick replies" }, m.chips.map(function (c, k) {
      return G.btn(c, { small: true, cls: "conv-chip", id: pre + "chip-" + wo.id + "-" + k, guard: canAnswer.allowed ? null : canAnswer, onClick: function () { send(wo.id, c); } });
    })) : null;
    return h("li", { class: "conv-msg" + (agent ? " is-agent" : " is-person") + (mine ? " is-mine" : "") + (sys ? " is-sys" : "") + (isCurrent ? " is-current" : "") },
      h("div", { class: "conv-msg-av" }, G.avatar(m.from, "sm")),
      h("div", { class: "conv-bubble" },
        h("div", { class: "conv-meta" }, h("strong", null, mine ? "You" : who), agent ? h("span", { class: "conv-tag mono" }, "agent") : null, h("span", { class: "mono muted" }, G.fmt.ist(m.at) + " IST")),
        h("div", { class: "conv-text" }, m.text),
        chips));
  }
  function send(woId, text) {
    var r = G.ops.answer(woId, text);
    if (r.ok) { drafts[woId] = ""; if (r.msg !== "Answer recorded.") G.toast(r.msg, "ok"); }
    else G.toast(r.msg, "error");
    if (G.drawer.isOpen()) G.drawer.refresh();
    return r;
  }

  G.renderConversation = function (woId, opts) {
    opts = opts || {};
    var pre = opts.idPrefix || "conv-"; if (pre.slice(-1) !== "-") pre += "-";
    var wo = G.find.wo(woId);
    if (!wo) return G.emptyState({ title: "No such work order", text: "It may have been removed." });
    var project = G.find.project(wo.project);
    var conv = wo.conv;
    var canAnswer = answerDecision(wo);
    var intake = atIntake(wo);
    var raised = raisedOpen(wo);
    var stop = G.stopState(wo.project, wo.repo);
    var lastQ = -1;
    conv.messages.forEach(function (m, i) { if (m.qid) lastQ = i; });
    var curQ = conv.questions[conv.qi];
    var showChips = intake && !conv.done && !raised.length && curQ;
    var msgs = h("ol", { class: "conv-msgs", id: pre + "msgs-" + wo.id, "aria-label": "Messages", tabindex: "0" },
      conv.messages.map(function (m, i) { return msgNode(wo, m, i, showChips && i === lastQ && m.qid === curQ.id, canAnswer, pre); }));
    var key = pre + wo.id;
    msgs.addEventListener("scroll", function () { savedScroll[key] = msgs.scrollTop; });
    setTimeout(function () {
      if (!document.body.contains(msgs)) return;
      if (lastCount[key] !== conv.messages.length) { msgs.scrollTop = msgs.scrollHeight; lastCount[key] = conv.messages.length; }
      else if (savedScroll[key] != null) msgs.scrollTop = savedScroll[key];
    }, 0);

    /* composer */
    var closed = !intake && !raised.length && !(wo.bay === "person");
    var ta = h("textarea", { id: pre + "reply-" + wo.id, class: "input conv-input", rows: "2", placeholder: closed ? "This conversation is closed." : raised.length ? "Answer the question from " + ((G.find.station(raised[0].station) || {}).name || "the station") : conv.done ? "Add a note to the brief" : "Type your own answer", disabled: !canAnswer.allowed || closed, "aria-label": "Reply" });
    ta.value = drafts[wo.id] || "";
    ta.addEventListener("input", function () { drafts[wo.id] = ta.value; });
    function submit() { if (!ta.value.trim()) { G.toast("Write an answer first.", "warn"); return; } send(wo.id, ta.value); }
    ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canAnswer.allowed && !closed) submit(); } });
    var sendBtn = G.btn("Send", { kind: "primary", icon: "send", small: true, id: pre + "send-" + wo.id, guard: canAnswer.allowed ? null : canAnswer, disabledReason: canAnswer.allowed && closed ? "The conversation is closed" : null, onClick: submit });

    /* classification */
    var clsD = G.me("wo.classify", { project: wo.project });
    var cls = h("div", { class: "conv-cls" },
      h("div", { class: "conv-cls-row" }, h("span", { class: "kicker" }, "Class"), G.classChip(wo.cls), G.intakeConfMeter ? G.intakeConfMeter(wo.clsConfidence) : h("span", { class: "mono" }, Math.round(wo.clsConfidence * 100) + "%"),
        G.btn("Change class", { small: true, icon: "swap", id: pre + "reclass-" + wo.id, guard: clsD, disabledReason: clsD.allowed && !intake ? "Class can only change at Intake" : null,
          onClick: function () { if (G.intakeReclassifyDialog) G.intakeReclassifyDialog(wo.id); } })),
      h("p", { class: "small conv-cls-why" }, wo.clsRationale),
      wo.clsOverridden ? h("p", { class: "small conv-ovr" }, G.icon("swap"), " Overridden from " + G.find.cls(wo.clsOverridden.from).name + " by " + G.actorName(wo.clsOverridden.by) + ", " + G.fmt.stamp(wo.clsOverridden.at) + (wo.clsOverridden.reason ? ": " + wo.clsOverridden.reason : "") + ".") : null);

    /* confirm / decline */
    var gd = G.gateDecision(G.viewerId(), wo, "G0G1");
    var decD = G.me("wo.decline", { project: wo.project });
    var openQs = conv.questions.length - conv.qi;
    var actions = intake ? h("div", { class: "conv-actions" },
      h("div", { class: "conv-gate" }, G.gateDiamond({ gateId: "G0G1", state: wo.gates.G0G1.status === "waiting" ? "waiting" : "clear", count: 1, size: "sm" }), h("span", { class: "small" }, conv.done ? "Brief is complete. Confirming passes G0+G1 and starts the route." : openQs + " question" + (openQs === 1 ? "" : "s") + " left before the brief can be confirmed.")),
      (opts && opts.noActions) ? h("span", { class: "muted small" }, "Confirm or decline from the traveler header.") : h("div", { class: "conv-act-btns" },
        G.btn("Decline", { kind: "danger", small: true, icon: "x", id: pre + "decline-" + wo.id, guard: decD, onClick: function () {
          G.reasonDialog({ title: "Decline " + wo.id, kicker: "Intake · decline", sub: "The work order moves to the Declined bay. The submitter sees your reason.", label: "Reason", ok: "Decline work order", kind: "danger", min: 5, placeholder: "For example: duplicate of WO-2398.",
            onOk: function (v) { var r = G.ops.decline(wo.id, v); if (r.ok) G.toast(r.msg, "warn"); return r; } });
        } }),
        G.btn("Confirm brief", { kind: "primary", small: true, icon: "check", id: pre + "confirm-" + wo.id, guard: gd,
          disabledReason: gd.allowed ? (stop ? stop.reason : !conv.done ? "Answer the " + openQs + " open question" + (openQs === 1 ? "" : "s") + " first" : null) : null,
          onClick: function () { var r = G.ops.confirmBrief(wo.id); G.toast(r.msg, r.ok ? "ok" : "error"); } }))) : null;

    var awaitNote = conv.awaiting && conv.awaiting !== "submitter" && intake ? h("div", { class: "callout" }, G.icon(conv.awaiting === "slack" ? "slack" : "api"), h("div", { class: "small" }, "The submitter answers through " + (conv.awaiting === "slack" ? ((G.integrationFor({ channel: "slack", target: "" }, wo.project) || { name: "Slack" }).name) : conv.awaiting === "api" ? "the API caller" : ((G.find.integration(conv.awaiting) || { name: conv.awaiting }).name)) + " (simulated). Answers given here are recorded the same way.")) : null;
    var raisedNote = raised.length ? h("div", { class: "callout callout-warn" }, G.icon("human"), h("div", null, h("strong", null, ((G.find.station(raised[0].station) || {}).name || raised[0].station) + " needs an answer. "), raised[0].text, h("div", { class: "small muted" }, "The work order waits in Needs a person until someone answers below."))) : null;
    var endNote = wo.bay === "declined" ? h("div", { class: "callout callout-fail" }, G.icon("x"), h("div", null, h("strong", null, "Declined. "), wo.bayReason)) : wo.state === "killed" ? h("div", { class: "callout callout-fail" }, G.icon("st-kill"), h("div", null, h("strong", null, "Killed. "), wo.killed ? wo.killed.reason : "")) : null;

    return h("div", { class: "conv-thread" },
      !opts.head ? null : h("div", { class: "conv-head" },
        h("div", { class: "conv-head-id" }, h("span", { class: "mono big-id" }, wo.id), G.stateChip(wo.state), statusChip(wo)),
        h("h2", { class: "conv-title" }, wo.title),
        h("p", { class: "small muted" }, (G.find.repo(wo.repo) || {}).name + " · requested by " + G.actorName(wo.requestedBy) + " via " + wo.source + " · " + G.fmt.ago(wo.createdAt)),
        h("div", { class: "conv-head-btns" }, G.btn("Open traveler", { small: true, kind: "ghost", icon: "page", id: pre + "trav-" + wo.id, onClick: function () { G.openTraveler(wo.id); } }),
          G.btn("Open full record", { small: true, kind: "ghost", icon: "record", id: pre + "rec-" + wo.id, onClick: function () { G.openRecord(wo.id); } }))),
      cls, endNote, raisedNote, awaitNote, msgs,
      h("div", { class: "conv-compose" }, G.lockNote(canAnswer.allowed ? null : canAnswer, "Answering this conversation"), ta, h("div", { class: "conv-compose-foot" }, h("span", { class: "small muted" }, "Enter sends, Shift+Enter adds a line. The Intake agent's questions run on local sample logic."), sendBtn)),
      intake && !opts.noFollowup ? followupBox(wo, pre, canAnswer) : null,
      actions);
  };

  /* ---------- live brief ---------- */
  G.renderBriefPanel = function (woId, opts) {
    opts = opts || {};
    var wo = G.find.wo(woId); if (!wo) return null;
    var b = wo.brief, conv = wo.conv, project = G.find.project(wo.project);
    var first = !lastBrief[woId];
    var mem = lastBrief[woId] || (lastBrief[woId] = {});
    function sec(key, title, content, val) {
      var v = JSON.stringify(val);
      if (!mem[key]) mem[key] = { v: v, at: 0 };
      else if (mem[key].v !== v) { mem[key] = { v: v, at: Date.now() }; }
      var changed = !first && Date.now() - mem[key].at < 8000;
      return h("section", { class: "brief-sec" + (changed ? " is-new" : "") }, h("h3", { class: "brief-h" }, title, changed ? h("span", { class: "brief-upd mono" }, "updated") : null), content);
    }
    function list(items, empty, cls) { return items && items.length ? h("ul", { class: "brief-list " + (cls || "") }, items.map(function (x) { return h("li", null, x); })) : h("p", { class: "muted small" }, empty); }
    var answered = conv.qi, total = conv.questions.length;
    var children = b.children || [];
    var made = (wo.children || []).map(function (id) { return G.find.wo(id); }).filter(Boolean);
    var node = h("div", { class: "brief" },
      h("div", { class: "brief-top" }, h("div", { class: "kicker" }, "Brief · built live"), h("div", { class: "brief-prog" }, G.meter(answered, total, answered + " of " + total + " answered"))),
      sec("goal", "Goal", h("p", { class: "brief-goal" }, b.goal), b.goal),
      sec("scope", "Scope", h("div", { class: "brief-scope" }, h("div", null, h("div", { class: "kv-k" }, "In"), list(b.scopeIn, "Not set yet")), h("div", null, h("div", { class: "kv-k" }, "Out"), list(b.scopeOut, "Nothing excluded"))), [b.scopeIn, b.scopeOut]),
      sec("ac", "Acceptance criteria", list(b.ac, "Not set yet", "brief-ac"), b.ac),
      sec("misses", "Misses the agent found", conv.misses.length ? h("ul", { class: "brief-misses" }, conv.misses.map(function (m) { return h("li", { class: m.resolved ? "is-ok" : "is-open" }, G.icon(m.resolved ? "check" : "alert"), h("span", null, m.text), h("span", { class: "small muted" }, m.resolved ? "answered" : "open")); })) : h("p", { class: "muted small" }, "None found."), conv.misses),
      sec("risks", "Risks", list(b.risks, "None recorded"), b.risks),
      sec("open", "Open questions", list(b.open, "None. The brief is complete."), b.open),
      sec("decisions", "Decisions", conv.decisions.length ? h("ol", { class: "brief-dec" }, conv.decisions.map(function (d) { return h("li", null, h("span", null, d.text), h("span", { class: "small muted" }, G.actorName(d.by) + ", " + G.fmt.ist(d.at) + " IST")); })) : h("p", { class: "muted small" }, "None yet."), conv.decisions.length),
      sec("est", "Estimate and route", h("div", null, h("p", null, h("span", { class: "mono strong" }, b.estimate), h("span", { class: "small muted" }, " · " + G.find.cls(wo.cls).name + " route, " + b.route.length + " stations")), G.intakeRouteStrip && project ? G.intakeRouteStrip(project, wo.cls) : h("p", { class: "small" }, b.route.join(" → "))), [b.estimate, b.route]),
      wo.cls === "epic" ? sec("children", "Child work orders", h("div", null,
        made.length ? h("div", { class: "brief-kids" }, made.map(function (c) { return G.woToken(c, { compact: true, idPrefix: (opts.idPrefix || "brief-") + "kid-" }); }))
          : children.length ? h("ul", { class: "brief-list" }, children.map(function (c) { return h("li", null, h("span", { class: "mono muted" }, "proposed "), wo.title + ": " + c); }))
          : h("p", { class: "muted small" }, conv.answers.children ? "You chose not to split this epic." : "The Intake agent will propose children. Answer the split question to confirm them."),
        children.length && !made.length ? h("p", { class: "small muted" }, "Confirmed in the conversation. They are created after Plan, each with its own brief.") : null), [children, made.length]) : null);
    return node;
  };

  /* ---------- view ---------- */
  function render() {
    var project = G.currentProject();
    if (!project) return h("div", { class: "view" }, G.emptyState({ title: "No project", text: "You do not have a project to show." }));
    if (ui.viewer !== G.viewerId()) { ui.viewer = G.viewerId(); ui.tab = null; ui.sel = null; ui.mobileThread = false; lastBrief = {}; }
    var wos = G.store.get("workOrders").filter(function (w) { return w.project === project.id; });
    var mineIds = G.awaitingMe().map(function (w) { return w.id; });
    var groups = {
      awaiting: wos.filter(function (w) { return mineIds.indexOf(w.id) >= 0; }),
      open: wos.filter(isOpen),
      resolved: wos.filter(function (w) { return !isOpen(w); })
    };
    Object.keys(groups).forEach(function (k) { groups[k].sort(function (a, b) { return lastAt(b) - lastAt(a); }); });
    var pending = G.store.get("prefs").openConversation;
    if (pending) {
      var pw = G.find.wo(pending);
      if (pw && pw.project === project.id) { ui.sel = pending; ui.tab = groups.awaiting.indexOf(pw) >= 0 ? "awaiting" : isOpen(pw) ? "open" : "resolved"; ui.mobileThread = true; }
      setTimeout(function () { G.store.update("prefs", function (p) { p.openConversation = null; }); }, 0);
    }
    if (!ui.tab) ui.tab = groups.awaiting.length ? "awaiting" : "open";
    var list = groups[ui.tab];
    var selWo = ui.sel && G.find.wo(ui.sel);
    /* the selected conversation moved (answered, confirmed, declined): follow it to its new tab */
    if (selWo && selWo.project === project.id && list.indexOf(selWo) < 0) {
      ui.tab = groups.awaiting.indexOf(selWo) >= 0 ? "awaiting" : groups.open.indexOf(selWo) >= 0 ? "open" : "resolved";
      list = groups[ui.tab];
    }
    if (!selWo || selWo.project !== project.id) { ui.sel = list[0] ? list[0].id : null; selWo = ui.sel && G.find.wo(ui.sel); }

    var inbox = h("nav", { class: "conv-inbox", "aria-label": "Conversations" },
      G.tabBar({ id: "conv-tab", items: [{ id: "awaiting", label: "For me", count: groups.awaiting.length }, { id: "open", label: "Open", count: groups.open.length }, { id: "resolved", label: "Resolved", count: groups.resolved.length }], active: ui.tab, onChange: function (t) { ui.tab = t; ui.sel = null; G.rerender(); } }),
      list.length ? h("ul", { class: "conv-list", "data-keep-scroll": "conv-list" }, list.map(function (w) {
        var mine = mineIds.indexOf(w.id) >= 0;
        var b = h("button", { type: "button", class: "conv-item" + (w.id === ui.sel ? " is-selected" : "") + (mine ? " is-mine" : ""), id: "conv-item-" + w.id, "aria-current": w.id === ui.sel ? "true" : null, onClick: function () { ui.sel = w.id; ui.mobileThread = true; G.rerender(); } },
          h("span", { class: "conv-item-top" }, h("span", { class: "mono strong" }, w.id), G.classChip(w.cls, { small: true }), h("span", { class: "mono muted small conv-item-t" }, G.fmt.ago(lastAt(w)))),
          h("span", { class: "conv-item-title" }, w.title),
          h("span", { class: "conv-item-foot" }, statusChip(w), mine ? h("span", { class: "conv-you" }, "You") : null));
        return h("li", { class: "conv-li" }, b, h("button", { type: "button", class: "icon-btn icon-btn-sm conv-item-rec", id: "conv-rec-" + w.id, "aria-label": "Open full record for " + w.id, "data-tip": "Full record", onClick: function () { G.openRecord(w.id); } }, G.icon("record")));
      })) : G.emptyState({ id: "conv-empty", icon: "chat", title: ui.tab === "awaiting" ? "Nothing waits on you" : ui.tab === "open" ? "No open conversations" : "Nothing resolved yet",
        text: ui.tab === "awaiting" ? "Questions for you from the Intake agent and later stations appear here." : "Submit a work order to start an intake conversation.",
        action: ui.tab !== "resolved" ? G.btn("New work order", { small: true, icon: "plus", id: "conv-new-empty", guard: G.me("wo.submit", { project: project.id }), disabledReason: G.me("wo.submit", { project: project.id }).allowed && G.intakeSubmitBlock ? G.intakeSubmitBlock(project) : null, onClick: function () { G.startNewWO ? G.startNewWO({ project: project.id }) : G.newWODialog && G.newWODialog({ project: project.id }); } }) : null }));

    var thread = selWo ? h("section", { class: "conv-main", "aria-label": "Conversation " + selWo.id },
      h("button", { type: "button", class: "linkish conv-back", id: "conv-back", onClick: function () { ui.mobileThread = false; G.rerender(); } }, G.icon("back"), "Inbox"),
      G.renderConversation(selWo.id, { head: true })) : h("section", { class: "conv-main" }, G.emptyState({ title: "No conversation selected", text: "Pick one from the inbox." }));
    var brief = selWo ? h("aside", { class: "conv-brief", "aria-label": "Brief", "data-keep-scroll": "conv-brief" }, G.renderBriefPanel(selWo.id)) : null;

    var subD = G.me("wo.submit", { project: project.id });
    return h("div", { class: "view conv-view" },
      G.pageHeader({ id: "conv-headbar", kicker: "Project · " + project.name, title: "Conversations",
        sub: "The Intake agent asks what it needs to write the brief. Work stays at Intake until the brief is confirmed at G0+G1 or declined.",
        meta: [["For me", String(groups.awaiting.length)], ["Open", String(groups.open.length)], ["Ready to confirm", String(groups.open.filter(function (w) { return atIntake(w) && w.conv.done; }).length)]],
        actions: [G.btn("New work order", { kind: "primary", icon: "plus", id: "conv-new", guard: subD, disabledReason: subD.allowed && G.intakeSubmitBlock ? G.intakeSubmitBlock(project) : null, onClick: function () { G.startNewWO ? G.startNewWO({ project: project.id }) : G.newWODialog({ project: project.id }); } })] }),
      h("div", { class: "conv-layout" + (ui.mobileThread && selWo ? " show-thread" : "") }, inbox, thread, brief));
  }

  G.views["conversations"] = { title: "Conversations", render: render, keys: ["workOrders", "repos"] };
})(window.G);
