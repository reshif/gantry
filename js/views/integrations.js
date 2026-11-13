/* Integrations (#integrations): a catalogue of integration types by category (state.integrationTypes,
   built-in plus custom) and the connected instances of those types (state.integrationInstances,
   several per type, each scoped to all or some projects). Add flow: pick type -> schema-driven form
   with masked secrets -> simulated connection test -> scope to projects -> connected. Instance drawer:
   test, edit, disable / enable, remove with the routes, triggers and repos that depend on it.
   Custom integration builder: name, category, auth, config fields, events, actions, payload format,
   with a live preview of the resulting form and a sample payload. Every change goes through G.ops
   (addIntegrationType, removeIntegrationType, addIntegration, updateIntegration, testIntegrationInstance, removeIntegration).
   Connections are simulated; nothing leaves the page. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "connected", q: "", cat: "all", status: "all", b: null, built: null };

  var AUTHS = [{ value: "token", label: "API token" }, { value: "oauth", label: "OAuth app" }, { value: "hmac", label: "Signed (HMAC secret)" }, { value: "basic", label: "Basic auth" }, { value: "app", label: "App with private key" }, { value: "smtp", label: "SMTP login" }, { value: "none", label: "None" }];
  var PAYLOADS = [{ value: "json", label: "JSON" }, { value: "cloudevents", label: "CloudEvents JSON" }, { value: "form", label: "Form-encoded" }, { value: "blocks", label: "Chat blocks" }, { value: "adaptive", label: "Adaptive card" }, { value: "html", label: "HTML email" }];
  var FTYPES = [{ value: "text", label: "Text" }, { value: "url", label: "URL (https)" }, { value: "secret", label: "Secret (masked)" }, { value: "select", label: "Choice" }, { value: "bool", label: "Yes / no" }, { value: "number", label: "Number" }];

  function S(k) { return G.store.get(k) || []; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function types() { return S("integrationTypes"); }
  function insts() { return S("integrationInstances"); }
  function typeOf(i) { return G.find.integrationType(i.type) || { id: i.type, name: i.type, category: "custom", icon: "plug", fields: [], events: [], actions: [] }; }
  function catName(id) { var c = G.INTEGRATION_CATEGORIES.find(function (x) { return x.id === id; }); return c ? c.name : id; }
  function evName(id) { return G.notifyEventName(id); }
  function pname(id) { var p = G.find.project(id); return p ? p.name : id; }
  function liveProjects() { return S("projects").filter(function (p) { return p.status !== "archived"; }); }
  function show(r, okMsg) { G.toast(r.ok ? (okMsg || r.msg) : r.msg, r.ok ? "ok" : "error"); return r; }
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24); }
  function keyOf(s) { var w = String(s || "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean); return w.map(function (x, i) { x = x.toLowerCase(); return i ? x.charAt(0).toUpperCase() + x.slice(1) : x; }).join("").slice(0, 24); }
  function statusOf(i) { return !i.connected ? "disabled" : i.status === "failing" ? "failing" : i.status === "offline" ? "offline" : "healthy"; }
  function health(st) {
    var cls = st === "healthy" ? "healthy" : st === "failing" ? "failing" : st === "degraded" ? "degraded" : "offline";
    return h("span", { class: "health h-" + cls }, h("span", { class: "health-shape", "aria-hidden": "true" }), st);
  }
  function scopeText(i) { return i.projects === "all" ? "All projects" : (i.projects || []).length === 1 ? pname(i.projects[0]) : (i.projects || []).length + " projects"; }
  function opensTo(i, pid) { return i.projects === "all" || (i.projects || []).indexOf(pid) >= 0; }
  function dirTags(t) {
    return [t.source ? h("span", { class: "tag int-dir" }, "source") : null, t.destination ? h("span", { class: "tag int-dir" }, "destination") : null, t.custom ? h("span", { class: "tag int-custom" }, "custom") : null];
  }

  /* the source-control instance a repo was connected through (shared: G.sourceIntegrationFor in store.js) */
  function sourceFor(projectOrRepo) { return G.sourceIntegrationFor(projectOrRepo); }

  /* who depends on an instance */
  function usage(inst) {
    var routes = [], implicit = [], overrides = [];
    S("projects").forEach(function (p) {
      (p.notifications || []).forEach(function (r) {
        r.dest.forEach(function (d) {
          if (d.integration === inst.id) routes.push({ project: p, route: r, target: d.target });
          else if (!d.integration && G.integrationFor(d, p.id) === inst) implicit.push({ project: p, route: r, target: d.target });
        });
      });
    });
    S("repos").forEach(function (r) { (r.notifyOverrides || []).forEach(function (o) { (o.dest || []).forEach(function (d) { if (d.integration === inst.id) overrides.push({ repo: r, o: o }); }); }); });
    var triggers = S("triggers").filter(function (t) { return t.source === inst.id; });
    var repos = typeOf(inst).category === "source" ? S("repos").filter(function (r) { return sourceFor(r) === inst; }) : [];
    return { routes: routes, implicit: implicit, overrides: overrides, triggers: triggers, repos: repos };
  }
  function usageLine(u) {
    var parts = [];
    if (u.routes.length + u.implicit.length) parts.push((u.routes.length + u.implicit.length) + " route" + (u.routes.length + u.implicit.length === 1 ? "" : "s"));
    if (u.triggers.length) parts.push(u.triggers.length + " trigger" + (u.triggers.length === 1 ? "" : "s"));
    if (u.repos.length) parts.push(u.repos.length + " repo" + (u.repos.length === 1 ? "" : "s"));
    return parts.length ? parts.join(" · ") : "nothing yet";
  }
  function delivOf(inst) {
    return S("deliveries").filter(function (d) { return d.integration === inst.id || (!d.integration && d.channel === inst.type && G.integrationFor(d, d.project) === inst); });
  }

  /* ---------- schema-driven form ---------- */
  function control(prefix, f, value, onChange, ro) {
    var id = prefix + f.key;
    if (f.type === "select") return G.select(id, (f.options || []).map(function (o) { return { value: o, label: o }; }), value || (f.options || [])[0], onChange, { disabled: ro });
    if (f.type === "bool") {
      var cb = h("input", { type: "checkbox", id: id, checked: !!value, disabled: ro, onChange: function (e) { onChange(e.target.checked); } });
      return h("label", { class: "check int-bool", for: id }, cb, h("span", null, f.label));
    }
    return h("input", { id: id, class: "input" + (f.type === "secret" || f.type === "url" || f.type === "number" ? " mono" : ""), type: f.type === "secret" ? "password" : f.type === "number" ? "number" : "text", autocomplete: "off",
      value: value == null ? "" : String(value), placeholder: f.placeholder || (f.type === "url" ? "https://" : ""), disabled: ro, onInput: function (e) { onChange(e.target.value); } });
  }
  function schemaForm(prefix, t, vals, ro, secretHint) {
    return t.fields.map(function (f) {
      var c = control(prefix, f, f.type === "secret" ? vals.__secret : vals[f.key], function (v) { if (f.type === "secret") vals.__secret = v; else vals[f.key] = v; }, ro);
      if (f.type === "bool") return h("div", { class: "field" }, c);
      return G.field(f.label + (f.required === false ? " (optional)" : ""), c, f.type === "secret" ? (secretHint || "Stored masked. Gantry keeps only the first and last characters for display.") : f.type === "url" ? "Must start with https://." : null);
    });
  }
  function validate(t, vals, needSecret) {
    for (var i = 0; i < t.fields.length; i++) {
      var f = t.fields[i], v = f.type === "secret" ? vals.__secret : vals[f.key];
      var s = v == null ? "" : String(v).trim();
      if (f.type === "bool") continue;
      if (f.type === "secret") { if (needSecret && f.required !== false && !s) return "Add the " + f.label.toLowerCase() + "."; if (s && s.length < 6) return f.label + " looks too short."; continue; }
      if (f.required !== false && !s) return "Fill in " + f.label + ".";
      if (f.type === "url" && s && !/^https:\/\/[^\s/]+\.[^\s]+/.test(s)) return f.label + " must be an https URL.";
      if (f.type === "number" && s && isNaN(+s)) return f.label + " must be a number.";
    }
    return null;
  }
  function configOf(t, vals) { var c = {}; t.fields.forEach(function (f) { if (f.type !== "secret" && vals[f.key] != null && vals[f.key] !== "") c[f.key] = f.type === "number" ? +vals[f.key] : vals[f.key]; }); return c; }
  function hostOf(t, vals) {
    var u = t.fields.find(function (f) { return f.type === "url" && vals[f.key]; });
    if (u) return String(vals[u.key]).replace(/^https:\/\//, "").split("/")[0];
    var first = t.fields.find(function (f) { return f.type === "text" && vals[f.key]; });
    return first ? String(vals[first.key]) : t.name;
  }
  function scopePicker(prefix, st, ro) {
    var all = st.projects === "all";
    return h("fieldset", { class: "int-scope" }, h("legend", { class: "field-label" }, "Projects that may use it"),
      h("label", { class: "check int-scope-all", for: prefix + "all" }, h("input", { type: "checkbox", id: prefix + "all", checked: all, disabled: ro, onChange: function (e) { st.projects = e.target.checked ? "all" : []; st.redraw(); } }), "All projects, including new ones"),
      h("div", { class: "check-grid" }, liveProjects().map(function (p) {
        var cb = h("input", { type: "checkbox", id: prefix + p.id, checked: all || st.projects.indexOf(p.id) >= 0, disabled: ro || all, onChange: function (e) {
          var i = st.projects.indexOf(p.id); if (e.target.checked && i < 0) st.projects.push(p.id); if (!e.target.checked && i >= 0) st.projects.splice(i, 1);
        } });
        return h("label", { class: "check", for: prefix + p.id }, cb, h("span", null, p.name));
      })));
  }

  /* ---------- add integration (four steps) ---------- */
  var STEPS = ["Type", "Settings", "Connection test", "Scope"];
  function addDialog(typeId) {
    var perm = G.me("integration.add");
    var st = { step: typeId ? 1 : 0, type: typeId || null, q: "", name: "", vals: {}, targetId: "", projects: "all", test: null, busy: false };
    var box = h("div", { class: "form-grid int-add" }), dlg;
    function t() { return G.find.integrationType(st.type); }
    function pick(id) {
      st.type = id; st.vals = {}; st.test = null;
      var ty = t(), n = insts().filter(function (i) { return i.type === id; }).length;
      st.name = ty.name + (n ? " " + (n + 1) : "");
      ty.fields.forEach(function (f) { if (f.type === "select") st.vals[f.key] = (f.options || [])[0]; if (f.type === "bool") st.vals[f.key] = false; });
      st.targetId = id === "webhook" ? "" : null;
      st.step = 1; draw();
    }
    function testNow() {
      var ty = t(), e = validate(ty, st.vals, true);
      st.busy = true; st.test = null; draw();
      setTimeout(function () {
        st.busy = false;
        var host = hostOf(ty, st.vals), sec = ty.fields.find(function (f) { return f.type === "secret"; });
        if (e) st.test = { ok: false, lines: [["fail", e]] };
        else st.test = { ok: true, ms: 90 + (host.length * 41) % 380, lines: [["ok", "Reached " + host + "."], ["ok", "Authenticated with " + (AUTHS.find(function (a) { return a.value === ty.auth; }) || { label: ty.auth }).label.toLowerCase() + (sec && st.vals.__secret ? " (" + st.vals.__secret.slice(0, 4) + "••••)" : "") + "."],
          ty.actions.length ? ["ok", "Allowed actions: " + ty.actions.join(", ") + "."] : null,
          ty.events.length ? ["ok", "Events: " + ty.events.map(evName).join(", ") + "."] : null].filter(Boolean) };
        draw();
      }, G.reducedMotion() ? 0 : 450);
    }
    function footer() {
      var f = dlg.footer; G.clear(f);
      f.appendChild(G.btn("Cancel", { kind: "ghost", id: "int-add-cancel", onClick: function () { dlg.close(); } }));
      if (st.step > 0) f.appendChild(G.btn("Back", { id: "int-add-back", onClick: function () { st.step--; draw(); } }));
      if (st.step === 1) f.appendChild(G.btn("Next: test connection", { kind: "primary", id: "int-add-next", guard: perm, onClick: function () {
        var ty = t(), e = !st.name.trim() ? "Name this connection." : validate(ty, st.vals, true);
        if (!e && st.type === "webhook" && !/^[a-z0-9-]{2,24}$/.test((st.targetId || "").trim())) e = "Endpoint id: 2 to 24 lowercase letters, digits or dashes.";
        if (!e && st.type === "webhook" && insts().some(function (i) { return i.targetId === st.targetId.trim(); })) e = "An endpoint called " + st.targetId.trim() + " exists.";
        if (e) { box.querySelector("#int-add-err").textContent = e; return; }
        st.step = 2; st.test = null; draw(); testNow();
      } }));
      if (st.step === 2) f.appendChild(G.btn("Next: scope", { kind: "primary", id: "int-add-next", guard: st.test && st.test.ok ? perm : { allowed: false, reason: st.busy ? "The test is still running." : "Pass the connection test first." }, onClick: function () { st.step = 3; draw(); } }));
      if (st.step === 3) f.appendChild(G.btn("Connect " + t().name, { kind: "primary", icon: "plug", id: "int-add-go", guard: perm, onClick: function () {
        if (st.projects !== "all" && !st.projects.length) { box.querySelector("#int-add-err").textContent = "Pick at least one project, or all projects."; return; }
        var ty = t();
        var r = G.ops.addIntegration({ type: ty.id, name: st.name.trim(), config: configOf(ty, st.vals), secret: st.vals.__secret || "", projects: st.projects === "all" ? "all" : st.projects.slice(), targetId: st.type === "webhook" ? st.targetId.trim() : undefined });
        if (!r.ok) { box.querySelector("#int-add-err").textContent = r.msg; return; }
        G.ops.testIntegrationInstance(r.integration.id);
        G.toast(r.msg, "ok"); dlg.close(); ui.tab = "connected"; G.rerender(); openInstance(r.integration.id);
      } }));
    }
    function draw() {
      G.clear(box);
      var ty = t();
      G.append(box, [G.lockNote(perm, "Adding integrations"),
        h("ol", { class: "stepper int-stepper", "aria-label": "Steps" }, STEPS.map(function (s, i) { return h("li", { class: i === st.step ? "is-on" : i < st.step ? "is-done" : "" , "aria-current": i === st.step ? "step" : null }, h("span", null, i < st.step ? "✓" : String(i + 1)), s); }))]);
      if (st.step === 0) {
        var q = st.q.trim().toLowerCase();
        var search = h("input", { id: "int-add-q", class: "input", placeholder: "Search types", value: st.q, "aria-label": "Search integration types", onInput: function (e) { st.q = e.target.value; var pos = e.target.selectionStart; draw(); var n = box.querySelector("#int-add-q"); n.focus(); n.setSelectionRange(pos, pos); } });
        box.appendChild(search);
        G.INTEGRATION_CATEGORIES.forEach(function (c) {
          var list = types().filter(function (x) { return x.category === c.id && (!q || (x.name + " " + c.name).toLowerCase().indexOf(q) >= 0); });
          if (!list.length) return;
          box.appendChild(h("div", { class: "int-pick-cat" }, h("div", { class: "nt-sub int-sub" }, c.name),
            h("div", { class: "int-pick" }, list.map(function (x) {
              var n = insts().filter(function (i) { return i.type === x.id; }).length;
              return h("button", { type: "button", class: "int-pick-item", id: "int-add-type-" + x.id, onClick: function () { pick(x.id); } },
                h("span", { class: "int-mark int-mark-sm" }, G.icon(x.icon || "plug")), h("span", { class: "int-pick-main" }, h("strong", null, x.name), h("span", { class: "small muted" }, (x.source ? "source" : "") + (x.source && x.destination ? " · " : "") + (x.destination ? "destination" : "") + (n ? " · " + n + " connected" : ""))));
            }))));
        });
        if (!box.querySelector(".int-pick-item")) box.appendChild(G.emptyState({ title: "No type matches", text: "Try another word, or build a custom integration." }));
      }
      if (st.step === 1) {
        var name = h("input", { id: "int-add-name", class: "input", value: st.name, onInput: function (e) { st.name = e.target.value; } });
        G.append(box, [
          h("div", { class: "int-typeline" }, h("span", { class: "int-mark int-mark-sm" }, G.icon(ty.icon || "plug")), h("strong", null, ty.name), h("span", { class: "muted small" }, catName(ty.category) + " · " + (AUTHS.find(function (a) { return a.value === ty.auth; }) || { label: ty.auth }).label), dirTags(ty)),
          G.field("Connection name", name, "Shown in pickers across Gantry, so make it tell two of the same type apart (for example a workspace name)."),
          schemaForm("int-f-", ty, st.vals, false),
          st.type === "webhook" ? G.field("Endpoint id", h("input", { id: "int-add-target", class: "input mono", value: st.targetId || "", placeholder: "audit-lake", onInput: function (e) { st.targetId = e.target.value; } }), "Routes in Notifications pick this endpoint by id.") : null]);
      }
      if (st.step === 2) {
        box.appendChild(h("div", { class: "int-test", role: "status", "aria-live": "polite", id: "int-add-test" },
          st.busy ? h("p", { class: "muted" }, G.icon("refresh"), " Connecting to " + hostOf(ty, st.vals) + " (simulated)…")
            : st.test ? h("div", null,
              h("div", { class: "decision " + (st.test.ok ? "is-allowed" : "is-denied") }, h("div", { class: "decision-v" }, G.icon(st.test.ok ? "check" : "x"), st.test.ok ? "Connection works" : "Connection failed"), st.test.ok ? h("div", { class: "mono small" }, st.test.ms + " ms") : null),
              h("ul", { class: "int-testlines" }, st.test.lines.map(function (l) { return h("li", { class: l[0] === "ok" ? "" : "neg" }, h("span", { "aria-hidden": "true" }, l[0] === "ok" ? "✓ " : "✕ "), l[1]); })),
              h("div", { class: "form-actions" }, G.btn("Run the test again", { small: true, icon: "refresh", id: "int-add-test-again", onClick: testNow })),
              st.test.ok ? null : h("p", { class: "muted small" }, "Go back to fix the settings, then test again."))
            : null),
          h("p", { class: "footnote" }, "Simulated: Gantry checks the settings and pretends to call the service. Nothing leaves this page."));
      }
      if (st.step === 3) {
        st.redraw = draw;
        G.append(box, [scopePicker("int-add-scope-", st, false),
          h("dl", { class: "int-kv int-review" },
            [["Type", ty.name], ["Name", st.name.trim()], ["Host", hostOf(ty, st.vals)], ["Projects", st.projects === "all" ? "All" : st.projects.map(pname).join(", ") || "none"]].map(function (kv) { return h("div", null, h("dt", null, kv[0]), h("dd", null, kv[1])); }))]);
      }
      box.appendChild(h("div", { class: "form-err", role: "alert", id: "int-add-err" }));
      footer();
    }
    dlg = G.dialog({ title: "Add integration", kicker: "Integrations", wide: true, body: box, actions: [] });
    draw();
  }

  /* ---------- edit ---------- */
  function editDialog(inst) {
    var t = typeOf(inst), perm = G.me("integration.edit");
    var st = { name: inst.name, vals: Object.assign({}, clone(inst.config), { __secret: "" }), projects: inst.projects === "all" ? "all" : (inst.projects || []).slice() };
    var box = h("div", { class: "form-grid" });
    function draw() {
      G.clear(box); st.redraw = draw;
      G.append(box, [G.lockNote(perm, inst.name),
        G.field("Connection name", h("input", { id: "int-ed-name", class: "input", value: st.name, onInput: function (e) { st.name = e.target.value; } })),
        schemaForm("int-ed-", t, st.vals, !perm.allowed, "Leave empty to keep " + (inst.secretMask || "the current secret") + ". Enter a new value to rotate it."),
        scopePicker("int-ed-scope-", st, !perm.allowed),
        h("div", { class: "form-err", role: "alert", id: "int-ed-err" })]);
    }
    draw();
    G.dialog({ title: "Edit " + inst.name, kicker: t.name, wide: true, body: box, actions: [{ label: "Cancel" }, { label: "Save changes", kind: "primary", submit: true, id: "int-ed-go", guard: perm, onClick: function (close) {
      var err = box.querySelector("#int-ed-err");
      var e = !st.name.trim() ? "Name this connection." : validate(t, st.vals, false);
      if (!e && st.projects !== "all" && !st.projects.length) e = "Pick at least one project, or all projects.";
      if (!e && st.projects !== "all") {
        var u = usage(inst), lost = u.routes.filter(function (x) { return st.projects.indexOf(x.project.id) < 0; }).concat(u.triggers.filter(function (x) { return st.projects.indexOf(x.project) < 0; }));
        if (lost.length) e = "Still used outside the new scope: " + lost.map(function (x) { return x.route ? x.project.name + " " + x.route.id : x.name; }).join(", ") + ".";
      }
      if (e) { err.textContent = e; return; }
      var patch = { name: st.name.trim(), config: configOf(t, st.vals), projects: st.projects };
      if (st.vals.__secret) patch.secret = st.vals.__secret;
      var r = G.ops.updateIntegration(inst.id, patch);
      if (!r.ok) { err.textContent = r.msg; return; }
      G.toast(r.msg, "ok"); close();
    } }] });
  }

  /* ---------- disable / remove ---------- */
  function impactList(u, inst) {
    var items = [];
    u.routes.forEach(function (x) { items.push(h("li", null, G.icon("bell"), h("span", null, x.project.name + " route " + x.route.id + ": " + evName(x.route.event) + " → ", h("span", { class: "mono" }, x.target)), h("span", { class: "chip chip-block" }, "pinned"))); });
    u.implicit.forEach(function (x) { items.push(h("li", null, G.icon("bell"), h("span", null, x.project.name + " route " + x.route.id + ": " + evName(x.route.event) + " → ", h("span", { class: "mono" }, x.target)), h("span", { class: "chip" }, "resolves here"))); });
    u.overrides.forEach(function (x) { items.push(h("li", null, G.icon("branch"), h("span", null, x.repo.name + " override " + (x.o.id || "") + ": " + evName(x.o.event)))); });
    u.triggers.forEach(function (x) { items.push(h("li", null, G.icon("api"), h("span", null, "Trigger " + x.id + " " + x.name + " on " + pname(x.project)), x.enabled ? h("span", { class: "chip chip-block" }, "on") : h("span", { class: "chip" }, "off"))); });
    u.repos.forEach(function (x) { items.push(h("li", null, G.icon("branch"), h("span", { class: "mono" }, x.name), h("span", { class: "muted small" }, "source for onboarding PRs and merges"))); });
    return items.length ? h("ul", { class: "plain-list int-impact" }, items) : h("p", { class: "muted small" }, "Nothing depends on " + inst.name + ".");
  }
  function toggleDialog(inst) {
    var perm = G.me("integration.edit");
    if (!inst.connected) { show(G.ops.updateIntegration(inst.id, { connected: true }), inst.name + " enabled."); return; }
    var u = usage(inst);
    G.dialog({ title: "Disable " + inst.name + "?", kicker: typeOf(inst).name,
      body: h("div", { class: "form-grid" },
        h("p", null, "Gantry stops using it straight away. Settings are kept, so enabling it again restores everything."),
        h("div", { class: "callout callout-block" }, G.icon("alert"), h("span", null, "Deliveries to it fail and show in the delivery log; triggers from it stop firing; repos that use it as their source cannot open or merge PRs.")),
        h("h3", { class: "sub-h" }, "Depends on it"), impactList(u, inst)),
      actions: [{ label: "Cancel" }, { label: "Disable " + inst.name, kind: "danger", id: "int-dis-go", guard: perm, onClick: function (close) { var r = show(G.ops.updateIntegration(inst.id, { connected: false }), inst.name + " disabled."); if (r.ok) close(); } }] });
  }
  function removeDialog(inst) {
    var perm = G.me("integration.edit"), u = usage(inst);
    var on = u.triggers.filter(function (x) { return x.enabled; });
    var block = u.routes.length || on.length ? { allowed: false, reason: (u.routes.length ? u.routes.length + (u.routes.length > 1 ? " routes send" : " route sends") + " to it. Change them in Notifications" : "") + (u.routes.length && on.length ? "; " : "") + (on.length ? on.length + (on.length > 1 ? " triggers use" : " trigger uses") + " it. Turn them off in API & triggers" : "") + " first." } : null;
    var alt = u.implicit.length ? (G.integrationsFor(u.implicit[0].project.id, inst.type).filter(function (x) { return x !== inst; })[0] || null) : null;
    G.dialog({ title: "Remove " + inst.name + "?", kicker: typeOf(inst).name,
      body: h("div", { class: "form-grid" },
        h("p", null, "Removes the connection and its stored secret. This cannot be undone; adding it again needs the secret."),
        block ? h("div", { class: "callout callout-block", id: "int-rm-blocked" }, G.icon("lock"), h("span", null, block.reason)) : null,
        u.implicit.length ? h("div", { class: "callout callout-warn" }, G.icon("alert"), h("span", null, u.implicit.length + " route" + (u.implicit.length > 1 ? "s" : "") + " pick it by type today. After removal they " + (alt ? "use " + alt.name + "." : "fail until you pick another destination."))) : null,
        h("h3", { class: "sub-h" }, "Depends on it"), impactList(u, inst),
        h("div", { class: "form-actions int-impact-links" },
          u.routes.length || u.implicit.length ? h("a", { href: "#notifications", class: "linkish", id: "int-rm-to-routes" }, "Open Notifications") : null,
          u.triggers.length ? h("a", { href: "#api", class: "linkish", id: "int-rm-to-triggers", onClick: function () { G.store.update("prefs", function (p) { p.apiTab = "triggers"; }); } }, "Open API & triggers") : null)),
      actions: [{ label: "Cancel" }, { label: "Remove " + inst.name, kind: "danger", id: "int-rm-go", guard: block || perm, onClick: function (close) {
        var r = show(G.ops.removeIntegration(inst.id)); if (r.ok) { close(); G.drawer.close(); }
      } }] });
  }

  /* ---------- instance drawer ---------- */
  function openInstance(id) { G.drawer.open("int:" + id, function (close) { return instanceDrawer(id, close); }); }
  function instanceDrawer(id, close) {
    var inst = G.find.integration(id); if (!inst) return null;
    var t = typeOf(inst), perm = G.me("integration.edit"), st = statusOf(inst), u = usage(inst);
    var dl = delivOf(inst), day = dl.filter(function (d) { return d.at > Date.now() - G.DAY; }), failed = day.filter(function (d) { return d.status === "failed"; }).length;
    var secretF = t.fields.find(function (f) { return f.type === "secret"; });
    return h("div", { class: "drawer-inner int-drawer" },
      h("div", { class: "drawer-head" },
        h("div", null, h("div", { class: "kicker" }, t.name + " · " + catName(t.category)), h("div", { class: "drawer-id" }, h("span", { class: "int-mark int-mark-sm" }, G.icon(t.icon || "plug")), health(st)), h("h2", { class: "drawer-title" }, inst.name)),
        h("button", { type: "button", class: "icon-btn drawer-close", "aria-label": "Close", onClick: close }, G.icon("x"))),
      h("div", { class: "drawer-scroll" },
        G.lockNote(perm, inst.name),
        h("div", { class: "int-drawer-actions" },
          G.btn("Test connection", { small: true, icon: "refresh", id: "int-d-test", guard: perm, onClick: function () { show(G.ops.testIntegrationInstance(inst.id)); } }),
          G.btn("Edit", { small: true, icon: "dots", id: "int-d-edit", guard: perm, onClick: function () { editDialog(inst); } }),
          G.btn(inst.connected ? "Disable" : "Enable", { small: true, kind: inst.connected ? "ghost" : "primary", icon: "power", id: "int-d-toggle", guard: perm, onClick: function () { toggleDialog(inst); } }),
          G.btn("Remove", { small: true, kind: "danger", icon: "x", id: "int-d-remove", guard: perm, onClick: function () { removeDialog(inst); } })),
        inst.lastTest ? h("div", { class: "callout " + (inst.lastTest.ok ? "callout-ok" : "callout-warn"), role: "status", id: "int-d-lasttest" }, G.icon(inst.lastTest.ok ? "check" : "alert"),
          h("span", null, "Last test " + G.fmt.ago(inst.lastTest.at) + " by " + G.actorName(inst.lastTest.by) + ": " + (inst.lastTest.ok ? "answered." : inst.connected ? "failed (HTTP 502)." : "not reachable, it is disabled."))) : null,
        h("dl", { class: "int-kv int-kv-drawer" },
          t.fields.map(function (f) {
            var v = f.type === "secret" ? inst.secretMask || "not set" : f.type === "bool" ? (inst.config[f.key] ? "yes" : "no") : inst.config[f.key];
            return h("div", null, h("dt", null, f.label), h("dd", { class: f.type === "text" ? null : "mono" }, v == null || v === "" ? h("span", { class: "muted" }, "not set") : String(v)));
          }),
          inst.targetId ? h("div", null, h("dt", null, "Endpoint id"), h("dd", { class: "mono" }, inst.targetId)) : null,
          h("div", null, h("dt", null, "Projects"), h("dd", null, inst.projects === "all" ? "All projects" : inst.projects.map(pname).join(", "))),
          h("div", null, h("dt", null, "Last sync"), h("dd", null, G.fmt.ago(inst.lastSync))),
          h("div", null, h("dt", null, "Added"), h("dd", null, G.actorName(inst.createdBy) + ", " + G.fmt.ago(inst.createdAt))),
          h("div", null, h("dt", null, "Last 24h"), h("dd", { class: "mono" + (failed ? " neg" : "") }, day.length + " sent" + (failed ? ", " + failed + " failed" : "")))),
        secretF ? null : h("p", { class: "muted small" }, "This type stores no secret."),
        h("h3", { class: "sub-h" }, "What it does"),
        h("div", { class: "int-caps" },
          h("div", null, h("div", { class: "nt-sub int-sub" }, "Events"), t.events.length ? h("ul", { class: "int-chips" }, t.events.map(function (e) { return h("li", { class: "int-chip mono" }, e); })) : h("p", { class: "muted small" }, "Receives every event a route sends it.")),
          h("div", null, h("div", { class: "nt-sub int-sub" }, "Actions"), t.actions.length ? h("ul", { class: "int-chips" }, t.actions.map(function (a) { return h("li", { class: "int-chip mono" }, a); })) : h("p", { class: "muted small" }, "None declared."))),
        h("h3", { class: "sub-h" }, "Depends on it (" + (u.routes.length + u.implicit.length + u.overrides.length + u.triggers.length + u.repos.length) + ")"),
        impactList(u, inst),
        h("h3", { class: "sub-h" }, "Recent deliveries"),
        dl.length ? h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
          h("thead", null, h("tr", null, h("th", null, "Time (IST)"), h("th", null, "Project"), h("th", null, "Event"), h("th", null, "Target"), h("th", null, "Status"))),
          h("tbody", null, dl.slice(-8).reverse().map(function (d) {
            return h("tr", null, h("td", { class: "mono" }, G.fmt.ist(d.at)), h("td", null, (G.find.project(d.project) || {}).key || d.project), h("td", null, evName(d.event)), h("td", { class: "mono" }, d.target),
              h("td", null, h("span", { class: "outcome o-" + (d.status === "failed" ? "failed" : "ok") }, d.status === "failed" ? "✕ failed" : "✓ delivered")));
          })))) : h("p", { class: "muted small" }, t.destination ? "Nothing sent yet." : "Source integrations send events to Gantry; nothing is delivered to them."),
        G.historyList ? h("div", null, h("h3", { class: "sub-h" }, "History"), G.historyList({ type: "integration", id: inst.id })) : null));
  }

  /* ---------- type drawer ---------- */
  function openType(id) { G.drawer.open("int-type:" + id, function (close) { return typeDrawer(id, close); }); }
  function typeDrawer(id, close) {
    var t = G.find.integrationType(id); if (!t) return null;
    var mine = insts().filter(function (i) { return i.type === t.id; });
    return h("div", { class: "drawer-inner int-drawer" },
      h("div", { class: "drawer-head" },
        h("div", null, h("div", { class: "kicker" }, catName(t.category) + (t.custom ? " · custom type" : " · built in")), h("div", { class: "drawer-id" }, h("span", { class: "int-mark int-mark-sm" }, G.icon(t.icon || "plug")), dirTags(t)), h("h2", { class: "drawer-title" }, t.name)),
        h("button", { type: "button", class: "icon-btn drawer-close", "aria-label": "Close", onClick: close }, G.icon("x"))),
      h("div", { class: "drawer-scroll" },
        h("div", { class: "int-drawer-actions" }, G.btn("Add " + t.name, { small: true, kind: "primary", icon: "plus", id: "int-t-add", guard: G.me("integration.add"), onClick: function () { close(); addDialog(t.id); } }),
          t.custom ? G.btn("Remove type", { small: true, kind: "ghost", icon: "x", id: "int-t-remove", guard: !G.me("integration.add").allowed ? G.me("integration.add") : mine.length ? { allowed: false, needs: "", reason: mine.length + " connection" + (mine.length > 1 ? "s use" : " uses") + " this type. Remove " + (mine.length > 1 ? "them" : "it") + " first." } : null, onClick: function () { removeTypeDialog(t, close); } }) : null),
        h("dl", { class: "int-kv int-kv-drawer" },
          [["Auth", (AUTHS.find(function (a) { return a.value === t.auth; }) || { label: t.auth }).label], ["Payload", (PAYLOADS.find(function (p) { return p.value === t.payload; }) || { label: t.payload }).label], ["Target", t.destination ? t.targetLabel || "Target" : "not a destination"],
            ["Created", t.custom ? G.actorName(t.createdBy) + ", " + G.fmt.ago(t.createdAt) : "built in"]].map(function (kv) { return h("div", null, h("dt", null, kv[0]), h("dd", null, kv[1])); })),
        h("h3", { class: "sub-h" }, "Settings form"),
        h("div", { class: "int-form-preview" }, schemaForm("int-tp-" + t.id + "-", t, {}, true)),
        h("div", { class: "int-caps" },
          h("div", null, h("div", { class: "nt-sub int-sub" }, "Events"), t.events.length ? h("ul", { class: "int-chips" }, t.events.map(function (e) { return h("li", { class: "int-chip mono" }, e); })) : h("p", { class: "muted small" }, "Any.")),
          h("div", null, h("div", { class: "nt-sub int-sub" }, "Actions"), t.actions.length ? h("ul", { class: "int-chips" }, t.actions.map(function (a) { return h("li", { class: "int-chip mono" }, a); })) : h("p", { class: "muted small" }, "None declared."))),
        h("h3", { class: "sub-h" }, "Connected (" + mine.length + ")"),
        mine.length ? h("ul", { class: "plain-list int-uses" }, mine.map(function (i) {
          return h("li", null, h("button", { type: "button", class: "linkish", id: "int-t-open-" + i.id, onClick: function () { openInstance(i.id); } }, i.name), h("span", { class: "muted small" }, scopeText(i)), health(statusOf(i)));
        })) : h("p", { class: "muted small" }, "None yet.")));
  }

  function removeTypeDialog(t, closeDrawer) {
    G.dialog({ title: "Remove " + t.name + " from the catalogue?", kicker: "Integrations · custom type", body: h("p", null, "No connection uses it. New connections of this type can no longer be added. The removal is audited."),
      actions: [{ label: "Cancel" }, { label: "Remove type", kind: "danger", id: "int-t-remove-go", guard: G.me("integration.add"), onClick: function (close) { var r = show(G.ops.removeIntegrationType(t.id)); if (r.ok) { close(); if (closeDrawer) closeDrawer(); ui.built = null; G.rerender(); } } }] });
  }

  /* ---------- connected tab ---------- */
  function matches(t, extra) { var q = ui.q.trim().toLowerCase(); return (ui.cat === "all" || t.category === ui.cat) && (!q || (t.name + " " + catName(t.category) + " " + (extra || "")).toLowerCase().indexOf(q) >= 0); }
  function filters(withStatus) {
    var q = h("input", { id: "int-q", class: "input", type: "search", value: ui.q, placeholder: "Search by name, type or category", onInput: function (e) { ui.q = e.target.value; G.rerender(); } });
    return h("div", { class: "filters int-filters" },
      G.field("Search", q),
      G.field("Category", G.select("int-cat", [{ value: "all", label: "All categories" }].concat(G.INTEGRATION_CATEGORIES.map(function (c) { return { value: c.id, label: c.name }; })), ui.cat, function (v) { ui.cat = v; G.rerender(); })),
      withStatus ? G.field("Status", G.select("int-status", [{ value: "all", label: "Any status" }, { value: "healthy", label: "Healthy" }, { value: "failing", label: "Failing" }, { value: "disabled", label: "Disabled" }], ui.status, function (v) { ui.status = v; G.rerender(); })) : null);
  }
  function connectedTab() {
    var all = insts();
    var rows = all.filter(function (i) { return matches(typeOf(i), i.name) && (ui.status === "all" || statusOf(i) === ui.status); });
    var bad = all.filter(function (i) { return statusOf(i) !== "healthy"; });
    return h("div", { class: "form-grid" },
      bad.length ? h("div", { class: "callout callout-warn int-attn", role: "note" }, G.icon("alert"), h("span", null, bad.length + " need attention: ", bad.map(function (i, n) {
        return [n ? ", " : "", h("button", { type: "button", class: "linkish", id: "int-attn-" + i.id, onClick: function () { openInstance(i.id); } }, i.name), " (" + statusOf(i) + ")"];
      }))) : null,
      filters(true),
      G.dataTable({ id: "int-table", caption: "Connected integrations", rows: rows, rowKey: function (i) { return i.id; }, onRow: function (i) { openInstance(i.id); }, sort: { key: "name", dir: 1 },
        empty: { title: all.length ? "No connection matches" : "Nothing connected", text: all.length ? "Change the search or filters." : "Add an integration to start." },
        columns: [
          { key: "name", label: "Connection", sort: function (i) { return i.name.toLowerCase(); }, render: function (i) {
            return h("div", { class: "int-cell-name" }, h("span", { class: "int-mark int-mark-sm" }, G.icon(typeOf(i).icon || "plug")),
              h("div", null, h("button", { type: "button", class: "linkish int-name-btn", id: "int-open-" + i.id, onClick: function () { openInstance(i.id); } }, i.name), h("div", { class: "small muted" }, typeOf(i).name, typeOf(i).custom ? " · custom" : "")));
          } },
          { key: "category", label: "Category", hideSmall: true, sort: function (i) { return catName(typeOf(i).category); }, render: function (i) { return catName(typeOf(i).category); } },
          { key: "scope", label: "Projects", sort: function (i) { return i.projects === "all" ? "" : scopeText(i); }, render: function (i) { return scopeText(i); } },
          { key: "status", label: "Status", sort: function (i) { return statusOf(i); }, render: function (i) { return health(statusOf(i)); } },
          { key: "used", label: "Used by", render: function (i) { return h("span", { class: "small" }, usageLine(usage(i))); } },
          { key: "sync", label: "Last sync", align: "end", hideSmall: true, sort: function (i) { return -i.lastSync; }, render: function (i) { return h("span", { class: "mono small" }, G.fmt.ago(i.lastSync)); } }
        ] }));
  }

  /* ---------- catalogue tab ---------- */
  function catalogueTab() {
    var perm = G.me("integration.add");
    var q = ui.q.trim().toLowerCase();
    var byQ = types().filter(function (t) { return !q || (t.name + " " + catName(t.category)).toLowerCase().indexOf(q) >= 0; });
    var list = byQ.filter(function (t) { return ui.cat === "all" || t.category === ui.cat; });
    var search = h("input", { id: "int-q", class: "input", type: "search", value: ui.q, placeholder: "Search by name or category", "aria-label": "Search the catalogue", onInput: function (e) { ui.q = e.target.value; G.rerender(); } });
    var chips = [{ id: "all", name: "All", n: byQ.length }].concat(G.INTEGRATION_CATEGORIES.map(function (c) { return { id: c.id, name: c.name, n: byQ.filter(function (t) { return t.category === c.id; }).length }; }));
    return h("div", { class: "form-grid" },
      h("div", { class: "int-catbar" }, h("div", { class: "int-catsearch" }, search),
        h("div", { class: "int-catchips", role: "group", "aria-label": "Category" }, chips.map(function (c) {
          return h("button", { type: "button", class: "int-catchip" + (ui.cat === c.id ? " is-on" : ""), id: "int-catf-" + c.id, "aria-pressed": ui.cat === c.id ? "true" : "false", disabled: !c.n && c.id !== ui.cat, onClick: function () { ui.cat = c.id; G.rerender(); } }, c.name, h("span", { class: "mono" }, String(c.n)));
        }))),
      list.length ? h("div", { class: "int-grid" }, list.map(function (t) {
        var n = insts().filter(function (i) { return i.type === t.id; });
        return h("article", { class: "panel int-tile" + (t.custom ? " is-custom" : ""), "aria-label": t.name },
          h("div", { class: "int-tile-head" }, h("span", { class: "int-mark" }, G.icon(t.icon || "plug")),
            h("div", { class: "int-tile-name" }, h("div", { class: "int-sub" }, catName(t.category)), h("h3", { class: "int-name" }, t.name))),
          h("div", { class: "int-tags" }, dirTags(t), n.length ? h("span", { class: "tag int-n" }, n.length + " connected") : null),
          h("p", { class: "small int-what" }, (AUTHS.find(function (a) { return a.value === t.auth; }) || { label: t.auth }).label + ", " + t.fields.length + " settings. " + (t.actions.length ? "Can " + t.actions.slice(0, 3).join(", ").replace(/_/g, " ") + "." : "")),
          h("div", { class: "int-tile-actions" },
            G.btn("Add", { small: true, kind: "primary", icon: "plus", id: "int-cat-add-" + t.id, guard: perm, onClick: function () { addDialog(t.id); } }),
            G.btn("Details", { small: true, id: "int-cat-info-" + t.id, onClick: function () { openType(t.id); } })));
      })) : G.emptyState({ id: "int-cat-empty", title: "No type matches", text: "Try another word or category, or build a custom integration.", action: G.btn("Build custom integration", { small: true, id: "int-cat-build", onClick: function () { ui.tab = "custom"; G.rerender(); } }) }));
  }

  /* ---------- custom builder ---------- */
  function newBuilder() {
    return { name: "", category: "custom", auth: "token", source: false, destination: true, targetLabel: "Target", payload: "json", events: ["kill", "andon", "released"], inbound: "", actions: "post_event",
      fields: [{ label: "Base URL", key: "url", type: "url", required: true, options: "" }, { label: "API token", key: "token", type: "secret", required: true, options: "" }] };
  }
  function builderDef(b) {
    var inbound = b.source ? b.inbound.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : [];
    return { name: b.name.trim(), category: b.category, auth: b.auth, payload: b.payload, source: b.source, destination: b.destination, targetLabel: b.destination ? (b.targetLabel.trim() || "Target") : undefined, icon: "plug",
      fields: b.fields.map(function (f) { var o = { key: f.key.trim(), label: f.label.trim(), type: f.type, required: !!f.required }; if (f.type === "select") o.options = f.options.split(",").map(function (x) { return x.trim(); }).filter(Boolean); return o; }),
      events: (b.destination ? b.events.slice() : []).concat(inbound), actions: b.actions.split(",").map(function (x) { return x.trim(); }).filter(Boolean) };
  }
  function builderError(b) {
    if (!b.name.trim()) return "Name the integration.";
    if (types().some(function (t) { return t.id === slug(b.name); })) return "An integration type with this name exists.";
    if (!b.source && !b.destination) return "Pick whether Gantry sends to it, receives from it, or both.";
    var keys = {};
    for (var i = 0; i < b.fields.length; i++) {
      var f = b.fields[i];
      if (!f.label.trim()) return "Field " + (i + 1) + " needs a label.";
      if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(f.key.trim())) return "Field " + f.label + ": the key uses letters, digits and underscores and starts with a letter.";
      if (keys[f.key.trim()]) return "Two fields use the key " + f.key.trim() + ".";
      keys[f.key.trim()] = 1;
      if (f.type === "select" && f.options.split(",").filter(function (x) { return x.trim(); }).length < 2) return "Field " + f.label + " needs at least two choices.";
    }
    var acts = b.actions.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (acts.some(function (a) { return !/^[a-z][a-z0-9_]*$/.test(a); })) return "Actions are lowercase words joined by underscores, like post_event.";
    if (b.source && b.inbound.split(",").map(function (x) { return x.trim(); }).filter(Boolean).some(function (e) { return !/^[a-z][a-z0-9_.]*$/.test(e); })) return "Inbound events are lowercase names like ticket.created.";
    if (b.source && !b.inbound.trim()) return "List at least one event it sends to Gantry.";
    if (b.destination && !b.events.length) return "Pick at least one Gantry event it can receive.";
    return null;
  }
  function samplePayload(def) {
    var now = new Date(), wo = (S("workOrders").filter(function (w) { return w.state !== "killed"; }).slice(-1)[0]) || { id: "WO-2417", title: "Sample work order", repo: "payments-api", cls: "feature" };
    var out = {};
    if (def.destination) {
      var ev = def.events.filter(function (e) { return G.INTEGRATION_EVENTS_ALL.indexOf(e) >= 0; })[0] || "released";
      var body = { id: "evt_" + (now.getTime() % 1e8).toString(36), type: ev, created_at: now.toISOString(), project: { id: wo.project || "payments", name: pname(wo.project || "payments") }, work_order: { id: wo.id, title: wo.title, repo: wo.repo, "class": wo.cls }, summary: evName(ev) + ": " + wo.id, links: { html: "https://gantry.acme.dev/wo/" + wo.id }, action: def.actions[0] || null, simulated: true };
      if (def.payload === "cloudevents") body = { specversion: "1.0", id: body.id, source: "gantry.acme.dev", type: "dev.gantry." + ev, time: body.created_at, datacontenttype: "application/json", data: body };
      out.out = def.payload === "form" ? Object.keys(body).filter(function (k) { return typeof body[k] !== "object"; }).map(function (k) { return k + "=" + encodeURIComponent(String(body[k])); }).join("&") : JSON.stringify(body, null, 2);
    }
    if (def.source) {
      var inEv = def.events.filter(function (e) { return G.INTEGRATION_EVENTS_ALL.indexOf(e) < 0; })[0] || "item.created";
      out["in"] = JSON.stringify({ event: inEv, id: "src-" + (now.getTime() % 1e5), title: "Checkout returns 500 for gift cards", labels: ["gantry", "bug"], author: "priya@acme.dev", repo: "payments-api", url: "https://" + slug(def.name || "custom") + ".example/items/4821" }, null, 2);
    }
    return out;
  }
  function customTab() {
    var perm = G.me("integration.add"), ro = !perm.allowed;
    var b = ui.b = ui.b || newBuilder();
    var err = builderError(b), def = builderDef(b);
    function inp(id, key, ph, mono) { return h("input", { id: id, class: "input" + (mono ? " mono" : ""), value: b[key], placeholder: ph || "", disabled: ro, onInput: function (e) { b[key] = e.target.value; }, onChange: function () { G.rerender(); } }); }
    function cb(id, key, label) { return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: b[key], disabled: ro, onChange: function (e) { b[key] = e.target.checked; G.rerender(); } }), label); }
    var custom = types().filter(function (t) { return t.custom; });
    var form = G.panel("Custom integration builder", h("div", { class: "form-grid int-builder" },
      G.lockNote(perm, "Custom integration types"),
      h("div", { class: "form-row" }, G.field("Name", inp("int-b-name", "name", "Incident board")),
        G.field("Category", G.select("int-b-cat", G.INTEGRATION_CATEGORIES.map(function (c) { return { value: c.id, label: c.name }; }), b.category, function (v) { b.category = v; G.rerender(); }, { disabled: ro })),
        G.field("Auth", G.select("int-b-auth", AUTHS, b.auth, function (v) { b.auth = v; G.rerender(); }, { disabled: ro }))),
      h("fieldset", { class: "int-fs" }, h("legend", { class: "field-label" }, "Direction"),
        h("div", { class: "nt-inline int-inline" }, cb("int-b-dst", "destination", "Gantry sends events to it (notification destination)"), cb("int-b-src", "source", "It sends events to Gantry (trigger source)"))),
      h("div", { class: "form-row" },
        b.destination ? G.field("Target label", inp("int-b-target", "targetLabel", "Board, channel, queue"), "What a route picks inside it, shown next to the destination.") : null,
        G.field("Payload format", G.select("int-b-payload", PAYLOADS, b.payload, function (v) { b.payload = v; G.rerender(); }, { disabled: ro }))),
      h("fieldset", { class: "int-fs" }, h("legend", { class: "field-label" }, "Config fields"),
        h("div", { class: "table-scroll" }, h("table", { class: "table table-compact int-ftable" },
          h("thead", null, h("tr", null, h("th", null, "Label"), h("th", null, "Key"), h("th", null, "Type"), h("th", null, "Required"), h("th", null, "Choices"), h("th", null, h("span", { class: "sr" }, "Remove")))),
          h("tbody", null, b.fields.map(function (f, i) {
            return h("tr", null,
              h("td", null, h("input", { id: "int-b-f-label-" + i, class: "input", value: f.label, disabled: ro, "aria-label": "Field " + (i + 1) + " label", onInput: function (e) { var auto = !f.key || f.key === keyOf(f.label); f.label = e.target.value; if (auto) { f.key = keyOf(f.label); var k = document.getElementById("int-b-f-key-" + i); if (k) k.value = f.key; } }, onChange: function () { G.rerender(); } })),
              h("td", null, h("input", { id: "int-b-f-key-" + i, class: "input mono", value: f.key, disabled: ro, "aria-label": "Field " + (i + 1) + " key", onInput: function (e) { f.key = e.target.value; }, onChange: function () { G.rerender(); } })),
              h("td", null, G.select("int-b-f-type-" + i, FTYPES, f.type, function (v) { f.type = v; G.rerender(); }, { disabled: ro, "aria-label": "Field " + (i + 1) + " type" })),
              h("td", null, h("input", { type: "checkbox", id: "int-b-f-req-" + i, checked: f.required, disabled: ro || f.type === "bool", "aria-label": "Field " + (i + 1) + " required", onChange: function (e) { f.required = e.target.checked; G.rerender(); } })),
              h("td", null, f.type === "select" ? h("input", { id: "int-b-f-opts-" + i, class: "input mono", value: f.options, placeholder: "eu, us", disabled: ro, "aria-label": "Field " + (i + 1) + " choices", onInput: function (e) { f.options = e.target.value; }, onChange: function () { G.rerender(); } }) : h("span", { class: "muted small" }, "–")),
              h("td", null, G.btn("", { small: true, kind: "ghost", icon: "x", aria: "Remove field " + (f.label || i + 1), id: "int-b-f-rm-" + i, guard: ro ? perm : null, onClick: function () { b.fields.splice(i, 1); G.rerender(); } })));
          })))),
        G.btn("Add field", { small: true, icon: "plus", id: "int-b-f-add", guard: perm, onClick: function () { b.fields.push({ label: "", key: "", type: "text", required: false, options: "" }); G.rerender(); } })),
      b.destination ? h("fieldset", { class: "int-fs" }, h("legend", { class: "field-label" }, "Gantry events it can receive"),
        h("div", { class: "check-grid" }, G.INTEGRATION_EVENTS_ALL.map(function (e) {
          var c = h("input", { type: "checkbox", id: "int-b-ev-" + e.replace(/\./g, "-"), checked: b.events.indexOf(e) >= 0, disabled: ro, onChange: function (ev) { var k = b.events.indexOf(e); if (ev.target.checked && k < 0) b.events.push(e); if (!ev.target.checked && k >= 0) b.events.splice(k, 1); G.rerender(); } });
          return h("label", { class: "check", for: c.id }, c, h("span", { class: "small" }, evName(e)));
        }))) : null,
      b.source ? G.field("Events it sends to Gantry", inp("int-b-in", "inbound", "ticket.created, ticket.labeled", true), "Comma separated. Triggers on this source fire on these.") : null,
      G.field("Actions it can perform", inp("int-b-actions", "actions", "post_event, resolve", true), "Comma separated, lowercase with underscores."),
      h("p", { class: "small int-b-status" + (err ? " muted" : ""), role: "status", id: "int-b-err" }, ro ? "" : err ? "To add it: " + err.charAt(0).toLowerCase() + err.slice(1) : "Ready to add."),
      h("div", { class: "form-actions" },
        G.btn("Reset", { id: "int-b-reset", guard: ro ? perm : null, onClick: function () { ui.b = null; G.rerender(); } }),
        G.btn("Add to catalogue", { kind: "primary", icon: "plus", id: "int-b-save", guard: !perm.allowed ? perm : err ? { allowed: false, reason: err } : null, onClick: function () {
          var r = G.ops.addIntegrationType(builderDef(b));
          if (!r.ok) { G.toast(r.msg, "error"); return; }
          G.toast(r.msg, "ok"); ui.built = r.type.id; ui.b = null; G.rerender();
        } }))), { cls: "int-builder-panel" });
    var sp = samplePayload(def);
    var previewT = Object.assign({}, def, { fields: def.fields.filter(function (f) { return f.key && f.label; }) });
    var prev = G.panel("Preview", h("div", { class: "form-grid" },
      h("div", { class: "int-typeline" }, h("span", { class: "int-mark int-mark-sm" }, G.icon("plug")), h("strong", null, def.name || "Unnamed integration"), h("span", { class: "muted small" }, catName(def.category)), dirTags(Object.assign({ custom: true }, def))),
      h("div", { class: "nt-sub int-sub" }, "Add form people will fill in"),
      h("div", { class: "int-form-preview", id: "int-b-preview" },
        G.field("Connection name", h("input", { id: "int-bp-name", class: "input", disabled: true, value: (def.name || "Custom") + " (production)" })),
        schemaForm("int-bp-", previewT, {}, true)),
      sp.out ? h("div", null, h("div", { class: "nt-sub int-sub" }, "Sample payload Gantry sends (" + (PAYLOADS.find(function (p) { return p.value === def.payload; }) || {}).label + ")"), h("pre", { class: "api-pre mono int-pre", tabindex: "0", id: "int-b-sample", "aria-label": "Sample outgoing payload" }, sp.out)) : null,
      sp["in"] ? h("div", null, h("div", { class: "nt-sub int-sub" }, "Sample event it sends to Gantry"), h("pre", { class: "api-pre mono int-pre", tabindex: "0", id: "int-b-sample-in", "aria-label": "Sample inbound event" }, sp["in"])) : null,
      h("p", { class: "footnote" }, "Instances of this type appear as " + [def.destination ? "notification destinations" : null, def.source ? "trigger sources in API & triggers" : null].filter(Boolean).join(" and ") + ".")), { cls: "int-preview-panel" });
    var built = ui.built && G.find.integrationType(ui.built);
    return h("div", { class: "form-grid" },
      built ? h("div", { class: "callout callout-ok", role: "status", id: "int-b-done" }, G.icon("check"), h("span", null, built.name + " is in the catalogue. "),
        G.btn("Add a " + built.name + " connection", { small: true, kind: "primary", id: "int-b-add-inst", guard: perm, onClick: function () { var id = built.id; ui.built = null; addDialog(id); } })) : null,
      h("div", { class: "int-bsplit" }, form, prev),
      G.panel("Custom types (" + custom.length + ")", G.dataTable({ id: "int-custom-table", caption: "Custom integration types", rows: custom, rowKey: function (t) { return t.id; }, onRow: function (t) { openType(t.id); },
        empty: { title: "No custom types", text: "Build one above." },
        columns: [
          { key: "name", label: "Type", sort: true, render: function (t) { return h("button", { type: "button", class: "linkish", id: "int-ct-open-" + t.id, onClick: function () { openType(t.id); } }, t.name); } },
          { key: "category", label: "Category", render: function (t) { return catName(t.category); } },
          { key: "dir", label: "Direction", render: function (t) { return h("span", null, dirTags(t)); } },
          { key: "fields", label: "Fields", align: "end", render: function (t) { return h("span", { class: "mono" }, String(t.fields.length)); } },
          { key: "n", label: "Connected", align: "end", render: function (t) { return h("span", { class: "mono" }, String(insts().filter(function (i) { return i.type === t.id; }).length)); } },
          { key: "by", label: "Created", hideSmall: true, render: function (t) { return G.actorName(t.createdBy) + ", " + G.fmt.ago(t.createdAt); } },
          { key: "add", label: "", align: "end", render: function (t) { var n = insts().filter(function (i) { return i.type === t.id; }).length; return h("span", { class: "row gap-sm int-ct-ops" }, G.btn("Add", { small: true, icon: "plus", id: "int-ct-add-" + t.id, guard: perm, onClick: function () { addDialog(t.id); } }),
            G.btn("Remove", { small: true, kind: "ghost", id: "int-ct-rm-" + t.id, guard: !perm.allowed ? perm : n ? { allowed: false, needs: "", reason: n + " connection" + (n > 1 ? "s use" : " uses") + " this type. Remove " + (n > 1 ? "them" : "it") + " first." } : null, onClick: function () { removeTypeDialog(t); } })); } }
        ] }), { flush: true }));
  }

  function render() {
    var all = insts(), ty = types();
    var failing = all.filter(function (i) { return statusOf(i) === "failing"; }).length, off = all.filter(function (i) { return !i.connected; }).length;
    var failed = S("deliveries").filter(function (d) { return d.status === "failed" && d.at > Date.now() - G.DAY; }).length;
    var add = G.me("integration.add");
    var tabs = [{ id: "connected", label: "Connected", count: all.length }, { id: "catalogue", label: "Catalogue", count: ty.length }, { id: "custom", label: "Custom builder", count: ty.filter(function (t) { return t.custom; }).length }];
    if (!tabs.some(function (t) { return t.id === ui.tab; })) ui.tab = "connected";
    return h("div", { class: "view cx int-view" },
      G.pageHeader({ id: "int-head", kicker: "Connect · Integrations", title: "Integrations", sub: "Where Gantry reads work from and where it sends cards. Several connections per type, each scoped to projects. Connections are simulated; nothing leaves this page.",
        meta: [["Connected", String(all.length - off)], ["Failing", String(failing)], ["Disabled", String(off)], ["Types", ty.length + " (" + ty.filter(function (t) { return t.custom; }).length + " custom)"], ["Failed deliveries 24h", String(failed)]],
        actions: [G.btn("Add integration", { kind: "primary", icon: "plus", id: "int-add", guard: add, onClick: function () { addDialog(null); } }),
          G.btn("Build custom integration", { icon: "tool", id: "int-build", guard: add, onClick: function () { ui.tab = "custom"; G.rerender(); } })] }),
      G.tabBar({ id: "int-tab", items: tabs, active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      h("div", { id: "int-tab-panel", role: "tabpanel", "aria-labelledby": "int-tab-" + ui.tab }, ui.tab === "catalogue" ? catalogueTab() : ui.tab === "custom" ? customTab() : connectedTab()));
  }

  G.openIntegration = function (id) { location.hash = "integrations"; setTimeout(function () { openInstance(id); }, 60); };
  G.views["integrations"] = { title: "Integrations", render: render, keys: ["integrationTypes", "integrationInstances", "deliveries", "projects", "repos", "triggers"] };
})(window.G);
