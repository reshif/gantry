/* API & triggers (#api): API keys (service accounts) with show-once secret, endpoint reference
   with copyable samples, a playground that really submits through G.ops.apiSubmit, request log,
   rate-limit / idempotency settings, and triggers (issue with label, PR / MR comment command,
   schedule, failing CI on main) with "simulate incoming" and run history. A trigger's `source` is a
   connected source-control, issue-tracker, CI or custom source instance open to the project (or
   "schedule"); class pickers come from G.classesOf(project). The API is simulated:
   nothing leaves the page. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var BASE = "https://gantry.acme.dev";
  var ui = { tab: "keys", pg: { key: "", project: "", repo: "", title: "Retry failed payout webhooks with backoff", description: "Payout webhooks fail permanently after one 5xx. Retry with exponential backoff.", cls: "", priority: "P2", idem: "", last: null },
    log: { key: "all", status: "all" }, lim: null, tsel: null, tdraft: null, tkey: null, sim: {} };
  var KEY_ACTIONS = [["wo.submit", "Submit work orders"], ["wo.read", "Read work orders"], ["wo.answer", "Answer intake questions"], ["triggers.run", "Fire triggers"]];
  var TTYPES = { issue: { name: "Issue with label", icon: "tag" }, comment: { name: "PR / MR comment command", icon: "chat" }, schedule: { name: "Schedule", icon: "clock" }, ci: { name: "Failing CI on main", icon: "alert" } };
  /* which trigger kinds a source can drive */
  function kindsFor(srcId) {
    if (srcId === "schedule") return ["schedule"];
    var i = G.find.integration(srcId), t = i && G.find.integrationType(i.type);
    if (!t) return ["issue"];
    if (t.category === "source") return ["issue", "comment", "ci"];
    if (t.category === "ci") return ["ci"];
    return ["issue"];
  }
  function srcInsts(pid) { return G.integrationsFor(pid).filter(function (i) { var t = G.find.integrationType(i.type); return t && t.source; }); }
  function srcName(src) { if (src === "schedule") return "Schedule"; var i = G.find.integration(src); return i ? i.name : src ? src + " (removed)" : "No source"; }
  function srcState(src) { if (src === "schedule") return "healthy"; var i = G.find.integration(src); return !i ? "missing" : !i.connected ? "disabled" : i.status; }
  function srcOptions(pid, cur, kind) {
    var list = srcInsts(pid).filter(function (i) { return !kind || kindsFor(i.id).indexOf(kind) >= 0; }).map(function (i) { return { value: i.id, label: i.name + (srcState(i.id) === "healthy" ? "" : " (" + srcState(i.id) + ")") }; });
    if (!kind || kind === "schedule") list.push({ value: "schedule", label: "Schedule (no external source)" });
    if (cur && !list.some(function (o) { return o.value === cur; })) list.unshift({ value: cur, label: srcName(cur) + " (not open to this project)" });
    return list;
  }
  function clsOptionsFor(pid) { var p = G.find.project(pid); return (p ? G.classesOf(p) : G.CLASSES).map(function (c) { return { value: c.id, label: c.name }; }); }
  var WHO = [{ value: "org", label: "Org members only" }, { value: "anyone", label: "Anyone with repo access" }, { value: "system", label: "System (no author)" }];

  function S(k) { return G.store.get(k); }
  function show(r, okMsg) { G.toast(r.ok ? (okMsg || r.msg) : r.msg, r.ok ? "ok" : "error"); return r; }
  function vis() { return G.visibleProjects(G.viewerId()); }
  function visIds() { return vis().map(function (p) { return p.id; }); }
  function pname(id) { var p = G.find.project(id); return p ? p.name : id; }
  function keyOf(id) { return S("apiKeys").find(function (k) { return k.id === id; }); }
  function statusChip(code) {
    var c = code >= 500 ? "failed" : code >= 400 ? (code === 429 ? "warn" : "denied") : "ok";
    return h("span", { class: "outcome o-" + c + " mono" }, (c === "ok" ? "✓ " : c === "warn" ? "◆ " : "✕ ") + code);
  }
  function codeBlock(id, text, label) {
    return h("div", { class: "api-code" },
      h("div", { class: "api-code-bar" }, h("span", { class: "kv-k" }, label || "Sample"), G.btn("Copy", { small: true, icon: "copy", id: id, onClick: function () { G.copy(text); } })),
      h("pre", { class: "mono", tabindex: "0", "aria-label": label || "Code sample" }, text));
  }

  /* ---------- keys ---------- */
  function createKeyDialog() {
    var ps = vis();
    var st = { name: "", project: (G.currentProject() && visIds().indexOf(G.currentProject().id) >= 0) ? G.currentProject().id : (ps[0] && ps[0].id), actions: ["wo.submit", "wo.read"] };
    var err = h("div", { class: "form-err", role: "alert" });
    var name = h("input", { id: "api-key-name", class: "input", placeholder: "ServiceNow bridge", onInput: function (e) { st.name = e.target.value; } });
    var lock = h("div");
    function relock() { G.clear(lock); G.append(lock, G.lockNote(G.me("api.keys", { project: st.project }), "API keys on " + pname(st.project))); }
    relock();
    var body = h("div", { class: "form-grid" }, lock,
      G.field("Name", name, "Name the system that will hold the key. It shows in the request log and audit."),
      G.field("Project", G.select("api-key-project", ps.map(function (p) { return { value: p.id, label: p.name }; }), st.project, function (v) { st.project = v; relock(); }), "A key works on one project only."),
      h("fieldset", { class: "api-fs" }, h("legend", { class: "field-label" }, "Scope"), h("div", { class: "check-grid" }, KEY_ACTIONS.map(function (a) {
        var cb = h("input", { type: "checkbox", id: "api-key-act-" + a[0].replace(".", "-"), checked: st.actions.indexOf(a[0]) >= 0, onChange: function (e) { var i = st.actions.indexOf(a[0]); if (e.target.checked && i < 0) st.actions.push(a[0]); if (!e.target.checked && i >= 0) st.actions.splice(i, 1); } });
        return h("label", { class: "check", for: cb.id }, cb, h("span", null, a[1], " ", h("span", { class: "mono small muted" }, a[0])));
      }))), err);
    G.dialog({ title: "Create an API key", kicker: "API & triggers", sub: "Each key is a service account on one project. Work it submits is recorded against the key and the person who created it.", body: body,
      actions: [{ label: "Cancel" }, { label: "Create key", kind: "primary", submit: true, id: "api-key-go", onClick: function (close) {
        if (!st.name.trim()) { err.textContent = "Name the key."; return; }
        if (!st.actions.length) { err.textContent = "Pick at least one scope."; return; }
        var r = G.ops.createKey({ name: st.name, project: st.project, actions: st.actions.slice() });
        if (!r.ok) { err.textContent = r.msg; return; }
        close(); secretDialog(r.key, r.secret); ui.pg.key = r.key.id; ui.pg.project = r.key.project;
      } }] });
  }
  function secretDialog(k, secret) {
    var stored = false;
    var done;
    var cb = h("input", { type: "checkbox", id: "api-secret-ack", onChange: function (e) { stored = e.target.checked; if (done) { done.setAttribute("aria-disabled", stored ? "false" : "true"); done.classList.toggle("is-locked", !stored); if (stored) done.removeAttribute("data-reason"); else done.setAttribute("data-reason", "Confirm you stored the key first."); } } });
    var d = G.dialog({ title: "Copy your new key now", kicker: k.name, sub: "This is the only time Gantry shows the full key. It is stored hashed; if you lose it, revoke it and create another.",
      body: h("div", { class: "form-grid" },
        h("div", { class: "api-secret" }, h("input", { id: "api-secret-value", class: "input mono", readonly: true, value: secret, "aria-label": "New API key", onFocus: function (e) { e.target.select(); } }),
          G.btn("Copy key", { kind: "primary", icon: "copy", id: "api-secret-copy", onClick: function () { G.copy(secret); } })),
        h("div", { class: "callout callout-warn" }, G.icon("key"), h("span", null, "Project ", h("strong", null, pname(k.project)), ". Scope: ", h("span", { class: "mono" }, k.actions.join(", ")), ". Prefix shown later: ", h("span", { class: "mono" }, k.prefix + "…"))),
        h("label", { class: "check", for: "api-secret-ack" }, cb, "I have stored this key somewhere safe")),
      actions: [{ label: "Done", kind: "primary", id: "api-secret-done", onClick: function (close) { if (!stored) { G.tip.show(done); return; } close(); } }] });
    done = d.footer.querySelector("#api-secret-done");
    done.setAttribute("aria-disabled", "true"); done.classList.add("is-locked"); done.setAttribute("data-reason", "Confirm you stored the key first.");
  }
  function keysTab() {
    var keys = S("apiKeys").filter(function (k) { return visIds().indexOf(k.project) >= 0; }).slice().sort(function (a, b) { return (a.revoked - b.revoked) || b.created - a.created; });
    return h("div", { class: "form-grid" },
      h("div", { class: "toolbar" }, h("p", { class: "muted" }, "Keys are service accounts scoped to one project and a set of actions. The full key is shown once at creation."),
        G.btn("Create key", { kind: "primary", icon: "plus", id: "api-key-new", guard: G.meAnyProject("api.keys"), onClick: createKeyDialog })),
      G.panel(null, h("div", { class: "table-scroll" }, h("table", { class: "table table-compact api-keys" },
        h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Key"), h("th", null, "Project"), h("th", null, "Scope"), h("th", null, "Created"), h("th", null, "Last used"), h("th", null, "Status"), h("th", null, h("span", { class: "sr" }, "Actions")))),
        h("tbody", null, keys.length ? keys.map(function (k) {
          var perm = G.me("api.keys", { project: k.project });
          return h("tr", { class: k.revoked ? "api-revoked" : "", id: "api-key-row-" + k.id },
            h("td", null, h("strong", null, k.name), h("div", { class: "small muted" }, "by " + G.actorName(k.by))),
            h("td", { class: "mono" }, k.prefix + "…"),
            h("td", null, pname(k.project)),
            h("td", null, k.actions.map(function (a) { return h("span", { class: "tag" }, a); })),
            h("td", { class: "mono small" }, G.fmt.istDate(k.created)),
            h("td", { class: "small" }, k.lastUsed ? G.fmt.ago(k.lastUsed) : "never"),
            h("td", null, k.revoked ? h("span", { class: "outcome o-denied" }, "⊘ revoked") : h("span", { class: "outcome o-ok" }, "✓ active")),
            h("td", { class: "num" }, k.revoked ? null : G.btn("Revoke", { small: true, kind: "ghost", id: "api-key-revoke-" + k.id, guard: perm, onClick: function () {
              var n = S("requestLog").filter(function (x) { return x.key === k.id && x.at > Date.now() - G.DAY; }).length;
              G.dialog({ title: "Revoke " + k.name + "?", kicker: "API key " + k.prefix + "…", body: h("p", null, "Requests with this key fail with 401 immediately. It made " + n + " request" + (n === 1 ? "" : "s") + " in the last 24 hours. This cannot be undone."),
                actions: [{ label: "Cancel" }, { label: "Revoke key", kind: "danger", id: "api-key-revoke-go", guard: perm, onClick: function (close) { var r = show(G.ops.revokeKey(k.id)); if (r.ok) close(); } }] });
            } })));
        }) : h("tr", null, h("td", { colspan: "8", class: "muted" }, "No keys on your projects."))))), { flush: true }));
  }

  /* ---------- endpoint reference ---------- */
  var ENDPOINTS = [
    { m: "POST", p: "/v1/projects/{project}/work-orders", d: "Submit a work order. Intake classifies it and opens the intake conversation over the API.", scope: "wo.submit",
      body: { repo: "payments-api", title: "Add idempotency keys to refund endpoint", description: "Keep behaviour backwards compatible.", "class": "feature", priority: "P2" },
      res: { id: "WO-2431", status: "intake", "class": "feature", class_confidence: 0.91, conversation: { state: "awaiting_answers", via: "api" } }, idem: true },
    { m: "GET", p: "/v1/work-orders/{id}", d: "Read a work order: station, state, gates, brief and links.", scope: "wo.read", res: { id: "WO-2431", station: "spec", state: "waiting", gate: "G2" } },
    { m: "GET", p: "/v1/work-orders/{id}/record", d: "The full work order record: request, clarification, agreed brief, station by station, files changed and commits, verification per acceptance criterion, merge and release, approvals with the trust level in force, after-release outcomes and the timeline. The evidence record for a release; add Accept: text/markdown for the same Markdown the record page copies.", scope: "wo.read",
      res: { id: "WO-2406", summary: "Bump Go toolchain to 1.25 ...", completeness: { done: 11, total: 11 }, request: { source: "slack", by: "p-tomas" }, criteria: [{ id: "AC-1", status: "met" }], files: [{ path: "internal/toolchain/toolchain.go", status: "modified", plus: 73, minus: 28, step: "P2", ac: ["AC-1"] }], pr: { number: 1836, state: "merged", tag: "v1.12.1" }, gates: { G5: { decision: { mode: "human", by: "p-priya", trust: 2 } } }, outcomes: [{ kind: "healthy" }] } },
    { m: "GET", p: "/v1/work-orders/{id}/conversation", d: "Read the intake conversation, including the next open question.", scope: "wo.read", res: { awaiting: "api", next_question: { id: "scope", text: "What is in scope?", chips: ["Only payments-api"] } } },
    { m: "POST", p: "/v1/work-orders/{id}/answers", d: "Answer the open intake question. The brief updates as answers arrive.", scope: "wo.answer", body: { question: "scope", text: "Only payments-api" }, res: { ok: true, next_question: "ac" } },
    { m: "POST", p: "/v1/triggers/{id}/fire", d: "Fire a trigger from your own system, with the same dedupe and author rules.", scope: "triggers.run", body: { title: "Nightly dependency updates" }, res: { outcome: "created", wo: "WO-2432" } }
  ];
  function curl(e) {
    var s = "curl -X " + e.m + " " + BASE + e.p.replace("{project}", "payments").replace("{id}", e.p.indexOf("triggers") >= 0 ? "TR-3" : "WO-2431") + " \\\n  -H \"Authorization: Bearer $GANTRY_KEY\"";
    if (e.body) s += " \\\n  -H \"Content-Type: application/json\"" + (e.idem ? " \\\n  -H \"Idempotency-Key: 6f1c-refund-42\"" : "") + " \\\n  -d '" + JSON.stringify(e.body, null, 2).replace(/\n/g, "\n  ") + "'";
    return s;
  }
  function refTab() {
    var cfg = S("apiConfig");
    return h("div", { class: "form-grid" },
      h("div", { class: "callout" }, G.icon("api"), h("span", null, "Base URL ", h("span", { class: "mono" }, BASE), ". Bearer keys from the Keys tab. Rate limit ", h("strong", { class: "mono" }, cfg.rateLimit + "/min"), " per key with a burst of ", h("span", { class: "mono" }, String(cfg.burst)), "; idempotency keys are remembered for ", h("span", { class: "mono" }, cfg.idempotencyHours + "h"), ". In this demo only the Playground calls the API, through local logic.")),
      ENDPOINTS.map(function (e, i) {
        return h("section", { class: "panel api-ep", "aria-label": e.m + " " + e.p },
          h("div", { class: "api-ep-head" }, h("span", { class: "api-m api-m-" + e.m.toLowerCase() }, e.m), h("span", { class: "mono api-path" }, e.p), h("span", { class: "tag" }, e.scope)),
          h("p", { class: "api-ep-d" }, e.d),
          h("div", { class: "api-ep-code" }, codeBlock("api-ref-copy-" + i, curl(e), "Request"), codeBlock("api-ref-res-" + i, JSON.stringify(e.res, null, 2), "Response")));
      }),
      G.panel("Verifying webhook signatures", codeBlock("api-ref-sig", "// Node.js\nconst mac = crypto.createHmac(\"sha256\", process.env.GANTRY_WEBHOOK_SECRET)\n  .update(rawBody).digest(\"hex\");\nconst ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(req.get(\"X-Gantry-Signature\").split(\"=\")[1]));", "Signature check (" + cfg.webhookSigning + ")")));
  }

  /* ---------- playground ---------- */
  function playTab() {
    var pg = ui.pg;
    var keys = S("apiKeys").filter(function (k) { return visIds().indexOf(k.project) >= 0; });
    if (!keyOf(pg.key) || keys.indexOf(keyOf(pg.key)) < 0) pg.key = (keys.find(function (k) { return !k.revoked; }) || keys[0] || {}).id || "";
    var k = keyOf(pg.key);
    if (!pg.project || visIds().indexOf(pg.project) < 0) pg.project = k ? k.project : (vis()[0] || {}).id;
    var repos = S("repos").filter(function (r) { return r.project === pg.project; });
    if (pg.cls && !clsOptionsFor(pg.project).some(function (c) { return c.value === pg.cls; })) pg.cls = "";
    if (!repos.some(function (r) { return r.id === pg.repo; })) pg.repo = (repos.find(function (r) { return r.onboarding.stage === "ready"; }) || repos[0] || {}).id || "";
    var perm = k ? G.me("api.keys", { project: k.project }) : { allowed: false, reason: "Create a key first." };
    var body = { repo: pg.repo, title: pg.title, description: pg.description };
    if (pg.cls) body["class"] = pg.cls;
    body.priority = pg.priority;
    if (pg.idem) body.idempotency_key = pg.idem;
    var req = "POST /v1/projects/" + pg.project + "/work-orders\nAuthorization: Bearer " + (k ? k.prefix + "…" : "(no key)") + "\nContent-Type: application/json" + (pg.idem ? "\nIdempotency-Key: " + pg.idem : "") + "\n\n" + JSON.stringify(body, null, 2);
    function inp(id, key, ph, mono) { return h("input", { id: id, class: "input" + (mono ? " mono" : ""), value: pg[key], placeholder: ph || "", onInput: function (e) { pg[key] = e.target.value; }, onChange: function () { G.rerender(); } }); }
    var last = pg.last;
    return h("div", { class: "api-play" },
      G.panel("Request", h("div", { class: "form-grid" },
        h("div", { class: "form-row" },
          G.field("API key", G.select("api-pg-key", keys.map(function (x) { return { value: x.id, label: x.name + " · " + x.prefix + "…" + (x.revoked ? " (revoked)" : "") }; }), pg.key, function (v) { pg.key = v; var kk = keyOf(v); if (kk) pg.project = kk.project; G.rerender(); })),
          G.field("Project in URL", G.select("api-pg-project", vis().map(function (p) { return { value: p.id, label: p.id }; }), pg.project, function (v) { pg.project = v; G.rerender(); }), "Try another project to see a 403.")),
        h("div", { class: "form-row" },
          G.field("repo", G.select("api-pg-repo", repos.map(function (r) { return { value: r.id, label: r.id + (r.onboarding.stage === "ready" ? "" : " (not ready)") }; }), pg.repo, function (v) { pg.repo = v; G.rerender(); })),
          G.field("class", G.select("api-pg-class", [{ value: "", label: "Let Intake decide" }].concat(clsOptionsFor(pg.project).map(function (c) { return { value: c.value, label: c.value }; })), pg.cls, function (v) { pg.cls = v; G.rerender(); })),
          G.field("priority", G.select("api-pg-prio", ["P1", "P2", "P3"], pg.priority, function (v) { pg.priority = v; G.rerender(); }))),
        G.field("title", inp("api-pg-title", "title")),
        G.field("description", h("textarea", { id: "api-pg-desc", class: "input", rows: "2", onInput: function (e) { pg.description = e.target.value; }, onChange: function () { G.rerender(); } }, pg.description)),
        h("div", { class: "api-idem" }, G.field("Idempotency-Key header", inp("api-pg-idem", "idem", "optional", true), "Send twice with the same key to get the original back."),
          G.btn("Generate", { small: true, id: "api-pg-idem-gen", onClick: function () { pg.idem = "pg-" + Date.now().toString(36); G.rerender(); } })),
        h("pre", { class: "api-pre mono", "aria-label": "Request preview" }, req),
        G.lockNote(perm, "Playground with this key"),
        h("div", { class: "form-actions" }, G.btn("Send request", { kind: "primary", icon: "send", id: "api-pg-send", guard: perm, onClick: function () {
          if (!pg.title.trim()) { G.toast("A title is required by the API.", "error"); return; }
          var r = G.ops.apiSubmit(pg.key, pg.project, JSON.parse(JSON.stringify(body)));
          pg.last = { at: Date.now(), status: r.status, ok: r.ok, msg: r.msg, response: r.response, wo: r.wo ? r.wo.id : (r.response && r.response.id) || null };
          G.toast(r.status + " " + r.msg, r.ok ? "ok" : "error");
          G.rerender();
        } })))),
      G.panel("Response", last ? h("div", { class: "form-grid", role: "status" },
        h("div", { class: "api-resline" }, statusChip(last.status), h("span", null, last.msg), h("span", { class: "muted small mono" }, G.fmt.ist(last.at) + " IST")),
        h("pre", { class: "api-pre mono", id: "api-pg-response" }, JSON.stringify(last.response, null, 2)),
        last.ok && last.wo && G.find.wo(last.wo) ? h("div", { class: "form-actions" }, G.btn("Open " + last.wo, { icon: "chevron", id: "api-pg-open", onClick: function () { G.openTraveler(last.wo); } })) : null)
        : G.emptyState({ title: "No request yet", text: "Send the request to see the response. It goes through the same intake as the web form." })));
  }

  /* ---------- request log ---------- */
  function logTab() {
    var f = ui.log, mine = visIds();
    var keys = S("apiKeys").filter(function (k) { return mine.indexOf(k.project) >= 0; });
    var ids = keys.map(function (k) { return k.id; });
    var list = S("requestLog").filter(function (x) { return ids.indexOf(x.key) >= 0 && (f.key === "all" || x.key === f.key) && (f.status === "all" || (f.status === "2xx" ? x.status < 300 : f.status === "429" ? x.status === 429 : x.status >= 400 && x.status !== 429)); }).slice().reverse();
    return h("div", { class: "form-grid" },
      h("div", { class: "filters" },
        G.field("Key", G.select("api-log-key", [{ value: "all", label: "All keys" }].concat(keys.map(function (k) { return { value: k.id, label: k.name }; })), f.key, function (v) { f.key = v; G.rerender(); })),
        G.field("Status", G.select("api-log-status", [{ value: "all", label: "All" }, { value: "2xx", label: "Success (2xx)" }, { value: "429", label: "Rate limited (429)" }, { value: "4xx", label: "Refused (4xx)" }], f.status, function (v) { f.status = v; G.rerender(); }))),
      G.panel(null, list.length ? h("div", { class: "table-scroll", "data-keep-scroll": "api-log" }, h("table", { class: "table table-compact api-log" },
        h("thead", null, h("tr", null, h("th", null, "Time (IST)"), h("th", null, "Key"), h("th", null, "Method"), h("th", null, "Path"), h("th", null, "Status"), h("th", { class: "num" }, "ms"))),
        h("tbody", null, list.slice(0, 80).map(function (x) {
          var k = keyOf(x.key);
          return h("tr", null, h("td", { class: "mono" }, G.fmt.istDate(x.at) + " " + G.fmt.ist(x.at)), h("td", null, k ? k.name : x.key), h("td", null, h("span", { class: "api-m api-m-" + x.method.toLowerCase() }, x.method)),
            h("td", { class: "mono" }, x.path), h("td", null, statusChip(x.status)), h("td", { class: "num mono" }, String(x.ms)));
        })))) : G.emptyState({ title: "No requests", text: "Nothing matches these filters." }), { flush: !!list.length }));
  }

  /* ---------- limits ---------- */
  function limitsTab() {
    var cfg = S("apiConfig"), perm = G.me("integration.edit"), ro = !perm.allowed;
    var d = ui.lim = ui.lim || { rateLimit: String(cfg.rateLimit), burst: String(cfg.burst), idempotencyHours: String(cfg.idempotencyHours), webhookSigning: cfg.webhookSigning };
    function num(id, key, label, hint) { return G.field(label, h("input", { id: id, class: "input mono", type: "number", min: "1", value: d[key], disabled: ro, onInput: function (e) { d[key] = e.target.value; } }), hint); }
    return G.panel("Rate limits and idempotency", h("div", { class: "form-grid api-lim" },
      G.lockNote(perm, "API settings"),
      h("div", { class: "form-row" },
        num("api-lim-rate", "rateLimit", "Requests per minute per key", "Over the limit returns 429 with Retry-After."),
        num("api-lim-burst", "burst", "Burst", "Extra requests allowed in a spike."),
        num("api-lim-idem", "idempotencyHours", "Idempotency window (hours)", "Same Idempotency-Key in this window returns the original work order.")),
      G.field("Webhook signing", G.select("api-lim-sign", [{ value: "HMAC-SHA256", label: "HMAC-SHA256" }, { value: "HMAC-SHA512", label: "HMAC-SHA512" }, { value: "Ed25519", label: "Ed25519" }], d.webhookSigning, function (v) { d.webhookSigning = v; }, { disabled: ro })),
      h("div", { class: "form-actions" }, G.btn("Save settings", { kind: "primary", id: "api-lim-save", guard: perm, onClick: function () {
        var rl = +d.rateLimit, b = +d.burst, ih = +d.idempotencyHours;
        if (!(rl >= 1 && rl <= 6000) || !(b >= 0 && b <= 1000) || !(ih >= 1 && ih <= 168) || [rl, b, ih].some(function (n) { return Math.floor(n) !== n; })) { G.toast("Use whole numbers: rate 1 to 6000, burst 0 to 1000, window 1 to 168 hours.", "error"); return; }
        var r = show(G.ops.setApiConfig({ rateLimit: rl, burst: b, idempotencyHours: ih, webhookSigning: d.webhookSigning }));
        if (r.ok) ui.lim = null;
      } }))));
  }

  /* ---------- triggers ---------- */
  function newTriggerDialog() {
    var ps = vis();
    var st = { project: (G.currentProject() && visIds().indexOf(G.currentProject().id) >= 0) ? G.currentProject().id : ps[0].id, type: "issue", name: "", source: "" };
    var err = h("div", { class: "form-err", role: "alert" });
    var box = h("div", { class: "form-grid" });
    function fix() {
      var opts = srcOptions(st.project, null, null);
      if (!opts.some(function (o) { return o.value === st.source; })) st.source = (opts[0] || {}).value || "";
      var kinds = kindsFor(st.source); if (kinds.indexOf(st.type) < 0) st.type = kinds[0];
    }
    function draw() {
      fix(); G.clear(box);
      var src = G.find.integration(st.source);
      G.append(box, [G.lockNote(G.me("triggers.edit", { project: st.project }), "Triggers on " + pname(st.project)),
        G.field("Project", G.select("api-tr-new-project", ps.map(function (p) { return { value: p.id, label: p.name }; }), st.project, function (v) { st.project = v; draw(); })),
        G.field("Source", G.select("api-tr-new-source", srcOptions(st.project, null, null), st.source, function (v) { st.source = v; draw(); }), "Connected source-control, issue-tracker, CI and custom source connections open to this project. Add more in Integrations."),
        G.field("Type", G.select("api-tr-new-type", kindsFor(st.source).map(function (k) { return { value: k, label: TTYPES[k].name }; }), st.type, function (v) { st.type = v; })),
        src && srcState(src.id) !== "healthy" ? h("div", { class: "callout callout-warn" }, G.icon("alert"), h("span", null, src.name + " is " + srcState(src.id) + ". The trigger saves, but events from it will not arrive until it is healthy.")) : null,
        G.field("Name", h("input", { id: "api-tr-new-name", class: "input", value: st.name, placeholder: "Issues labelled factory", onInput: function (e) { st.name = e.target.value; } })), err]);
    }
    draw();
    G.dialog({ title: "New trigger", kicker: "API & triggers", body: box,
      actions: [{ label: "Cancel" }, { label: "Create trigger", kind: "primary", submit: true, id: "api-tr-new-go", onClick: function (close) {
        if (!st.name.trim()) { err.textContent = "Name the trigger."; return; }
        if (!st.source) { err.textContent = "Pick a source. Connect one in Integrations first."; return; }
        var base = { project: st.project, type: st.type, name: st.name.trim(), enabled: false, source: st.source };
        if (st.type === "issue") Object.assign(base, { label: "factory", labelMap: { bug: "bug", enhancement: "feature" }, reply: "Thanks. Gantry opened {wo}." });
        if (st.type === "comment") Object.assign(base, { command: "/factory fix", reply: "On it: {wo}." });
        var pcl = clsOptionsFor(st.project).map(function (c) { return c.value; });
        if (st.type === "schedule") Object.assign(base, { schedule: "Mon 06:00 IST", cls: pcl.indexOf("chore") >= 0 ? "chore" : pcl[0], who: "system" });
        if (st.type === "ci") Object.assign(base, { cls: pcl.indexOf("hotfix") >= 0 ? "hotfix" : pcl[0], who: "system", reply: "Main is red. Proposed hotfix {wo} needs a person to confirm." });
        var r = G.ops.saveTrigger(null, base);
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg + " It starts disabled; review it, then turn it on.", "ok"); ui.tsel = r.trigger.id; ui.tdraft = null; close();
      } }] });
  }
  function simulateDialog(t) {
    var perm = G.me("triggers.edit", { project: t.project });
    var repos = S("repos").filter(function (r) { return r.project === t.project; });
    var st = { repo: (repos.find(function (r) { return r.onboarding.stage === "ready"; }) || repos[0] || {}).id, title: t.type === "issue" ? "Refund endpoint returns 500 for partial refunds" : t.type === "comment" ? "Fix flaky ledger reconciliation test" : t.type === "ci" ? "Main is red: fix failing ci/test" : "Weekly dependency updates",
      labels: t.type === "issue" ? t.label + ", bug" : "", author: "priya-acme", body: "", comment: (t.command || "/factory fix") + " the flaky reconciliation test" };
    var err = h("div", { class: "form-err", role: "alert" });
    function inp(id, k, mono) { return h("input", { id: id, class: "input" + (mono ? " mono" : ""), value: st[k], onInput: function (e) { st[k] = e.target.value; } }); }
    var fields = [];
    if (t.type !== "schedule") fields.push(G.field("Repo", G.select("api-sim-repo", repos.map(function (r) { return { value: r.id, label: r.name + (r.onboarding.stage === "ready" ? "" : " (not ready)") }; }), st.repo, function (v) { st.repo = v; })));
    fields.push(G.field(t.type === "comment" ? "Work order title" : t.type === "schedule" ? "Title of the scheduled work" : "Issue title", inp("api-sim-title", "title")));
    if (t.type === "issue") fields.push(G.field("Labels", inp("api-sim-labels", "labels", true), "Comma separated. The trigger fires on '" + t.label + "'; other labels map to a class."));
    if (t.type === "comment") fields.push(G.field("Comment", inp("api-sim-comment", "comment", true)));
    if (t.type === "issue" || t.type === "comment") fields.push(G.field("Author", inp("api-sim-author", "author", true), "Login or email on " + srcName(t.source) + ". Org members end in -acme or use an @acme.dev address."));
    G.dialog({ title: "Simulate: " + t.name, kicker: TTYPES[t.type].name + " · " + srcName(t.source), sub: "Sends a fake " + (t.type === "issue" ? "issue" : t.type === "comment" ? "PR comment" : t.type === "ci" ? "check failure on main" : "schedule tick") + " through the real trigger rules. Nothing is sent to " + srcName(t.source) + ".",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Triggers on " + pname(t.project)), fields, err),
      actions: [{ label: "Cancel" }, { label: "Simulate incoming", kind: "primary", submit: true, id: "api-sim-go", guard: perm, onClick: function (close) {
        if (t.type === "comment" && st.comment.trim().indexOf(t.command) !== 0) { err.textContent = "The comment must start with " + t.command + " or the trigger ignores it."; return; }
        var input = { repo: t.type === "schedule" ? undefined : st.repo, title: st.title.trim() || undefined, labels: st.labels.split(",").map(function (x) { return x.trim(); }).filter(Boolean), author: t.type === "issue" || t.type === "comment" ? st.author.trim() : undefined };
        var r = G.ops.simulateTrigger(t.id, input);
        if (r.decision) { err.textContent = r.msg; return; }
        ui.sim[t.id] = { outcome: r.run.outcome, msg: r.msg, wo: r.run.wo, at: Date.now() };
        G.toast(r.run.outcome === "created" ? "Created " + r.run.wo + "." : "Trigger " + r.run.outcome + ": " + r.msg, r.run.outcome === "created" ? "ok" : "warn");
        close();
      } }] });
  }
  function tDraft(t) {
    if (ui.tdraft && ui.tkey === t.id) return ui.tdraft;
    ui.tkey = t.id;
    ui.tdraft = { source: t.source || "", name: t.name, label: t.label || "", command: t.command || "", schedule: t.schedule || "", cls: t.cls || "", who: t.who || "org", reply: t.reply || "", dedupe: !!t.dedupe,
      labelMap: Object.keys(t.labelMap || {}).map(function (k) { return { label: k, cls: t.labelMap[k] }; }) };
    return ui.tdraft;
  }
  function triggerDetail(t) {
    var perm = G.me("triggers.edit", { project: t.project }), ro = !perm.allowed;
    var d = tDraft(t);
    function inp(id, k, ph, mono) { return h("input", { id: id, class: "input" + (mono ? " mono" : ""), value: d[k], placeholder: ph || "", disabled: ro, onInput: function (e) { d[k] = e.target.value; } }); }
    var clsOpts = clsOptionsFor(t.project);
    var res = ui.sim[t.id];
    var f = [G.field("Name", inp("api-tr-name", "name")),
      G.field("Source", G.select("api-tr-source", srcOptions(t.project, d.source, t.type), d.source, function (v) { d.source = v; G.rerender(); }, { disabled: ro }), srcState(d.source) === "healthy" ? "Events arrive from this connection." : srcName(d.source) + " is " + srcState(d.source) + ": events from it will not arrive.")];
    if (t.type === "issue") {
      f.push(G.field("Label that fires it", inp("api-tr-label", "label", "factory", true)));
      f.push(h("fieldset", { class: "api-fs" }, h("legend", { class: "field-label" }, "Label to class"),
        h("ul", { class: "api-lmap" }, d.labelMap.map(function (m, i) {
          return h("li", null, h("input", { id: "api-tr-lm-l-" + i, class: "input mono", value: m.label, disabled: ro, "aria-label": "Label", onInput: function (e) { m.label = e.target.value; } }), h("span", { "aria-hidden": "true" }, "→"),
            G.select("api-tr-lm-c-" + i, clsOpts, m.cls, function (v) { m.cls = v; }, { disabled: ro, "aria-label": "Class" }),
            G.btn("", { small: true, kind: "ghost", icon: "x", aria: "Remove mapping " + m.label, id: "api-tr-lm-rm-" + i, guard: perm, onClick: function () { d.labelMap.splice(i, 1); G.rerender(); } }));
        })),
        G.btn("Add mapping", { small: true, icon: "plus", id: "api-tr-lm-add", guard: perm, onClick: function () { d.labelMap.push({ label: "", cls: "feature" }); G.rerender(); } }),
        h("p", { class: "field-hint" }, "Intake still classifies; a mapped label is passed as the requested class.")));
    }
    if (t.type === "comment") f.push(G.field("Command", inp("api-tr-command", "command", "/factory fix", true), "Comment on a PR starting with this command opens a work order linked to the PR."));
    if (t.type === "schedule") f.push(h("div", { class: "form-row" }, G.field("When", inp("api-tr-schedule", "schedule", "Mon 06:00 IST", true)), G.field("Class", G.select("api-tr-cls", clsOpts, d.cls || "chore", function (v) { d.cls = v; }, { disabled: ro }))));
    if (t.type === "ci") f.push(h("div", { class: "form-row" }, G.field("Proposed class", G.select("api-tr-cls", clsOpts, d.cls || "hotfix", function (v) { d.cls = v; }, { disabled: ro })), h("p", { class: "field-hint" }, "Opens a proposal at Intake and asks a person to confirm it before any work starts.")));
    if (t.type === "issue" || t.type === "comment") f.push(G.field("Who may trigger", G.select("api-tr-who", WHO, d.who, function (v) { d.who = v; }, { disabled: ro })));
    if (t.type !== "schedule") f.push(G.field("Auto-reply", h("textarea", { id: "api-tr-reply", class: "input", rows: "2", disabled: ro, onInput: function (e) { d.reply = e.target.value; } }, d.reply), "Posted back on " + srcName(d.source) + ". {wo} becomes the work order id."));
    f.push(h("label", { class: "toggle-row api-dedupe", for: "api-tr-dedupe" }, h("span", null, h("strong", null, "Dedupe"), h("span", { class: "muted small" }, " Skip when an open work order on this project has the same title.")),
      G.toggle("api-tr-dedupe", d.dedupe, function (v) { d.dedupe = v; }, ro ? perm : null)));
    var runs = t.runs.slice().reverse().slice(0, 8);
    return h("div", { class: "api-tdetail" },
      G.panel(h("span", { class: "api-th" }, G.icon(TTYPES[t.type].icon), t.name), h("div", { class: "form-grid" },
        G.lockNote(perm, "Triggers on " + pname(t.project)),
        h("div", { class: "toggle-row api-enabled" }, h("span", null, h("strong", null, t.enabled ? "Enabled" : "Disabled"), " · " + TTYPES[t.type].name + " from " + srcName(t.source) + " · " + pname(t.project)),
          G.toggle("api-tr-enabled", t.enabled, function (v) { show(G.ops.saveTrigger(t.id, { enabled: v }), t.name + (v ? " enabled." : " disabled.")); }, perm, "Trigger enabled")),
        f,
        h("div", { class: "form-actions" },
          G.btn("Revert", { id: "api-tr-revert", onClick: function () { ui.tdraft = null; G.rerender(); } }),
          G.btn("Save trigger", { kind: "primary", id: "api-tr-save", guard: perm, onClick: function () {
            if (!d.name.trim()) { G.toast("Name the trigger.", "error"); return; }
            if (!d.source) { G.toast("Pick a source.", "error"); return; }
            var patch = { name: d.name.trim(), who: d.who, reply: d.reply, dedupe: d.dedupe, source: d.source };
            if (t.type === "issue") {
              if (!/^[a-z0-9:_ .-]{1,40}$/i.test(d.label.trim())) { G.toast("Enter the label that fires the trigger.", "error"); return; }
              var lm = {}; for (var i = 0; i < d.labelMap.length; i++) { var l = d.labelMap[i].label.trim(); if (!l) { G.toast("Every mapping needs a label.", "error"); return; } lm[l] = d.labelMap[i].cls; }
              patch.label = d.label.trim(); patch.labelMap = lm;
            }
            if (t.type === "comment") { if (!/^\/\S+/.test(d.command.trim())) { G.toast("Commands start with a slash, like /factory fix.", "error"); return; } patch.command = d.command.trim(); }
            if (t.type === "schedule") { if (!d.schedule.trim()) { G.toast("Say when the schedule runs.", "error"); return; } patch.schedule = d.schedule.trim(); patch.cls = d.cls || "chore"; }
            if (t.type === "ci") patch.cls = d.cls || "hotfix";
            var r = show(G.ops.saveTrigger(t.id, patch)); if (r.ok) ui.tdraft = null;
          } })))),
      G.panel("Simulate and history", h("div", { class: "form-grid" },
        h("div", { class: "toolbar" }, h("p", { class: "muted small" }, "Send a fake event through this rule: label check, author check, dedupe, then a real work order through Intake."),
          G.btn("Simulate incoming " + (t.type === "issue" ? "issue" : t.type === "comment" ? "comment" : t.type === "ci" ? "CI failure" : "schedule tick"), { icon: "play", id: "api-tr-sim", guard: perm, onClick: function () { simulateDialog(t); } })),
        res ? h("div", { class: "callout " + (res.outcome === "created" ? "callout-ok" : "callout-warn"), role: "status", id: "api-tr-simres" }, G.icon(res.outcome === "created" ? "check" : "alert"),
          h("span", null, h("strong", null, res.outcome), res.msg ? ": " + res.msg : "", " ", res.wo && G.find.wo(res.wo) ? h("button", { type: "button", class: "linkish mono", id: "api-tr-simwo", onClick: function () { G.openTraveler(res.wo); } }, "Open " + res.wo) : null)) : null,
        runs.length ? h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
          h("thead", null, h("tr", null, h("th", null, "Time (IST)"), h("th", null, "Source"), h("th", null, "Outcome"), h("th", null, "Work order"))),
          h("tbody", null, runs.map(function (r, i) {
            var oc = r.outcome === "created" ? "ok" : r.outcome === "refused" ? "denied" : "warn";
            return h("tr", null, h("td", { class: "mono" }, G.fmt.istDate(r.at) + " " + G.fmt.ist(r.at)), h("td", { class: "mono small" }, r.source),
              h("td", null, h("span", { class: "outcome o-" + oc }, (oc === "ok" ? "✓ " : oc === "denied" ? "⊘ " : "◆ ") + r.outcome)),
              h("td", null, r.wo ? (G.find.wo(r.wo) ? h("button", { type: "button", class: "linkish mono", id: "api-tr-run-" + i, onClick: function () { G.openTraveler(r.wo); } }, r.wo) : h("span", { class: "mono" }, r.wo)) : h("span", { class: "muted" }, "–")));
          })))) : G.emptyState({ title: "No runs yet", text: "Simulate an event to see it here." }))));
  }
  function triggersTab() {
    var list = S("triggers").filter(function (t) { return visIds().indexOf(t.project) >= 0; });
    if (!list.some(function (t) { return t.id === ui.tsel; })) { ui.tsel = list[0] ? list[0].id : null; ui.tdraft = null; }
    var t = G.find.trigger(ui.tsel);
    return h("div", { class: "form-grid" },
      h("div", { class: "toolbar" }, h("p", { class: "muted" }, "Triggers open work orders from events on connected source control, issue trackers and CI, and from schedules. Every trigger still goes through Intake and the project's gates."),
        G.btn("New trigger", { kind: "primary", icon: "plus", id: "api-tr-new", guard: G.meAnyProject("triggers.edit"), onClick: newTriggerDialog })),
      h("div", { class: "api-tsplit" },
        G.panel("Triggers", h("ul", { class: "api-tlist" }, list.map(function (x) {
          var last = x.runs[x.runs.length - 1];
          return h("li", null, h("button", { type: "button", class: "api-titem" + (x.id === ui.tsel ? " is-selected" : "") + (x.enabled ? "" : " is-off"), id: "api-tr-open-" + x.id, "aria-pressed": x.id === ui.tsel ? "true" : "false", onClick: function () { ui.tsel = x.id; ui.tdraft = null; G.rerender(); } },
            G.icon(TTYPES[x.type].icon), h("span", { class: "api-titem-main" }, h("strong", null, x.name), h("span", { class: "small muted" }, srcName(x.source) + " · " + TTYPES[x.type].name + " · " + pname(x.project)), srcState(x.source) === "healthy" ? null : h("span", { class: "small neg" }, "✕ source " + srcState(x.source))),
            h("span", { class: "api-titem-meta small" }, x.enabled ? h("span", { class: "outcome o-ok" }, "on") : h("span", { class: "outcome" }, "off"), last ? h("span", { class: "muted" }, G.fmt.ago(last.at)) : null)));
        })), { flush: true }),
        t ? triggerDetail(t) : G.emptyState({ title: "No triggers", text: "Create a trigger to open work orders from a connected source." })));
  }

  function render() {
    var pr = S("prefs");
    if (pr && pr.apiTab) { ui.tab = pr.apiTab; G.store.update("prefs", function (x) { delete x.apiTab; }); }
    var mine = visIds();
    var keys = S("apiKeys").filter(function (k) { return mine.indexOf(k.project) >= 0; });
    var ids = keys.map(function (k) { return k.id; });
    var day = S("requestLog").filter(function (x) { return ids.indexOf(x.key) >= 0 && x.at > Date.now() - G.DAY; });
    var trig = S("triggers").filter(function (t) { return mine.indexOf(t.project) >= 0; });
    var tabs = [{ id: "keys", label: "Keys", count: keys.filter(function (k) { return !k.revoked; }).length }, { id: "ref", label: "Endpoints" }, { id: "play", label: "Playground" },
      { id: "log", label: "Request log", count: day.length }, { id: "triggers", label: "Triggers", count: trig.length }, { id: "limits", label: "Limits" }];
    var body = { keys: keysTab, ref: refTab, play: playTab, log: logTab, triggers: triggersTab, limits: limitsTab }[ui.tab] || keysTab;
    return h("div", { class: "view cx api-view" },
      G.pageHeader({ id: "api-head", kicker: "Connect · API & triggers", title: "API & triggers", sub: "Submit and follow work orders from other systems, and open work from source control, issue trackers, CI and schedules. The API here runs on local sample logic.",
        meta: [["Active keys", String(keys.filter(function (k) { return !k.revoked; }).length)], ["Requests 24h", String(day.length)], ["Rate limited 24h", String(day.filter(function (x) { return x.status === 429; }).length)], ["Triggers on", trig.filter(function (t) { return t.enabled; }).length + " of " + trig.length]] }),
      G.tabBar({ id: "api-tab", items: tabs, active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      h("div", { id: "api-tab-panel", role: "tabpanel", "aria-labelledby": "api-tab-" + ui.tab }, body()));
  }

  G.views["api"] = { title: "API & triggers", render: render, keys: ["apiKeys", "apiConfig", "requestLog", "triggers", "repos", "integrationInstances", "projects"] };
})(window.G);
