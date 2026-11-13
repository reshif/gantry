/* Notifications (#notifications): routes per project (event -> destinations -> card template ->
   conditions), repo overrides, a card designer with field toggles, custom card templates, test sends
   and the delivery log with retry. Destinations are connected integration instances with the notify
   capability (state.integrationInstances, built-in and custom types); each destination stores
   { channel: type id, target, integration: instance id }. Events come from the one catalogue list
   (G.NOTIFY_EVENTS, incl. trust, learning and post-release outcomes). Every change, test send and retry goes
   through G.ops, which resolve the destination's integration instance. Card previews are drawn in Gantry
   tokens; nothing is sent. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "routes", sel: null, draftKey: null, draft: null, preview: null, ov: { repo: "", event: "gate.waiting", integration: "", target: "", mode: "also" }, dl: { status: "all", integration: "all", event: "all" }, dlLimit: 40, ct: { sel: null, draft: null } };

  var TPL = G.CARD_TEMPLATES, ACTION_LABEL = G.CARD_ACTIONS; /* card catalogue (sim.js) */
  var DEF_TPL = G.CARD_DEFAULTS;
  var FIELDS = [["title", "Work order title"], ["repo", "Repo"], ["class", "Class"], ["priority", "Priority"], ["approvers", "Approvers"], ["link", "Link"], ["actions", "Action buttons"]];
  var KIND_EVENT = { gate: "gate.waiting", question: "question", incident: "blocked", kill: "kill", release: "released", onboarding: "onboarding.pr", submitted: "submitted", budget: "budget", eval: "eval.regression" };

  function S(k) { return G.store.get(k); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function evName(id) { return G.notifyEventName(id); }
  function events() { return G.NOTIFY_EVENTS.map(function (e) { return { value: e.id, label: e.name }; }); }
  function typeDef(id) { return G.find.integrationType(id) || { id: id, name: id, icon: "send", category: "custom", fields: [], events: [], actions: [] }; }
  function chan(id) { var t = typeDef(id); return { id: id, name: t.name, icon: t.icon || "send" }; }
  /* instances a project can send to: destination-capable types open to the project */
  function destInsts(p) { return G.integrationsFor(p.id).filter(function (i) { return typeDef(i.type).destination; }); }
  function instOf(d, p) { return G.integrationFor(d, p ? p.id : null); }
  function instState(i) { return !i ? "missing" : !i.connected ? "disabled" : i.status === "failing" ? "failing" : i.status === "offline" ? "offline" : "healthy"; }
  function defaultTarget(type, p, inst) {
    if (type === "email") return "submitter";
    if (type === "slack" || type === "discord") return "#" + p.key.toLowerCase() + "-factory";
    if (type === "teams") return "General";
    if (type === "gchat") return p.key.toLowerCase() + "-factory";
    if (type === "webhook") return inst ? inst.targetId || inst.id : "";
    if (type === "paging") return G.integrationTargets(inst || G.integrationsFor(p.id, "paging")[0])[0] || "";
    return "";
  }
  /* card templates: built-in kinds plus custom ones (saveCardTemplate / removeCardTemplate); `deleted` marks
     templates hidden by an earlier version and is still honoured */
  function customTpls() { return (S("cardTemplates") || []).filter(function (t) { return !t.deleted; }); }
  function tplInfo(id) {
    if (TPL[id]) return { id: id, name: TPL[id].name, kind: id, actions: TPL[id].actions.slice(), custom: false };
    var c = (S("cardTemplates") || []).find(function (t) { return t.id === id; });
    if (c) return { id: c.id, name: c.name + (c.deleted ? " (deleted)" : ""), kind: c.kind, actions: (c.actions || []).slice(), fields: c.fields, custom: true, integration: c.integration || null };
    return { id: id, name: id, kind: "submitted", actions: TPL.submitted.actions.slice(), custom: false };
  }
  function tplOptions(includeId) {
    return Object.keys(TPL).map(function (k) { return { value: k, label: TPL[k].name }; })
      .concat(customTpls().map(function (t) { return { value: t.id, label: t.name + " (custom)" }; }))
      .concat(includeId && !TPL[includeId] && !customTpls().some(function (t) { return t.id === includeId; }) ? [{ value: includeId, label: tplInfo(includeId).name }] : []);
  }
  function routesUsingTpl(id) { var out = []; S("projects").forEach(function (p) { p.notifications.forEach(function (r) { if (r.template === id) out.push(p.key + " " + r.id); }); }); return out; }
  function fieldOn(f, k) { return !f || f[k] !== false; }
  function project() {
    var vis = G.visibleProjects(G.viewerId());
    var cur = G.currentProject();
    return vis.find(function (p) { return cur && p.id === cur.id; }) || vis[0] || null;
  }
  function show(r, okMsg) { G.toast(r.ok ? (okMsg || r.msg) : r.msg, r.ok ? "ok" : "error"); return r; }

  /* ---------- validation ---------- */
  function targetError(d, p) {
    var t = (d.target || "").trim(), inst = d.integration ? G.find.integration(d.integration) : instOf(d, p);
    if (!inst) return "Pick a connection for each destination. Add one in Integrations if the list is empty.";
    if (p && !(inst.projects === "all" || (inst.projects || []).indexOf(p.id) >= 0)) return inst.name + " is not open to " + p.name + ". Change its scope in Integrations.";
    if (!t) return inst.name + " needs a " + (typeDef(inst.type).targetLabel || "target").toLowerCase() + ".";
    if (inst.type === "slack" && !/^[#@][a-z0-9._-]+$/i.test(t)) return "Slack targets start with # (channel) or @ (person or role).";
    if (inst.type === "discord" && !/^#?[a-z0-9._-]+$/i.test(t)) return "Discord targets are a channel name.";
    if (inst.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && ["submitter", "approvers", "project admins", "owners"].indexOf(t) < 0) return "Email targets are an address or one of: submitter, approvers, project admins, owners.";
    return null;
  }
  function draftError(r, p) {
    if (!r.dest.length) return "Add at least one destination.";
    for (var i = 0; i < r.dest.length; i++) { var e = targetError(r.dest[i], p); if (e) return e; }
    return null;
  }
  /* events a destination type accepts: built-in chat/email/webhook types take any event; a type that
     lists Gantry events (custom ones such as Status page) takes only those */
  function accepts(inst, ev) { return G.integrationAccepts(inst, ev); }

  /* ---------- test send and retry: the shared ops resolve the destination's integration instance ---------- */
  function sendTestInst(p, d, event) { return G.ops.sendTest(p.id, { channel: d.channel, target: d.target, integration: d.integration || null }, event); }
  function retry(dl) { return G.ops.retryDelivery(dl.id); }

  /* ---------- sample data for previews ---------- */
  function sample(p, r) {
    var wos = S("workOrders").filter(function (w) { return w.project === p.id && w.state !== "killed"; });
    var wo = (r.template === "gate" && (wos.find(function (w) { var g = w.state === "waiting" && G.gateForWO(p, w); return g && g.id !== "G0G1"; }) || wos.find(function (w) { return w.state === "waiting"; }))) || wos.slice(-1)[0] || null;
    var gate = wo ? G.gateForWO(p, wo) : null;
    gate = gate || G.gateDef("G2");
    var ap = p.approvers && p.approvers[gate.id];
    var approvers = ap ? (ap.roles.map(function (x) { var ro = G.find.role(x); return ro ? ro.name : x; }).concat(ap.people.map(function (x) { return G.actorName(x); }))).join(", ") + " · " + ap.required + " needed" : "Submitter";
    var repo = wo ? G.find.repo(wo.repo) : S("repos").find(function (x) { return x.project === p.id; });
    var woId = wo ? wo.id : "WO-2417", title = wo ? wo.title : "Sample work order";
    var onb = S("repos").find(function (x) { return x.project === p.id && x.onboarding.pr; });
    var H = {
      submitted: [woId + " submitted to " + p.name, "Intake classified it and opened the intake conversation."],
      question: ["Intake has a question on " + woId, (wo && wo.conv && wo.conv.questions[wo.conv.qi] ? wo.conv.questions[wo.conv.qi].text : "What is in scope?")],
      "gate.waiting": [gate.label + " " + gate.name + " is waiting on " + woId, "This gate needs a person. Approving moves the work order to the next station."],
      "gate.decided": [gate.label + " approved on " + woId, "Approved by Kenji Watanabe. The work order moved on."],
      blocked: [woId + " is blocked", wo && wo.blockReason ? wo.blockReason : "The agent stopped and needs a decision."],
      "security.hold": [woId + " moved to Security hold", "G3s flagged a high-severity finding in the plan."],
      andon: ["Andon halt on " + p.name, "A person halted the line. Agents finish their current step and wait."],
      kill: ["Kill switch pulled on " + p.name, "Hard stop. In-flight work is held in place until restored."],
      restore: [p.name + " restored after kill", "Work resumes from where it was held."],
      "onboarding.pr": ["Onboarding PR #" + (onb ? onb.onboarding.pr.number : 338) + " opened for " + (onb ? onb.name : "acme/mobile-app"), "The Onboarding agent proposes the changes this repo needs before work orders can run."],
      released: ["Released " + woId, "Tagged " + ((wo && wo.pr && wo.pr.tag) || "v1.8.3") + " and closed linked issues."],
      "eval.regression": ["Eval regression on Builder 2.7.0-rc1", "Golden set score fell from 0.90 to 0.82. Promotion is blocked."],
      budget: [p.name + " at " + Math.round(p.budget.mtd / Math.max(1, p.budget.monthly) * 100) + "% of monthly budget", G.fmt.money0(p.budget.mtd) + " of " + G.fmt.money0(p.budget.monthly) + " spent this month."],
      "trust.changed": trustHead(p),
      "learning.proposed": learnHead(p),
      "outcome.recorded": outcomeHead(p)
    }[r.event] || [evName(r.event), ""];
    return { wo: wo, woId: woId, title: title, repo: repo ? repo.name : "acme/repo", cls: wo ? wo.cls : "feature", prio: wo ? wo.priority : "P2", gate: gate, approvers: approvers,
      link: "https://gantry.acme.dev/wo/" + woId, head: H[0], body: H[1], project: p, at: Date.now() };
  }
  function outcomeHead(p) {
    var w = S("workOrders").filter(function (x) { return x.project === p.id && (x.outcomes || []).some(function (o) { return o.kind !== "healthy"; }); }).slice(-1)[0];
    var o = w ? w.outcomes.filter(function (x) { return x.kind !== "healthy"; }).slice(-1)[0] : null;
    return o ? ["Post-release " + (o.kind === "followup" ? "follow-up" : o.kind) + " on " + w.id, o.text] : ["Post-release incident on WO-2417", "Error rate rose after release. Trust for this class drops a level and the learning loop gets the signal."];
  }
  function trustHead(p) {
    var cells = ((S("trust") || {}).cells || []).filter(function (c) { return c.project === p.id && c.history.length > 1; });
    var c = cells.sort(function (a, b) { return b.since - a.since; })[0];
    if (!c) return ["Trust level changed on " + p.name, "A trust cell moved on the ladder."];
    var last = c.history[c.history.length - 1], lv = function (n) { return n == null ? "new" : "L" + n; };
    return [(G.trustCellLabel ? G.trustCellLabel(c) : c.id) + ": " + lv(last.from) + " to " + lv(last.to), last.reason || "Trust level changed."];
  }
  function learnHead(p) {
    var l = ((S("learning") || {}).proposals || []).filter(function (x) { return !x.change || !x.change.project || x.change.project === p.id; }).slice(-1)[0];
    return l ? ["Learning proposal " + l.id + ": " + l.title, "Expected effect: " + (l.expected || "not stated") + "."] : ["Learning proposal drafted", "Gantry grouped recent signals into a proposed improvement."];
  }
  function tone(r) {
    return { "gate.waiting": "gate", "gate.decided": "done", blocked: "block", "security.hold": "block", andon: "block", kill: "kill", restore: "done", released: "done", "eval.regression": "fail", budget: "wait", "trust.changed": "gate" }[r.event] || "accent";
  }
  function factRows(r, s) {
    var f = r.fields, rows = [];
    if (fieldOn(f, "title")) rows.push(["Work order", s.woId + " · " + s.title]);
    if (fieldOn(f, "repo")) rows.push(["Repo", s.repo]);
    if (fieldOn(f, "class")) rows.push(["Class", (G.find.cls(s.cls) || { name: s.cls }).name]);
    if (fieldOn(f, "priority")) rows.push(["Priority", s.prio]);
    if (fieldOn(f, "approvers") && (r.template === "gate" || r.event.indexOf("gate") === 0)) rows.push(["Approvers", s.approvers]);
    return rows;
  }
  function actionsFor(r, channel, inst) {
    if (!fieldOn(r.fields, "actions")) return { list: [], note: "Action buttons are off for this route." };
    var ints = S("integrations") || {};
    var list = (r.__tpl || tplInfo(r.template)).actions.slice();
    var note = null;
    var canApprove = inst && inst.config && inst.config.approve != null ? !!inst.config.approve : channel === "slack" ? !!(ints.slack || {}).approveFromSlack : channel === "teams" ? !!(ints.teams || {}).approveFromTeams : false;
    if (list.indexOf("approve") >= 0 && !canApprove) {
      list = list.filter(function (a) { return a !== "approve" && a !== "reject"; });
      note = channel === "email" ? "Email cards never approve; the button opens Gantry where approver rules run." : "Approve from card is off for " + (inst ? inst.name : chan(channel).name) + ". Turn it on in that connection's settings in Integrations.";
    }
    if (!fieldOn(r.fields, "link")) list = list.filter(function (a) { return a !== "open"; });
    return { list: list, note: note };
  }

  /* ---------- previews ---------- */
  function btnRow(acts, cls) {
    return acts.list.length ? h("div", { class: cls }, acts.list.map(function (a) {
      return h("span", { class: "np-act np-act-" + a, role: "presentation" }, ACTION_LABEL[a]);
    })) : null;
  }
  function slackCard(r, s, target, inst) {
    var ty = inst ? typeDef(inst.type) : typeDef("slack");
    var acts = actionsFor(r, ty.id, inst);
    var where = inst ? inst.name : "Slack";
    return h("div", { class: "np-frame np-slack" },
      h("div", { class: "np-chanbar" }, h("span", { class: "mono" }, target || "#channel"), h("span", { class: "muted small" }, where + " · preview")),
      h("div", { class: "np-msg" },
        h("span", { class: "np-appav" }, G.logo()),
        h("div", { class: "np-msg-main" },
          h("div", { class: "np-msg-meta" }, h("strong", null, "Gantry"), h("span", { class: "np-appbadge" }, "APP"), h("span", { class: "muted small mono" }, G.fmt.ist(s.at))),
          h("div", { class: "np-msg-text" }, h("strong", null, s.head)),
          h("div", { class: "np-attach np-tone-" + tone(r) },
            h("div", { class: "np-attach-body" },
              s.body ? h("p", null, s.body) : null,
              h("dl", { class: "np-fields" }, factRows(r, s).map(function (x) { return h("div", null, h("dt", null, x[0]), h("dd", null, x[1])); })),
              btnRow(acts, "np-btns"),
              fieldOn(r.fields, "link") ? h("div", { class: "np-ctx small" }, s.project.name + " · ", h("span", { class: "np-link" }, s.link.replace("https://", ""))) : h("div", { class: "np-ctx small" }, s.project.name))),
          acts.note ? h("div", { class: "np-note small" }, G.icon("lock"), acts.note) : null)));
  }
  function teamsCard(r, s, target, inst) {
    var acts = actionsFor(r, "teams", inst);
    return h("div", { class: "np-frame np-teams" },
      h("div", { class: "np-chanbar" }, h("span", null, G.icon("teams"), " ", target || "General"), h("span", { class: "muted small" }, (inst ? inst.name + " · tenant " + (inst.config.tenant || "") : "Teams") + " · preview")),
      h("div", { class: "np-tcard np-tone-" + tone(r) },
        h("div", { class: "np-tcard-band" }),
        h("div", { class: "np-tcard-head" }, h("span", { class: "np-appav np-appav-sm" }, G.logo()), h("strong", null, "Gantry"), h("span", { class: "muted small mono" }, G.fmt.stamp(s.at))),
        h("div", { class: "np-tcard-title" }, s.head),
        s.body ? h("p", { class: "np-tcard-sub" }, s.body) : null,
        h("table", { class: "np-facts" }, h("tbody", null, factRows(r, s).map(function (x) { return h("tr", null, h("th", null, x[0]), h("td", null, x[1])); }))),
        btnRow(acts, "np-tbtns")),
      acts.note ? h("div", { class: "np-note small" }, G.icon("lock"), acts.note) : null);
  }
  function emailCard(r, s, target, inst) {
    var acts = actionsFor(r, "email", inst);
    var to = target === "submitter" ? G.actorName(s.wo ? s.wo.requestedBy : "p-tomas") + " (submitter)" : target || "recipient";
    return h("div", { class: "np-frame np-email" },
      h("dl", { class: "np-mailhead" },
        h("div", null, h("dt", null, "From"), h("dd", null, "Gantry <" + ((inst && inst.config.from) || (S("integrations").email || {}).from || "gantry@acme.dev") + ">")),
        h("div", null, h("dt", null, "To"), h("dd", null, to)),
        h("div", null, h("dt", null, "Subject"), h("dd", null, h("strong", null, "[" + s.project.key + "] " + s.head)))),
      h("div", { class: "np-mailbody" },
        h("div", { class: "np-mailbrand np-tone-" + tone(r) }, G.logo(), h("span", null, "GANTRY")),
        h("h3", { class: "np-mail-h" }, s.head),
        s.body ? h("p", null, s.body) : null,
        h("table", { class: "np-mailtable" }, h("tbody", null, factRows(r, s).map(function (x) { return h("tr", null, h("th", null, x[0]), h("td", null, x[1])); }))),
        acts.list.length ? h("div", { class: "np-btns" }, acts.list.map(function (a, i) { return h("span", { class: "np-act" + (i === 0 ? " np-act-primary" : "") }, ACTION_LABEL[a]); })) : null,
        fieldOn(r.fields, "link") ? h("p", { class: "small muted" }, "Or paste this link: ", h("span", { class: "np-link mono" }, s.link)) : null,
        h("p", { class: "np-mailfoot small" }, "You get this because route " + (r.id || "(new)") + " on " + s.project.name + " sends " + evName(r.event).toLowerCase() + " events here. Manage notifications in Gantry.")),
      acts.note ? h("div", { class: "np-note small" }, G.icon("lock"), acts.note) : null);
  }
  function payload(r, s) {
    var f = r.fields, wo = {};
    wo.id = s.woId;
    if (fieldOn(f, "title")) wo.title = s.title;
    if (fieldOn(f, "repo")) wo.repo = s.repo;
    if (fieldOn(f, "class")) wo["class"] = s.cls;
    if (fieldOn(f, "priority")) wo.priority = s.prio;
    var o = { id: "evt_" + (s.at % 1e8).toString(36), type: r.event, created_at: new Date(s.at).toISOString(), project: { id: s.project.id, key: s.project.key, name: s.project.name }, work_order: wo, summary: s.head };
    if (r.event.indexOf("gate") === 0 || r.template === "gate") { o.gate = { id: s.gate.id, label: s.gate.label, name: s.gate.name }; if (fieldOn(f, "approvers")) o.gate.approvers = s.approvers; }
    if (fieldOn(f, "link")) o.links = { html: s.link, api: "/v1/work-orders/" + s.woId };
    if (fieldOn(f, "actions")) o.actions = (r.__tpl || tplInfo(r.template)).actions.filter(function (a) { return a !== "open"; }).map(function (a) { return { id: a, method: "POST", href: "/v1/work-orders/" + s.woId + "/" + a }; });
    o.route = r.id || null; o.simulated = true;
    return o;
  }
  function webhookCard(r, s, target, inst) {
    var ty = inst ? typeDef(inst.type) : typeDef("webhook");
    var urlKey = (ty.fields || []).find(function (f) { return f.type === "url" && inst && inst.config[f.key]; });
    var url = urlKey ? inst.config[urlKey.key] : "https://receiver.example/hook";
    var body = payload(r, s);
    if (ty.payload === "cloudevents" || (inst && inst.config.format === "cloudevents")) body = { specversion: "1.0", id: body.id, source: "gantry.acme.dev", type: "dev.gantry." + r.event, time: body.created_at, datacontenttype: "application/json", data: body };
    if (inst && ty.id !== "webhook") body.target = target;
    var json = JSON.stringify(body, null, 2);
    var head = "POST " + url + "\nContent-Type: application/json\nX-Gantry-Event: " + r.event + "\nX-Gantry-Delivery: DLV-" + S("nextDelivery") + (ty.auth === "hmac" ? "\nX-Gantry-Signature: " + S("apiConfig").webhookSigning.toLowerCase().replace("hmac-", "") + "=3f9c…e21a" : "\nAuthorization: " + (ty.auth === "basic" ? "Basic" : "Bearer") + " " + (inst ? inst.secretMask || "••••" : "••••"));
    return h("div", { class: "np-frame np-hook" },
      h("div", { class: "np-chanbar" }, h("span", { class: "mono" }, (inst ? inst.name + " · " : "") + (target || "endpoint")), G.btn("Copy JSON", { small: true, icon: "copy", id: "nt-copy-json", onClick: function () { G.copy(json); } })),
      h("pre", { class: "np-pre np-pre-head mono" }, head),
      h("pre", { class: "np-pre mono", tabindex: "0", "aria-label": "Webhook JSON payload" }, json));
  }
  function preview(r, p, channel, target, inst) {
    var s = sample(p, r);
    var ty = typeDef(channel);
    if (channel === "teams") return teamsCard(r, s, target, inst);
    if (channel === "email") return emailCard(r, s, target, inst);
    if (channel === "slack" || channel === "gchat" || channel === "discord") return slackCard(r, s, target, inst);
    if (channel !== "paging") return webhookCard(r, s, target, inst);
    if (channel === "paging") return h("div", { class: "np-frame np-page" },
      h("div", { class: "np-chanbar" }, h("span", { class: "mono" }, target || "schedule"), h("span", { class: "muted small" }, "On-call page · preview")),
      h("div", { class: "np-pagebody np-tone-" + tone(r) }, h("div", { class: "np-page-sev mono" }, ["kill", "block"].indexOf(tone(r)) >= 0 ? "SEV-2 · HIGH URGENCY" : "LOW URGENCY"),
        h("strong", null, s.head), h("p", null, s.body), fieldOn(r.fields, "link") ? h("p", { class: "mono small" }, s.link) : null,
        h("div", { class: "np-btns" }, h("span", { class: "np-act" }, "Acknowledge"), h("span", { class: "np-act" }, "Resolve"))),
      h("div", { class: "np-note small" }, G.icon("alert"), "Pages carry no field toggles beyond the link. Keep pages for halts, kills and security holds."));
  }

  /* ---------- routes ---------- */
  function routeRow(p, r, perm) {
    var sel = ui.sel === r.id;
    var cond = [];
    if (r.cond.classes.length) cond.push(r.cond.classes.map(function (c) { return (G.find.cls(c) || { name: c }).name; }).join("/"));
    if (r.cond.priority.length) cond.push(r.cond.priority.join("/"));
    if (r.cond.hours === "business") cond.push("business hours");
    var tr = h("tr", { class: "row-link" + (sel ? " is-selected" : "") + (r.enabled ? "" : " nt-off"), id: "nt-row-" + r.id },
      h("td", null, G.toggle("nt-en-" + r.id, r.enabled, function (v) { show(G.ops.saveRoute(p.id, r.id, { enabled: v }), r.id + (v ? " on." : " off.")); }, perm, "Route " + r.id + " enabled")),
      h("td", null, h("button", { type: "button", class: "linkish nt-ev", id: "nt-open-" + r.id, onClick: function () { select(r.id); } }, h("span", { class: "mono small" }, r.id), " ", evName(r.event))),
      h("td", null, h("ul", { class: "nt-dests" }, r.dest.map(function (d) {
        var inst = instOf(d, p), st = instState(inst);
        return h("li", null, G.icon(chan(d.channel).icon), h("span", { class: "nt-dest-inst small" }, inst ? inst.name : chan(d.channel).name), h("span", { class: "mono" }, d.target), st !== "healthy" ? h("span", { class: "nt-dest-bad", title: st }, "✕ " + st) : null);
      }))),
      h("td", null, tplInfo(r.template).name),
      h("td", { class: "small" }, cond.length ? cond.join(" · ") : h("span", { class: "muted" }, "always")));
    tr.addEventListener("click", function (e) { if (e.target.closest("button,input,.switch")) return; select(r.id); });
    return tr;
  }
  function select(id) { ui.sel = id; ui.draft = null; ui.draftKey = null; ui.preview = null; G.rerender(); }
  function newDraft(p) {
    var first = destInsts(p).filter(function (i) { return i.type === "slack" && i.connected; })[0] || destInsts(p)[0];
    return { id: null, event: "blocked", dest: first ? [{ channel: first.type, target: defaultTarget(first.type, p, first), integration: first.id }] : [], template: "incident", cond: { classes: [], priority: [], hours: "any" }, enabled: true,
      fields: { title: true, repo: true, "class": true, priority: true, approvers: true, link: true, actions: true } };
  }
  function ensureDraft(p) {
    var key = p.id + ":" + ui.sel;
    if (ui.draft && ui.draftKey === key) return ui.draft;
    var r = ui.sel === "new" ? newDraft(p) : p.notifications.find(function (x) { return x.id === ui.sel; });
    if (!r) { ui.sel = p.notifications[0] ? p.notifications[0].id : null; if (!ui.sel) return null; r = p.notifications[0]; key = p.id + ":" + ui.sel; }
    ui.draft = clone(r); ui.draftKey = key;
    ui.draft.fields = Object.assign({ title: true, repo: true, "class": true, priority: true, approvers: true, link: true, actions: true }, ui.draft.fields || {});
    return ui.draft;
  }
  function isDirty(p, d) {
    if (!d.id) return true;
    var r = p.notifications.find(function (x) { return x.id === d.id; });
    if (!r) return true;
    var a = clone(r); a.fields = Object.assign({ title: true, repo: true, "class": true, priority: true, approvers: true, link: true, actions: true }, a.fields || {});
    return JSON.stringify(a) !== JSON.stringify(d);
  }
  function targetControl(d, i, ro, p) {
    var id = "nt-dest-t-" + i, inst = d.integration ? G.find.integration(d.integration) : instOf(d, p);
    function set(v) { d.target = v; }
    if (inst && inst.type === "webhook") {
      d.target = inst.targetId || inst.id;
      return h("input", { id: id, class: "input mono", value: d.target, readonly: true, "aria-label": "Webhook endpoint id", title: inst.config.url || "" });
    }
    if (d.channel === "paging") {
      var sch = G.integrationTargets(inst);
      if (sch.length) {
        if (sch.indexOf(d.target) < 0) d.target = sch[0];
        return G.select(id, sch, d.target, function (v) { set(v); G.rerender(); }, { disabled: ro, "aria-label": "On-call schedule" });
      }
    }
    var ty = typeDef(d.channel);
    return h("input", { id: id, class: "input mono", value: d.target, disabled: ro, "aria-label": (ty.targetLabel || "Target"), placeholder: d.channel === "slack" ? "#channel or @person" : d.channel === "email" ? "address or submitter" : ty.targetLabel || "Target",
      onInput: function (e) { set(e.target.value); }, onChange: function () { G.rerender(); } });
  }
  function instSelect(id, p, d, ro, onPick) {
    var list = destInsts(p), cur = d.integration ? G.find.integration(d.integration) : instOf(d, p);
    var opts = list.map(function (x) { var st = instState(x); return { value: x.id, label: x.name + (st === "healthy" ? "" : " (" + st + ")") }; });
    if (cur && !list.some(function (x) { return x.id === cur.id; })) opts.unshift({ value: cur.id, label: cur.name + " (not open to " + p.key + ")" });
    if (!cur) opts.unshift({ value: "", label: "Pick a connection" });
    return G.select(id, opts, cur ? cur.id : "", function (v) { var x = G.find.integration(v); if (x) onPick(x); }, { disabled: ro, "aria-label": "Connection" });
  }
  function editor(p, perm) {
    var d = ensureDraft(p);
    if (!d) return G.panel("Route", G.emptyState({ title: "No routes", text: "This project sends no notifications yet. Add a route to start." }));
    var ro = !perm.allowed;
    var err = h("div", { class: "form-err", role: "alert", id: "nt-err" });
    var dirty = isDirty(p, d);
    var classes = G.classesOf(p);
    var refuse = d.dest.map(function (x) { return instOf(x, p); }).filter(function (x) { return x && !accepts(x, d.event); });
    function toggleIn(arr, v, on) { var i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }
    var body = h("div", { class: "form-grid" },
      G.lockNote(perm, "Notification routes on " + p.name),
      h("div", { class: "form-row" },
        G.field("Event", G.select("nt-event", events(), d.event, function (v) { d.event = v; d.template = DEF_TPL[v] || d.template; G.rerender(); }, { disabled: ro })),
        G.field("Card template", G.select("nt-template", tplOptions(d.template), d.template, function (v) {
          d.template = v; var ti = tplInfo(v);
          if (ti.custom && ti.fields) FIELDS.forEach(function (f) { d.fields[f[0]] = ti.fields.indexOf(f[0]) >= 0; });
          G.rerender();
        }, { disabled: ro }), tplInfo(d.template).custom ? "Custom template. Its fields are copied into the toggles below." : null)),
      refuse.length ? h("div", { class: "callout callout-warn", role: "note", id: "nt-refuse" }, G.icon("alert"), h("span", null, refuse.map(function (x) { return x.name; }).join(", ") + " only accept" + (refuse.length === 1 ? "s " : " ") + (typeDef(refuse[0].type).events || []).filter(function (e) { return (G.INTEGRATION_EVENTS_ALL || []).indexOf(e) >= 0; }).map(evName).join(", ").toLowerCase() + ". Deliveries of this event will be refused by the receiver.")) : null,
      h("fieldset", { class: "nt-fs" }, h("legend", { class: "field-label" }, "Destinations"),
        destInsts(p).length ? null : h("p", { class: "muted small" }, "No connection with notify capability is open to " + p.name + ". ", h("a", { href: "#integrations", class: "linkish", id: "nt-to-int" }, "Add one in Integrations"), "."),
        h("ul", { class: "nt-destlist" }, d.dest.map(function (x, i) {
          var inst = x.integration ? G.find.integration(x.integration) : instOf(x, p), st = instState(inst);
          return h("li", { class: "nt-destrow" },
            instSelect("nt-dest-c-" + i, p, x, ro, function (ni) { var keep = ni.type === x.channel && ni.type !== "webhook"; x.integration = ni.id; x.channel = ni.type; if (!keep) x.target = defaultTarget(ni.type, p, ni); G.rerender(); }),
            targetControl(x, i, ro, p),
            st === "healthy" ? null : h("span", { class: "chip chip-warn", title: inst ? inst.name + " is " + st : "No connection" }, G.icon("plug"), st),
            G.btn("Send test", { small: true, icon: "send", id: "nt-test-" + i, guard: !d.id ? { allowed: false, reason: "Save the route before sending a test." } : perm, onClick: function () {
              var e = targetError(x, p); if (e) { G.toast(e, "error"); return; }
              show(sendTestInst(p, { channel: x.channel, target: x.target.trim(), integration: x.integration || (inst && inst.id) }, d.event));
            } }),
            G.btn("", { small: true, kind: "ghost", icon: "x", aria: "Remove destination " + (i + 1), id: "nt-dest-rm-" + i, guard: ro ? perm : d.dest.length < 2 ? { allowed: false, reason: "A route needs at least one destination." } : null, onClick: function () { d.dest.splice(i, 1); G.rerender(); } }));
        })),
        G.btn("Add destination", { small: true, icon: "plus", id: "nt-dest-add", guard: !perm.allowed ? perm : destInsts(p).length ? null : { allowed: false, reason: "No connection is open to " + p.name + "." }, onClick: function () {
          var used = d.dest.map(function (x) { return x.integration; });
          var ni = destInsts(p).filter(function (x) { return used.indexOf(x.id) < 0 && x.type === "email"; })[0] || destInsts(p).filter(function (x) { return used.indexOf(x.id) < 0; })[0] || destInsts(p)[0];
          d.dest.push({ channel: ni.type, target: ni.type === "email" ? "approvers" : defaultTarget(ni.type, p, ni), integration: ni.id }); G.rerender();
        } })),
      h("fieldset", { class: "nt-fs" }, h("legend", { class: "field-label" }, "Conditions (empty means every)"),
        h("div", { class: "nt-sub" }, "Class"),
        h("div", { class: "check-grid nt-checks" }, classes.map(function (c) {
          var cb = h("input", { type: "checkbox", id: "nt-cls-" + c.id, checked: d.cond.classes.indexOf(c.id) >= 0, disabled: ro, onChange: function (e) { toggleIn(d.cond.classes, c.id, e.target.checked); G.rerender(); } });
          return h("label", { class: "check", for: "nt-cls-" + c.id }, cb, G.classChip(c.id, { small: true }));
        })),
        h("div", { class: "nt-cond2" },
          h("div", null, h("div", { class: "nt-sub" }, "Priority"), h("div", { class: "nt-inline" }, ["P1", "P2", "P3"].map(function (pr) {
            var cb = h("input", { type: "checkbox", id: "nt-prio-" + pr, checked: d.cond.priority.indexOf(pr) >= 0, disabled: ro, onChange: function (e) { toggleIn(d.cond.priority, pr, e.target.checked); G.rerender(); } });
            return h("label", { class: "check", for: "nt-prio-" + pr }, cb, h("span", { class: "mono" }, pr));
          }))),
          G.field("Hours", G.select("nt-hours", [{ value: "any", label: "Any time" }, { value: "business", label: "Business hours, 09:00 to 19:00 IST" }], d.cond.hours, function (v) { d.cond.hours = v; G.rerender(); }, { disabled: ro })))),
      err,
      h("div", { class: "form-actions nt-actions" },
        d.id ? G.btn("Delete route", { kind: "ghost", id: "nt-del", guard: perm, onClick: function () {
          G.dialog({ title: "Delete route " + d.id + "?", kicker: p.name, body: h("p", null, evName(d.event) + " events will no longer go to " + d.dest.map(function (x) { return x.target; }).join(", ") + "."),
            actions: [{ label: "Cancel" }, { label: "Delete route", kind: "danger", id: "nt-del-go", guard: perm, onClick: function (close) { var r = show(G.ops.deleteRoute(p.id, d.id), "Route " + d.id + " deleted."); if (r.ok) { close(); select(null); } } }] });
        } }) : null,
        dirty && d.id ? G.btn("Revert", { id: "nt-revert", onClick: function () { ui.draft = null; G.rerender(); } }) : null,
        dirty && !d.id ? G.btn("Discard", { id: "nt-discard", onClick: function () { select(null); } }) : null,
        G.btn(d.id ? "Save route" : "Create route", { kind: "primary", id: "nt-save", guard: perm.allowed && !dirty ? { allowed: false, reason: "No changes to save." } : perm, onClick: function () {
          var e = draftError(d, p); if (e) { err.textContent = e; G.toast(e, "error"); return; }
          var payloadR = clone(d); delete payloadR.id;
          payloadR.dest = payloadR.dest.map(function (x) { var inst = x.integration ? G.find.integration(x.integration) : instOf(x, p); return { channel: inst ? inst.type : x.channel, target: x.target.trim(), integration: inst ? inst.id : undefined }; });
          var r = G.ops.saveRoute(p.id, d.id, payloadR);
          show(r);
          if (r.ok) { ui.sel = r.id; ui.draft = null; ui.draftKey = null; G.rerender(); }
        } })));
    return G.panel(h("span", null, d.id ? "Route " + d.id : "New route", dirty && d.id ? h("span", { class: "chip chip-warn nt-dirty" }, "unsaved") : null), body, { cls: "nt-editor" });
  }
  function designer(p, perm) {
    var d = ui.draft; if (!d) return null;
    var ro = !perm.allowed;
    var items = d.dest.map(function (x, i) { var inst = instOf(x, p); return { id: "d" + i, label: (inst ? inst.name : chan(x.channel).name), icon: chan(x.channel).icon, dest: x, inst: inst }; });
    items.push({ id: "json", label: "JSON payload", icon: "webhook", dest: null, inst: null });
    if (!ui.preview || !items.some(function (x) { return x.id === ui.preview; })) ui.preview = items[0].id;
    var pv = items.find(function (x) { return x.id === ui.preview; });
    var toggles = h("div", { class: "nt-fields" },
      h("div", { class: "nt-sub" }, "Fields on the card"),
      FIELDS.map(function (f) {
        return h("label", { class: "toggle-row", for: "nt-fld-" + f[0] }, h("span", null, f[1]),
          G.toggle("nt-fld-" + f[0], fieldOn(d.fields, f[0]), function (v) { d.fields[f[0]] = v; G.rerender(); }, ro ? perm : null));
      }),
      h("p", { class: "footnote" }, "Toggles change the draft. Save the route to keep them."),
      G.btn("Send test to all destinations", { icon: "send", id: "nt-test-all", guard: !d.id ? { allowed: false, reason: "Save the route before sending a test." } : perm, onClick: function () {
        var okN = 0, bad = [];
        d.dest.forEach(function (x) { var r = sendTestInst(p, { channel: x.channel, target: x.target.trim(), integration: x.integration }, d.event); if (r.ok) okN++; else bad.push(x.target); });
        G.toast(okN + " test" + (okN === 1 ? "" : "s") + " delivered" + (bad.length ? ", failed: " + bad.join(", ") : "") + ". See the delivery log.", bad.length ? "warn" : "ok");
      } }));
    var seg = G.segmented("nt-pv", items.map(function (x) { return { id: x.id, label: x.label, icon: x.icon }; }), ui.preview, function (v) { ui.preview = v; G.rerender(); }, "Preview destination");
    return G.panel("Card designer", h("div", { class: "nt-designer" }, toggles,
      h("div", { class: "nt-preview" }, seg, h("div", { class: "nt-stage", "data-keep-scroll": "nt-stage" }, pv.dest ? preview(d, p, pv.dest.channel, pv.dest.target, pv.inst) : webhookCard(d, sample(p, d), "payload", null)),
        h("p", { class: "footnote" }, "Preview uses live sample data from " + p.name + ". Cards are drawn by Gantry; delivery is simulated."))), { cls: "nt-designer-panel" });
  }
  function routesTab(p, perm) {
    var list = p.notifications;
    if (ui.sel !== "new" && !list.some(function (r) { return r.id === ui.sel; })) { ui.sel = list[0] ? list[0].id : null; ui.draft = null; }
    return h("div", { class: "nt-routes" },
      h("div", { class: "nt-split" },
        G.panel("Routes on " + p.name, h("div", { class: "table-scroll" }, h("table", { class: "table table-compact nt-table" },
          h("thead", null, h("tr", null, h("th", null, "On"), h("th", null, "Event"), h("th", null, "Destinations"), h("th", null, "Card"), h("th", null, "Conditions"))),
          h("tbody", null, list.length ? list.map(function (r) { return routeRow(p, r, perm); }) : h("tr", null, h("td", { colspan: "5", class: "muted" }, "No routes yet."))))),
          { flush: true, tools: G.btn("Add route", { small: true, icon: "plus", kind: "primary", id: "nt-add", guard: perm, onClick: function () { select("new"); } }) }),
        editor(p, perm)),
      designer(p, perm));
  }

  /* ---------- repo overrides ---------- */
  function overridesTab(p) {
    var repos = S("repos").filter(function (r) { return r.project === p.id; });
    var o = ui.ov;
    if (!repos.some(function (r) { return r.id === o.repo; })) o.repo = repos[0] ? repos[0].id : "";
    if (!destInsts(p).some(function (x) { return x.id === o.integration; })) o.integration = (destInsts(p).find(function (x) { return x.type === "slack"; }) || destInsts(p)[0] || {}).id || "";
    var perm = G.me("onboarding.manage", { project: p.id }), ro = !perm.allowed;
    var rows = [];
    repos.forEach(function (r) { (r.notifyOverrides || []).forEach(function (x, i) { rows.push({ repo: r, o: x, i: i }); }); });
    var tIn = h("input", { id: "nt-ov-target", class: "input mono", value: o.target, disabled: ro, placeholder: "#payments-api", onInput: function (e) { o.target = e.target.value; } });
    return h("div", { class: "form-grid" },
      h("p", { class: "muted" }, "A repo can add a destination to a project route (also) or replace the route's destinations for that repo (instead). Project routes still decide which events and conditions apply."),
      G.panel("Overrides on " + p.name + " repos", h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
        h("thead", null, h("tr", null, h("th", null, "Repo"), h("th", null, "Event"), h("th", null, "Mode"), h("th", null, "Destination"), h("th", null, h("span", { class: "sr" }, "Actions")))),
        h("tbody", null, rows.length ? rows.map(function (x) {
          return h("tr", null, h("td", { class: "mono" }, x.repo.name), h("td", null, evName(x.o.event)), h("td", null, h("span", { class: "chip" + (x.o.mode === "instead" ? " chip-warn" : "") }, x.o.mode === "instead" ? "instead of route" : "also")),
            h("td", null, (x.o.dest || []).map(function (dd) { var ii = instOf(dd, p); return h("span", { class: "nt-ov-dest" }, G.icon(chan(dd.channel).icon), " ", h("span", { class: "small" }, ii ? ii.name + " " : ""), h("span", { class: "mono" }, dd.target)); })),
            h("td", { class: "num" }, G.btn("Remove", { small: true, kind: "ghost", id: "nt-ov-rm-" + x.repo.id + "-" + x.i, guard: perm, onClick: function () {
              var list = x.repo.notifyOverrides.filter(function (_, j) { return j !== x.i; });
              show(G.ops.configureRepo(x.repo.id, { notifyOverrides: list }), "Override removed from " + x.repo.name + ".");
            } })));
        }) : h("tr", null, h("td", { colspan: "5", class: "muted" }, "No repo overrides. Every repo follows the project routes."))))), { flush: true }),
      G.panel("Add an override", h("div", { class: "form-grid" }, G.lockNote(perm, "Repo overrides"),
        h("div", { class: "form-row" },
          G.field("Repo", G.select("nt-ov-repo", repos.map(function (r) { return { value: r.id, label: r.name }; }), o.repo, function (v) { o.repo = v; }, { disabled: ro })),
          G.field("Event", G.select("nt-ov-event", events(), o.event, function (v) { o.event = v; }, { disabled: ro })),
          G.field("Mode", G.select("nt-ov-mode", [{ value: "also", label: "Also send here" }, { value: "instead", label: "Send here instead" }], o.mode, function (v) { o.mode = v; }, { disabled: ro })),
          G.field("Connection", G.select("nt-ov-channel", destInsts(p).map(function (x) { return { value: x.id, label: x.name + (instState(x) === "healthy" ? "" : " (" + instState(x) + ")") }; }), o.integration, function (v) { o.integration = v; var x = G.find.integration(v); if (x && x.type === "webhook") o.target = x.targetId || x.id; G.rerender(); }, { disabled: ro })),
          G.field("Target", tIn)),
        h("div", { class: "form-actions" }, G.btn("Add override", { kind: "primary", icon: "plus", id: "nt-ov-add", guard: perm, onClick: function () {
          var repo = G.find.repo(o.repo); if (!repo) { G.toast("Pick a repo.", "error"); return; }
          var oi = G.find.integration(o.integration);
          var e = oi ? targetError({ channel: oi.type, target: o.target, integration: oi.id }, p) : "Pick a connection."; if (e) { G.toast(e, "error"); return; }
          var ovId = "RO-" + ((repo.notifyOverrides || []).reduce(function (m, x) { return Math.max(m, +String(x.id || "RO-0").slice(3) || 0); }, 0) + 1);
          var list = (repo.notifyOverrides || []).concat([{ id: ovId, event: o.event, dest: [{ channel: oi.type, target: o.target.trim(), integration: oi.id }], template: DEF_TPL[o.event] || "submitted", mode: o.mode }]);
          var r = show(G.ops.configureRepo(repo.id, { notifyOverrides: list }), "Override added to " + repo.name + ".");
          if (r.ok) o.target = "";
        } })))));
  }

  /* ---------- delivery log ---------- */
  function deliveriesTab(p) {
    var f = ui.dl;
    var all = S("deliveries").filter(function (d) { return d.project === p.id; });
    var list = all.filter(function (d) { return (f.status === "all" || d.status === f.status) && (f.integration === "all" || (d.integration || ((instOf(d, p) || {}).id)) === f.integration) && (f.event === "all" || d.event === f.event); }).slice().reverse();
    var failed = all.filter(function (d) { return d.status === "failed"; }).length;
    var perm = G.me("notify.edit", { project: p.id });
    return h("div", { class: "form-grid" },
      h("div", { class: "toolbar" },
        h("div", { class: "filters" },
          G.field("Status", G.select("nt-dl-status", [{ value: "all", label: "All" }, { value: "delivered", label: "Delivered" }, { value: "failed", label: "Failed" }], f.status, function (v) { f.status = v; G.rerender(); })),
          G.field("Connection", G.select("nt-dl-channel", [{ value: "all", label: "All" }].concat(destInsts(p).map(function (c) { return { value: c.id, label: c.name }; })), f.integration, function (v) { f.integration = v; G.rerender(); })),
          G.field("Event", G.select("nt-dl-event", [{ value: "all", label: "All" }].concat(events()), f.event, function (v) { f.event = v; G.rerender(); }))),
        h("div", { class: "kv-row" }, h("div", null, h("div", { class: "kv-k" }, "Shown"), h("div", { class: "kv-v mono" }, String(list.length))), h("div", null, h("div", { class: "kv-k" }, "Failed"), h("div", { class: "kv-v mono" + (failed ? " neg" : "") }, String(failed))))),
      G.panel(null, h("div", { class: "table-scroll", "data-keep-scroll": "nt-dl" }, h("table", { class: "table table-compact nt-dl" },
        h("thead", null, h("tr", null, h("th", null, "Time (IST)"), h("th", null, "Id"), h("th", null, "Event"), h("th", null, "Connection"), h("th", null, "Target"), h("th", null, "Work order"), h("th", null, "Status"), h("th", { class: "num" }, "Tries"), h("th", null, "Error"), h("th", null, h("span", { class: "sr" }, "Retry")))),
        h("tbody", null, list.length ? list.slice(0, ui.dlLimit).map(function (d) {
          return h("tr", { id: "nt-dl-" + d.id },
            h("td", { class: "mono" }, G.fmt.istDate(d.at) + " " + G.fmt.ist(d.at)), h("td", { class: "mono" }, d.id, d.test ? h("span", { class: "tag nt-testtag" }, "test") : null),
            h("td", null, evName(d.event)), h("td", null, G.icon(chan(d.channel).icon), " ", (function () { var ii = d.integration ? G.find.integration(d.integration) : instOf(d, p); return ii ? ii.name : chan(d.channel).name + (d.integration ? " (removed)" : ""); })()), h("td", { class: "mono" }, d.target),
            h("td", null, d.wo && G.find.wo(d.wo) ? h("button", { type: "button", class: "linkish mono", id: "nt-dl-wo-" + d.id, onClick: function () { G.openTraveler(d.wo); } }, d.wo) : h("span", { class: "muted" }, "–")),
            h("td", null, h("span", { class: "outcome o-" + (d.status === "failed" ? "failed" : "ok") }, d.status === "failed" ? "✕ failed" : "✓ delivered")),
            h("td", { class: "num mono" }, String(d.attempts)), h("td", { class: "small nt-err" }, d.error || ""),
            h("td", { class: "num" }, d.status === "failed" ? G.btn("Retry", { small: true, icon: "refresh", id: "nt-retry-" + d.id, guard: perm, onClick: function () { show(retry(d)); } }) : null));
        }) : h("tr", null, h("td", { colspan: "10", class: "muted" }, "No deliveries match these filters."))))), { flush: true }),
      list.length > ui.dlLimit ? h("div", { class: "more" }, G.btn("Show 40 more", { id: "nt-dl-more", onClick: function () { ui.dlLimit += 40; G.rerender(); } })) : null,
      G.lockNote(perm, "Retries on " + p.name));
  }

  /* ---------- card templates ---------- */
  function ctDraft(t) {
    return { id: t.custom ? t.id : null, name: t.custom ? t.name : "", kind: t.kind, fields: t.fields ? t.fields.slice() : FIELDS.map(function (f) { return f[0]; }), actions: t.actions.slice(), integration: t.integration || "" };
  }
  function templatesTab(p, perm) {
    var ro = !perm.allowed, c = ui.ct;
    var rows = Object.keys(TPL).map(function (k) { return tplInfo(k); }).concat(customTpls().map(function (t) { return tplInfo(t.id); }));
    if (!c.draft) { var first = rows.find(function (x) { return x.id === c.sel; }) || customTpls().map(function (t) { return tplInfo(t.id); })[0] || rows[0]; c.sel = first.id; c.draft = ctDraft(first); if (!first.custom) { c.draft.name = first.name + " (copy)"; } }
    var d = c.draft, selInfo = tplInfo(c.sel);
    function pick(t) { c.sel = t.id; c.draft = ctDraft(t); if (!t.custom) c.draft.name = t.name + " (copy)"; G.rerender(); }
    function save(rec, msg) { var r = G.ops.saveCardTemplate(Object.assign({ project: p.id }, rec)); show(r, msg); return r; }
    var table = G.dataTable({ id: "nt-ct-table", caption: "Card templates", rows: rows, rowKey: function (t) { return t.id; }, onRow: pick,
      columns: [
        { key: "name", label: "Template", render: function (t) { return h("button", { type: "button", class: "linkish nt-ev" + (t.id === c.sel ? " is-sel" : ""), id: "nt-ct-open-" + t.id, "aria-pressed": t.id === c.sel ? "true" : "false", onClick: function () { pick(t); } }, t.name); } },
        { key: "kind", label: "For", render: function (t) { return t.custom ? TPL[t.kind].name : h("span", { class: "muted" }, "built in"); } },
        { key: "actions", label: "Buttons", hideSmall: true, render: function (t) { return h("span", { class: "small" }, t.actions.map(function (a) { return ACTION_LABEL[a]; }).join(", ") || "none"); } },
        { key: "used", label: "Routes, all projects", align: "end", render: function (t) { return h("span", { class: "mono" }, String(routesUsingTpl(t.id).length)); } },
        { key: "ops", label: "", align: "end", render: function (t) {
          return h("span", { class: "nt-ct-ops" },
            G.btn("Duplicate", { small: true, id: "nt-ct-dup-" + t.id, guard: perm, onClick: function () { var r = save({ name: t.name.replace(/ \(copy\)$/, "") + " (copy)", kind: t.kind, fields: t.fields ? t.fields.slice() : FIELDS.map(function (f) { return f[0]; }), actions: t.actions.slice(), integration: t.integration || undefined }, "Duplicated as " + t.name + " (copy)."); if (r.ok) { c.sel = r.template.id; c.draft = null; G.rerender(); } } }),
            t.custom ? G.btn("Delete", { small: true, kind: "ghost", id: "nt-ct-del-" + t.id, guard: !perm.allowed ? perm : routesUsingTpl(t.id).length ? { allowed: false, reason: "Used by " + routesUsingTpl(t.id).join(", ") + ". Pick another card on those routes first." } : null, onClick: function () {
              G.dialog({ title: "Delete " + t.name + "?", kicker: "Card templates", body: h("p", null, "No route uses it. It stays in the audit ledger."), actions: [{ label: "Cancel" }, { label: "Delete template", kind: "danger", id: "nt-ct-del-go", guard: perm, onClick: function (close) {
                var r = show(G.ops.removeCardTemplate(t.id), t.name + " deleted."); if (r.ok) { close(); c.sel = null; c.draft = null; G.rerender(); }
              } }] });
            } }) : null);
        } }
      ] });
    var conns = destInsts(p);
    var fake = { id: null, event: KIND_EVENT[d.kind] || "submitted", template: d.kind, fields: {}, dest: [], cond: { classes: [], priority: [], hours: "any" } };
    FIELDS.forEach(function (f) { fake.fields[f[0]] = d.fields.indexOf(f[0]) >= 0; });
    fake.__tpl = { actions: d.actions.slice() };
    var pvInst = (d.integration && G.find.integration(d.integration)) || conns.find(function (x) { return x.type === "slack"; }) || conns[0] || null;
    var editing = selInfo.custom;
    var ed = G.panel(editing ? "Edit " + selInfo.name : "New template from " + selInfo.name, h("div", { class: "form-grid" },
      G.lockNote(perm, "Card templates"),
      h("div", { class: "form-row" },
        G.field("Name", h("input", { id: "nt-ct-name", class: "input", value: d.name, disabled: ro, onInput: function (e) { d.name = e.target.value; } })),
        G.field("Card for", G.select("nt-ct-kind", Object.keys(TPL).map(function (k) { return { value: k, label: TPL[k].name }; }), d.kind, function (v) { d.kind = v; d.actions = d.actions.filter(function () { return true; }); G.rerender(); }, { disabled: ro })),
        G.field("Only on", G.select("nt-ct-int", [{ value: "", label: "Any connection" }].concat(conns.map(function (x) { return { value: x.id, label: x.name }; })), d.integration, function (v) { d.integration = v; G.rerender(); }, { disabled: ro }), "Optional. The preview uses this connection.")),
      h("fieldset", { class: "nt-fs" }, h("legend", { class: "field-label" }, "Fields"),
        h("div", { class: "check-grid" }, FIELDS.map(function (f) {
          var cb = h("input", { type: "checkbox", id: "nt-ct-f-" + f[0], checked: d.fields.indexOf(f[0]) >= 0, disabled: ro, onChange: function (e) { var k = d.fields.indexOf(f[0]); if (e.target.checked && k < 0) d.fields.push(f[0]); if (!e.target.checked && k >= 0) d.fields.splice(k, 1); G.rerender(); } });
          return h("label", { class: "check", for: cb.id }, cb, f[1]);
        }))),
      h("fieldset", { class: "nt-fs" }, h("legend", { class: "field-label" }, "Buttons"),
        h("div", { class: "check-grid" }, Object.keys(ACTION_LABEL).map(function (a) {
          var cb = h("input", { type: "checkbox", id: "nt-ct-a-" + a, checked: d.actions.indexOf(a) >= 0, disabled: ro, onChange: function (e) { var k = d.actions.indexOf(a); if (e.target.checked && k < 0) d.actions.push(a); if (!e.target.checked && k >= 0) d.actions.splice(k, 1); G.rerender(); } });
          return h("label", { class: "check", for: cb.id }, cb, ACTION_LABEL[a]);
        }))),
      h("div", { class: "form-actions" },
        G.btn(editing ? "Revert" : "Reset", { id: "nt-ct-revert", onClick: function () { c.draft = null; G.rerender(); } }),
        G.btn(editing ? "Save template" : "Create template", { kind: "primary", id: "nt-ct-save", guard: perm, onClick: function () {
          if (!d.name.trim()) { G.toast("Name the card.", "error"); return; }
          var rec = { name: d.name.trim(), kind: d.kind, fields: d.fields.slice(), actions: d.actions.slice(), integration: d.integration || undefined };
          if (editing) rec.id = selInfo.id;
          var r = save(rec);
          if (r.ok) { c.sel = r.template.id; c.draft = null; G.rerender(); }
        } }))), { cls: "nt-ct-editor" });
    var pv = G.panel("Preview", h("div", { class: "nt-stage" }, pvInst ? preview(fake, p, pvInst.type, defaultTarget(pvInst.type, p, pvInst) || "target", pvInst) : webhookCard(fake, sample(p, fake), "payload", null)), { cls: "nt-ct-preview" });
    return h("div", { class: "form-grid" },
      h("p", { class: "muted" }, "Built-in cards cover each kind of event. Make your own to change which fields and buttons appear; pick one per route in the route editor."),
      h("div", { class: "nt-split" }, G.panel("Templates", table, { flush: true }), ed), pv);
  }

  function render() {
    var p = project();
    if (!p) return h("div", { class: "view cx nt-view" }, G.viewHead({ kicker: "Connect · Notifications", title: "Notifications" }), G.emptyState({ title: "No projects", text: "You have no projects to configure." }));
    var perm = G.me("notify.edit", { project: p.id });
    var vis = G.visibleProjects(G.viewerId());
    var failed = S("deliveries").filter(function (d) { return d.project === p.id && d.status === "failed"; }).length;
    var ovN = S("repos").filter(function (r) { return r.project === p.id; }).reduce(function (n, r) { return n + (r.notifyOverrides || []).length; }, 0);
    var tab = ui.tab === "overrides" ? overridesTab(p) : ui.tab === "log" ? deliveriesTab(p) : ui.tab === "templates" ? templatesTab(p, perm) : routesTab(p, perm);
    return h("div", { class: "view cx nt-view" },
      G.pageHeader({ id: "nt-head", kicker: "Connect · Notifications", title: "Notifications", sub: "Which events reach which people, through which connection, with which card. Per project, with repo overrides. Delivery is simulated.",
        meta: [["Project", p.name], ["Routes", p.notifications.filter(function (r) { return r.enabled; }).length + " on / " + p.notifications.length], ["Connections", String(destInsts(p).length)], ["Failed deliveries", String(failed)], ["Edit rights", perm.allowed ? "yes" : "read-only"]],
        actions: vis.length > 1 ? [h("span", { class: "muted small" }, "Switch project in the top bar to edit another project's routes.")] : null }),
      G.tabBar({ id: "nt-tab", items: [{ id: "routes", label: "Routes", count: p.notifications.length }, { id: "templates", label: "Card templates", count: Object.keys(TPL).length + customTpls().length }, { id: "overrides", label: "Repo overrides", count: ovN }, { id: "log", label: "Delivery log", count: failed ? failed + " failed" : null }], active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      h("div", { id: "nt-tab-panel", role: "tabpanel", "aria-labelledby": "nt-tab-" + ui.tab }, tab));
  }

  G.views["notifications"] = { title: "Notifications", render: render, keys: ["projects", "deliveries", "integrations", "integrationInstances", "integrationTypes", "cardTemplates", "repos", "apiConfig", "trust", "learning"] };
})(window.G);
