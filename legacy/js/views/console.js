/* Console: talk to the factory. Free-form questions go to Claude through G.ask with the shared tools
   (read the live store, propose actions); answers stream, cite entities as chips, and proposed actions
   render as confirm cards that run only on click, permission-checked for the signed-in person.
   When Claude is unavailable (absent, not granted, rate limited, error) a local intent matcher answers
   from the same store. Slash commands are shortcuts that always run locally.
   Local coverage: projects, status, onboarding, new work orders with classification, why-stuck,
   who-can, evals, triggers, approve, halt/resume, /kill and /restore, changes, bottlenecks,
   summaries, workload, trust and "waiting on me". */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { draft: "", lastCount: 0, slashIdx: 0, cards: {}, stream: {}, ac: null, streaming: null, nextMeta: null };
  var nextId = 1;

  var SLASH = [
    { cmd: "/help", hint: "What the console understands" },
    { cmd: "/projects", hint: "Your projects with state, WIP and gates" },
    { cmd: "/status ", hint: "One project in detail, e.g. /status payments" },
    { cmd: "/onboarding ", hint: "Repo onboarding pipeline, e.g. /onboarding storefront" },
    { cmd: "/onboard ", hint: "Connect a repo, e.g. /onboard acme/search-api to identity" },
    { cmd: "/new ", hint: "New work order, e.g. /new payments-api: Fix refund rounding" },
    { cmd: "/why ", hint: "Why is a work order stuck, e.g. /why WO-2398" },
    { cmd: "/who-can ", hint: "e.g. /who-can release payments friday 22:00" },
    { cmd: "/approve ", hint: "Approve the gate a work order waits at" },
    { cmd: "/evals", hint: "Latest eval scores and regressions" },
    { cmd: "/triggers ", hint: "GitHub and schedule triggers for a project" },
    { cmd: "/halt ", hint: "Andon: /halt payments-api duplicate refunds" },
    { cmd: "/resume ", hint: "Resume a halted project or repo" },
    { cmd: "/kill ", hint: "Hard stop: /kill WO-2398 | /kill payments | /kill factory, then a reason" },
    { cmd: "/restore ", hint: "Restore after a kill: /restore payments reason" },
    { cmd: "/changes ", hint: "What changed in a project, e.g. /changes payments" },
    { cmd: "/bottlenecks", hint: "Which gates wait longest on people" },
    { cmd: "/summary ", hint: "Plain summary of a work order, e.g. /summary WO-2417" },
    { cmd: "/workload", hint: "Who carries the approvals in your projects" },
    { cmd: "/trust ", hint: "Trust levels and proposals, e.g. /trust payments" },
    { cmd: "/mine", hint: "Approvals and questions waiting on you" }
  ];
  /* suggested questions by role and current project */
  function suggestions() {
    var p = cur(), v = G.viewer(); if (!v) return ["/help"];
    var roles = p ? G.rolesIn(v, p.id) : v.roles.map(function (g) { return g.role; });
    var live = p ? G.store.get("workOrders").filter(function (w) { return w.project === p.id && ["done", "killed"].indexOf(w.state) < 0; }) : [];
    var stuck = live.find(function (w) { return w.state === "waiting" || w.state === "blocked" || w.bay; }) || live[0];
    var done = p ? G.store.get("workOrders").filter(function (w) { return w.project === p.id && w.state === "done"; }).slice(-1)[0] : null;
    var pn = p ? p.name : "my projects";
    if (roles.indexOf("factory_admin") >= 0) return ["Which gates are slowing us down?", "What changed in " + pn + " this week?", (done || stuck) ? "Summarise " + (done || stuck).id + " for a manager" : "/projects", "Who can release " + pn + " tonight and why?", "/bottlenecks"];
    if (roles.indexOf("auditor") >= 0) return ["What changed in " + pn + " this week?", "Show kills and halts in the last 7 days", "Who can kill " + pn + " and why?", "/trust " + (p ? p.id : ""), done ? "Summarise " + done.id + " for a manager" : "/projects"];
    if (roles.indexOf("project_admin") >= 0 || roles.indexOf("line_lead") >= 0) return ["Which gates are slowing us down?", "Who is the only approver on waiting gates?", stuck ? "Why is " + stuck.id + " stuck?" : "/status", "What changed in " + pn + " this week?", "/trust " + (p ? p.id : "")];
    return ["What is waiting on me?", stuck ? "Why is " + stuck.id + " stuck?" : "/status", (done || stuck) ? "Summarise " + (done || stuck).id + " for a manager" : "/projects", "What changed in " + pn + " this week?", "/status"];
  }

  /* ---------- transcript (the console slice is this view's own state) ---------- */
  function msgs() { var me = G.viewerId(); return G.store.get("console").messages.filter(function (m) { return !m.owner || m.owner === me; }); }
  function push(m) {
    m.id = "m" + Date.now().toString(36) + (nextId++); m.at = Date.now(); m.owner = G.viewerId();
    if (m.role === "factory" && ui.nextMeta) { Object.keys(ui.nextMeta).forEach(function (k) { if (m[k] == null) m[k] = ui.nextMeta[k]; }); ui.nextMeta = null; }
    G.store.update("console", function (c) { c.messages.push(m); }); return m;
  }
  function patch(id, fn) { G.store.update("console", function (c) { var m = c.messages.find(function (x) { return x.id === id; }); if (m) fn(m); }); }
  function reply(text, card) { return push({ role: "factory", text: text, card: card || null }); }
  function cur() { return G.currentProject(); }

  /* ---------- parsing ---------- */
  function visible() { return G.visibleProjects(G.viewerId()); }
  function findProject(t) {
    var low = " " + t.toLowerCase() + " ";
    return G.store.get("projects").find(function (p) { return new RegExp("[\\s/:,]" + p.id + "[\\s.,:?!]").test(low) || low.indexOf(" " + p.name.toLowerCase()) >= 0 || new RegExp("\\s" + p.key.toLowerCase() + "[\\s.,:?!]").test(low); }) || null;
  }
  function findRepo(t) {
    var low = t.toLowerCase();
    return G.store.get("repos").slice().sort(function (a, b) { return b.id.length - a.id.length; }).find(function (r) { return low.indexOf(r.name) >= 0 || new RegExp("(^|[\\s/:])" + r.id.replace(/[-]/g, "\\-") + "($|[\\s.,:?!])").test(low); }) || null;
  }
  function findWO(t) { var m = t.match(/wo-?\s?(\d{3,5})/i); return m ? G.find.wo("WO-" + m[1]) : null; }
  function canSeeProject(pid) { return visible().some(function (p) { return p.id === pid; }); }
  /* refusals never name, count or confirm anything in a project the person cannot see */
  function noAccess() { var v = visible().filter(function (p) { return p.status !== "archived"; }); return "That is outside the projects you can see. I can answer about " + (v.length ? v.map(function (p) { return p.name; }).join(", ") : "no project yet") + "."; }
  function noWO(id) { return "I cannot find " + id + " among the work orders you can see."; }
  var ACTION_WORDS = [
    [/kill (the )?factory/, "kill.factory"], [/restore (the )?factory/, "restore.factory"], [/kill (a |the )?(project|line)/, "kill.project"], [/restore (a |the )?project/, "restore.project"],
    [/kill (a |the )?(work ?order|wo)\b/, "kill.workorder"], [/restore (a |the )?(work ?order|wo)\b/, "restore.workorder"], [/\bkill\b/, "kill.project"],
    [/release|ship|deploy/, "release"], [/merge (the )?onboarding|onboarding pr/, "onboarding.merge"], [/onboard|connect (a )?repo/, "repo.onboard"],
    [/approver/, "approvers.edit"], [/approve|gate/, "gate.approve"], [/resume/, "line.resume"], [/halt|andon|stop the line/, "line.halt"],
    [/submit|new work order|create (a )?work order/, "wo.submit"], [/confirm (the )?brief/, "brief.confirm"], [/reclassify|classif/, "wo.classify"], [/decline/, "wo.decline"],
    [/send back|rework/, "wo.sendback"], [/reassign/, "wo.reassign"], [/trigger/, "triggers.edit"], [/api key/, "api.keys"], [/invite|people/, "people.manage"],
    [/polic|permission/, "policy.edit"], [/security|sso|mfa/, "security.manage"], [/agent/, "agent.edit"], [/model|routing/, "model.edit"], [/eval/, "eval.run"],
    [/archive/, "project.archive"], [/member/, "project.members"], [/config|flow/, "project.config"], [/audit|ledger/, "audit.view"]
  ];
  function parseAction(t) { var low = t.toLowerCase(); var hit = ACTION_WORDS.find(function (x) { return x[0].test(low); }); return hit ? hit[1] : null; }
  function parseWhen(t) {
    var low = t.toLowerCase();
    var days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    var todayIst = new Date(Date.now() + 330 * 60000);
    var offset = 0, named = false;
    var di = days.findIndex(function (d) { return low.indexOf(d) >= 0 || new RegExp("\\b" + d.slice(0, 3) + "\\b").test(low); });
    if (di >= 0) { offset = (di - todayIst.getUTCDay() + 7) % 7; named = true; }
    else if (/tomorrow/.test(low)) { offset = 1; named = true; }
    else if (/today|tonight/.test(low)) named = true;
    var time = null;
    var m = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || low.match(/\b(\d{1,2}):(\d{2})\b/);
    if (m) { var hh = +m[1]; if (m[3] === "pm" && hh < 12) hh += 12; if (m[3] === "am" && hh === 12) hh = 0; time = String(hh).padStart(2, "0") + ":" + (m[2] || "00"); }
    else if (/night|tonight/.test(low)) time = "22:00"; else if (/evening/.test(low)) time = "19:00"; else if (/afternoon/.test(low)) time = "15:00"; else if (/morning/.test(low)) time = "10:00";
    if (!named && !time) return { t: Date.now(), label: "now (" + G.fmt.stamp(Date.now()) + ")" };
    var tt = G.istTime(G.istToday(offset), time || "12:00");
    return { t: tt, label: G.fmt.stamp(tt) };
  }
  function rest(t, words) { var out = t; words.forEach(function (w) { if (w) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), ""); }); return out.replace(/^\s*(because|:|-|,)\s*/i, "").replace(/\s+/g, " ").trim(); }

  /* ---------- intent matcher ---------- */
  function interpret(text) {
    var t = text.trim(), low = t.toLowerCase();
    if (!t) return;
    if (/^\/mine\b|waiting (on|for) me|my approvals|what do i need to (do|approve)/.test(low)) return mine();
    if (/^\/changes?\b|what (has )?changed|what happened|kills? and halts|recent (kills|halts|releases)/.test(low)) return changes(t);
    if (/^\/bottlenecks?\b|slowing|bottleneck|slow(est)? gates?|waits? longest|only approver|sole approver|bus factor/.test(low)) return bottlenecks(t);
    if (/^\/summary\b|summari[sz]e|summary of|tl;?dr/.test(low) && findWO(t)) return summary(findWO(t), t);
    if (/^\/workload\b|workload|busiest|overloaded|who (carries|does) (the )?approvals/.test(low)) return workloadAns(t);
    if (/^\/trust\b|\btrust (level|ladder|proposals?)\b|autonomy/.test(low)) return trustAns(t);
    if (/^\/?help\b|what can you do/.test(low)) return reply("Slash commands and plain sentences both work. Anything that changes state shows a confirm card first.", { type: "help" });
    if (/^\/kill\b|^kill\b|pull the kill/.test(low)) return kill(t);
    if (/^\/restore\b|^restore\b/.test(low)) return restore(t);
    if (/^\/projects?\b$|^\/projects\b|^(list |show )?(my )?projects\b/.test(low)) return projects();
    if (/^\/onboarding\b|onboarding (status|pipeline)|which repos are (ready|onboarding)/.test(low)) return onboardingStatus(t);
    if (/^\/onboard\b|^onboard\b|connect (the )?repo/.test(low)) return onboard(t);
    if (/^\/new\b|new work order|create (a )?work order|open (a )?work order|^submit\b/.test(low)) return newWO(t);
    if (/^\/who-?can\b|who can\b/.test(low)) return whoCan(t);
    if (/^\/evals?\b|eval(s|uation)? (status|results)|regression/.test(low)) return evals();
    if (/^\/triggers?\b|\btriggers?\b/.test(low)) return triggers(t);
    if (/^\/approve\b|^approve\b/.test(low)) return approve(t);
    if (/^\/halt\b|^halt\b|andon|pull the cord/.test(low)) return halt(t);
    if (/^\/resume\b|^resume\b/.test(low)) return resume(t);
    if (/^\/status\b|^status\b|how('s| is) (the )?(floor|factory|project)/.test(low)) return status(t);
    if (/^\/why\b|why|stuck|explain/.test(low) && findWO(t)) return explain(findWO(t));
    if (findWO(t)) return explain(findWO(t));
    var p = findProject(t); if (p) return status(t);
    reply("I could not match that with local logic. It understands the questions and commands below; with Claude available it can answer free-form questions too.", { type: "suggest" });
  }

  /* ---------- read-only answers ---------- */
  function projectRow(p) {
    var wos = G.store.get("workOrders").filter(function (w) { return w.project === p.id; });
    var live = wos.filter(function (w) { return ["done", "killed"].indexOf(w.state) < 0 && w.bay !== "declined"; });
    var repos = G.store.get("repos").filter(function (r) { return r.project === p.id; });
    return { id: p.id, wip: live.length, waiting: live.filter(function (w) { return w.state === "waiting" && !w.bay; }).length, blocked: live.filter(function (w) { return w.state === "blocked" || w.state === "failed"; }).map(function (w) { return w.id; }),
      parked: live.filter(function (w) { return w.bay; }).length, slots: G.slotsUsed(p.id).length + "/" + p.flow.slots, ready: repos.filter(function (r) { return r.onboarding.stage === "ready"; }).length, repos: repos.length,
      killed: !!p.killed, halted: !!p.halted, status: p.status, shipped: wos.filter(function (w) { return w.state === "done" && w.doneAt && Date.now() - w.doneAt < 7 * G.DAY; }).length };
  }
  function projects() {
    var vis = visible();
    if (!vis.length) return reply("You have no projects yet. Ask a Project Admin to add you.");
    reply("You can see " + vis.length + " project" + (vis.length > 1 ? "s" : "") + ". Snapshot at " + G.fmt.ist(Date.now()) + " IST.", { type: "projects", data: vis.map(projectRow) });
  }
  function status(t) {
    var p = findProject(t) || (findRepo(t) && G.find.project(findRepo(t).project)) || cur();
    if (!p) return reply("Which project?");
    if (!canSeeProject(p.id)) return reply(noAccess());
    reply(p.name + " at " + G.fmt.ist(Date.now()) + " IST" + (findProject(t) ? "." : " (your current project)."), { type: "status", data: projectRow(p) });
  }
  function onboardingStatus(t) {
    var p = findProject(t) || cur();
    if (!canSeeProject(p.id)) return reply(noAccess());
    var repos = G.store.get("repos").filter(function (r) { return r.project === p.id; });
    var order = G.ONBOARD_STAGES.map(function (s) { return s.id; });
    var mergers = G.store.get("people").filter(function (x) { return x.status === "active" && G.can(x.id, "onboarding.merge", { project: p.id }).allowed; }).map(function (x) { return x.id; });
    reply("Onboarding for " + p.name + ": " + repos.filter(function (r) { return r.onboarding.stage === "ready"; }).length + " of " + repos.length + " repos are Ready. Work orders can only go to Ready repos.",
      { type: "onboarding", data: { project: p.id, mergers: mergers, rows: repos.map(function (r) { var st = r.onboarding.stage; return { repo: r.id, name: r.name, stage: st, idx: order.indexOf(st), pr: r.onboarding.pr ? r.onboarding.pr.number : null, prState: r.onboarding.pr ? r.onboarding.pr.state : null, blocker: r.onboarding.blocker || (st === "failed" ? "Assessment or checks failed" : st === "person" ? "Needs a person" : "") }; }) } });
  }
  function evals() {
    var s = G.store.get();
    var rows = s.suites.map(function (su) {
      var runs = s.evalRuns.filter(function (r) { return r.suite === su.id; });
      var last = runs[runs.length - 1], prev = runs[runs.length - 2];
      if (!last) return null;
      return { suite: su.id, agent: (G.find.agent(su.agent) || { name: su.agent }).name, version: last.version, score: last.score, threshold: su.threshold, delta: prev ? last.score - prev.score : 0 };
    }).filter(Boolean);
    if (!rows.length) return reply("No eval runs yet.");
    reply("Latest run per suite against its promotion threshold.", { type: "evals", data: rows });
  }
  function triggers(t) {
    var p = findProject(t) || cur();
    if (!canSeeProject(p.id)) return reply(noAccess());
    var list = G.store.get("triggers").filter(function (x) { return x.project === p.id; });
    if (!list.length) return reply(p.name + " has no triggers. Add them in API and triggers.");
    reply(p.name + " has " + list.length + " trigger" + (list.length > 1 ? "s" : "") + ". Simulate one to see what it would create; GitHub is simulated.", { type: "triggers", data: { project: p.id, ids: list.map(function (x) { return x.id; }) } });
  }
  function whoCan(t) {
    var body = t.replace(/^\/?who-?\s?can\s*/i, "");
    var action = parseAction(body);
    if (!action) return reply("Which action? For example: who can release payments on Friday at 22:00?");
    var act = G.find.action(action);
    var repo = findRepo(body), p = findProject(body) || (repo && G.find.project(repo.project));
    if (act.scope === "project" && !p) p = cur();
    if (act.scope === "project" && p && !canSeeProject(p.id)) return reply(noAccess());
    var when = parseWhen(body);
    var rows = G.store.get("people").filter(function (x) { return x.status === "active"; }).map(function (x) {
      var d = G.can(x.id, action, act.scope === "project" ? { project: p.id, repo: repo && repo.id, time: when.t } : { time: when.t });
      return { person: x.id, allowed: d.allowed, reason: d.reason, rule: d.rule.id };
    });
    reply("Asked the policy engine: " + act.name.toLowerCase() + (act.scope === "project" ? " in " + p.name + (repo ? " / " + repo.name : "") : " (factory-wide)") + ", " + when.label + ".", { type: "whocan", data: { action: action, where: act.scope === "project" ? p.name + (repo ? " / " + repo.name : "") : "factory", when: when.label, rows: rows } });
  }
  function explain(w) {
    var p = G.find.project(w.project);
    if (!canSeeProject(p.id)) return reply(noWO(w.id));
    var st = G.STATIONS[w.station], e = w.history[w.history.length - 1] || {};
    var b = [], who = [], unblock = null, approveHere = false;
    var stop = G.stopState(w.project, w.repo), halt = G.haltState(w.project, w.repo);
    if (w.state === "killed") { b.push("Killed by " + G.actorName(w.killed.by) + " at " + G.fmt.stamp(w.killed.at) + ": " + w.killed.reason + "."); unblock = "restore.workorder"; }
    else if (stop) { b.push(stop.reason + (w.heldByKill ? " This work order is held in place and resumes on restore." : "")); unblock = stop.level === "factory" ? "restore.factory" : "restore.project"; }
    if (halt) { b.push("Andon halt: " + halt.reason); unblock = unblock || "line.resume"; }
    if (w.bay) { b.push("Parked in " + G.bayDef(w.bay).name + (w.bayReason ? ": " + w.bayReason : "") + "."); if (w.bay === "queue") b.push("Coding slots in use: " + G.slotsUsed(w.project).length + " of " + p.flow.slots + "."); if (w.bay === "person") unblock = unblock || "wo.answer"; else unblock = unblock || "wo.park"; }
    if (w.state === "blocked") { b.push("Blocked at " + st.name + ": " + (w.blockReason || "no reason recorded") + "."); unblock = unblock || "wo.sendback"; }
    if (w.state === "failed") { b.push("Check failed at " + st.name + ": " + (w.failReason || "see the traveler") + "."); unblock = unblock || "wo.sendback"; }
    if (w.state === "waiting") {
      var g = G.gateForWO(p, w);
      if (g) {
        var prog = G.gateProgress(p, w, g.id);
        b.push("Waiting at " + g.label + " " + g.name + " for " + G.fmt.dur(Date.now() - (e.endedAt || e.startedAt || w.createdAt)) + ": " + prog.have + " of " + prog.need + " approvals" + (prog.unmet.length ? "; still needs: " + prog.unmet.map(function (c) { return c.text; }).join("; ") : "") + ".");
        if (g.id === "G0G1" && !w.conv.done) b.push("The intake conversation still has open questions for " + G.actorName(w.requestedBy) + ".");
        who = G.store.get("people").filter(function (x) { return x.status === "active" && G.gateDecision(x.id, w, g.id).allowed; }).map(function (x) { return x.id; });
        approveHere = G.gateDecision(G.viewerId(), w, g.id).allowed;
      }
    }
    if (w.state === "running") b.push("Running at " + st.no + " " + st.name + " with " + G.actorName(e.agent) + " on " + e.model + ", " + Math.round(w.progress) + "% through the station.");
    if (w.state === "done") b.push(w.split ? "Split into child work orders." : "Done and released" + (w.pr && w.pr.tag ? " as " + w.pr.tag : "") + ".");
    var visits = {}; w.history.forEach(function (x) { visits[x.station] = (visits[x.station] || 0) + 1; });
    Object.keys(visits).forEach(function (k) { if (visits[k] > 1) b.push(G.find.station(k).name + " visited " + visits[k] + " times (rework)."); });
    if (w.slaDue && ["done", "killed"].indexOf(w.state) < 0) b.push(w.slaDue < Date.now() ? "Past its SLA by " + G.fmt.dur(Date.now() - w.slaDue) + "." : "SLA due in " + G.fmt.dur(w.slaDue - Date.now()) + ".");
    if (!b.length) b.push("Nothing is holding it right now.");
    if (unblock && !who.length) who = G.store.get("people").filter(function (x) { return x.status === "active" && G.can(x.id, unblock, { project: w.project, repo: w.repo }).allowed; }).map(function (x) { return x.id; });
    reply("Here is what the traveler says about " + w.id + ".", { type: "explain", data: { wo: w.id, bullets: b, unblock: w.state === "waiting" ? "gate.approve" : unblock, who: who, approveHere: approveHere, spend: G.woTotals(w).cost, age: Date.now() - w.createdAt } });
  }

  /* ---------- round-three local answers (same data the tools read, scoped to what the viewer sees) ---------- */
  function sinceHours(t) {
    var low = t.toLowerCase();
    if (/today|24 ?h|last day/.test(low)) return 24;
    var m = low.match(/(\d+)\s*(day|d\b)/); if (m) return Math.min(168, +m[1] * 24);
    var mh = low.match(/(\d+)\s*(hour|h\b)/); if (mh) return Math.min(168, +mh[1]);
    return 168;
  }
  function mine() {
    var ap = G.myApprovals(), conv = G.awaitingMe ? G.awaitingMe() : [];
    if (!ap.length && !conv.length) return reply("Nothing is waiting on you right now: no gates you can decide and no intake questions for you.");
    reply(ap.length + " approval" + (ap.length === 1 ? "" : "s") + " and " + conv.length + " conversation" + (conv.length === 1 ? "" : "s") + " wait on you.", { type: "mine", data: { approvals: ap.filter(function (a) { return a.wo; }).map(function (a) { return { wo: a.wo.id, gate: a.gate }; }), repos: ap.filter(function (a) { return a.repo; }).map(function (a) { return a.repo.id; }), conv: conv.map(function (w) { return (w.id || (w.wo && w.wo.id)); }).filter(Boolean) } });
  }
  function changes(t) {
    var p = findProject(t), low = t.toLowerCase();
    if (p && !canSeeProject(p.id)) return reply(noAccess());
    var hrs = sinceHours(t);
    var types = /kill|halt/.test(low) && !/release/.test(low) ? ["kill", "restore", "halt", "resume"] : null;
    var ev = G.askTools.call("events", { project: p ? p.id : undefined, since_hours: hrs, types: types || undefined });
    if (ev.error) return reply(ev.error);
    var since = Date.now() - hrs * G.HOUR;
    var vis = visible().map(function (x) { return x.id; });
    var raw = G.replay.events({ project: p ? p.id : null, from: since, types: types || undefined }).filter(function (e) { return !e.project || vis.indexOf(e.project) >= 0; });
    var count = {}; raw.forEach(function (e) { count[e.type] = (count[e.type] || 0) + 1; });
    var shipped = G.store.get("workOrders").filter(function (w) { return vis.indexOf(w.project) >= 0 && (!p || w.project === p.id) && w.state === "done" && w.doneAt >= since; });
    var notable = raw.filter(function (e) { return ["release", "kill", "restore", "halt", "resume", "trust.change"].indexOf(e.type) >= 0; }).slice(-10).reverse();
    var where = p ? p.name : "your projects";
    reply((types ? "Kills, halts and restores in " : "What changed in ") + where + " in the last " + (hrs >= 48 ? Math.round(hrs / 24) + " days" : hrs + " hours") + ": " + raw.length + " events" + (types ? "." : ", " + shipped.length + " work orders shipped."), { type: "changes", data: { project: p ? p.id : null, count: count, shipped: types ? [] : shipped.slice(-8).reverse().map(function (w) { return w.id; }), notable: notable.map(function (e) { return { at: e.at, type: e.type, wo: e.wo || null, project: e.project || null, text: e.text || "", by: e.by || null, cell: e.cell || null, from: e.from, to: e.to }; }) } });
  }
  function bottlenecks(t) {
    if (!G.workloadSummary) return reply("Workload data is not available.");
    var p = findProject(t);
    if (p && !canSeeProject(p.id)) return reply(noAccess());
    var m = G.workloadSummary(p ? [p.id] : null, 7);
    var top = m.bottlenecks.slice(0, 6);
    var sole = m.gates.filter(function (g) { return g.eligible.length === 1; });
    if (!top.length) return reply("Nothing waits on people in " + (p ? p.name : "your projects") + " this week.");
    reply("Gates where work waited longest for a person in " + (p ? p.name : "your projects") + " over 7 days. " + sole.length + " of " + m.gates.length + " waiting gates have exactly one eligible approver.", { type: "bottlenecks", data: { rows: top.map(function (b) { return { project: b.project, gate: b.gate, median: b.medianWaitMin, n: b.decisions, open: b.open, oldest: b.oldestMin, minEligible: b.minEligible }; }), sole: sole.slice(0, 6).map(function (g) { return { wo: g.wo.id, gate: g.gate, person: g.eligible[0] }; }) } });
  }
  function summary(w, t) {
    if (!canSeeProject(w.project)) return reply(noWO(w.id));
    G.lc.ensure(w);
    var txt = (w.recordSummary && w.recordSummary.text) || G.lc.summaryText(w);
    var c = G.lc.completeness(w);
    reply(txt, { type: "summary", data: { wo: w.id, done: c.done, total: c.total } });
  }
  function workloadAns(t) {
    if (!G.workloadSummary) return reply("Workload data is not available.");
    var p = findProject(t);
    if (p && !canSeeProject(p.id)) return reply(noAccess());
    var m = G.workloadSummary(p ? [p.id] : null, 7);
    var rows = m.rows.slice().sort(function (a, b) { return b.minutes - a.minutes; }).slice(0, 6);
    if (!rows.length) return reply("No approvals, confirmations or answers in " + (p ? p.name : "your projects") + " this week.");
    reply("Who carried the human work in " + (p ? p.name : "your projects") + " over 7 days, by estimated minutes.", { type: "workload", data: { rows: rows.map(function (r) { return { person: r.person, minutes: r.minutes, approvals: r.approvals, waiting: r.waiting, sole: r.sole, n: r.n, ah: r.afterHours }; }) } });
  }
  function trustAns(t) {
    var p = findProject(t) || cur();
    if (!p || !canSeeProject(p.id)) return reply("Which project? You can ask about " + visible().map(function (x) { return x.name; }).slice(0, 4).join(", ") + ".");
    var tr = G.askTools.call("trust", { project: p.id });
    if (tr.error) return reply(tr.error);
    var lv = [0, 0, 0, 0, 0]; tr.cells.forEach(function (c) { lv[c.level] = (lv[c.level] || 0) + 1; });
    var cov = tr.coverage || { total: 0, auto: 0, share: 0 };
    reply("Trust in " + p.name + ": " + tr.cells.length + " cells; " + cov.auto + " of " + cov.total + " gate decisions in 7 days passed under trust" + (cov.total >= 5 ? " (" + G.fmt.pct(cov.share) + ")" : cov.total ? " (too few to give a rate)" : "") + ".", { type: "trust", data: { project: p.id, levels: lv, proposals: tr.proposals.map(function (x) { return { id: x.id, cell: x.cell, from: x.from, to: x.to, saved: x.savedPerWeek }; }) } });
  }

  /* ---------- actions behind confirm cards ---------- */
  function confirmCard(kind, args, title, steps, perm, extra) {
    return push({ role: "factory", text: "Here is the plan. Nothing changes until you confirm it.", card: Object.assign({ type: "confirm", kind: kind, args: args, title: title, steps: steps, perm: perm, status: "pending" }, extra || {}) });
  }
  /* repos the current project's source instances offer: [{ repo, lang, source }] */
  function offered(p) {
    var out = [];
    G.sourceInstances(p.id).forEach(function (i) { if (i.connected !== false) G.availableRepos(i.id).forEach(function (a) { out.push({ repo: a.repo, lang: a.lang, source: i.id }); }); });
    return out;
  }
  function onboard(t) {
    var m = t.match(/([a-z0-9-]+\/[a-z0-9._-]+)/i);
    var p0 = findProject(t.replace(m ? m[1] : "", "")) || cur();
    if (!p0 || !canSeeProject(p0.id)) return reply(noAccess());
    var src0 = G.sourceIntegrationFor(p0.id);
    var org = src0 && src0.config ? src0.config.org || src0.config.group || src0.config.workspace || "acme" : "acme";
    var name = m ? m[1].toLowerCase() : (t.replace(/^\/?onboard( repo)?/i, "").trim().split(/\s+/)[0] || "").toLowerCase();
    if (!name) return reply("Which repo? These are offered by the source-control integrations of " + p0.name + " (simulated) and not yet connected:", { type: "repos" });
    if (name.indexOf("/") < 0) name = org + "/" + name;
    var existing = G.find.repo(name);
    if (existing) return reply(canSeeProject(existing.project) ? name + " is already connected to " + G.find.project(existing.project).name + " (stage: " + existing.onboarding.stage + "). Try /onboarding " + existing.project + "." : name + " is already connected to another project.");
    var av = offered(p0).find(function (x) { return x.repo === name; });
    var inst = av ? G.find.integration(av.source) : src0;
    if (!inst) return reply("No source-control integration is open to " + p0.name + ". Add one in Integrations first.");
    if (!av) return reply("I cannot see " + name + " in " + inst.name + ". These repos are offered:", { type: "repos" });
    var team = p0.teams[0] || "platform";
    confirmCard("onboard", { repo: name, project: p0.id, team: team, source: inst.id }, "Connect " + name + " to " + p0.name, [
      "Connect through " + inst.name + " (simulated)", "Owning team: " + (G.find.team(team) || { name: team }).name,
      "The Onboarding agent assesses CI, tests, branch protection, CODEOWNERS, secrets and MCP needs", "It opens an onboarding PR; the repo becomes Ready after the PR merges and verifies"
    ], ["repo.onboard", { project: p0.id }]);
  }
  function newWO(t) {
    var body = t.replace(/^\/new( work order)?|^(please )?(create|open) (a )?(new )?work order|^new work order|^submit/i, "").trim();
    var repo = findRepo(body);
    var title = (body.split(/:\s*/).slice(1).join(": ") || (body.match(/\bto (.+)$/i) || [])[1] || "").trim();
    if (!repo) {
      var p0 = cur();
      var ready = G.store.get("repos").filter(function (r) { return r.project === p0.id && r.onboarding.stage === "ready"; });
      return reply("Which repo? Ready repos in " + p0.name + ": " + (ready.map(function (r) { return r.id; }).join(", ") || "none yet") + ". For example: /new " + (ready[0] ? ready[0].id : "payments-api") + ": Fix refund rounding");
    }
    var p = G.find.project(repo.project);
    if (!canSeeProject(p.id)) return reply("I cannot find " + repo.name + " in the projects you can see.");
    if (!title) return reply("What should the work order say? For example: /new " + repo.id + ": Fix refund rounding");
    var clsIds = G.classesOf(p).map(function (k) { return k.id; });
    var reqM = body.match(/\b(?:as|class:?)\s+([a-z][a-z-]+)\b/i);
    var req = reqM && clsIds.indexOf(reqM[1].toLowerCase()) >= 0 ? reqM[1] : null;
    var prio = (body.match(/\b(P[0-3])\b/i) || [])[1];
    if (req) title = title.replace(reqM[0], "");
    title = title.replace(/\bP[0-3]\b/i, "").trim();
    title = title.charAt(0).toUpperCase() + title.slice(1);
    return submitCard(repo, title, req, prio);
  }
  function submitCard(repo, title, req, prio, description) {
    var p = G.find.project(repo.project);
    var c = G.classify(title, req ? req.toLowerCase() : null, p);
    var cls = req ? req.toLowerCase() : c.cls;
    var guard = G.submitGuard(p.id, repo.id);
    var route = G.route(p, cls);
    confirmCard("submit", { project: p.id, repo: repo.id, title: title, description: description || "", requestedCls: req ? req.toLowerCase() : null, priority: prio ? prio.toUpperCase() : null }, "Submit a work order to " + repo.name, [
      "Title: " + title, description ? "Description: " + description : null, "Priority " + (prio ? prio.toUpperCase() : (G.classOf(p, cls) || {}).priority || "P2") + ", source console",
      "Starts at S0 Intake; the Intake Clerk opens a conversation with you to build the brief"
    ], ["wo.submit", { project: p.id }], { classify: { project: p.id, cls: c.cls, confidence: c.confidence, rationale: c.rationale, alternatives: c.alternatives, requested: req ? req.toLowerCase() : null, route: route, gates: G.routeGates(p, cls) }, refuse: guard });
  }
  function approve(t) {
    var w = findWO(t);
    if (!w) return reply("Which work order? For example: /approve WO-2398");
    return approveCard(w);
  }
  function approveCard(w) {
    var p = G.find.project(w.project);
    if (!canSeeProject(p.id)) return reply(noAccess());
    var g = G.gateForWO(p, w);
    if (w.state !== "waiting" || !g) return reply(w.id + " is not waiting at a gate. It is " + G.STATES[w.state].label.toLowerCase() + " at " + G.stationOf(w).name + ".");
    var prog = G.gateProgress(p, w, g.id);
    confirmCard("approve", { wo: w.id, gate: g.id }, "Approve " + g.label + " " + g.name + " on " + w.id, [w.title, "Approvals so far: " + prog.have + " of " + prog.need, prog.have + 1 >= prog.need && !prog.unmet.length ? "This approval should pass the gate" : "More approvals or conditions may still be needed"], ["gate", { wo: w.id, gate: g.id }]);
  }
  function target(t, words) {
    var w = findWO(t), r = findRepo(t), p = findProject(t);
    if (/\bfactory\b/i.test(t) && !w && !p && !r) return { scope: "factory", id: "factory", label: "the factory" };
    if (w) return { scope: "workorder", id: w.id, label: w.id, project: w.project, word: w.id };
    if (r && (!p || words === "halt")) return { scope: "repo", id: r.id, label: r.name, project: r.project, word: t.toLowerCase().indexOf(r.name) >= 0 ? r.name : r.id };
    if (p) { var mm = t.match(new RegExp(p.name, "i")) || t.match(new RegExp("\\b" + p.id + "\\b", "i")) || t.match(new RegExp("\\b" + p.key + "\\b", "i")); return { scope: "project", id: p.id, label: p.name, project: p.id, word: mm ? mm[0] : p.id }; }
    return null;
  }
  function halt(t) {
    var x = target(t, "halt");
    if (!x || x.scope === "factory" || x.scope === "workorder") return reply("Halt a project or a repo, for example: /halt payments-api duplicate refunds. To stop one work order, use /kill " + (findWO(t) ? findWO(t).id : "WO-…") + ".");
    var reason = rest(t, [/^\/?halt/i.exec(t) && /^\/?halt/i.exec(t)[0], x.word, x.scope === "repo" ? G.find.repo(x.id).id : null]);
    return haltCard(x, reason);
  }
  function haltCard(x, reason) {
    var p = G.find.project(x.project);
    if (!canSeeProject(p.id)) return reply(noAccess());
    confirmCard("halt", { scope: x.scope, id: x.id, reason: reason }, "Pull the andon cord on " + x.label, ["A soft, resumable pause: agents stop at their current step", "Give a reason of at least " + (p.regulated && x.scope === "project" ? 20 : 4) + " characters", "Posted to the project's andon notification routes", "For a hard stop use /kill"], ["line.halt", { project: x.project }], { needsReason: true, reason0: reason });
  }
  function resume(t) {
    var x = target(t, "halt");
    if (!x || x.scope === "factory" || x.scope === "workorder") return reply("Resume a project or a repo, for example: /resume payments-api.");
    var obj = x.scope === "repo" ? G.find.repo(x.id) : G.find.project(x.id);
    if (!obj.halted) return reply(x.label + " is not halted; nothing to resume.");
    confirmCard("resume", { scope: x.scope, id: x.id }, "Resume " + x.label, ["Agents restart from where they stopped", "Halt reason was: " + obj.halted.reason], ["line.resume", { project: x.project }]);
  }
  function kill(t) {
    var x = target(t.replace(/^\/?kill\s*/i, " "), "kill");
    if (!x) return reply("What should I kill? /kill WO-2398 reason, /kill payments reason, or /kill factory reason. Kills are hard stops; for a pause use /halt.");
    if (x.scope === "repo") { var rp = G.find.repo(x.id); x = { scope: "project", id: rp.project, label: G.find.project(rp.project).name, project: rp.project, word: x.word }; }
    if (x.project && !canSeeProject(x.project)) return reply(noAccess());
    var reason = rest(t, [/^\/?kill/i.exec(t) && /^\/?kill/i.exec(t)[0], x.word, x.scope === "factory" ? "the factory" : null, x.scope === "factory" ? "factory" : null]);
    return killCard(x, reason);
  }
  function killCard(x, reason) {
    var imp = G.ops.killImpact(x.scope, x.id);
    var phrase = x.scope === "factory" ? "KILL FACTORY" : x.scope === "project" ? G.find.project(x.id).name : null;
    confirmCard("kill", { scope: x.scope, id: x.id }, "Kill " + x.label, [
      "Hard stop: agents stop, coding slots are freed, new submissions are refused",
      x.scope === "workorder" ? "The work order moves to Killed; an open PR becomes a draft" : "Choose below: hold work in place, or cancel it to Killed",
      "Posted to the kill notification routes", "Restoring needs restore." + x.scope + (x.scope === "factory" && G.store.get("security").restoreFactoryNeedsTwo ? " from two Factory Admins" : "")
    ], ["kill." + x.scope, { project: x.project }], { impact: { projects: imp.projects, workOrders: imp.workOrders, running: imp.running, slots: imp.slots, prs: imp.prs }, phrase: phrase, reason0: reason, needsReason: true, danger: true });
  }
  function restore(t) {
    var x = target(t.replace(/^\/?restore\s*/i, " "), "kill");
    if (!x) return reply("What should I restore? /restore WO-2398 reason, /restore payments reason, or /restore factory reason.");
    if (x.scope === "repo") { var rp = G.find.repo(x.id); x = { scope: "project", id: rp.project, label: G.find.project(rp.project).name, project: rp.project, word: x.word }; }
    var k = x.scope === "factory" ? G.store.get("factory").killed : x.scope === "project" ? G.find.project(x.id).killed : G.find.wo(x.id).killed;
    if (!k) return reply(x.label + " is not killed.");
    var reason = rest(t, [/^\/?restore/i.exec(t) && /^\/?restore/i.exec(t)[0], x.word, x.scope === "factory" ? "the factory" : null, x.scope === "factory" ? "factory" : null]);
    confirmCard("restore", { scope: x.scope, id: x.id }, "Restore " + x.label, ["Killed by " + G.actorName(k.by) + " at " + G.fmt.stamp(k.at) + ": " + k.reason, x.scope === "factory" && G.store.get("security").restoreFactoryNeedsTwo ? "Needs two different Factory Admins; " + (k.restoreApprovals || []).length + " of 2 so far" : "Held work resumes; cancelled work orders stay killed until restored one by one"], ["restore." + x.scope, { project: x.project }], { reason0: reason, needsReason: true });
  }

  function decisionFor(c) {
    if (!c.perm) return { allowed: true, reason: "" };
    if (c.perm[0] === "gate") { var w = G.find.wo(c.perm[1].wo); return w ? G.gateDecision(G.viewerId(), w, c.perm[1].gate) : { allowed: false, reason: "Work order not found.", needs: "" }; }
    if (c.perm[0] === "triggers.simulate") return G.me("triggers.edit", c.perm[1]);
    return G.me(c.perm[0], c.perm[1] || {});
  }
  function runConfirm(m) {
    var c = m.card, a = c.args, d = ui.cards[m.id] || {}, r;
    var reason = (d.reason != null ? d.reason : c.reason0 || "").trim();
    if (c.kind === "submit") r = G.ops.submitWO({ project: a.project, repo: a.repo, title: a.title, description: a.description || undefined, requestedCls: a.requestedCls, priority: a.priority || undefined, source: "console" }, "console");
    if (c.kind === "onboard") r = G.ops.connectRepo(a.project, a.repo, a.team, a.source);
    if (c.kind === "approve") r = G.ops.approveGate(a.wo, "console");
    if (c.kind === "halt") r = a.scope === "repo" ? G.ops.haltRepo(a.id, reason, "console") : G.ops.haltProject(a.id, reason, "console");
    if (c.kind === "resume") r = a.scope === "repo" ? G.ops.resumeRepo(a.id, "console") : G.ops.resumeProject(a.id, "console");
    if (c.kind === "trigger") r = G.ops.simulateTrigger(a.id, a.input);
    if (c.kind === "kill") {
      if (c.phrase && (d.confirm || "") !== c.phrase) { patch(m.id, function (x) { x.card.err = "Type " + c.phrase + " exactly to confirm."; }); return; }
      r = G.ops.kill(a.scope, a.id, { reason: reason, mode: d.mode || "hold", confirmText: d.confirm || null }, "console");
    }
    if (c.kind === "restore") r = G.ops.restore(a.scope, a.id, reason, "console");
    if (!r) return;
    if (!r.ok && c.needsReason && /reason/i.test(r.msg)) { patch(m.id, function (x) { x.card.err = r.msg; }); return; }
    patch(m.id, function (x) { x.card.status = r.ok ? "done" : "failed"; x.card.result = r.msg; x.card.err = null; if (r.wo) x.card.woId = r.wo.id; if (r.run && r.run.wo) x.card.woId = r.run.wo; if (r.pending) x.card.pending = true; });
    G.toast(r.msg, r.ok ? (c.kind === "kill" ? "warn" : "ok") : "error");
  }

  /* ---------- Claude through G.ask ---------- */
  var INSTRUCTIONS = "You are the Gantry console, answering people who run a software factory of AI coding agents. Answer questions about projects, work orders, gates, onboarding, trust, workload, evals and the audit ledger by calling the read tools; do not guess numbers. " +
    "When the person asks you to change something (submit a work order, approve a gate, halt, kill, park, change trust, onboard a repo), call the matching propose_* tool once: the page shows a confirm card and runs nothing until they click it, so say it is waiting for their confirmation. " +
    "If a tool says something is not visible, say you cannot see it; never reveal projects the tools do not return. Mention work orders by id (WO-1234), projects by name, gates by label (G5, G3+G3s). Keep answers under 150 words unless asked for detail. Plain sentences, no headings, no emoji.";
  function modeNote(err) {
    return { absent: "Claude is not available on this page, so local logic answered.", not_granted: "Claude access was not granted, so local logic answered. The console will not ask again this session.",
      rate_limited: "Claude is rate limited for a moment, so local logic answered.", checking: "Claude was still starting, so local logic answered." }[err] || (err ? "Claude did not answer (" + err + "), so local logic answered." : "");
  }
  function turnsBefore(n) {
    var list = msgs().filter(function (m) { return m.text && !m.streaming && m.kind !== "note"; });
    return list.slice(Math.max(0, list.length - 1 - n), list.length - 1).map(function (m) { return { role: m.role === "user" ? "user" : "gantry", text: String(m.text).slice(0, 600) }; });
  }
  /* entities named in an answer beyond what G.ask cites: agents, people, gates */
  function extraEntities(text, cited) {
    var out = [], seen = {}, t = String(text || "");
    (cited || []).forEach(function (e) { seen[e.type + ":" + e.id] = 1; });
    function add(e) { var k = e.type + ":" + e.id; if (seen[k]) return; seen[k] = 1; out.push(e); }
    function rx(word) { return new RegExp("(^|[^A-Za-z0-9+-])" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9+])"); }
    G.store.get("agents").forEach(function (a) { if (rx(a.id).test(t) || (a.name.length > 4 && rx(a.name).test(t))) add({ type: "agent", id: a.id, label: a.name }); });
    G.store.get("people").forEach(function (p) { if (p.name.indexOf(" ") > 0 && t.indexOf(p.name) >= 0) add({ type: "person", id: p.id, label: p.name }); });
    var proj = (cited || []).filter(function (e) { return e.type === "project"; })[0];
    var pr = proj ? G.find.project(proj.id) : cur();
    if (pr && canSeeProject(pr.id)) G.flowOf(pr).gates.forEach(function (g) { if (g.label && g.label.length >= 2 && rx(g.label).test(t)) add({ type: "gate", id: g.id, label: g.label + " " + g.name, project: pr.id }); });
    return out;
  }
  /* entity chips are the shared ones (ask.js): work order -> record, project / gate -> floor, repo, agent, person */
  function chip(e) { return G.entityChip(e); }
  /* a proposal from a tool call becomes the console's own confirm card where one exists */
  function proposalToCard(p) {
    ui.nextMeta = { mode: "claude", proposed: true };
    try {
      if (p.kind === "submit") { var a = p.args[0], repo = G.find.repo(a.repo); if (repo) { submitCard(repo, a.title, null, a.priority, a.description); return; } }
      if (p.kind === "approve") { var w = G.find.wo(p.args[0]); if (w) { approveCard(w); return; } }
      if (p.kind === "halt") { var sc = p.op === "haltRepo" ? "repo" : "project", obj = sc === "repo" ? G.find.repo(p.args[0]) : G.find.project(p.args[0]); if (obj) { haltCard({ scope: sc, id: obj.id, label: obj.name, project: sc === "repo" ? obj.project : obj.id }, p.args[1] || ""); return; } }
      if (p.kind === "kill" && p.dialog) {
        var ks = p.dialog.args[0], kid = p.dialog.args[1], x = null;
        if (ks === "factory") x = { scope: "factory", id: "factory", label: "the factory" };
        if (ks === "project") { var pid = (p.entities[0] || {}).id, pr = G.find.project(pid); if (pr) x = { scope: "project", id: pr.id, label: pr.name, project: pr.id }; }
        if (ks === "workorder") { var kw = G.find.wo(kid); if (kw) x = { scope: "workorder", id: kw.id, label: kw.id, project: kw.project }; }
        if (x) { killCard(x, p.summary || ""); return; }
      }
      push({ role: "factory", text: "Proposed action. Nothing runs until you confirm it.", card: { type: "proposal", proposal: p } });
    } finally { ui.nextMeta = null; }
  }
  function askClaude(text) {
    var p = cur(), v = G.viewer();
    var ph = push({ role: "factory", text: "", streaming: true, mode: "pending" });
    var mid = ph.id;
    ui.streaming = mid; ui.stream[mid] = "";
    ui.ac = typeof AbortController === "function" ? new AbortController() : null;
    G.rerender();
    G.ask({
      instructions: INSTRUCTIONS,
      data: { currentProject: p ? { id: p.id, name: p.name } : null, person: v ? { name: v.name, title: v.title, roles: v.roles.map(function (g) { return (G.find.role(g.role) || { name: g.role }).name + " @ " + (g.scope === "factory" ? "factory" : (G.find.project(g.scope) || { name: g.scope }).name); }) } : null,
        visibleProjects: visible().map(function (x) { return x.id + " (" + x.name + ")"; }) },
      turns: turnsBefore(8), question: text, tools: true, signal: ui.ac ? ui.ac.signal : undefined,
      onText: function (full) {
        ui.stream[mid] = full;
        var el = document.getElementById("con-msg-text-" + mid);
        if (el) { el.textContent = full; el.classList.remove("is-thinking"); var th = document.getElementById("con-thread"); if (th) th.scrollTop = th.scrollHeight; }
      },
      fallback: function () { return "local"; }
    }).then(function (r) {
      ui.streaming = null; ui.ac = null; delete ui.stream[mid];
      if (r.mode === "local") {
        G.store.update("console", function (c) { c.messages = c.messages.filter(function (m) { return m.id !== mid; }); });
        ui.nextMeta = { mode: "local", note: modeNote(r.error) };
        try { interpret(text); } catch (e) { console.error(e); reply("Something went wrong while answering that: " + (e && e.message)); }
        ui.nextMeta = null;
        return;
      }
      var cited = (r.cited || []).filter(function (e, i, arr) { return arr.findIndex(function (x) { return x.type === e.type && x.id === e.id; }) === i; });
      cited = cited.concat(extraEntities(r.text, cited));
      patch(mid, function (m) { m.text = r.text || (r.error === "aborted" ? "" : "Claude returned no text."); m.streaming = false; m.mode = "claude"; m.cited = cited; if (r.error === "aborted") m.stopped = true; });
      (r.proposals || []).forEach(proposalToCard);
    }, function (e) { console.error(e); ui.streaming = null; ui.ac = null; patch(mid, function (m) { m.streaming = false; m.text = "Something went wrong: " + (e && e.message); m.mode = "local"; }); });
  }
  function stopAnswer() { if (ui.ac) ui.ac.abort(); }

  function send(text) {
    text = (text || "").trim(); if (!text) return;
    if (ui.streaming) { G.toast("Wait for the current answer or stop it.", "warn"); return; }
    push({ role: "user", text: text, by: G.viewerId() });
    ui.draft = "";
    if (text.charAt(0) === "/") {
      setTimeout(function () { ui.nextMeta = { mode: "local", via: "slash" }; try { interpret(text); } catch (e) { console.error(e); reply("Something went wrong while answering that: " + (e && e.message)); } ui.nextMeta = null; }, G.reducedMotion() ? 0 : 120);
      return;
    }
    askClaude(text);
  }
  G.consoleSend = send;

  /* ---------- cards ---------- */
  function kvs(k, v) { return h("div", { class: "kv" }, h("div", { class: "kv-k" }, k), h("div", { class: "kv-v mono" }, v)); }
  function focusComposer() { setTimeout(function () { var c = document.getElementById("con-input"); if (c) { c.focus(); c.setSelectionRange(c.value.length, c.value.length); } }, 30); }
  function goProject(pid, hash) { G.store.update("prefs", function (p) { p.project = pid; }); if (hash) location.hash = hash; }
  function stepPill(label, on) { return h("span", { class: "step-pill" + (on ? " is-on" : "") }, label); }
  function stateBadge(r) { return r.killed ? h("span", { class: "state state-killed" }, G.icon("st-kill"), h("span", null, "Killed")) : r.halted ? h("span", { class: "state state-blocked" }, G.icon("halt"), h("span", null, "Halted")) : h("span", { class: "con-pstat mono" }, r.status); }

  function card(m) {
    var c = m.card, mid = m.id;
    if (c.type === "help") return h("div", { class: "ccard" }, h("ul", { class: "slash-help" }, SLASH.map(function (s, i) { return h("li", null, h("button", { type: "button", class: "linkish mono", id: "con-help-" + mid + "-" + i, onClick: function () { ui.draft = s.cmd; G.rerender(); focusComposer(); } }, s.cmd.trim()), h("span", { class: "muted" }, s.hint)); })));
    if (c.type === "suggest") return h("div", { class: "ccard" }, h("div", { class: "chips" }, suggestions().map(function (s, i) { return h("button", { type: "button", class: "sugg", id: "con-sug-" + mid + "-" + i, onClick: function () { send(s); } }, s); })));
    if (c.type === "repos") {
      var av = cur() ? offered(cur()) : [];
      return h("div", { class: "ccard" }, av.length ? h("div", { class: "chips" }, av.map(function (r, i) { return h("button", { type: "button", class: "sugg mono", id: "con-repo-" + mid + "-" + i, title: (G.find.integration(r.source) || {}).name, onClick: function () { send("/onboard " + r.repo + " to " + cur().id); } }, r.repo); })) : h("p", { class: "muted" }, "Every repo the source integrations offer is already connected."));
    }
    if (c.type === "projects") return h("div", { class: "ccard" }, h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
      h("thead", null, h("tr", null, ["Project", "State", "WIP", "At gates", "Blocked", "Slots", "Ready repos", ""].map(function (x) { return h("th", { scope: "col" }, x); }))),
      h("tbody", null, c.data.map(function (r) {
        var p = G.find.project(r.id); if (!p) return null;
        return h("tr", { class: r.killed ? "con-killed" : r.halted ? "row-halt" : "" }, h("td", null, h("strong", null, p.name), h("span", { class: "mono muted small" }, " " + p.key)), h("td", null, stateBadge(r)),
          h("td", { class: "mono num" }, String(r.wip)), h("td", { class: "mono num" }, String(r.waiting)), h("td", { class: "mono num" }, String(r.blocked.length)), h("td", { class: "mono" }, r.slots), h("td", { class: "mono" }, r.ready + "/" + r.repos),
          h("td", null, G.btn("Status", { small: true, kind: "ghost", id: "con-pst-" + mid + "-" + r.id, onClick: function () { send("/status " + r.id); } }), G.btn("Floor", { small: true, kind: "ghost", id: "con-pfl-" + mid + "-" + r.id, onClick: function () { goProject(r.id, "floor"); } })));
      })))));
    if (c.type === "status") {
      var p = G.find.project(c.data.id), r = c.data;
      return h("div", { class: "ccard" },
        h("div", { class: "ccard-head" }, h("strong", null, p.name), stateBadge(r)),
        G.miniBelt({ project: p }),
        h("div", { class: "kv-row" }, kvs("WIP", String(r.wip)), kvs("At gates", String(r.waiting)), kvs("Parked", String(r.parked)), kvs("Slots", r.slots), kvs("Shipped 7d", String(r.shipped)), kvs("Ready repos", r.ready + "/" + r.repos)),
        r.blocked.length ? h("p", { class: "small" }, h("strong", null, "Blocked or failing: "), r.blocked.map(function (id) { return h("button", { type: "button", class: "linkish mono", id: "con-blk-" + mid + "-" + id, onClick: function () { send("/why " + id); } }, id + " "); })) : h("p", { class: "small muted" }, "Nothing blocked."),
        h("div", { class: "ccard-actions" }, G.btn("Open floor", { small: true, id: "con-st-floor-" + mid, onClick: function () { goProject(p.id, "floor"); } }), G.btn("Onboarding", { small: true, kind: "ghost", id: "con-st-onb-" + mid, onClick: function () { send("/onboarding " + p.id); } })));
    }
    if (c.type === "onboarding") {
      var mergers = c.data.mergers;
      return h("div", { class: "ccard" }, h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
        h("thead", null, h("tr", null, ["Repo", "Stage", "Progress", "PR", "Note"].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, c.data.rows.map(function (r) {
          var bad = r.stage === "failed" || r.stage === "person";
          return h("tr", null, h("td", { class: "mono" }, r.name),
            h("td", null, h("span", { class: "con-stage" + (r.stage === "ready" ? " is-ready" : bad ? " is-bad" : "") }, G.icon(r.stage === "ready" ? "check" : bad ? "alert" : "clock"), (G.ONBOARD_STAGES.find(function (s) { return s.id === r.stage; }) || { name: r.stage === "person" ? "Needs a person" : "Failed" }).name)),
            h("td", null, h("span", { class: "con-steps", "aria-label": (r.idx + 1) + " of 7" }, G.ONBOARD_STAGES.map(function (s, i) { return h("span", { class: "con-step" + (i <= r.idx ? " is-done" : "") }); }))),
            h("td", { class: "mono" }, r.pr ? "#" + r.pr + " " + r.prState : "–"), h("td", { class: "small" }, r.blocker || ""));
        })))),
        h("p", { class: "small" }, h("strong", null, "Can merge onboarding PRs: "), mergers.length ? mergers.map(G.actorName).join(", ") : "nobody"),
        h("div", { class: "ccard-actions" }, G.btn("Open onboarding", { small: true, id: "con-onb-open-" + mid, onClick: function () { goProject(c.data.project, "onboarding"); } })));
    }
    if (c.type === "evals") return h("div", { class: "ccard" }, h("ul", { class: "eval-mini con-evals" }, c.data.map(function (r) {
      var pass = r.score >= r.threshold;
      return h("li", null, h("span", { class: "mono" }, r.suite), h("span", null, r.agent + " " + r.version),
        h("span", { class: "mono " + (pass ? "pos" : "neg") }, G.fmt.pct(r.score) + " / " + G.fmt.pct(r.threshold)),
        r.delta < -0.03 ? h("span", { class: "state state-failed" }, G.icon("st-fail"), h("span", null, "Regression " + G.fmt.pct(r.delta, 0))) : h("span", { class: "muted small" }, pass ? "eligible" : "below threshold"));
    })), h("div", { class: "ccard-actions" }, G.btn("Open Evals", { small: true, id: "con-ev-open-" + mid, onClick: function () { location.hash = "evals"; } })));
    if (c.type === "triggers") {
      return h("div", { class: "ccard" }, h("ul", { class: "con-trig" }, c.data.ids.map(function (id) {
        var t = G.find.trigger(id); if (!t) return null;
        var last = t.runs[t.runs.length - 1];
        return h("li", null, h("span", { class: "mono strong" }, t.id), h("span", null, t.name, h("span", { class: "muted small" }, " · " + t.type + (t.type === "issue" ? " label '" + t.label + "'" : t.type === "schedule" ? " " + t.schedule : t.type === "comment" ? " " + t.command : ""))),
          h("span", { class: "small " + (t.enabled ? "pos" : "muted") }, t.enabled ? "on" : "off"), h("span", { class: "small muted" }, last ? "last: " + last.outcome + " " + G.fmt.ago(last.at) : "never ran"),
          G.btn("Simulate", { small: true, kind: "ghost", icon: "play", id: "con-trg-" + mid + "-" + t.id, guard: G.me("triggers.edit", { project: t.project }), onClick: function () {
            var repo = (G.store.get("repos").find(function (r) { return r.project === t.project && r.onboarding.stage === "ready"; }) || {}).id;
            var input = { repo: repo, title: t.type === "issue" ? "Console test: " + (t.name || "issue") + " " + G.fmt.ist(Date.now()) : undefined, labels: t.label ? [t.label] : [], author: "priya-acme" };
            confirmCard("trigger", { id: t.id, input: input }, "Simulate " + t.id + " " + t.name, ["Pretend GitHub sent " + (t.type === "issue" ? "an issue labelled '" + t.label + "' on " + (repo ? "acme/" + repo : "a ready repo") : "a " + t.type + " event"), "The trigger runs its rules: who may trigger, label mapping, dedupe", "A created work order goes to Intake like any other"], ["triggers.simulate", { project: t.project }]);
          } }));
      })));
    }
    if (c.type === "whocan") {
      var allowed = c.data.rows.filter(function (r) { return r.allowed; }), denied = c.data.rows.filter(function (r) { return !r.allowed; });
      var rules = {}; denied.forEach(function (r) { rules[r.rule] = (rules[r.rule] || 0) + 1; });
      return h("div", { class: "ccard" },
        h("div", { class: "decision " + (allowed.length ? "is-allowed" : "is-denied") }, h("div", { class: "decision-v" }, G.icon(allowed.length ? "check" : "halt"), allowed.length ? allowed.length + " allowed" : "Nobody"), h("div", { class: "small" }, G.find.action(c.data.action).name + " · " + c.data.where + " · " + c.data.when)),
        allowed.length ? h("ul", { class: "who-list" }, allowed.map(function (r) { return h("li", null, G.who(r.person), h("span", { class: "muted small" }, r.reason)); })) : null,
        h("details", { class: "who-denied" }, h("summary", null, denied.length + " denied · deciding rules: " + Object.keys(rules).map(function (k) { return k + " ×" + rules[k]; }).join(", ")),
          h("ul", { class: "who-list" }, denied.map(function (r) { return h("li", null, G.who(r.person), h("span", { class: "muted small" }, r.reason)); }))),
        h("div", { class: "ccard-actions" }, G.canSeeRoute("access") ? G.btn("Open the simulator", { small: true, kind: "ghost", id: "con-wc-acc-" + mid, onClick: function () { location.hash = "access"; } }) : null));
    }
    if (c.type === "explain") {
      var w = G.find.wo(c.data.wo); if (!w) return null;
      var pinned = G.store.get("console").pinned.indexOf(w.id) >= 0;
      return h("div", { class: "ccard" },
        h("div", { class: "ccard-head" }, h("span", { class: "mono strong" }, w.id), G.stateChip(w.state), G.classChip(w.cls, { small: true }), h("span", { class: "muted" }, w.title)),
        h("ul", { class: "bullets" }, c.data.bullets.map(function (b) { return h("li", null, b); })),
        c.data.unblock ? h("p", { class: "small" }, h("strong", null, "Who can move it: "), c.data.who.length ? c.data.who.map(G.actorName).join(", ") : "nobody right now", h("span", { class: "muted" }, " (" + (G.find.action(c.data.unblock) || { name: c.data.unblock }).name.toLowerCase() + ")")) : null,
        h("div", { class: "kv-row" }, kvs("Age", G.fmt.dur(c.data.age)), kvs("Spend", G.fmt.money(c.data.spend)), kvs("Station", G.STATIONS[w.station].no + " " + G.STATIONS[w.station].name)),
        h("div", { class: "ccard-actions" }, G.btn("Open traveler", { small: true, id: "con-ex-open-" + mid, onClick: function () { G.openTraveler(w.id); } }),
          c.data.approveHere && w.state === "waiting" ? G.btn("Approve…", { small: true, kind: "primary", icon: "check", id: "con-ex-appr-" + mid, onClick: function () { send("/approve " + w.id); } }) : null,
          G.btn(pinned ? "Pinned" : "Pin", { small: true, kind: "ghost", icon: "pin", id: "con-ex-pin-" + mid, disabledReason: pinned ? "Already pinned in the context panel." : null, onClick: function () { G.store.update("console", function (x) { x.pinned.push(w.id); }); } })));
    }
    if (c.type === "mine") return h("div", { class: "ccard" },
      c.data.approvals.length ? h("ul", { class: "con-list" }, c.data.approvals.map(function (a, i) { var w = G.find.wo(a.wo); if (!w) return null; return h("li", null, chip({ type: "wo", id: w.id }), h("span", { class: "mono small" }, (G.gateDef(a.gate) || {}).label), h("span", { class: "small" }, w.title), G.btn("Approve…", { small: true, kind: "ghost", icon: "check", id: "con-mine-ap-" + mid + "-" + i, onClick: function () { approveCard(w); } })); })) : null,
      c.data.repos.length ? h("p", { class: "small" }, "Onboarding PRs ready to merge: " + c.data.repos.map(function (r) { return (G.find.repo(r) || { name: r }).name; }).join(", ")) : null,
      c.data.conv.length ? h("p", { class: "small" }, h("strong", null, "Conversations: "), c.data.conv.map(function (id) { return chip({ type: "wo", id: id }); })) : null);
    if (c.type === "changes") {
      var labels = { "wo.submit": "submitted", "wo.enter": "station entries", "gate.decision": "gate decisions", "trust.auto": "passed under trust", "wo.bay": "moved to bays", release: "releases", "wo.done": "finished", halt: "halts", resume: "resumes", kill: "kills", restore: "restores", "trust.change": "trust changes" };
      return h("div", { class: "ccard" },
        h("div", { class: "kv-row" }, Object.keys(c.data.count).map(function (k) { return kvs(labels[k] || k, String(c.data.count[k])); })),
        c.data.shipped.length ? h("p", { class: "small" }, h("strong", null, "Shipped: "), c.data.shipped.map(function (id) { return chip({ type: "wo", id: id }); })) : null,
        c.data.notable.length ? h("ul", { class: "con-list" }, c.data.notable.map(function (e) { return h("li", null, h("span", { class: "mono muted small" }, G.fmt.istDate(e.at) + " " + G.fmt.ist(e.at)), h("span", { class: "con-ev con-ev-" + e.type.replace(".", "-") }, labels[e.type] || e.type), e.wo ? chip({ type: "wo", id: e.wo }) : e.project ? chip({ type: "project", id: e.project }) : null, h("span", { class: "small" }, e.type === "trust.change" ? "L" + e.from + " to L" + e.to + (e.text ? ": " + e.text : "") : e.text || ""), e.by ? h("span", { class: "muted small" }, G.actorName(e.by)) : null); })) : null,
        h("div", { class: "ccard-actions" }, c.data.project ? G.btn("Open floor", { small: true, id: "con-chg-floor-" + mid, onClick: function () { goProject(c.data.project, "floor"); } }) : null, G.canSeeRoute("audit") ? G.btn("Open audit", { small: true, kind: "ghost", id: "con-chg-aud-" + mid, onClick: function () { location.hash = "audit"; } }) : null));
    }
    if (c.type === "bottlenecks") return h("div", { class: "ccard" },
      h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" }, h("thead", null, h("tr", null, ["Gate", "Project", "Median wait", "Waiting now", "Oldest", "Eligible"].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, c.data.rows.map(function (b) { return h("tr", null, h("td", { class: "mono strong" }, (G.gateDef(b.gate) || { label: b.gate }).label), h("td", null, chip({ type: "project", id: b.project })), h("td", { class: "mono" }, b.n ? G.fmt.dur((b.median || 0) * G.MIN) + (b.n < 5 ? " (n=" + b.n + ", insufficient data)" : " (n=" + b.n + ")") : "no decisions"), h("td", { class: "mono num" }, String(b.open)), h("td", { class: "mono" }, b.open ? G.fmt.dur(b.oldest * G.MIN) : "–"), h("td", { class: "mono" }, b.minEligible == null ? "–" : String(b.minEligible))); })))),
      c.data.sole.length ? h("p", { class: "small" }, h("strong", null, "Only one eligible approver: "), c.data.sole.map(function (x) { return h("span", { class: "con-sole" }, chip({ type: "wo", id: x.wo }), " " + (G.gateDef(x.gate) || {}).label + " · " + G.actorName(x.person) + " "); })) : null,
      h("div", { class: "ccard-actions" }, G.canSeeRoute("workload") ? G.btn("Open Workload", { small: true, id: "con-bn-wl-" + mid, onClick: function () { location.hash = "workload"; } }) : null));
    if (c.type === "summary") return h("div", { class: "ccard" }, h("div", { class: "ccard-head" }, chip({ type: "wo", id: c.data.wo }), h("span", { class: "muted small" }, "Record " + c.data.done + " of " + c.data.total + " sections filled · local summary")),
      h("div", { class: "ccard-actions" }, G.btn("Open full record", { small: true, icon: "record", id: "con-sum-rec-" + mid, onClick: function () { G.openRecord(c.data.wo); } })));
    if (c.type === "workload") return h("div", { class: "ccard" }, h("ul", { class: "con-list" }, c.data.rows.map(function (r) { return h("li", null, G.who(r.person), h("span", { class: "mono small" }, r.minutes + " min"), h("span", { class: "small" }, r.approvals + " approvals, " + r.waiting + " waiting" + (r.sole ? ", only approver on " + r.sole : "")), h("span", { class: "muted small" }, r.n >= 5 ? G.fmt.pct(r.ah / r.n) + " out of hours" : "after hours: insufficient data")); })),
      h("div", { class: "ccard-actions" }, G.canSeeRoute("workload") ? G.btn("Open Workload", { small: true, id: "con-wl-open-" + mid, onClick: function () { location.hash = "workload"; } }) : null));
    if (c.type === "trust") return h("div", { class: "ccard" }, h("div", { class: "kv-row" }, c.data.levels.map(function (n, i) { return kvs("L" + i + " " + ((G.TRUST_LEVELS && G.TRUST_LEVELS[i]) ? G.TRUST_LEVELS[i].name : ""), String(n || 0)); })),
      c.data.proposals.length ? h("ul", { class: "con-list" }, c.data.proposals.map(function (x) { var cell = G.find.trustCell(x.cell); return h("li", null, h("span", { class: "mono strong" }, x.id), h("span", { class: "small" }, (cell ? G.trustCellLabel(cell) : x.cell) + ": L" + x.from + " to L" + x.to), h("span", { class: "muted small" }, "saves about " + (x.saved || 0) + " approvals a week")); })) : h("p", { class: "small muted" }, "No pending promotion proposals."),
      h("div", { class: "ccard-actions" }, G.canSeeRoute("trust") ? G.btn("Open Trust", { small: true, id: "con-tr-open-" + mid, onClick: function () { G.store.update("prefs", function (p) { p.project = c.data.project; }); location.hash = "trust"; } }) : null));
    if (c.type === "proposal") return G.proposalCard(c.proposal, function (r, pr) { patch(mid, function (x) { x.card.proposal = pr; }); });
    if (c.type === "confirm") return confirmView(m);
    return null;
  }

  function confirmView(m) {
    var c = m.card, mid = m.id, status = c.status;
    var d = ui.cards[mid] || (ui.cards[mid] = { reason: c.reason0 || "", confirm: "", mode: "hold" });
    var dec = status === "pending" ? decisionFor(c) : null;
    var refuse = status === "pending" && c.refuse ? { allowed: false, reason: c.refuse, needs: "" } : null;
    var gate = refuse || dec;
    var fields = null;
    if (status === "pending" && (c.needsReason || c.phrase || c.kind === "kill")) {
      var reasonIn = c.needsReason ? h("input", { id: "con-cf-reason-" + mid, class: "input", value: d.reason, placeholder: c.kind === "kill" ? "What is happening? Posted to the kill routes." : "Reason", autocomplete: "off" }) : null;
      if (reasonIn) reasonIn.addEventListener("input", function () { d.reason = reasonIn.value; });
      var conf = c.phrase ? h("input", { id: "con-cf-confirm-" + mid, class: "input mono", value: d.confirm, placeholder: c.phrase, autocomplete: "off" }) : null;
      if (conf) conf.addEventListener("input", function () { d.confirm = conf.value; });
      fields = h("div", { class: "con-cf-fields" },
        reasonIn ? G.field("Reason (required)", reasonIn) : null,
        c.kind === "kill" && c.args.scope !== "workorder" ? h("div", { class: "field" }, h("div", { class: "field-label" }, "In-flight work"), G.segmented("con-cf-mode-" + mid, [{ id: "hold", label: "Hold in place" }, { id: "cancel", label: "Cancel to Killed" }], d.mode, function (v) { d.mode = v; }, "In-flight work")) : null,
        conf ? G.field("Type " + c.phrase + " to confirm", conf) : null);
    }
    var cl = c.classify;
    return h("div", { class: "ccard ccard-confirm is-" + status + (c.danger ? " is-danger" : "") },
      h("div", { class: "ccard-steps" }, stepPill("Plan", true), stepPill("Confirm", status !== "pending" && status !== "cancelled"), stepPill("Done", status === "done")),
      h("div", { class: "ccard-title" }, c.danger ? G.icon("st-kill") : null, c.title),
      cl ? h("div", { class: "con-cls" },
        h("div", { class: "con-cls-top" }, h("span", { class: "kicker" }, "Intake classifier (local)"), G.classChip(cl.requested || cl.cls), h("span", { class: "mono small" }, Math.round(cl.confidence * 100) + "% confident" + (cl.requested && cl.requested !== cl.cls ? ", you asked for " + G.find.cls(cl.requested).name + " (suggested " + G.find.cls(cl.cls).name + ")" : ""))),
        h("p", { class: "small" }, cl.rationale + (cl.alternatives.length ? " Alternatives: " + cl.alternatives.map(function (x) { return G.find.cls(x).name; }).join(", ") + "." : "")),
        h("ol", { class: "con-route", "aria-label": "Route" }, G.flowOf(G.find.project(cl.project || c.args.project)).active.map(function (s) { var on = cl.route.indexOf(s.id) >= 0; var g = G.flowOf(G.find.project(cl.project || c.args.project)).gates.find(function (x) { return x.after === s.id && x.enabled !== false; }); return [h("li", { class: on ? "is-on" : "is-skip", title: on ? s.name : s.name + " skipped" }, h("span", { class: "mono" }, s.no), on ? s.name : h("s", null, s.name)), g && cl.gates.indexOf(g.id) >= 0 ? h("li", { class: "con-gate", title: g.label + " " + g.name }, h("span", { class: "con-dia", "aria-hidden": "true" }), h("span", { class: "mono" }, g.label)) : null]; }))) : null,
      c.impact ? h("dl", { class: "titleblock kill-impact con-impact" },
        c.args.scope === "factory" ? h("div", null, h("dt", null, "Projects"), h("dd", null, String(c.impact.projects))) : null,
        h("div", null, h("dt", null, "Work orders"), h("dd", null, String(c.impact.workOrders))), h("div", null, h("dt", null, "Running agents"), h("dd", null, String(c.impact.running))),
        h("div", null, h("dt", null, "Slots freed"), h("dd", null, String(c.impact.slots))), h("div", null, h("dt", null, "Open PRs"), h("dd", null, String(c.impact.prs)))) : null,
      h("ol", { class: "bullets" }, c.steps.filter(Boolean).map(function (s) { return h("li", null, s); })),
      gate ? h("div", { class: "perm " + (gate.allowed ? "pos" : "neg") }, G.icon(gate.allowed ? "check" : "lock"), h("span", null, gate.allowed ? "You can do this. " + gate.reason : "You can't do this: " + (gate.needs ? gate.needs + ". " : "") + gate.reason)) : null,
      gate && !gate.allowed && !refuse && c.perm && G.explainDenial ? G.explainDenial({ id: "con-cf-explain-" + mid, person: G.viewerId(), action: c.perm[0] === "gate" ? "gate.approve" : c.perm[0] === "triggers.simulate" ? "triggers.edit" : c.perm[0], project: c.perm[1] && (c.perm[1].project || (c.perm[1].wo && (G.find.wo(c.perm[1].wo) || {}).project)) || undefined, decision: gate }) : null,
      fields,
      c.err ? h("div", { class: "form-err", role: "alert" }, c.err) : null,
      c.result ? h("div", { class: "perm " + (status === "done" ? "pos" : "neg") }, G.icon(status === "done" ? "check" : "x"), h("span", null, c.result)) : null,
      status === "done" && c.woId ? h("div", { class: "ccard-actions" }, G.btn("Open " + c.woId, { small: true, id: "con-cf-wo-" + mid, onClick: function () { G.openTraveler(c.woId); } }),
        c.kind === "submit" ? G.btn("Answer the intake questions", { small: true, kind: "primary", icon: "chat", id: "con-cf-conv-" + mid, onClick: function () { G.store.update("prefs", function (p) { p.openConversation = c.woId; p.project = c.args.project; }); location.hash = "conversations"; } }) : null) : null,
      status === "done" && c.kind === "onboard" ? h("div", { class: "ccard-actions" }, G.btn("Open onboarding", { small: true, id: "con-cf-onb-" + mid, onClick: function () { goProject(c.args.project, "onboarding"); } })) : null,
      status === "pending" && c.refuse ? h("div", { class: "ccard-actions" }, G.btn("Open onboarding", { small: true, kind: "ghost", icon: "branch", id: "con-cf-onbref-" + mid, onClick: function () { goProject(c.args.project, "onboarding"); } })) : null,
      status === "cancelled" ? h("div", { class: "muted small" }, "Cancelled. Nothing changed.") : null,
      status === "pending" ? h("div", { class: "ccard-actions" },
        G.btn(c.kind === "kill" ? "Kill " + (c.args.scope === "workorder" ? c.args.id : c.args.scope) : c.kind === "restore" ? "Restore" : "Confirm and run", { kind: c.danger ? "danger" : "primary", small: true, icon: c.danger ? "st-kill" : "check", id: "con-cf-ok-" + mid, guard: gate && !gate.allowed ? gate : null, onClick: function () { runConfirm(m); } }),
        G.btn("Cancel", { small: true, kind: "ghost", id: "con-cf-no-" + mid, onClick: function () { patch(mid, function (x) { x.card.status = "cancelled"; }); } })) : null);
  }

  /* ---------- view ---------- */
  function render() {
    var s = G.store.get();
    var v = G.viewer();
    var p = cur();
    if (!msgs().length) s.console.messages.push({ id: "m0-" + G.viewerId(), at: Date.now(), owner: G.viewerId(), role: "factory", text: "Ask about your projects in plain language, or use a slash command. When Claude is available it answers with tools over the live factory; otherwise local logic answers the questions it recognises. Anything that changes state shows a confirm card and runs only when you click it. Questions without a project use your current project, " + (p ? p.name : "none") + ".", card: { type: "suggest" } });
    var list = msgs();
    var thread = h("div", { class: "thread", id: "con-thread", "data-keep-scroll": "con-thread", role: "log", "aria-live": "polite", "aria-label": "Console conversation" },
      list.map(function (m) {
        return h("div", { class: "msg msg-" + m.role },
          h("div", { class: "msg-who" }, m.role === "user" ? G.avatar(m.by, "sm") : h("span", { class: "av av-factory av-sm", "aria-hidden": "true" }, "G"),
            h("span", { class: "msg-name" }, m.role === "user" ? G.actorName(m.by) : "Gantry"), h("span", { class: "mono muted small" }, G.fmt.ist(m.at))),
          m.streaming ? h("div", { class: "msg-text" + (ui.stream[m.id] ? "" : " is-thinking"), id: "con-msg-text-" + m.id }, ui.stream[m.id] || (ui.stream[m.id] === undefined ? "This answer was interrupted." : "Thinking with Claude…"))
            : m.text ? h("div", { class: "msg-text", id: "con-msg-text-" + m.id }, m.text) : null,
          m.role === "factory" && (m.mode === "claude" || m.mode === "local" || m.mode === "pending") ? h("div", { class: "msg-meta" },
            h("span", { class: "msg-mode is-" + m.mode }, m.mode === "claude" ? (m.proposed ? "Proposed by Claude" : "Claude") + (m.stopped ? " · stopped" : "") : m.mode === "pending" ? "Claude · streaming" : m.via === "slash" ? "Slash command · local logic" : "Local logic"),
            m.note ? h("span", { class: "msg-note" }, m.note) : null) : null,
          m.cited && m.cited.length ? h("div", { class: "chips msg-chips", "aria-label": "Used in this answer" }, h("span", { class: "kicker" }, "Used"), m.cited.map(chip)) : null,
          m.card ? card(m) : null);
      }));
    var input = h("textarea", { id: "con-input", class: "input composer-input", rows: "2", placeholder: "Ask or instruct. Type / for commands.", "aria-label": "Message the factory", "aria-autocomplete": "list", "aria-controls": "con-slash" });
    input.value = ui.draft;
    var slash = ui.draft.charAt(0) === "/" && ui.draft.indexOf(" ") < 0 ? SLASH.filter(function (x) { return x.cmd.indexOf(ui.draft.toLowerCase()) === 0; }) : [];
    if (ui.slashIdx >= slash.length) ui.slashIdx = 0;
    input.addEventListener("input", function () { var wasSlash = ui.draft.charAt(0) === "/" && ui.draft.indexOf(" ") < 0; ui.draft = input.value; ui.slashIdx = 0; var isSlash = ui.draft.charAt(0) === "/" && ui.draft.indexOf(" ") < 0; if (wasSlash || isSlash) G.rerender(); });
    input.addEventListener("keydown", function (e) {
      if (slash.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); ui.slashIdx = (ui.slashIdx + (e.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length; G.rerender(); return; }
      if (slash.length && e.key === "Tab") { e.preventDefault(); ui.draft = slash[ui.slashIdx].cmd; G.rerender(); focusComposer(); return; }
      if (slash.length && e.key === "Escape") { e.preventDefault(); ui.draft = ui.draft + " "; G.rerender(); focusComposer(); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (slash.length && ui.draft.trim() !== slash[ui.slashIdx].cmd.trim()) { ui.draft = slash[ui.slashIdx].cmd; G.rerender(); focusComposer(); return; }
        send(input.value); G.rerender(); focusComposer();
      }
    });
    var form = h("form", { class: "composer", id: "con-form" },
      slash.length ? h("ul", { class: "slash-menu", id: "con-slash", role: "listbox", "aria-label": "Commands" }, slash.map(function (x, i) {
        var li = h("li", { role: "option", id: "con-slash-" + i, class: i === ui.slashIdx ? "is-active" : "", "aria-selected": i === ui.slashIdx ? "true" : "false" }, h("span", { class: "mono" }, x.cmd.trim()), h("span", { class: "muted" }, x.hint));
        li.addEventListener("mousedown", function (e) { e.preventDefault(); ui.draft = x.cmd; G.rerender(); focusComposer(); });
        return li;
      })) : null,
      input,
      h("div", { class: "composer-foot" },
        h("div", { class: "chips" }, suggestions().slice(0, 3).map(function (sg, i) { return h("button", { type: "button", class: "sugg", id: "con-foot-sug-" + i, onClick: function () { send(sg); } }, sg); })),
        ui.streaming ? h("div", { class: "row gap-sm" }, G.btn("Stop", { kind: "danger", small: true, icon: "x", id: "con-stop", onClick: stopAnswer }), G.btn("Send", { kind: "primary", icon: "send", type: "submit", id: "con-send", disabledReason: "Wait for the answer or stop it." }))
          : G.btn("Send", { kind: "primary", icon: "send", type: "submit", id: "con-send" })));
    form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); G.rerender(); focusComposer(); });

    /* context panel */
    var vis = visible();
    var pSel = G.select("con-ctx-project", vis.map(function (x) { return { value: x.id, label: x.name }; }), p && p.id, function (val) { G.store.update("prefs", function (pr) { pr.project = val; }); }, { "aria-label": "Current project" });
    var row = p ? projectRow(p) : null;
    var caps = [["wo.submit", "Submit work orders"], ["gate.approve", "Approve gates"], ["line.halt", "Halt (andon)"], ["line.resume", "Resume"], ["repo.onboard", "Connect repos"], ["triggers.edit", "Simulate triggers"], ["kill.workorder", "Kill a work order"], ["kill.project", "Kill this project"], ["restore.project", "Restore this project"], ["kill.factory", "Kill the factory"]];
    var capList = h("ul", { class: "caps" }, caps.map(function (cp) {
      var d = G.me(cp[0], { project: p && p.id });
      return h("li", { class: d.allowed ? "ok" : "no", tabindex: "0", "data-tip": d.reason }, G.icon(d.allowed ? "check" : "lock"), h("span", null, cp[1]), h("span", { class: "mono muted small" }, cp[0]));
    }));
    var recent = s.audit.filter(function (a) { return a.via === "console" && a.actor === G.viewerId(); }).slice(-6).reverse();
    var pins = s.console.pinned.map(function (id) {
      var w = G.find.wo(id); if (!w || !canSeeProject(w.project)) return null;
      return h("li", null, h("button", { type: "button", class: "linkish", id: "con-pin-" + id, onClick: function () { G.openTraveler(w.id); } }, h("span", { class: "mono" }, w.id), " " + w.title),
        G.stateChip(w.state, true),
        h("button", { type: "button", class: "icon-btn icon-btn-sm", id: "con-unpin-" + id, "aria-label": "Unpin " + id, onClick: function () { G.store.update("console", function (c) { c.pinned = c.pinned.filter(function (x) { return x !== id; }); }); } }, G.icon("x")));
    }).filter(Boolean);
    var side = h("aside", { class: "ctx", "aria-label": "Console context" },
      G.panel("Context", h("div", { class: "con-ctx" }, G.field("Current project", pSel),
        row ? h("div", { class: "kv-row" }, kvs("WIP", String(row.wip)), kvs("At gates", String(row.waiting)), kvs("Slots", row.slots)) : null,
        row ? h("div", null, stateBadge(row)) : null)),
      G.panel("What " + (v ? v.name.split(" ")[0] : "you") + " can do " + (p ? "in " + p.name : ""), capList),
      G.panel("Pinned", pins.length ? h("ul", { class: "pins" }, pins) : h("p", { class: "muted small" }, "Pin a work order from a why card.")),
      G.panel("Your console actions", recent.length ? h("ul", { class: "mini-log con-log" }, recent.map(function (a) { return h("li", null, h("span", { class: "mono muted" }, G.fmt.ist(a.at)), h("span", null, a.action + " · " + a.target), h("span", { class: "outcome o-" + a.outcome }, a.outcome)); })) : h("p", { class: "muted small" }, "Actions you confirm here are written to the audit ledger with via console.")),
      G.btn("Clear conversation", { small: true, kind: "ghost", icon: "x", id: "con-clear", onClick: function () { var me = G.viewerId(); ui.cards = {}; G.store.update("console", function (c) { c.messages = c.messages.filter(function (m) { return m.owner && m.owner !== me; }); }); } }),
      h("p", { class: "footnote" }, "Free-form questions go to Claude when this page runs inside the Claude artifact runtime and you grant access; otherwise a local matcher over this page's data answers. Slash commands always run locally. Claude only sees what the tools return for you, and its proposals run only after you confirm them here. Actions are real within this page's state and are audited."));

    var count = list.length;
    var node = h("div", { class: "view view-console" },
      G.pageHeader({ id: "con-head", kicker: "Overview · Console", title: "Console", badge: G.ask.badge("con-mode"), sub: "Talk to the factory in plain language or with slash commands. Anything that changes state shows a confirm card and waits for you." }),
      h("p", { class: "con-mode-line small", id: "con-mode-reason" }, G.icon(G.ask.available() === "ready" ? "check" : "dots"), h("span", null, G.ask.reason())),
      h("div", { class: "console-grid" }, h("section", { class: "console-main", "aria-label": "Conversation" }, thread, form), side));
    if (count !== ui.lastCount) {
      ui.lastCount = count;
      requestAnimationFrame(function () { var t = document.getElementById("con-thread"); if (t) t.scrollTop = t.scrollHeight; });
    }
    return node;
  }

  var lastAskState = null;
  G.ask.subscribe(function (st) { if (st === lastAskState) return; lastAskState = st; if (G.currentRoute && G.currentRoute() === "console" && G.viewer()) G.rerender(); });
  G.views.console = { title: "Console", render: render, keys: ["console", "audit", "repos", "triggers"] };
})(window.G);
