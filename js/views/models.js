/* Models: vendor hub (connect with masked key, region or endpoint, health, latency, spend vs
   budget, residency, model toggles, context, price, used-by) and the routing policy editor
   (default, per-station overrides, fallback order, residency rules, route preview).
   Every change goes through G.ops.change with the model.edit permission. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { prevStation: "build", prevRepo: null, rule: { tag: "regulated", use: "bedrock", region: "", alt: "", note: "" } };

  function usedBy(modelId) { return G.store.get("agents").filter(function (a) { return a.model === modelId || a.fallbacks.indexOf(modelId) >= 0; }); }
  function enabledModels() {
    var out = [];
    G.store.get("vendors").forEach(function (v) { v.models.forEach(function (m) { if (v.connected && m.enabled) out.push({ value: m.id, label: m.name + " · " + v.name }); }); });
    return out;
  }
  function ctxOf(m) { return m.context || 0; }
  function priceIn(m) { return m.inPrice || 0; }
  function priceOut(m) { return m.outPrice || 0; }
  function stLabel(st) { return st.no + " " + st.name + (st.custom ? " (" + ((G.find.project(st.project) || {}).name || st.project) + ")" : ""); }
  function hasEndpoint(v) { return v.id === "local" || !!v.custom; }
  function vendorName(id) { var v = G.find.vendor(id); return v ? v.name : id; }
  /* routing edits: apply fn to a copy and save through G.ops.setRouting (audited with before/after) */
  function change(slice, fn, action, target, before, after, msg) {
    var next = JSON.parse(JSON.stringify(G.store.get("routing"))); fn(next);
    var r = G.ops.setRouting(next, target);
    if (r.ok && msg) r.msg = msg;
    G.toast(r.msg, r.ok ? "ok" : "error");
    return r;
  }
  function repoTags(r) {
    var p = G.find.project(r.project);
    var t = (r.tags || []).slice();
    if (p && p.regulated && t.indexOf("regulated") < 0) t.push("regulated");
    return t;
  }

  /* ---------- connect / disconnect ---------- */
  function connectDialog(v) {
    var perm = G.me("model.edit");
    var isLocal = hasEndpoint(v);
    var runtime = v.id === "local" ? G.select("vc-runtime", [{ value: "vLLM endpoint", label: "vLLM (OpenAI-compatible)" }, { value: "Ollama", label: "Ollama" }], v.product, null) : null;
    var key = h("input", { id: "vc-key", class: "input mono", type: "password", autocomplete: "off", placeholder: isLocal ? "Optional bearer token" : v.id === "bedrock" ? "Access key id and secret, or role ARN" : "API key" });
    var region = v.id === "bedrock" ? G.select("vc-region", ["eu-central-1", "eu-west-1", "us-east-1", "us-west-2", "ap-south-1"], v.region) : null;
    var endpoint = isLocal ? h("input", { id: "vc-endpoint", class: "input mono", value: v.endpoint, placeholder: "http://host:8000/v1" }) : null;
    var budget = h("input", { id: "vc-budget", class: "input mono", type: "number", min: "0", step: "100", value: String(v.budget || (isLocal ? 0 : 1000)) });
    var err = h("div", { class: "form-err", role: "alert" });
    if (!perm.allowed) [key, budget, endpoint, region, runtime].forEach(function (x) { if (x) x.disabled = true; });
    G.dialog({
      title: (v.connected ? "Update " : "Connect ") + v.name, kicker: "Models · vendor",
      sub: "Keys go to the secrets vault and are never shown again. In this demo nothing is sent anywhere: the key stays in page memory, masked, and the connection test is simulated.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Vendor settings"),
        runtime ? G.field("Runtime", runtime) : null,
        endpoint ? G.field("Endpoint URL", endpoint, "OpenAI-compatible endpoint inside your network.") : null,
        G.field(isLocal ? "Token" : "API key", key, v.keyMask ? "Current: " + v.keyMask + ". Leave empty to keep it." : null),
        region ? G.field("Region", region, "Bedrock requests are pinned to this region. Residency rules in routing rely on it.") : null,
        G.field("Monthly budget (USD)", budget, isLocal ? "Use 0 for on-prem with no per-token cost." : "Alerts at 80% and 100%."), err),
      actions: [{ label: "Cancel" }, { label: v.connected ? "Save" : "Connect", kind: "primary", submit: true, id: "vc-submit", guard: perm, onClick: function (close) {
        var k = key.value.trim();
        if (!v.connected && !isLocal && k.length < 8) { err.textContent = "Enter the full key (at least 8 characters)."; return; }
        if (endpoint && !(v.custom ? /^https:\/\/\S+$/ : /^https?:\/\/\S+$/).test(endpoint.value.trim())) { err.textContent = v.custom ? "Endpoint must start with https://" : "Endpoint must start with http:// or https://"; return; }
        var mask = k ? k.slice(0, Math.min(6, Math.max(0, k.length - 4))) + "••••••••" + k.slice(-4) : v.keyMask;
        var before = (v.connected ? "connected" : "disconnected") + " " + (v.region || "") + " " + (v.endpoint || "") + " budget " + v.budget;
        var patch = { keyMask: mask, budget: +budget.value || 0 };
        if (region) patch.region = region.value; if (endpoint) patch.endpoint = endpoint.value.trim(); if (runtime) patch.product = runtime.value;
        if (!v.connected) patch.connected = true;
        var r = G.ops.setVendor(v.id, patch, v.connected ? "vendor.update" : "vendor.connect");
        G.toast(r.msg, r.ok ? "ok" : "error");
        if (r.ok) close(); else err.textContent = r.msg;
      } }]
    });
  }

  function disconnectDialog(v) {
    var perm = G.me("model.edit");
    var routing = G.store.get("routing");
    var ids = v.models.map(function (m) { return m.id; });
    var primaries = G.store.get("agents").filter(function (a) { return ids.indexOf(a.model) >= 0; });
    var isDefault = ids.indexOf(routing.defaultModel) >= 0;
    var guard = !perm.allowed ? perm : isDefault ? { allowed: false, needs: "", reason: "The factory default model is on " + v.name + ". Pick another default in the routing policy first." } : null;
    G.dialog({
      title: "Disconnect " + v.name, kicker: "Models · vendor",
      sub: "Requests stop at once and the key is removed from the vault. You can reconnect later.",
      body: h("div", { class: "form-grid" }, G.lockNote(guard || perm, "Disconnecting"),
        primaries.length ? h("div", { class: "callout callout-warn" }, G.icon("alert"), h("span", null, primaries.map(function (a) { return a.name; }).join(", ") + " use a " + v.name + " model as primary and will run on their first available fallback.")) : h("p", { class: "small muted" }, "No agent uses this vendor as its primary model.")),
      actions: [{ label: "Cancel" }, { label: "Disconnect", kind: "danger", id: "vd-submit", guard: guard, onClick: function (close) {
        var r = G.ops.setVendor(v.id, { connected: false }, "vendor.disconnect"); G.toast(r.msg, r.ok ? "ok" : "error");
        if (r.ok) close();
      } }]
    });
  }

  /* ---------- add vendor, add and remove models (round three) ---------- */
  function removeGuard(m, users, routing, perm) {
    if (!perm.allowed) return perm;
    if (routing.defaultModel === m.id) return { allowed: false, needs: "", reason: "This is the factory default model. Pick another default first." };
    if ((routing.fallback || []).indexOf(m.id) >= 0) return { allowed: false, needs: "", reason: "In the routing fallback order. Remove it there first." };
    if (Object.keys(routing.overrides || {}).some(function (k) { return routing.overrides[k] === m.id; })) return { allowed: false, needs: "", reason: "A per-station routing override uses it. Change that first." };
    if (users.length) return { allowed: false, needs: "", reason: "Used by " + users.map(function (a) { return a.name; }).join(", ") + ". Change those agents first." };
    return null;
  }
  function removeModelDialog(v, m) {
    var perm = G.me("model.edit");
    G.dialog({ title: "Remove " + m.name, kicker: "Models · " + v.name, sub: "Removes the model from the catalogue. No agent or routing rule uses it. Audited.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Models"), h("p", { class: "small mono" }, m.id)),
      actions: [{ label: "Cancel" }, { label: "Remove model", kind: "danger", id: "md-rm-ok", guard: perm, onClick: function (close) { var r = G.ops.removeModel(m.id); G.toast(r.msg, r.ok ? "ok" : "error"); if (r.ok) close(); } }] });
  }
  function addVendorDialog() {
    var perm = G.me("model.edit");
    var name = h("input", { id: "va-name", class: "input", placeholder: "e.g. Mistral, Together, in-house gateway" });
    var endpoint = h("input", { id: "va-endpoint", class: "input mono", placeholder: "https://llm.example.com/v1" });
    var key = h("input", { id: "va-key", class: "input mono", type: "password", autocomplete: "off", placeholder: "API key (optional now, needed to connect)" });
    var region = h("input", { id: "va-region", class: "input mono", placeholder: "e.g. eu-west-1 or on-prem Pune" });
    var err = h("div", { class: "form-err", role: "alert" });
    if (!perm.allowed) [name, endpoint, key, region].forEach(function (x) { x.disabled = true; });
    G.dialog({ title: "Add a model vendor", kicker: "Models · vendor", wide: true,
      sub: "Any service that speaks the OpenAI chat API can be added. The key is masked and kept in page memory; the connection is simulated.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Vendors"), G.field("Vendor name", name, null, "va-name"),
        G.field("OpenAI-compatible endpoint URL", endpoint, "Must start with https://. Leave empty for a hosted vendor you will configure later.", "va-endpoint"), h("div", { class: "form-row" }, G.field("API key", key, "Without a key the vendor is added but not connected.", "va-key"), G.field("Region or location", region, "Shown to people writing residency rules.", "va-region")), err),
      actions: [{ label: "Cancel" }, { label: "Add vendor", kind: "primary", submit: true, id: "va-ok", guard: perm, onClick: function (close) {
        var r = G.ops.addVendor({ name: name.value, endpoint: endpoint.value.trim(), key: key.value.trim(), region: region.value.trim() });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
        setTimeout(function () { var el = document.getElementById("vendor-" + r.vendor.id); if (el) el.scrollIntoView({ block: "start", behavior: G.reducedMotion() ? "auto" : "smooth" }); }, 60);
      } }] });
  }
  function addModelDialog(v) {
    var perm = G.me("model.edit");
    var name = h("input", { id: "ma-name", class: "input", placeholder: "e.g. Llama 4 70B Instruct" });
    var mid = h("input", { id: "ma-id", class: "input mono", placeholder: "model id sent to the API (from the name if empty)" });
    var pin = h("input", { id: "ma-in", class: "input mono", type: "number", min: "0", step: "0.01", value: "0" });
    var pout = h("input", { id: "ma-out", class: "input mono", type: "number", min: "0", step: "0.01", value: "0" });
    var ctx = h("input", { id: "ma-ctx", class: "input mono", type: "number", min: "1000", step: "1000", value: "128000" });
    var tier = G.select("ma-tier", [{ value: "fast", label: "Fast" }, { value: "standard", label: "Standard" }, { value: "frontier", label: "Frontier" }], "standard", null);
    var err = h("div", { class: "form-err", role: "alert" });
    if (!perm.allowed) [name, mid, pin, pout, ctx, tier].forEach(function (x) { x.disabled = true; });
    G.dialog({ title: "Add a model to " + v.name, kicker: "Models · catalogue", sub: "Prices are USD per million tokens. New models start enabled; nothing routes to them until an agent or routing rule picks them.",
      body: h("div", { class: "form-grid" }, G.lockNote(perm, "Models"), h("div", { class: "form-row" }, G.field("Name", name, null, "ma-name"), G.field("Model id", mid, null, "ma-id")),
        h("div", { class: "form-row" }, G.field("Input $ / Mtok", pin, null, "ma-in"), G.field("Output $ / Mtok", pout, null, "ma-out"), G.field("Context (tokens)", ctx, null, "ma-ctx"), G.field("Tier", tier, null, "ma-tier")), err),
      actions: [{ label: "Cancel" }, { label: "Add model", kind: "primary", submit: true, id: "ma-ok", guard: perm, onClick: function (close) {
        var r = G.ops.addModel(v.id, { id: mid.value.trim() || undefined, name: name.value, inPrice: pin.value, outPrice: pout.value, context: ctx.value, tier: tier.value });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }

  /* ---------- vendor card ---------- */
  function vendorPanel(v, s) {
    var perm = G.me("model.edit");
    var routing = s.routing;
    var head = h("div", { class: "vendor-head" },
      h("div", null, h("div", { class: "kicker" }, v.product || (v.custom ? "Custom vendor · OpenAI-compatible" : "Vendor")), h("h2", { class: "vendor-name" }, v.name)),
      h("span", { class: "health h-" + (v.connected ? v.health : "offline") }, h("span", { class: "health-shape", "aria-hidden": "true" }), v.connected ? v.health : "not connected"));
    var meta = h("dl", { class: "titleblock tb-vendor" },
      h("div", null, h("dt", null, "Latency p50"), h("dd", { class: "mono" }, v.connected ? v.latency + " ms" : "–")),
      h("div", null, h("dt", null, hasEndpoint(v) ? "Endpoint" : "Region"), h("dd", { class: "mono", title: hasEndpoint(v) ? v.endpoint : v.region }, (hasEndpoint(v) ? v.endpoint : v.region) || "–")),
      h("div", null, h("dt", null, "Key"), h("dd", { class: "mono" }, v.keyMask || "none")),
      h("div", null, h("dt", null, "Spend MTD"), h("dd", { class: "mono" }, G.fmt.money0(v.mtd || 0) + (v.budget ? " / " + G.fmt.money0(v.budget) : ""))));
    var pct = v.budget ? (v.mtd || 0) / v.budget : 0;
    var models = h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Model"), h("th", { scope: "col" }, "On"), h("th", { scope: "col", class: "num" }, "Context"), h("th", { scope: "col", class: "num" }, "$ in / out per Mtok"), h("th", { scope: "col" }, "Used by"))),
      h("tbody", null, v.models.length ? null : h("tr", null, h("td", { colspan: "5", class: "small muted" }, "No models yet. Add the models this endpoint serves.")), v.models.map(function (m) {
        var users = usedBy(m.id);
        var primaries = users.filter(function (a) { return a.model === m.id; });
        var isDefault = routing.defaultModel === m.id;
        var lock = !perm.allowed ? perm : !v.connected ? { allowed: false, needs: "", reason: "Connect " + v.name + " first." }
          : m.enabled && isDefault ? { allowed: false, needs: "", reason: "This is the factory default model. Pick another default first." }
          : m.enabled && primaries.length ? { allowed: false, needs: "", reason: "Primary model of " + primaries.map(function (a) { return a.name; }).join(", ") + ". Change those agents first." } : null;
        return h("tr", { class: m.enabled && v.connected ? "" : "md-off" },
          h("td", null, h("div", null, m.name, isDefault ? G.chip("factory default", "chip-accent md-def") : null), h("div", { class: "mono muted small md-id" }, m.id, G.btn("", { small: true, kind: "ghost", icon: "x", id: "md-rm-" + m.id, aria: "Remove " + m.name, cls: "md-rm", guard: removeGuard(m, users, routing, perm), onClick: function () { removeModelDialog(v, m); } }))),
          h("td", null, G.toggle("mt-" + m.id, m.enabled, function (on) {
            var r = G.ops.setModelEnabled(m.id, on); G.toast(r.msg, r.ok ? "ok" : "error");
          }, lock, "Enable " + m.name)),
          h("td", { class: "num mono" }, G.fmt.k(ctxOf(m))),
          h("td", { class: "num mono" }, priceIn(m) || priceOut(m) ? "$" + priceIn(m) + " / $" + priceOut(m) : "self-hosted"),
          h("td", null, users.length ? h("span", { class: "md-users" }, users.map(function (a) { return h("span", { class: "chip" + (a.model === m.id ? " chip-accent" : "") }, a.name + (a.model === m.id ? "" : " (fallback)")); })) : h("span", { class: "muted small" }, "none")));
      }))));
    return h("section", { class: "panel vendor" + (v.connected ? "" : " is-off"), "aria-label": v.name, id: "vendor-" + v.id },
      head, meta,
      v.budget ? h("div", { class: "budget-row md-budget" }, h("span", { class: "small muted" }, "Month to date vs budget"), G.meter(v.mtd, v.budget, v.name + " spend vs budget", 0.8), h("span", { class: "mono small" + (pct >= 0.8 ? " warn-text" : "") }, G.fmt.pct(pct))) : h("div", { class: "budget-row md-budget" }, h("span", { class: "small muted" }, v.custom ? "No monthly budget set" : "No per-token cost")),
      h("p", { class: "residency small" }, G.icon("shield"), h("span", null, v.residency || (v.endpoint ? "Data goes to " + v.endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "") + (v.region ? " in " + v.region : "") + ". Check where that endpoint runs before routing regulated work to it." : "No residency information."))),
      models,
      h("div", { class: "panel-actions md-actions" },
        G.btn(v.connected ? "Update key or settings" : "Connect " + v.name, { kind: v.connected ? null : "primary", icon: "key", id: "vendor-connect-" + v.id, guard: perm, onClick: function () { connectDialog(v); } }),
        G.btn("Test connection", { icon: "refresh", id: "vendor-test-" + v.id, guard: !v.connected ? { allowed: false, needs: "", reason: "Connect " + v.name + " first." } : null, onClick: function () {
          var ms = Math.round(v.latency * (0.8 + Math.random() * 0.4));
          var warn = v.health === "degraded";
          G.audit("vendor.test", v.name + " · " + ms + " ms (simulated)", "factory", warn ? "warn" : "ok", { category: "agents" });
          G.toast("Simulated test: " + v.name + " answered in " + ms + " ms" + (warn ? ". Error rate is elevated (2.1%)." : "."), warn ? "warn" : "ok");
        } }),
        G.btn("Add model", { icon: "plus", id: "vendor-addmodel-" + v.id, guard: perm, onClick: function () { addModelDialog(v); } }),
        v.connected ? G.btn("Disconnect", { kind: "ghost", id: "vendor-disc-" + v.id, guard: perm, onClick: function () { disconnectDialog(v); } }) : null));
  }

  /* ---------- routing ---------- */
  function resolve(s, stationId, repo) {
    var r = s.routing, steps = [];
    var tags = repo ? repoTags(repo) : [];
    var rule = r.rules.find(function (x) { return tags.indexOf(x.tag) >= 0; });
    var model = r.overrides[stationId] || r.defaultModel;
    steps.push(r.overrides[stationId] ? "Station override for " + G.find.station(stationId).name + ": " + model : "Factory default: " + model);
    if (rule) {
      var m = G.find.model(model);
      if (m && m.vendor === rule.use) steps.push(rule.id + " allows " + vendorName(rule.use) + ": keep " + model);
      else {
        var v = G.find.vendor(rule.use);
        var pickM = v && v.connected && v.models.find(function (x) { return x.enabled; });
        var alt = rule.alt && G.find.vendor(rule.alt);
        var altM = alt && alt.connected && alt.models.find(function (x) { return x.enabled; });
        if (pickM) { model = pickM.id; steps.push(rule.id + " requires " + vendorName(rule.use) + (rule.region ? " in " + rule.region : "") + ": switch to " + model); }
        else if (altM) { model = altM.id; steps.push(rule.id + ": " + vendorName(rule.use) + " unavailable, use " + vendorName(rule.alt) + ": " + model); }
        else { steps.push(rule.id + ": no allowed vendor is available. Work on this repo blocks rather than leaving its residency."); return { model: null, steps: steps, rule: rule }; }
      }
    }
    var mm = G.find.model(model), vv = mm && G.find.vendor(mm.vendor);
    if (!mm || !mm.enabled || !vv || !vv.connected) {
      var fb = r.fallback.find(function (id) { var x = G.find.model(id), y = x && G.find.vendor(x.vendor); return x && x.enabled && y && y.connected && (!rule || x.vendor === rule.use || x.vendor === rule.alt); });
      steps.push(model + " is unavailable; fallback order gives " + (fb || "nothing"));
      model = fb || null;
    }
    return { model: model, steps: steps, rule: rule };
  }

  function routingPanel(s) {
    var perm = G.me("model.edit");
    var ro = !perm.allowed;
    var r = s.routing;
    var enabled = enabledModels();
    var def = G.select("rt-default", enabled.concat(enabled.some(function (m) { return m.value === r.defaultModel; }) ? [] : [{ value: r.defaultModel, label: r.defaultModel + " (unavailable)" }]), r.defaultModel,
      function (v) { var b = r.defaultModel; change("routing", function (x) { x.defaultModel = v; }, "routing.edit", "Default model → " + v, b, v, "Default model is now " + v + "."); }, { disabled: ro });
    var overrides = h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Station"), h("th", { scope: "col" }, "Model"), h("th", { scope: "col" }, "Agent's own primary"))),
      h("tbody", null, G.STATIONS.map(function (st) {
        var cur = r.overrides[st.id] || "";
        var ag = G.find.agent(st.agent);
        return h("tr", null, h("td", { class: "nowrap" }, h("span", { class: "mono muted" }, st.no + " "), st.name, st.custom ? h("span", { class: "tag" }, (G.find.project(st.project) || {}).name || st.project) : null),
          h("td", null, G.select("rt-st-" + st.id, [{ value: "", label: "Default (" + r.defaultModel + ")" }].concat(enabled), cur, function (v) {
            change("routing", function (x) { if (v) x.overrides[st.id] = v; else delete x.overrides[st.id]; }, "routing.edit", st.name + " → " + (v || "default"), cur || "default", v || "default", st.name + " now uses " + (v || "the default") + ".");
          }, { disabled: ro, "aria-label": st.name + " model" })),
          h("td", null, ag ? h("span", { class: "mono small" }, ag.model) : h("span", { class: "muted small" }, "–")));
      }))));
    var fb = h("ol", { class: "chain" }, r.fallback.map(function (m, i) {
      var mm = G.find.model(m), vv = mm && G.find.vendor(mm.vendor);
      var ok = mm && mm.enabled && vv && vv.connected;
      return h("li", null, h("span", { class: "mono chain-n" }, String(i + 1)), h("span", { class: "mono" }, m), ok ? null : h("span", { class: "chip chip-warn" }, "unavailable, skipped"),
        h("span", { class: "chain-tools" },
          G.btn("", { icon: "up", small: true, id: "rt-fb-up-" + i, aria: "Move " + m + " up", disabledReason: ro ? perm.reason : i === 0 ? "Already first." : null, onClick: function () { change("routing", function (x) { x.fallback.splice(i, 1); x.fallback.splice(i - 1, 0, m); }, "routing.edit", "Fallback order: " + m + " up", r.fallback.join(","), null, "Fallback order changed."); } }),
          G.btn("", { icon: "down", small: true, id: "rt-fb-down-" + i, aria: "Move " + m + " down", disabledReason: ro ? perm.reason : i === r.fallback.length - 1 ? "Already last." : null, onClick: function () { change("routing", function (x) { x.fallback.splice(i, 1); x.fallback.splice(i + 1, 0, m); }, "routing.edit", "Fallback order: " + m + " down", r.fallback.join(","), null, "Fallback order changed."); } }),
          G.btn("", { icon: "x", small: true, id: "rt-fb-rm-" + i, aria: "Remove " + m, disabledReason: ro ? perm.reason : r.fallback.length < 2 ? "Keep at least one fallback." : null, onClick: function () { change("routing", function (x) { x.fallback.splice(i, 1); }, "routing.edit", "Removed " + m + " from fallback", r.fallback.join(","), null, m + " removed from the fallback order."); } })));
    }));
    var addable = enabled.filter(function (m) { return r.fallback.indexOf(m.value) < 0; });
    var addFb = G.select("rt-fb-add", [{ value: "", label: "Add to fallback order…" }].concat(addable), "", function (v) { if (v) change("routing", function (x) { x.fallback.push(v); }, "routing.edit", "Added " + v + " to fallback", null, v, v + " added to the fallback order."); }, { disabled: ro || !addable.length, "aria-label": "Add model to fallback order" });

    var tags = { regulated: true };
    s.repos.forEach(function (rp) { repoTags(rp).forEach(function (t) { tags[t] = true; }); });
    ["infra", "experimental", "pci"].forEach(function (t) { tags[t] = true; });
    var rules = h("ul", { class: "rule-cards" }, r.rules.map(function (rule) {
      var hits = s.repos.filter(function (rp) { return repoTags(rp).indexOf(rule.tag) >= 0; });
      return h("li", { class: "rule-card" },
        h("div", { class: "rule-top" }, h("span", { class: "mono" }, rule.id), h("span", { class: "tag" }, rule.tag)),
        h("p", { class: "rule-text" }, "Repos tagged ", h("strong", null, rule.tag), " use ", h("strong", null, vendorName(rule.use) + (rule.region ? " " + rule.region : "")), rule.alt ? h("span", null, " or ", h("strong", null, vendorName(rule.alt))) : null, " only."),
        rule.note ? h("p", { class: "muted small" }, rule.note) : null,
        h("p", { class: "small" }, "Applies to: ", h("span", { class: "mono" }, hits.map(function (x) { return x.name; }).join(", ") || "no repos yet")),
        G.btn("Remove rule", { small: true, kind: "ghost", icon: "x", id: "rr-del-" + rule.id, guard: perm, onClick: function () {
          change("routing", function (x) { x.rules = x.rules.filter(function (y) { return y.id !== rule.id; }); }, "routing.rule", "Removed " + rule.id + " (" + rule.tag + " → " + rule.use + ")", rule.tag + " → " + rule.use, null, rule.id + " removed.");
        } }));
    }));
    var d = ui.rule;
    var tagSel = G.select("rr-tag", Object.keys(tags), d.tag, function (v) { d.tag = v; }, { disabled: ro });
    var useSel = G.select("rr-use", s.vendors.map(function (v) { return { value: v.id, label: v.name }; }), d.use, function (v) { d.use = v; }, { disabled: ro });
    var regionIn = h("input", { id: "rr-region", class: "input mono", placeholder: "eu-central-1", value: d.region, disabled: ro });
    regionIn.addEventListener("input", function () { d.region = regionIn.value; });
    var altSel = G.select("rr-alt", [{ value: "", label: "No alternative" }].concat(s.vendors.map(function (v) { return { value: v.id, label: v.name }; })), d.alt, function (v) { d.alt = v; }, { disabled: ro });
    var noteIn = h("input", { id: "rr-note", class: "input", placeholder: "Why this rule exists", value: d.note, disabled: ro });
    noteIn.addEventListener("input", function () { d.note = noteIn.value; });
    var form = h("form", { class: "rule-form md-rule-form", id: "rr-form" },
      G.field("When repo is tagged", tagSel), G.field("Use only", useSel), G.field("Region (optional)", regionIn), G.field("Or else", altSel), G.field("Note", noteIn),
      G.btn("Add rule", { kind: "primary", type: "submit", icon: "plus", id: "rr-add", guard: perm }));
    form.addEventListener("submit", function (e) {
      e.preventDefault(); if (ro) return;
      if (d.alt && d.alt === d.use) { G.toast("The alternative must be a different vendor.", "error"); return; }
      if (r.rules.some(function (x) { return x.tag === d.tag; })) { G.toast("A rule for " + d.tag + " already exists. Remove it first.", "error"); return; }
      var id = "RR-" + (r.rules.reduce(function (m, x) { return Math.max(m, +x.id.slice(3) || 0); }, 0) + 1);
      var rule = { id: id, tag: d.tag, use: d.use, region: d.region.trim(), alt: d.alt, note: d.note.trim() };
      var res = change("routing", function (x) { x.rules.push(rule); }, "routing.rule", "Added " + id + ": " + rule.tag + " → " + rule.use + (rule.region ? " " + rule.region : "") + (rule.alt ? " or " + rule.alt : ""), null, rule.tag + " → " + rule.use, id + " added.");
      if (res.ok) ui.rule = { tag: "regulated", use: "bedrock", region: "", alt: "", note: "" };
    });

    /* route preview */
    var repos = s.repos;
    if (!ui.prevRepo || !G.find.repo(ui.prevRepo)) ui.prevRepo = (repos.find(function (x) { return repoTags(x).indexOf("regulated") >= 0; }) || repos[0]).id;
    var res = resolve(s, ui.prevStation, G.find.repo(ui.prevRepo));
    var preview = h("div", { class: "md-preview" },
      h("div", { class: "form-row" }, G.field("Station", G.select("rt-prev-station", G.STATIONS.map(function (x) { return { value: x.id, label: stLabel(x) }; }), ui.prevStation, function (v) { ui.prevStation = v; G.rerender(); })),
        G.field("Repo", G.select("rt-prev-repo", repos.map(function (x) { return { value: x.id, label: x.name + (repoTags(x).length ? " [" + repoTags(x).join(", ") + "]" : "") }; }), ui.prevRepo, function (v) { ui.prevRepo = v; G.rerender(); }))),
      h("ol", { class: "md-steps" }, res.steps.map(function (t) { return h("li", null, t); })),
      h("div", { class: "md-result " + (res.model ? "is-ok" : "is-block") }, G.icon(res.model ? "check" : "lock"), h("span", null, res.model ? "Requests go to " : "Blocked: "), h("strong", { class: "mono" }, res.model || "no allowed model")),
      h("p", { class: "muted small" }, "Agent chains and per-project overrides take precedence over station overrides; residency rules always win."));

    return G.panel("Routing policy", h("div", { class: "routing" },
      G.lockNote(perm, "Routing"),
      h("div", { class: "routing-grid" },
        h("div", null, G.field("Factory default model", def, "Used by any station without an override and by new agents."),
          h("h3", { class: "sub-h" }, "Per-station overrides"), overrides,
          h("h3", { class: "sub-h" }, "Fallback order"), h("p", { class: "muted small" }, "Tried in order when a model errors, times out or its vendor is down. Agent chains come first."), fb, addFb),
        h("div", null, h("h3", { class: "sub-h" }, "Residency and routing rules"), rules, form,
          h("h3", { class: "sub-h" }, "Where would this request go?"), preview))), { cls: "md-routing" });
  }

  function render() {
    var s = G.store.get();
    var mtd = s.vendors.reduce(function (t, v) { return t + (v.mtd || 0); }, 0), bud = s.vendors.reduce(function (t, v) { return t + (v.budget || 0); }, 0);
    var enabledN = s.vendors.reduce(function (t, v) { return t + (v.connected ? v.models.filter(function (m) { return m.enabled; }).length : 0); }, 0);
    var degraded = s.vendors.filter(function (v) { return v.connected && v.health !== "healthy"; });
    return h("div", { class: "view view-models" },
      G.pageHeader({ id: "md-head", kicker: "Agents · Sheet 15", title: "Models", sub: "Vendors the factory may call, what each costs, where data is processed, and how work is routed between them.",
        actions: [G.btn("Add vendor", { kind: "primary", icon: "plus", id: "md-add-vendor", guard: G.me("model.edit"), onClick: addVendorDialog })],
        meta: [["Default", s.routing.defaultModel], ["Vendors connected", s.vendors.filter(function (v) { return v.connected; }).length + " / " + s.vendors.length], ["Models on", String(enabledN)], ["Spend MTD", G.fmt.money0(mtd) + " / " + G.fmt.money0(bud)]] }),
      degraded.length ? h("div", { class: "callout callout-warn md-incident", role: "status" }, G.icon("alert"), h("span", null, degraded.map(function (v) { return v.name + " is " + v.health + " (p50 " + v.latency + " ms)."; }).join(" ") + " Agents with it as primary fall back automatically after two timeouts.")) : null,
      h("div", { class: "vendor-grid" }, s.vendors.map(function (v) { return vendorPanel(v, s); })),
      routingPanel(s));
  }

  G.views.models = { title: "Models", render: render, keys: ["vendors", "routing", "agents", "repos", "projects"] };
})(window.G);
