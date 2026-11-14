/* MCP servers (#mcp): registry (transport, URL, masked auth, health, tools with read/write flag,
   sensitivity), add-server dialog with simulated tool discovery, scoping by project, repo, agent and
   station, per-tool allow/deny, write-gate, an effective-access checker and the usage log.
   Station and class scope lists come from the flows of the projects in scope (G.flowOf, G.classesOf),
   so custom stations such as Compliance review appear, labelled with their project. Class scope is
   stored on the server as `classes` ("all" or ids) and enforced by G.mcpAccess (policy.js). Changes go through G.ops.addMCP / updateMCP / removeMCP. Tool discovery is simulated. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "registry", sel: null, scope: null, scopeKey: null, chk: { agent: "ag-build", project: "payments", repo: "", station: "build", cls: "", tool: "" }, f: { server: "all", agent: "all", project: "all", outcome: "all" }, limit: 50 };
  var SENS = [{ value: "public", label: "Public" }, { value: "internal", label: "Internal" }, { value: "confidential", label: "Confidential" }, { value: "restricted", label: "Restricted" }];

  function S(k) { return G.store.get(k); }
  function show(r, okMsg) { G.toast(r.ok ? (okMsg || r.msg) : r.msg, r.ok ? "ok" : "error"); return r; }
  function health(st) { var s = st === "healthy" ? "healthy" : st === "down" || st === "failing" ? "failing" : "degraded"; return h("span", { class: "health h-" + s }, h("span", { class: "health-shape", "aria-hidden": "true" }), st); }
  function rw(write) { return h("span", { class: "mcp-rw " + (write ? "is-w" : "is-r"), title: write ? "Write tool" : "Read-only tool" }, write ? "W" : "R"); }
  function sensChip(s) { return h("span", { class: "mcp-sens mcp-sens-" + s }, s); }
  function inList(v, x) { return v === "all" || (v || []).indexOf(x) >= 0; }
  function scopeText(v, name) { return v === "all" ? "all " + name : !v || !v.length ? "no " + name : v.length + " " + name; }

  /* shared resolver (policy.js) checks project, repo, agent, station, class and tool scope */
  function mcpAccess(srv, c) { return G.mcpAccess(srv, c); }
  function projectsIn(v) { return S("projects").filter(function (p) { return p.status !== "archived" && (v === "all" || (v || []).indexOf(p.id) >= 0); }); }
  /* stations / classes from the flows of the projects in scope; custom entries are labelled with their project */
  function stationsFor(projects) {
    var seen = {}, out = [];
    projects.forEach(function (p) { G.flowOf(p).stations.forEach(function (st) { if (!st.custom && !seen[st.id]) { seen[st.id] = 1; out.push(st); } }); });
    out.sort(function (a, b) { return a.index - b.index; });
    /* custom stations go right after the station they follow in their own project's flow */
    projects.forEach(function (p) { var fl = G.flowOf(p).stations; fl.forEach(function (st, i) {
      if (!st.custom || seen[st.id]) return; seen[st.id] = 1;
      var prev = i ? fl[i - 1].id : null, at = out.findIndex(function (x) { return x.id === prev; });
      out.splice(at < 0 ? out.length : at + 1, 0, st);
    }); });
    return out.map(function (st) { return { id: st.id, label: st.no + " " + st.name + (st.custom ? " (" + (G.find.project(st.project) || { name: st.project }).name + ")" : "") }; });
  }
  function classesFor(projects) {
    var seen = {}, out = [];
    projects.forEach(function (p) { G.classesOf(p).forEach(function (c) { if (seen[c.id]) return; seen[c.id] = 1; out.push({ id: c.id, label: c.name + (c.custom ? " (" + (G.find.project(c.project || p.id) || { name: p.id }).name + ")" : "") }); }); });
    return out;
  }

  /* ---------- add server ---------- */
  function addDialog() {
    var perm = G.me("mcp.edit");
    var st = { name: "", transport: "http", url: "", auth: "OAuth", secret: "", sensitivity: "internal", tools: null, busy: false };
    var box = h("div", { class: "form-grid" });
    var dlg;
    function draw() {
      G.clear(box);
      var name = h("input", { id: "mcp-add-name", class: "input", value: st.name, placeholder: "Incident tracker", onInput: function (e) { st.name = e.target.value; } });
      var url = h("input", { id: "mcp-add-url", class: "input mono", value: st.url, placeholder: st.transport === "stdio" ? "runner://command" : "https://mcp.example.acme.dev", onInput: function (e) { st.url = e.target.value; } });
      var sec = h("input", { id: "mcp-add-secret", class: "input mono", type: "password", value: st.secret, autocomplete: "off", disabled: st.auth === "None", onInput: function (e) { st.secret = e.target.value; } });
      G.append(box, [
        G.lockNote(perm, "MCP registry"),
        h("div", { class: "form-row" }, G.field("Name", name), G.field("Transport", G.select("mcp-add-transport", [{ value: "http", label: "Streamable HTTP" }, { value: "sse", label: "SSE" }, { value: "stdio", label: "stdio on the runner" }], st.transport, function (v) { st.transport = v; draw(); }))),
        G.field("URL or command", url, st.transport === "stdio" ? "Runs inside the sandboxed runner next to the agent." : "Gantry connects from the factory egress range."),
        h("div", { class: "form-row" },
          G.field("Auth", G.select("mcp-add-auth", ["OAuth", "API key", "mTLS", "Vault role", "Token", "None"], st.auth, function (v) { st.auth = v; draw(); })),
          G.field("Secret", sec, "Stored masked; never shown again."),
          G.field("Sensitivity", G.select("mcp-add-sens", SENS, st.sensitivity, function (v) { st.sensitivity = v; }))),
        h("div", { class: "mcp-disc" },
          G.btn(st.tools ? "Discover again" : "Discover tools", { icon: "search", id: "mcp-add-discover", guard: perm, onClick: function () {
            if (!st.name.trim() || !st.url.trim()) { G.toast("Enter a name and URL first.", "error"); return; }
            st.busy = true; st.tools = null; draw();
            setTimeout(function () {
              var r = G.ops.discoverTools(st.name, st.url);
              st.busy = false; st.tools = r.tools; draw();
            }, G.reducedMotion() ? 0 : 500);
          } }),
          h("span", { class: "muted small", role: "status" }, st.busy ? "Connecting and listing tools (simulated)…" : st.tools ? st.tools.length + " tools found. Write tools start denied." : "Gantry lists the server's tools before you add it.")),
        st.tools ? h("ul", { class: "mcp-disc-list" }, st.tools.map(function (t, i) {
          var cb = h("input", { type: "checkbox", id: "mcp-add-tool-" + i, checked: t.allowed, onChange: function (e) { t.allowed = e.target.checked; } });
          return h("li", null, h("label", { class: "check", for: "mcp-add-tool-" + i }, cb, h("span", { class: "mono" }, t.name)), rw(t.write), t.write ? h("span", { class: "muted small" }, "needs a gate") : null);
        })) : null,
        h("div", { class: "form-err", role: "alert", id: "mcp-add-err" })]);
    }
    draw();
    dlg = G.dialog({ title: "Add an MCP server", kicker: "MCP registry", wide: true, body: box, actions: [{ label: "Cancel" }, { label: "Add server", kind: "primary", submit: true, id: "mcp-add-go", guard: perm, onClick: function (close) {
      var err = box.querySelector("#mcp-add-err");
      if (!st.name.trim() || !st.url.trim()) { err.textContent = "Name and URL are required."; return; }
      if (st.transport !== "stdio" && !/^https:\/\/\S+\.\S+/.test(st.url.trim())) { err.textContent = "HTTP and SSE servers need an https URL."; return; }
      if (st.transport === "stdio" && !/^runner:\/\/\S+/.test(st.url.trim())) { err.textContent = "stdio servers use runner://command."; return; }
      if (st.auth !== "None" && st.secret.length < 6) { err.textContent = "Enter the secret for " + st.auth + " (6 characters or more)."; return; }
      if (!st.tools) { err.textContent = "Discover tools before adding the server."; return; }
      var r = G.ops.addMCP({ name: st.name, transport: st.transport, url: st.url, auth: st.auth, secret: st.auth === "None" ? "" : st.secret, sensitivity: st.sensitivity, tools: st.tools });
      if (!r.ok) { err.textContent = r.msg; return; }
      G.toast(r.msg, "ok"); ui.sel = r.server.id; ui.scope = null; ui.tab = "registry"; close();
    } }] });
  }

  /* ---------- detail ---------- */
  function scopeDraft(srv) {
    if (ui.scope && ui.scopeKey === srv.id) return ui.scope;
    ui.scopeKey = srv.id;
    ui.scope = { projects: srv.projects === "all" ? "all" : (srv.projects || []).slice(), repos: srv.repos === "all" ? "all" : (srv.repos || []).slice(), agents: (srv.agents || []).slice(), stations: (srv.stations || []).slice(), classes: srv.classes == null || srv.classes === "all" ? "all" : srv.classes.slice() };
    return ui.scope;
  }
  function scopeGroup(key, label, items, d, ro, allowAll) {
    var all = d[key] === "all";
    var allCb = allowAll ? h("input", { type: "checkbox", id: "mcp-sc-" + key + "-all", checked: all, disabled: ro, onChange: function (e) { d[key] = e.target.checked ? "all" : []; G.rerender(); } }) : null;
    return h("fieldset", { class: "mcp-scope" }, h("legend", { class: "field-label" }, label),
      allowAll ? h("label", { class: "check mcp-all", for: "mcp-sc-" + key + "-all" }, allCb, "All, including new ones") : null,
      h("div", { class: "check-grid" }, items.map(function (it) {
        var cb = h("input", { type: "checkbox", id: "mcp-sc-" + key + "-" + it.id, checked: all || d[key].indexOf(it.id) >= 0, disabled: ro || all, onChange: function (e) {
          var l = d[key]; var i = l.indexOf(it.id); if (e.target.checked && i < 0) l.push(it.id); if (!e.target.checked && i >= 0) l.splice(i, 1); G.rerender();
        } });
        return h("label", { class: "check", for: "mcp-sc-" + key + "-" + it.id }, cb, h("span", { class: it.mono ? "mono small" : null }, it.label));
      })));
  }
  function detail(srv) {
    var perm = G.me("mcp.edit"), ro = !perm.allowed;
    var d = scopeDraft(srv);
    var dirty = JSON.stringify(d) !== JSON.stringify({ projects: srv.projects, repos: srv.repos, agents: srv.agents, stations: srv.stations, classes: srv.classes == null ? "all" : srv.classes });
    var projects = S("projects").filter(function (p) { return p.status !== "archived"; });
    var repos = S("repos").filter(function (r) { return d.projects === "all" || d.projects.indexOf(r.project) >= 0; });
    var strict = srv.sensitivity === "confidential" || srv.sensitivity === "restricted";
    var c = ui.chk;
    if (!srv.tools.some(function (t) { return t.name === c.tool; })) c.tool = srv.tools[0] ? srv.tools[0].name : "";
    var repoChoices = S("repos").filter(function (r) { return r.project === c.project; });
    if (c.repo && !repoChoices.some(function (r) { return r.id === c.repo; })) c.repo = "";
    var chkP = G.find.project(c.project);
    var chkStations = chkP ? G.flowOf(chkP).stations : [], chkClasses = chkP ? G.classesOf(chkP) : [];
    if (!chkStations.some(function (st) { return st.id === c.station; })) c.station = chkStations[0] ? chkStations[0].id : "";
    if (c.cls && !chkClasses.some(function (x) { return x.id === c.cls; })) c.cls = "";
    var dec = mcpAccess(srv, c);
    var usage = S("mcpUsage").filter(function (u) { return u.server === srv.id; }).slice(-8).reverse();
    var enabledIn = S("projects").filter(function (p) { return (p.mcp || []).indexOf(srv.id) >= 0; });

    return h("div", { class: "mcp-detail" },
      G.panel(h("span", { class: "mcp-dh" }, G.icon("server"), srv.name), h("div", { class: "form-grid" },
        G.lockNote(perm, "MCP server settings"),
        h("dl", { class: "titleblock mcp-tb" },
          h("div", null, h("dt", null, "Transport"), h("dd", { class: "mono" }, srv.transport)),
          h("div", null, h("dt", null, "URL"), h("dd", { class: "mono", title: srv.url }, srv.url)),
          h("div", null, h("dt", null, "Auth"), h("dd", null, srv.auth + " · ", h("span", { class: "mono" }, srv.authMask))),
          h("div", null, h("dt", null, "Enabled in projects"), h("dd", null, enabledIn.length ? enabledIn.map(function (p) { return p.key; }).join(", ") : "none"))),
        h("div", { class: "form-row mcp-row" },
          G.field("Sensitivity", G.select("mcp-sens", SENS, srv.sensitivity, function (v) { show(G.ops.updateMCP(srv.id, { sensitivity: v }), srv.name + " is now " + v + "."); }, { disabled: ro })),
          h("div", { class: "toggle-row mcp-wg" }, h("div", null, h("strong", null, "Write tools need a gate"), h("div", { class: "muted small" }, strict ? "Always on for confidential and restricted servers." : "Each write call waits for the work order's next human approval.")),
            G.toggle("mcp-writegate", srv.writeGate, function (v) { show(G.ops.updateMCP(srv.id, { writeGate: v }), v ? "Write tools on " + srv.name + " now wait for a gate." : "Write tools on " + srv.name + " no longer wait for a gate."); },
              ro ? perm : strict ? { allowed: false, reason: "Confidential and restricted servers always gate write tools. Lower the sensitivity first." } : null, "Write tools need a gate"))),
        h("h3", { class: "sub-h" }, "Tools (" + srv.tools.length + ")"),
        h("div", { class: "table-scroll" }, h("table", { class: "table table-compact mcp-tools" },
          h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Kind"), h("th", null, "Allowed"), h("th", null, "Calls"))),
          h("tbody", null, srv.tools.map(function (t, i) {
            var n = S("mcpUsage").filter(function (u) { return u.server === srv.id && u.tool === t.name; }).length;
            return h("tr", { class: t.allowed ? "" : "mcp-denied" }, h("td", { class: "mono" }, t.name), h("td", null, rw(t.write), " ", t.write ? (srv.writeGate ? "write, gated" : "write") : "read"),
              h("td", null, h("span", { class: "mcp-allow" }, G.toggle("mcp-tool-" + i, t.allowed, function (v) {
                var tools = srv.tools.map(function (x) { return Object.assign({}, x); }); tools[i].allowed = v;
                show(G.ops.updateMCP(srv.id, { tools: tools }), t.name + (v ? " allowed." : " denied."));
              }, perm, "Allow " + t.name), h("span", { class: "small " + (t.allowed ? "" : "neg") }, t.allowed ? "allow" : "✕ deny"))),
              h("td", { class: "mono num" }, String(n)));
          })))),
        h("div", { class: "panel-actions mcp-danger" }, G.btn("Remove server", { kind: "danger", icon: "x", id: "mcp-remove", guard: perm, onClick: function () {
          var agents = S("agents").filter(function (a) { return (a.mcp || []).indexOf(srv.id) >= 0; });
          G.dialog({ title: "Remove " + srv.name + "?", kicker: "MCP registry", body: h("div", { class: "form-grid" },
            h("p", null, "Agents lose access immediately. " + (agents.length ? agents.length + " agent" + (agents.length > 1 ? "s" : "") + " list it: " + agents.map(function (a) { return a.name; }).join(", ") + "." : "No agent lists it.")),
            enabledIn.length ? h("p", null, "Enabled in " + enabledIn.map(function (p) { return p.name; }).join(", ") + ".") : null),
            actions: [{ label: "Cancel" }, { label: "Remove server", kind: "danger", id: "mcp-remove-go", guard: perm, onClick: function (close) { var r = show(G.ops.removeMCP(srv.id)); if (r.ok) { ui.sel = null; ui.scope = null; close(); } } }] });
        } }))), { tools: health(srv.health) }),

      G.panel("Scope", h("div", { class: "form-grid" },
        h("p", { class: "muted small" }, "An agent may call this server only where every scope matches. Projects must also enable it in Project config."),
        scopeGroup("projects", "Projects", projects.map(function (p) { return { id: p.id, label: p.name }; }), d, ro, true),
        scopeGroup("repos", "Repos", repos.map(function (r) { return { id: r.id, label: r.name, mono: true }; }), d, ro, true),
        scopeGroup("agents", "Agents", S("agents").map(function (a) { return { id: a.id, label: a.name }; }), d, ro, false),
        scopeGroup("stations", "Stations (from the flows of the projects in scope)", stationsFor(projectsIn(d.projects)), d, ro, false),
        scopeGroup("classes", "Work classes", classesFor(projectsIn(d.projects)), d, ro, true),
        h("div", { class: "form-actions" },
          dirty ? G.btn("Revert", { id: "mcp-sc-revert", onClick: function () { ui.scope = null; G.rerender(); } }) : null,
          G.btn("Save scope", { kind: "primary", id: "mcp-sc-save", guard: perm.allowed && !dirty ? { allowed: false, reason: "No changes to save." } : perm, onClick: function () {
            var patch = JSON.parse(JSON.stringify(d));
            if (patch.stations) { var okSt = stationsFor(projectsIn(patch.projects)).map(function (x) { return x.id; }); patch.stations = patch.stations.filter(function (id) { return okSt.indexOf(id) >= 0; }); }
            if (patch.classes !== "all") { var okC = classesFor(projectsIn(patch.projects)).map(function (x) { return x.id; }); patch.classes = patch.classes.filter(function (id) { return okC.indexOf(id) >= 0; }); }
            if (patch.repos !== "all") patch.repos = patch.repos.filter(function (id) { var r = G.find.repo(id); return r && (patch.projects === "all" || patch.projects.indexOf(r.project) >= 0); });
            var r = show(G.ops.updateMCP(srv.id, patch), "Scope saved for " + srv.name + ".");
            if (r.ok) ui.scope = null;
          } })))),

      G.panel("Access check", h("div", { class: "form-grid" },
        h("div", { class: "form-row" },
          G.field("Agent", G.select("mcp-chk-agent", S("agents").map(function (a) { return { value: a.id, label: a.name }; }), c.agent, function (v) { c.agent = v; G.rerender(); })),
          G.field("Project", G.select("mcp-chk-project", S("projects").map(function (p) { return { value: p.id, label: p.name }; }), c.project, function (v) { c.project = v; c.repo = ""; G.rerender(); })),
          G.field("Repo", G.select("mcp-chk-repo", [{ value: "", label: "Any repo" }].concat(repoChoices.map(function (r) { return { value: r.id, label: r.name }; })), c.repo, function (v) { c.repo = v; G.rerender(); })),
          G.field("Station", G.select("mcp-chk-station", chkStations.map(function (s) { return { value: s.id, label: s.no + " " + s.name }; }), c.station, function (v) { c.station = v; G.rerender(); })),
          G.field("Class", G.select("mcp-chk-cls", [{ value: "", label: "Any class" }].concat(chkClasses.map(function (x) { return { value: x.id, label: x.name }; })), c.cls, function (v) { c.cls = v; G.rerender(); })),
          G.field("Tool", G.select("mcp-chk-tool", srv.tools.map(function (t) { return { value: t.name, label: t.name + (t.write ? " (write)" : "") }; }), c.tool, function (v) { c.tool = v; G.rerender(); }))),
        h("div", { class: "decision " + (dec.allowed ? "is-allowed" : "is-denied"), role: "status", id: "mcp-chk-result" },
          h("div", { class: "decision-v" }, G.icon(dec.allowed ? (dec.gated ? "gate" : "check") : "x"), dec.allowed ? (dec.gated ? "Allowed after gate" : "Allowed") : "Denied"),
          h("div", null, dec.reason), h("div", { class: "decision-rule small" }, h("span", { class: "kv-k" }, "Deciding rule"), h("span", { class: "mono" }, dec.rule))))),

      G.panel("Recent calls", usage.length ? h("div", { class: "table-scroll" }, usageTable(usage, true)) : G.emptyState({ title: "No calls yet", text: "Calls from agents appear here." }), { flush: !!usage.length }));
  }
  function usageTable(list, compact) {
    return h("table", { class: "table table-compact mcp-usage" },
      h("thead", null, h("tr", null, h("th", null, "Time (IST)"), compact ? null : h("th", null, "Server"), h("th", null, "Tool"), h("th", null, "Agent"), h("th", null, "Project"), h("th", null, "Outcome"), h("th", { class: "num" }, "ms"))),
      h("tbody", null, list.map(function (u) {
        var srv = G.find.mcp(u.server), t = srv && srv.tools.find(function (x) { return x.name === u.tool; });
        var oc = u.outcome === "ok" ? "ok" : u.outcome === "gated" ? "warn" : u.outcome === "denied" ? "denied" : "failed";
        return h("tr", null, h("td", { class: "mono" }, G.fmt.istDate(u.at) + " " + G.fmt.ist(u.at)), compact ? null : h("td", null, srv ? srv.name : u.server + " (removed)"),
          h("td", null, t ? rw(t.write) : null, " ", h("span", { class: "mono" }, u.tool)), h("td", null, G.actorName(u.agent).replace(" (agent)", "")), h("td", null, (G.find.project(u.project) || { key: u.project }).key),
          h("td", null, h("span", { class: "outcome o-" + oc }, { ok: "✓ ok", warn: "◆ gated", denied: "⊘ denied", failed: "✕ error" }[oc])), h("td", { class: "num mono" }, String(u.ms)));
      })));
  }

  function registry() {
    var list = S("mcp");
    if (!list.some(function (m) { return m.id === ui.sel; })) { ui.sel = list[0] ? list[0].id : null; ui.scope = null; }
    var srv = G.find.mcp(ui.sel);
    var table = G.panel("Registry", h("div", { class: "table-scroll" }, h("table", { class: "table table-compact mcp-reg" },
      h("thead", null, h("tr", null, h("th", null, "Server and scope"), h("th", null, "Health"), h("th", null, "Tools"), h("th", null, "Sensitivity"))),
      h("tbody", null, list.map(function (m) {
        var w = m.tools.filter(function (t) { return t.write; }).length, den = m.tools.filter(function (t) { return !t.allowed; }).length;
        var tr = h("tr", { class: "row-link" + (m.id === ui.sel ? " is-selected" : ""), id: "mcp-row-" + m.id },
          h("td", null, h("button", { type: "button", class: "linkish mcp-name", id: "mcp-open-" + m.id, onClick: function () { ui.sel = m.id; ui.scope = null; G.rerender(); } }, m.name),
            h("div", { class: "mono small muted mcp-url" }, m.transport + " · " + m.url), h("div", { class: "small muted" }, m.auth + " ", h("span", { class: "mono" }, m.authMask)),
            h("div", { class: "small mcp-scopeline" }, scopeText(m.projects, "projects") + " · " + scopeText(m.repos, "repos") + " · " + scopeText(m.agents, "agents") + " · " + scopeText(m.stations, "stations") + " · " + scopeText(m.classes == null ? "all" : m.classes, "classes"))),
          h("td", null, health(m.health)),
          h("td", { class: "mono small mcp-tc" }, (m.tools.length - w) + " R · " + w + " W", den ? h("div", { class: "neg" }, den + " denied") : null),
          h("td", null, sensChip(m.sensitivity)));
        tr.addEventListener("click", function (e) { if (e.target.closest("button")) return; ui.sel = m.id; ui.scope = null; G.rerender(); });
        return tr;
      })))), { flush: true });
    return h("div", { class: "mcp-split" }, table, srv ? detail(srv) : G.emptyState({ title: "No servers", text: "Add an MCP server to give agents tools." }));
  }
  function usageTab() {
    var f = ui.f;
    var all = S("mcpUsage");
    var list = all.filter(function (u) { return (f.server === "all" || u.server === f.server) && (f.agent === "all" || u.agent === f.agent) && (f.project === "all" || u.project === f.project) && (f.outcome === "all" || u.outcome === f.outcome); }).slice().reverse();
    var by = {}; list.forEach(function (u) { by[u.server] = (by[u.server] || 0) + 1; });
    var max = Math.max.apply(null, [1].concat(Object.keys(by).map(function (k) { return by[k]; })));
    return h("div", { class: "form-grid" },
      h("div", { class: "filters" },
        G.field("Server", G.select("mcp-f-server", [{ value: "all", label: "All servers" }].concat(S("mcp").map(function (m) { return { value: m.id, label: m.name }; })), f.server, function (v) { f.server = v; G.rerender(); })),
        G.field("Agent", G.select("mcp-f-agent", [{ value: "all", label: "All agents" }].concat(S("agents").map(function (a) { return { value: a.id, label: a.name }; })), f.agent, function (v) { f.agent = v; G.rerender(); })),
        G.field("Project", G.select("mcp-f-project", [{ value: "all", label: "All projects" }].concat(S("projects").map(function (p) { return { value: p.id, label: p.name }; })), f.project, function (v) { f.project = v; G.rerender(); })),
        G.field("Outcome", G.select("mcp-f-outcome", [{ value: "all", label: "All" }, { value: "ok", label: "Ok" }, { value: "gated", label: "Gated" }, { value: "error", label: "Error" }, { value: "denied", label: "Denied" }], f.outcome, function (v) { f.outcome = v; G.rerender(); }))),
      h("div", { class: "mcp-bars", role: "list", "aria-label": "Calls by server" }, Object.keys(by).map(function (k) {
        var m = G.find.mcp(k);
        return h("div", { class: "mcp-bar", role: "listitem" }, h("span", { class: "small mcp-bar-l" }, m ? m.name : k), h("span", { class: "mcp-bar-t" }, h("span", { style: "width:" + (by[k] / max * 100).toFixed(0) + "%" })), h("span", { class: "mono small" }, String(by[k])));
      })),
      G.panel(null, list.length ? h("div", { class: "table-scroll", "data-keep-scroll": "mcp-usage" }, usageTable(list.slice(0, ui.limit), false)) : G.emptyState({ title: "No calls match", text: "Change the filters." }), { flush: true }),
      list.length > ui.limit ? h("div", { class: "more" }, G.btn("Show 50 more", { id: "mcp-more", onClick: function () { ui.limit += 50; G.rerender(); } })) : null,
      h("p", { class: "footnote" }, "Usage is recorded by the factory runner for every MCP call. Write calls show as gated until the gate decides."));
  }

  function render() {
    var list = S("mcp"), use = S("mcpUsage");
    var day = use.filter(function (u) { return u.at > Date.now() - G.DAY; });
    var perm = G.me("mcp.edit");
    return h("div", { class: "view cx mcp-view" },
      G.pageHeader({ id: "mcp-head", kicker: "Connect · MCP servers", title: "MCP servers", sub: "Tools agents may call, and exactly where. Scope by project, repo, agent, station and work class; deny single tools; write tools wait for a gate. Connections and discovery are simulated.",
        meta: [["Servers", String(list.length)], ["Not healthy", String(list.filter(function (m) { return m.health !== "healthy"; }).length)], ["Write tools", String(list.reduce(function (n, m) { return n + m.tools.filter(function (t) { return t.write; }).length; }, 0))], ["Calls 24h", String(day.length)]],
        actions: [G.btn("Add server", { kind: "primary", icon: "plus", id: "mcp-add", guard: perm, onClick: addDialog })] }),
      G.tabBar({ id: "mcp-tab", items: [{ id: "registry", label: "Registry", count: list.length }, { id: "usage", label: "Usage log", count: use.length }], active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); } }),
      h("div", { id: "mcp-tab-panel", role: "tabpanel", "aria-labelledby": "mcp-tab-" + ui.tab }, ui.tab === "usage" ? usageTab() : registry()));
  }

  G.views["mcp"] = { title: "MCP servers", render: render, keys: ["mcp", "mcpUsage", "projects", "repos", "agents"] };
})(window.G);
