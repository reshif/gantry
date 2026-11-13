/* Project config (#project-config): Overview, Members & roles, Flow (stations, gates, slots, WIP,
   class routes with a live mini-belt preview), Approvers (per-gate rules, N of M, separation of duties,
   conditions, escalation, delegation), Notifications, MCP, Budget, History, Danger zone.
   Every change goes through G.ops.setProject / setMemberRole / change, which audit. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { pid: null, tab: "overview", gate: "G5", drafts: {}, flowCls: "feature", add: { person: "", role: "engineer" }, scen: { cls: "hotfix", risk: "normal", path: "" }, text: {} };

  var TABS = [["overview", "Overview"], ["members", "Members & roles"], ["flow", "Flow"], ["classes", "Work classes"], ["approvers", "Approvers"], ["notifications", "Notifications"], ["mcp", "MCP"], ["budget", "Budget"], ["history", "History"], ["danger", "Danger zone"]];
  var PROJECT_ROLES = function () { return G.ROLES.filter(function (r) { return r.level === "project"; }); };
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function res(r, label) { G.toast(r.ok && label ? label : r.msg, r.ok ? "ok" : "error"); return r; }
  function roleName(id) { var r = G.find.role(id); return r ? r.name : id; }
  function members(p) { return G.store.get("people").filter(function (x) { return x.roles.some(function (g) { return g.scope === p.id; }); }); }

  /* number input committing on change. */
  function numInput(id, value, min, max, onCommit, decision, label) {
    var locked = decision && !decision.allowed;
    var el = h("input", { type: "number", id: id, class: "input pcf-num mono", min: String(min), max: String(max), value: String(value), disabled: locked, "aria-label": label || null });
    el.addEventListener("change", function () {
      var v = parseInt(el.value, 10);
      if (isNaN(v) || v < min || v > max) { G.toast("Enter a number from " + min + " to " + max + ".", "error"); el.value = String(value); return; }
      if (v !== value) onCommit(v);
    });
    return el;
  }

  /* ---------- class route matrix (also used by the template editor in projects.js) ----------
     o: { classes:[{id,name,skips,enabled,endsAfter}], stationsOff:[], decision, selected, idp, onToggle(clsId, sid, travels), onSelect(clsId), onEnable(clsId, bool) } */
  function routeMatrix(o) {
    var locked = o.decision && !o.decision.allowed;
    var sts = o.stations || G.flowOf(o.project || null).stations;
    var head = h("tr", null, h("th", { scope: "col" }, "Class"), o.onEnable ? h("th", { scope: "col" }, "On") : null,
      sts.map(function (s) { return h("th", { scope: "col", class: "pcf-rm-st" + (s.custom ? " is-custom" : ""), title: s.name }, h("span", { class: "mono" }, s.no), h("span", { class: "pcf-rm-sn" }, s.name.split(" ")[0])); }),
      h("th", { scope: "col", class: "num" }, "Stops"));
    var rows = o.classes.map(function (c) {
      var endIdx = c.endsAfter ? sts.findIndex(function (x) { return x.id === c.endsAfter; }) : 99;
      if (endIdx < 0) endIdx = 99;
      var stops = 0;
      var cells = sts.map(function (s, i) {
        var off = (o.stationsOff || []).indexOf(s.id) >= 0;
        var travels = c.skips.indexOf(s.id) < 0 && i <= endIdx;
        if (travels && !off) stops++;
        var why = s.id === "intake" ? "Every class starts at Intake." : i > endIdx ? c.name + " ends after " + G.find.station(c.endsAfter).name + "." : s.id === "close" ? "Every class ends at Close." : off ? s.name + " is off for the whole project." : null;
        var id = (o.idp || "pcf-rm") + "-" + c.id + "-" + s.id;
        var cb = h("input", { type: "checkbox", id: id, checked: travels && !off, disabled: locked || !!why, "aria-label": c.name + " travels " + s.name });
        if (!locked && !why) cb.addEventListener("change", function () { o.onToggle(c.id, s.id, cb.checked); });
        return h("td", { class: "pcf-rm-cell" + (travels && !off ? " is-on" : "") + (why ? " is-fixed" : ""), "data-tip": why || null }, cb);
      });
      var nameCell = h("th", { scope: "row", class: "pcf-rm-cls" }, o.onSelect ? h("button", { type: "button", class: "linkish pcf-rm-pick" + (o.selected === c.id ? " is-sel" : ""), id: (o.idp || "pcf-rm") + "-pick-" + c.id, "aria-pressed": o.selected === c.id ? "true" : "false", onClick: function () { o.onSelect(c.id); } }, G.classChip(c.id, { small: true })) : G.classChip(c.id, { small: true }));
      return h("tr", { class: (o.selected === c.id ? "is-selected" : "") + (c.enabled === false ? " is-disabled" : ""), onMouseenter: o.onSelect ? function () { if (o.hoverPreview) o.hoverPreview(c.id); } : null },
        nameCell,
        o.onEnable ? h("td", null, G.toggle((o.idp || "pcf-rm") + "-en-" + c.id, c.enabled !== false, function (v) { o.onEnable(c.id, v); }, o.decision, c.name + " enabled")) : null,
        cells, h("td", { class: "num mono" }, String(stops)));
    });
    return h("div", { class: "table-scroll pcf-rm-wrap", "data-keep-scroll": (o.idp || "pcf-rm") + "-scroll" }, h("table", { class: "table table-compact pcf-rm" }, h("thead", null, head), h("tbody", null, rows)));
  }
  function routeText(project, clsId) {
    var r = G.route(project, clsId);
    var g = G.routeGates(project, clsId);
    return { stations: r.map(function (s) { return G.find.station(s).name; }).join(" → "), gates: g.map(function (x) { return G.gateDef(x).label; }).join(", "), skipped: G.flowOf(project).stations.filter(function (s) { return r.indexOf(s.id) < 0; }).map(function (s) { return s.name; }) };
  }
  /* templates carry custom flow entries: the shared G.templateKit (ops3.js) records them in saveTemplate and
     createProject adds them through the flow ops; these aliases keep the cfgKit names used by projects.js */
  G.cfgKit = { routeMatrix: routeMatrix, tplCustom: G.templateKit.custom, tplCustomText: G.templateKit.text, tplCustomCount: G.templateKit.count, tplFlowProject: G.templateKit.flowProject,
    saveProjectTemplate: function (p, name) { return G.ops.saveTemplate({ name: name, fromProject: p.id }); }, tplCustomFromProject: G.templateKit.fromProject };

  /* ---------- tabs ---------- */
  function overview(p) {
    var d = G.me("project.config", { project: p.id });
    var locked = !d.allowed;
    var k = p.id + ":";
    if (ui.text[k + "desc"] == null) ui.text[k + "desc"] = p.desc || "";
    if (ui.text[k + "overlay"] == null) ui.text[k + "overlay"] = p.overlay || "";
    var desc = h("textarea", { id: "pcf-desc", class: "input", rows: "2", disabled: locked, value: ui.text[k + "desc"] });
    desc.addEventListener("input", function () { var was = ui.text[k + "desc"] !== (p.desc || ""); ui.text[k + "desc"] = desc.value; if (was !== (desc.value !== (p.desc || ""))) G.rerender(); });
    var ov = h("textarea", { id: "pcf-overlay", class: "input mono", rows: "5", disabled: locked, value: ui.text[k + "overlay"] });
    ov.addEventListener("input", function () { var was = ui.text[k + "overlay"] !== (p.overlay || ""); ui.text[k + "overlay"] = ov.value; if (was !== (ov.value !== (p.overlay || ""))) G.rerender(); });
    var dirty = ui.text[k + "desc"] !== (p.desc || "") || ui.text[k + "overlay"] !== (p.overlay || "");
    var repos = G.store.get("repos").filter(function (r) { return r.project === p.id; });
    var owners = G.store.get("people").filter(function (x) { return x.status === "active"; });
    var tpl = G.find.template(p.template);
    return h("div", { class: "two-col" },
      G.panel("About this project", h("div", { class: "form-grid" }, G.lockNote(d, "Project details"),
        G.field("Description", desc),
        G.field("Instructions overlay", ov, "Added to every agent's instructions for this project, after the factory base and before per-repo guidelines."),
        h("div", { class: "form-actions" },
          G.btn("Save details", { kind: "primary", id: "pcf-ov-save", guard: d, onClick: function () {
            var ok = true;
            if (ui.text[k + "desc"] === (p.desc || "") && ui.text[k + "overlay"] === (p.overlay || "")) { G.toast("No changes to save.", "info"); return; }
            if (ui.text[k + "desc"] !== (p.desc || "")) ok = res(G.ops.setProject(p.id, "desc", ui.text[k + "desc"].trim()), "Description saved.").ok;
            if (ok && ui.text[k + "overlay"] !== (p.overlay || "")) res(G.ops.setProject(p.id, "overlay", ui.text[k + "overlay"].trim()), "Instructions overlay saved.");
            ui.text[k + "desc"] = null; ui.text[k + "overlay"] = null; G.rerender();
          } }),
          dirty ? G.btn("Discard", { kind: "ghost", id: "pcf-ov-discard", onClick: function () { ui.text[k + "desc"] = null; ui.text[k + "overlay"] = null; G.rerender(); } }) : null))),
      h("div", { class: "pcf-stack" },
        G.panel("Facts", h("div", { class: "form-grid" },
          h("dl", { class: "titleblock pcf-facts" },
            h("div", null, h("dt", null, "Key"), h("dd", { class: "mono" }, p.key)),
            h("div", null, h("dt", null, "Status"), h("dd", null, p.status)),
            h("div", null, h("dt", null, "Template"), h("dd", null, tpl ? tpl.name : p.template)),
            h("div", null, h("dt", null, "Regulated"), h("dd", null, p.regulated ? "yes" : "no")),
            h("div", null, h("dt", null, "Teams"), h("dd", null, p.teams.map(function (t) { var x = G.find.team(t); return x ? x.name : t; }).join(", ") || "none")),
            h("div", null, h("dt", null, "Created"), h("dd", null, G.fmt.istDate(p.created)))),
          G.field("Owner", G.select("pcf-owner", owners.map(function (x) { return { value: x.id, label: x.name + " · " + x.title }; }), p.owner, function (v) { res(G.ops.setProject(p.id, "owner", v), "Owner is now " + G.actorName(v) + "."); }, { disabled: locked }), "The owner is the default fallback approver and gets budget alerts."),
          h("div", { class: "pcf-belt-row" }, G.miniBelt({ project: p })),
          (function () {
            var f = G.flowOf(p), cs = f.stations.filter(function (x) { return x.custom; }), cg = f.gates.filter(function (x) { return x.custom; }), cb = f.bays.filter(function (x) { return x.custom; }), cc = p.flow.classes.filter(function (x) { return x.custom; });
            var custom = cs.map(function (x) { return "station " + x.name; }).concat(cg.map(function (x) { return "gate " + x.label + " " + x.name; }), cb.map(function (x) { return "bay " + x.name; }), cc.map(function (x) { return "class " + x.name; }));
            return h("p", { class: "small", id: "pcf-flow-sum" }, f.stations.length + " stations, " + f.gates.length + " gates, " + f.bays.length + " bays, " + f.classes.length + " work classes. ",
              custom.length ? h("span", null, h("span", { class: "kv-k" }, "Custom "), custom.join(", ") + ".") : h("span", { class: "muted" }, "No custom entries."));
          })())),
        G.panel("Repos", repos.length ? h("ul", { class: "plain-list pcf-repos" }, repos.map(function (r) {
          var st = r.onboarding.stage;
          return h("li", null, h("span", { class: "mono" }, r.name), h("span", { class: "pcf-stage pcf-stage-" + st }, G.icon(st === "ready" ? "st-done" : st === "failed" || st === "person" ? "alert" : "rocket"), st === "ready" ? "Ready" : st === "person" ? "Needs a person" : st.replace("_", " ")), r.halted ? G.chip("halted", "chip-block") : null);
        })) : G.empty("No repos yet", "Connect a repo in Onboarding. It must be Ready before work orders can target it."),
          { tools: G.btn("Onboarding", { small: true, kind: "ghost", id: "pcf-to-onb", onClick: function () { location.hash = "onboarding"; } }) }),
        G.panel("Reuse", h("div", { class: "form-grid" }, h("p", { class: "small muted" }, "Save this project's stations, gates, bays, slots and class routes as a template for new projects, custom entries included."),
          h("div", null, G.btn("Save as template", { icon: "copy", id: "pcf-save-tpl", guard: G.me("template.edit"), onClick: function () { saveAsTemplateDialog(p); } }))))));
  }
  function saveAsTemplateDialog(p) {
    var name = h("input", { id: "pcf-tpl-name", class: "input", value: p.name + " template" });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: "Save " + p.name + " as a template", kicker: "Templates", body: h("div", { class: "form-grid" }, G.field("Template name", name), err),
      actions: [{ label: "Cancel" }, { label: "Save template", kind: "primary", submit: true, id: "pcf-tpl-ok", guard: G.me("template.edit"), onClick: function (close) {
        if (name.value.trim().length < 3) { err.textContent = "Name the template (3+ characters)."; return; }
        var r = G.ops.saveTemplate({ name: name.value.trim(), fromProject: p.id }); if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }

  function membersTab(p) {
    var d = G.me("project.members", { project: p.id });
    var mem = members(p);
    var factory = G.store.get("people").filter(function (x) { return x.roles.some(function (g) { return g.scope === "factory"; }); });
    var people = G.store.get("people").filter(function (x) { return x.status === "active" && !x.roles.some(function (g) { return g.scope === "factory"; }); });
    if (!ui.add.person && people.length) ui.add.person = people[0].id;
    var rows = mem.map(function (x) {
      var here = x.roles.filter(function (g) { return g.scope === p.id; });
      var elsewhere = x.roles.filter(function (g) { return g.scope !== p.id && g.scope !== "factory"; });
      return h("tr", null,
        h("td", null, G.who(x.id), h("div", { class: "muted small" }, x.title)),
        h("td", null, h("div", { class: "pcf-role-chips" }, here.map(function (g) {
          return h("span", { class: "pcf-role" }, roleName(g.role), G.btn("", { small: true, kind: "ghost", icon: "x", cls: "pcf-role-x", id: "pcf-rm-" + x.id + "-" + g.role, aria: "Remove " + roleName(g.role) + " from " + x.name, guard: d, onClick: function () { res(G.ops.setMemberRole(x.id, p.id, g.role, false)); } }));
        }))),
        h("td", { class: "small" }, elsewhere.length ? elsewhere.map(function (g) { var pr = G.find.project(g.scope); return h("div", null, roleName(g.role) + " on " + (pr ? pr.name : g.scope)); }) : h("span", { class: "muted" }, "only here")),
        h("td", { class: "small" }, x.oncall ? h("span", { class: "chip chip-accent" }, "on call") : null, x.away && x.away.to > Date.now() ? h("span", { class: "chip chip-warn" }, "away, delegate " + G.actorName(x.away.delegate)) : null, x.status !== "active" ? G.chip("invited") : null));
    });
    return h("div", { class: "pcf-stack" },
      G.panel("Members of " + p.name, h("div", null, G.lockNote(d, "Project membership"),
        h("p", { class: "small muted pcf-pad" }, "Roles here apply only to " + p.name + ". The same person can hold different roles in other projects."),
        h("div", { class: "table-scroll" }, h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, "Person"), h("th", null, "Roles on " + p.name), h("th", null, "Elsewhere"), h("th", null, "Status"))), h("tbody", null, rows)))), { flush: true }),
      G.panel("Grant a role", h("div", { class: "inline-form pcf-add" },
        G.field("Person", G.select("pcf-add-person", people.map(function (x) { return { value: x.id, label: x.name }; }), ui.add.person, function (v) { ui.add.person = v; }, { disabled: !d.allowed })),
        G.field("Role on " + p.name, G.select("pcf-add-role", PROJECT_ROLES().map(function (r) { return { value: r.id, label: r.name }; }), ui.add.role, function (v) { ui.add.role = v; }, { disabled: !d.allowed })),
        G.btn("Grant role", { kind: "primary", icon: "plus", id: "pcf-add-go", guard: d, onClick: function () {
          var x = G.find.person(ui.add.person);
          if (x && G.rolesIn(x, p.id).indexOf(ui.add.role) >= 0) { G.toast(x.name + " already holds " + roleName(ui.add.role) + " on " + p.name + ".", "warn"); return; }
          res(G.ops.setMemberRole(ui.add.person, p.id, ui.add.role, true));
        } }))),
      G.panel("Factory-wide roles", h("ul", { class: "plain-list" }, factory.map(function (x) { return h("li", null, G.who(x.id), h("span", { class: "muted small" }, " · " + x.roles.filter(function (g) { return g.scope === "factory"; }).map(function (g) { return roleName(g.role); }).join(", ") + " (all projects, managed in People)")); }))));
  }

  /* ---------- flow: stations, gates, bays (catalogue-driven, ops: addStation, moveStation, removeStation, addGate, addBay) ---------- */
  function wosLive(p) { return G.store.get("workOrders").filter(function (w) { return w.project === p.id && G.homeKit.inFlight(w); }); }
  function focusLater(id) { setTimeout(function () { var el = document.getElementById(id); if (el) el.focus(); }, 40); }
  /* a strip in the mini-belt style for dialogs: items [{ name, no, isNew, gate, gateNew, off }] */
  function previewStrip(items, label) {
    return h("div", { class: "mbelt pcf-pv", role: "img", "aria-label": label || items.map(function (x) { return x.name; }).join(", ") }, items.map(function (x) {
      return [h("span", { class: "mseg" + (x.isNew ? " is-custom is-new" : x.custom ? " is-custom" : "") + (x.off ? " is-off" : ""), title: x.no + " " + x.name },
          h("span", { class: "mseg-n mono" }, x.isNew ? "new" : x.no.replace(/^S/, ""))),
        x.gate ? h("span", { class: "mgate " + (x.gateNew ? "pcf-pv-gnew" : "gate-clear"), title: x.gate }) : null];
    }));
  }
  function stripFor(p, insert) {
    var f = G.flowOf(p), out = [];
    f.stations.forEach(function (s) {
      var g = f.gates.find(function (x) { return x.after === s.id; });
      out.push({ name: s.name, no: s.no, custom: s.custom, off: !s.enabled, gate: g ? g.label : (insert && insert.gateAfter === s.id ? insert.gateName : null), gateNew: !g && insert && insert.gateAfter === s.id });
      if (insert && insert.station && insert.after === s.id) out.push({ name: insert.station, no: "new", isNew: true, gate: insert.withGate ? insert.withGate : null, gateNew: true });
    });
    return out;
  }
  function stationDialog(p) {
    var d = G.me("flow.edit", { project: p.id });
    var order = G.flowOf(p).stations.filter(function (s) { return s.id !== "close"; });
    var agents = G.store.get("agents");
    var dr = { name: "", agent: (agents.find(function (a) { return a.id === "ag-review"; }) || agents[0]).id, purpose: "", wip: 5, after: (order.find(function (s) { return s.id === "review"; }) || order[order.length - 1]).id, gate: false, gName: "", gKind: "human", gRoles: ["line_lead"] };
    var holder = h("div", { class: "form-grid" }), err = h("div", { class: "form-err", role: "alert" }), pv = h("div", { class: "pcf-pv-wrap" });
    function paintPv() { G.clear(pv); pv.appendChild(h("span", { class: "kicker" }, "Preview")); pv.appendChild(previewStrip(stripFor(p, { station: dr.name || "New station", after: dr.after, withGate: dr.gate ? (dr.gName || "gate") : null }), "Flow with the new station after " + G.find.station(dr.after).name)); }
    function draw() {
      G.clear(holder);
      var name = h("input", { id: "pcf-ns-name", class: "input", value: dr.name, placeholder: "Load test", autocomplete: "off" }); name.addEventListener("input", function () { dr.name = name.value; paintPv(); });
      var purpose = h("input", { id: "pcf-ns-purpose", class: "input", value: dr.purpose, placeholder: "What the agent checks or produces here" }); purpose.addEventListener("input", function () { dr.purpose = purpose.value; });
      var wip = h("input", { id: "pcf-ns-wip", type: "number", min: "1", max: "30", class: "input mono pcf-num", value: String(dr.wip) }); wip.addEventListener("input", function () { dr.wip = parseInt(wip.value, 10) || 5; });
      var gname = h("input", { id: "pcf-ns-gname", class: "input", value: dr.gName, placeholder: "Load test sign-off", disabled: !dr.gate }); gname.addEventListener("input", function () { dr.gName = gname.value; paintPv(); });
      G.append(holder, [
        h("div", { class: "form-row" }, G.field("Station name", name), G.field("WIP limit", wip)),
        h("div", { class: "form-row" },
          G.field("Staffing agent", G.select("pcf-ns-agent", agents.map(function (a) { return { value: a.id, label: a.name + " · " + (G.find.station(a.station) || { name: a.station || "no station" }).name }; }), dr.agent, function (v) { dr.agent = v; })),
          G.field("Position", G.select("pcf-ns-after", order.map(function (s) { return { value: s.id, label: "After " + s.no + " " + s.name }; }), dr.after, function (v) { dr.after = v; paintPv(); }), "Close always stays last.")),
        G.field("Purpose", purpose),
        h("label", { class: "check", for: "pcf-ns-gate" }, h("input", { type: "checkbox", id: "pcf-ns-gate", checked: dr.gate, onChange: function (e) { dr.gate = e.target.checked; draw(); focusLater("pcf-ns-gate"); } }), "Add a gate after this station"),
        dr.gate ? h("div", { class: "pcf-fs" },
          h("div", { class: "form-row" }, G.field("Gate name", gname),
            G.field("Kind", G.select("pcf-ns-gkind", [{ value: "human", label: "Human: approver rules" }, { value: "mixed", label: "Mixed: checks, then a person" }, { value: "auto", label: "Automatic: checks only" }], dr.gKind, function (v) { dr.gKind = v; draw(); focusLater("pcf-ns-gkind"); }))),
          dr.gKind !== "auto" ? G.field("Approver roles", rolePicker("pcf-ns-gr", dr.gRoles, function (ids) { dr.gRoles = ids; })) : null) : null,
        pv, err]);
      paintPv();
    }
    draw();
    G.dialog({ title: "Add a station to " + p.name, kicker: "Flow · custom station", wide: true, sub: "The station appears on this project's belt, board and traveler. Work classes travel it unless their route skips it.", body: h("div", null, G.lockNote(d, "Adding stations"), holder),
      actions: [{ label: "Cancel" }, { label: "Add station", kind: "primary", submit: true, id: "pcf-ns-ok", guard: d, onClick: function (close) {
        if (dr.name.trim().length < 2) { err.textContent = "Name the station."; return; }
        if (dr.gate && dr.gName.trim().length < 2) { err.textContent = "Name the gate, or untick it."; return; }
        if (dr.gate && dr.gKind !== "auto" && !dr.gRoles.length) { err.textContent = "Pick at least one approver role for the gate."; return; }
        var r = G.ops.addStation(p.id, { name: dr.name.trim(), agent: dr.agent, purpose: dr.purpose.trim(), wip: dr.wip, gate: dr.gate ? { name: dr.gName.trim(), kind: dr.gKind, roles: dr.gKind === "auto" ? [] : dr.gRoles, required: 1, purpose: "Sign-off after " + dr.name.trim() + "." } : null }, dr.after);
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg + (dr.gate ? " Gate added after it." : ""), "ok"); close();
      } }] });
  }
  function rolePicker(idp, sel, onChange) {
    var cur = sel.slice();
    return h("div", { class: "check-grid" }, PROJECT_ROLES().filter(function (r) { return r.id !== "viewer"; }).map(function (ro) {
      var id = idp + "-" + ro.id;
      return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: cur.indexOf(ro.id) >= 0, onChange: function (e) { cur = e.target.checked ? cur.concat([ro.id]) : cur.filter(function (x) { return x !== ro.id; }); onChange(cur); } }), ro.name, ro.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null);
    }));
  }
  function gateDialog(p) {
    var d = G.me("flow.edit", { project: p.id });
    var f = G.flowOf(p);
    var free = f.stations.filter(function (s) { return s.id !== "close" && !f.gates.some(function (g) { return g.after === s.id; }) && !G.GATES.some(function (g) { return g.after === s.id && !(p.flow.gates[g.id] || {}).absent; }); });
    var dr = { name: "", label: "", after: free.length ? free[0].id : "", kind: "human", roles: ["line_lead"], required: 1, purpose: "" };
    var holder = h("div", { class: "form-grid" }), err = h("div", { class: "form-err", role: "alert" }), pv = h("div", { class: "pcf-pv-wrap" });
    function paintPv() { G.clear(pv); if (!dr.after) return; pv.appendChild(h("span", { class: "kicker" }, "Preview")); pv.appendChild(previewStrip(stripFor(p, { gateAfter: dr.after, gateName: dr.name || "new gate" }), "Flow with the new gate after " + G.find.station(dr.after).name)); }
    function draw() {
      G.clear(holder);
      if (!free.length) { holder.appendChild(G.emptyState({ id: "pcf-ng-none", icon: "gate", title: "Every station already has a gate", text: "A station can have one gate after it. Add a custom station first; you can create its gate in the same step." })); return; }
      var name = h("input", { id: "pcf-ng-name", class: "input", value: dr.name, placeholder: "Load test sign-off", autocomplete: "off" }); name.addEventListener("input", function () { dr.name = name.value; paintPv(); });
      var label = h("input", { id: "pcf-ng-label", class: "input mono", value: dr.label, maxlength: "5", placeholder: "GL" }); label.addEventListener("input", function () { dr.label = label.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
      var purpose = h("input", { id: "pcf-ng-purpose", class: "input", value: dr.purpose, placeholder: "What has to be true to pass" }); purpose.addEventListener("input", function () { dr.purpose = purpose.value; });
      G.append(holder, [
        h("div", { class: "form-row" }, G.field("Gate name", name), G.field("Short label", label, "Shown in the diamond. Letters and digits.")),
        h("div", { class: "form-row" },
          G.field("After station", G.select("pcf-ng-after", free.map(function (s) { return { value: s.id, label: s.no + " " + s.name }; }), dr.after, function (v) { dr.after = v; paintPv(); }), "Only stations without a gate are listed."),
          G.field("Kind", G.select("pcf-ng-kind", [{ value: "human", label: "Human: approver rules" }, { value: "mixed", label: "Mixed: checks, then a person" }, { value: "auto", label: "Automatic: checks only" }], dr.kind, function (v) { dr.kind = v; draw(); focusLater("pcf-ng-kind"); }))),
        dr.kind !== "auto" ? h("div", { class: "form-row" }, G.field("Approver roles", rolePicker("pcf-ng-r", dr.roles, function (ids) { dr.roles = ids; })),
          G.field("Approvals needed", (function () { var n = h("input", { id: "pcf-ng-req", type: "number", min: "1", max: "5", class: "input mono pcf-num", value: String(dr.required) }); n.addEventListener("input", function () { dr.required = parseInt(n.value, 10) || 1; }); return n; })())) : null,
        G.field("Purpose", purpose), pv, err]);
      paintPv();
    }
    draw();
    G.dialog({ title: "Add a gate to " + p.name, kicker: "Flow · custom gate", wide: true, sub: "Named approvers, conditions and escalation are edited on the Approvers tab once the gate exists.", body: h("div", null, G.lockNote(d, "Adding gates"), holder),
      actions: [{ label: "Cancel" }, { label: "Add gate", kind: "primary", submit: true, id: "pcf-ng-ok", guard: free.length ? d : { allowed: false, reason: "Every station already has a gate.", needs: "" }, onClick: function (close) {
        if (dr.name.trim().length < 2) { err.textContent = "Name the gate."; return; }
        if (dr.kind !== "auto" && !dr.roles.length) { err.textContent = "Pick at least one approver role."; return; }
        var r = G.ops.addGate(p.id, { name: dr.name.trim(), label: dr.label || undefined, after: dr.after, kind: dr.kind, roles: dr.kind === "auto" ? [] : dr.roles, required: dr.required, purpose: dr.purpose.trim() });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }
  function bayDialog(p) {
    var d = G.me("flow.edit", { project: p.id });
    var name = h("input", { id: "pcf-nb-name", class: "input", placeholder: "Vendor review", autocomplete: "off" });
    var desc = h("input", { id: "pcf-nb-desc", class: "input", placeholder: "Waiting for a reply from the vendor" });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: "Add a bay to " + p.name, kicker: "Flow · custom bay", sub: "Bays sit off the main belt. Work orders can be parked there and returned.", body: h("div", { class: "form-grid" }, G.lockNote(d, "Adding bays"), G.field("Bay name", name), G.field("What waits here", desc), err),
      actions: [{ label: "Cancel" }, { label: "Add bay", kind: "primary", submit: true, id: "pcf-nb-ok", guard: d, onClick: function (close) {
        if (name.value.trim().length < 2) { err.textContent = "Name the bay."; return; }
        var r = G.ops.addBay(p.id, { name: name.value.trim(), desc: desc.value.trim() });
        if (!r.ok) { err.textContent = r.msg; return; }
        G.toast(r.msg, "ok"); close();
      } }] });
  }

  function flowTab(p) {
    var d = G.me("project.config", { project: p.id });
    var fd = G.me("flow.edit", { project: p.id });
    var f = G.flowOf(p);
    var wos = wosLive(p);
    if (!p.flow.classes.some(function (c) { return c.id === ui.flowCls; })) ui.flowCls = p.flow.classes[0].id;
    var rt = routeText(p, ui.flowCls);
    var cls = G.classOf(p, ui.flowCls);
    var preview = h("section", { class: "panel pcf-preview", "aria-label": "Live route preview" },
      h("div", { class: "pcf-preview-head" }, h("span", { class: "kicker" }, "Live preview · " + f.stations.length + " stations, " + f.gates.length + " gates, " + f.bays.length + " bays"),
        G.field("Class", G.select("pcf-flow-cls", p.flow.classes.map(function (c) { return { value: c.id, label: c.name + (c.enabled === false ? " (off)" : "") + (c.custom ? " (custom)" : "") }; }), ui.flowCls, function (v) { ui.flowCls = v; G.rerender(); }))),
      G.miniBelt({ project: p, cls: ui.flowCls, labels: true }),
      h("p", { class: "small pcf-route-t", "aria-live": "polite" }, h("strong", null, cls.name + ": "), rt.stations, h("br"), h("span", { class: "muted" }, "Gates " + (rt.gates || "none") + (rt.skipped.length ? " · skips " + rt.skipped.join(", ") : ""))));
    var n = f.stations.length;
    var stationRows = f.stations.map(function (s, i) {
      var cfg = p.flow.stations[s.id];
      var here = wos.filter(function (w) { return w.station === s.index && !w.bay; }).length;
      var ag = G.find.agent(s.agent);
      var fixed = s.id === "intake" || s.id === "close";
      var upWhy = fixed ? (s.id === "intake" ? "Intake stays first." : "Close stays last.") : i <= 1 ? "Intake stays first." : null;
      var downWhy = fixed ? (s.id === "intake" ? "Intake stays first." : "Close stays last.") : i >= n - 2 ? "Close stays last." : null;
      return h("tr", { class: (cfg.enabled ? "" : "is-disabled") + (s.custom ? " is-custom" : "") },
        h("td", { class: "mono" }, s.no), h("th", { scope: "row" }, s.name, s.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null, h("div", { class: "muted small" }, ag ? ag.name : s.agent)),
        h("td", null, s.id === "intake" ? h("span", { "data-tip": "Intake is always on: every work order starts there.", tabindex: "0", class: "muted small" }, G.icon("lock"), " always on") : G.toggle("pcf-st-" + s.id, cfg.enabled, function (v) { res(G.ops.setProject(p.id, "flow.stations." + s.id + ".enabled", v), s.name + (v ? " turned on." : " turned off.")); }, d, s.name + " on")),
        h("td", null, numInput("pcf-wip-" + s.id, cfg.wip, 1, 30, function (v) { res(G.ops.setProject(p.id, "flow.stations." + s.id + ".wip", v), s.name + " WIP limit set to " + v + "."); }, d, s.name + " WIP limit")),
        h("td", { class: "num mono" + (here > cfg.wip ? " neg" : "") }, here + (here > cfg.wip ? " over" : "")),
        h("td", null, s.id === "build" ? h("div", { class: "pcf-slots" }, numInput("pcf-slots", p.flow.slots, 1, 8, function (v) { res(G.ops.setProject(p.id, "flow.slots", v), "Coding slots set to " + v + "."); }, d, "Coding slots"), h("span", { class: "small muted" }, G.slotsUsed(p.id).length + " in use")) : null),
        h("td", { class: "pcf-order" }, fixed ? h("span", { class: "muted small pcf-fixed", "data-tip": s.id === "intake" ? "Intake stays first." : "Close stays last.", tabindex: "0" }, G.icon("lock"), s.id === "intake" ? " first" : " last") : null,
          fixed ? null : G.btn("", { small: true, kind: "ghost", icon: "up", id: "pcf-mv-up-" + s.id, aria: "Move " + s.name + " earlier", guard: fd, disabledReason: fd.allowed ? upWhy : null, onClick: function () { res(G.ops.moveStation(p.id, s.id, -1)); focusLater("pcf-mv-up-" + s.id); } }),
          fixed ? null : G.btn("", { small: true, kind: "ghost", icon: "down", id: "pcf-mv-dn-" + s.id, aria: "Move " + s.name + " later", guard: fd, disabledReason: fd.allowed ? downWhy : null, onClick: function () { res(G.ops.moveStation(p.id, s.id, 1)); focusLater("pcf-mv-dn-" + s.id); } }),
          s.custom ? G.btn("Remove", { small: true, kind: "ghost", icon: "x", id: "pcf-st-rm-" + s.id, aria: "Remove " + s.name, guard: fd, disabledReason: fd.allowed && here ? here + " work order" + (here > 1 ? "s are" : " is") + " at " + s.name + ". Move them first." : null, onClick: function () {
            G.typedConfirm({ title: "Remove " + s.name, kicker: "Flow · " + p.name, sub: "Its gate goes too. Routes skip it from now on. History keeps the station's past entries.", phrase: s.name, okLabel: "Remove station", guard: fd, onOk: function () { var r = G.ops.removeStation(p.id, s.id); G.toast(r.msg, r.ok ? "ok" : "error"); return r; } });
          } }) : null));
    });
    var gateRows = f.gates.map(function (g) {
      var on = p.flow.gates[g.id].enabled;
      var gs = G.gateState(p, g.id, wos);
      var mode = G.gateKind(p, g.id);
      var modeOpts = [{ value: "human", label: "Human: approver rules" }, { value: "mixed", label: "Mixed: checks, then a person" }, { value: "auto", label: "Automatic: checks only" }].filter(function (o) { return g.id === "G0G1" ? o.value === "human" : g.id === "G6" ? o.value !== "auto" : true; });
      var kind = h("div", null, G.select("pcf-gmode-" + g.id, modeOpts, mode, function (v) { res(G.ops.setGateMode(p.id, g.id, v)); }, { disabled: !d.allowed || g.id === "G0G1", "aria-label": g.label + " mode" }),
        mode !== "human" && (g.checks || []).length ? h("div", { class: "muted small" }, g.checks.join(", ")) : null);
      return h("tr", { class: (on ? "" : "is-disabled") + (g.custom ? " is-custom" : "") },
        h("td", null, G.gateDiamond({ gateId: g.id, state: gs.state, count: gs.waiting || gs.failing, size: "sm" })),
        h("th", { scope: "row" }, h("span", { class: "mono" }, g.label), " " + g.name, g.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null, h("div", { class: "muted small" }, "after " + G.find.station(g.after).name)),
        h("td", { class: "small" }, kind),
        h("td", null, g.id === "G0G1" ? h("span", { "data-tip": "The brief confirmation gate cannot be turned off.", tabindex: "0", class: "muted small" }, G.icon("lock"), " always on") : G.toggle("pcf-gate-" + g.id, on, function (v) { res(G.ops.setProject(p.id, "flow.gates." + g.id + ".enabled", v), g.label + (v ? " turned on." : " turned off.")); }, d, g.label + " on")),
        h("td", null, mode === "auto" ? h("span", { class: "muted small" }, "no approvers") : G.btn("Approvers", { small: true, kind: "ghost", id: "pcf-gate-ap-" + g.id, onClick: function () { ui.tab = "approvers"; ui.gate = g.id; G.rerender(); } })));
    });
    var bayRows = f.bays.map(function (b) {
      var here = wos.filter(function (w) { return w.bay === b.id; }).length;
      return h("li", { class: "pcf-bay" + (b.custom ? " is-custom" : "") }, h("span", { class: "pcf-bay-n" }, b.name, b.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null), h("span", { class: "muted small" }, b.desc || ""), h("span", { class: "mono small" }, here + " parked"));
    });
    function setClasses(fn) { var arr = clone(p.flow.classes); fn(arr); res(G.ops.setProject(p.id, "flow.classes", arr), "Class routes saved."); }
    return h("div", { class: "pcf-stack" }, G.lockNote(d, "Flow settings"), preview,
      G.panel("Stations, WIP limits and slots", h("div", { class: "table-scroll" }, h("table", { class: "table table-compact pcf-st-table" }, h("thead", null, h("tr", null, h("th", null, "No"), h("th", null, "Station"), h("th", null, "On"), h("th", null, "WIP limit"), h("th", { class: "num" }, "WIP now"), h("th", null, "Coding slots"), h("th", null, "Order"))), h("tbody", null, stationRows))),
        { flush: true, tools: G.btn("Add station", { small: true, icon: "plus", id: "pcf-add-station", guard: fd, onClick: function () { stationDialog(p); } }) }),
      h("div", { class: "two-col pcf-flow-cols" },
        G.panel("Gates", h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" }, h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Gate"), h("th", null, "Kind"), h("th", null, "On"), h("th", null, ""))), h("tbody", null, gateRows))),
          { flush: true, tools: G.btn("Add gate", { small: true, icon: "plus", id: "pcf-add-gate", guard: fd, onClick: function () { gateDialog(p); } }) }),
        G.panel("Bays off the main belt", h("ul", { class: "plain-list pcf-bays" }, bayRows),
          { tools: G.btn("Add bay", { small: true, icon: "plus", id: "pcf-add-bay", guard: fd, onClick: function () { bayDialog(p); } }) })),
      G.panel("Class routes", h("div", null,
        h("p", { class: "small muted pcf-pad" }, "Ticked stations are on the class's route. Select a class to preview its route on the belt above. Turning a class off stops the Intake agent from proposing it. Add or edit classes on the ", h("button", { type: "button", class: "linkish", id: "pcf-to-classes", onClick: function () { ui.tab = "classes"; G.rerender(); } }, "Work classes"), " tab."),
        routeMatrix({ project: p, classes: p.flow.classes, stationsOff: f.stations.filter(function (s) { return !s.enabled; }).map(function (s) { return s.id; }), decision: d, selected: ui.flowCls, idp: "pcf-rm",
          onSelect: function (id) { ui.flowCls = id; G.rerender(); },
          onToggle: function (cid, sid, travels) { setClasses(function (arr) { var c = arr.find(function (x) { return x.id === cid; }); c.skips = travels ? c.skips.filter(function (x) { return x !== sid; }) : c.skips.concat([sid]); }); ui.flowCls = cid; },
          onEnable: function (cid, v) { if (!v && wos.some(function (w) { return w.cls === cid; })) { G.toast("Open work orders use " + G.classOf(p, cid).name + ". Reclassify or finish them first.", "error"); G.rerender(); return; } setClasses(function (arr) { arr.find(function (x) { return x.id === cid; }).enabled = v; }); } }),
        h("div", { class: "pcf-pad" }, G.btn("Reset routes to the template", { small: true, kind: "ghost", icon: "undo", id: "pcf-rm-reset", guard: d, onClick: function () {
          var tpl = G.find.template(p.template) || G.store.get("templates")[0];
          var fresh = G.flowFrom(tpl).classes;
          fresh.forEach(function (c) { var cur = p.flow.classes.find(function (x) { return x.id === c.id; }); if (cur) c.enabled = cur.enabled; });
          p.flow.classes.filter(function (c) { return c.custom; }).forEach(function (c) { fresh.push(clone(c)); });
          res(G.ops.setProject(p.id, "flow.classes", fresh), "Built-in class routes reset to the template. Custom classes kept.");
        } }))), { flush: true }));
  }

  /* ---------- work classes (ops: addClass, updateClass; trust ceilings: saveCeiling, removeCeiling) ---------- */
  var TOKENS = [["cls-feature", "Blue"], ["cls-bug", "Rust"], ["cls-hotfix", "Pink"], ["cls-epic", "Violet"], ["cls-chore", "Slate"], ["cls-refactor", "Teal"], ["cls-security", "Red"], ["cls-docs", "Green"], ["cls-spike", "Ochre"]];
  var SHAPES = [["bar", "Bar"], ["arrow", "Arrow"], ["wide", "Wide bar"]];
  function chipOf(c) {
    var el = G.classChip(c.id, { small: true });
    if (c.custom || c.shape) el.classList.add("pcf-shape-" + (c.shape || (c.id === "hotfix" || c.id === "security" ? "arrow" : c.id === "epic" ? "wide" : "bar")));
    return el;
  }
  function projectCeiling(p, clsId) { return (G.store.get("trust").ceilings || []).find(function (c) { var w = c.when || {}; return w.project === p.id && w.cls === clsId && !w.gate && !w.regulated; }); }
  function classDialog(p, c) {
    var d = G.me("class.edit", { project: p.id });
    var isNew = !c;
    var f = G.flowOf(p);
    var dr = c ? clone(c) : { id: "", name: "", skips: [], priority: "P2", slaH: 72, est: "M", token: "cls-chore", shape: "bar", hints: [], gates: [], enabled: true, custom: true };
    if (!dr.hints) dr.hints = []; if (!dr.gates) dr.gates = [];
    dr.hintsText = dr.hints.join(", ");
    var holder = h("div", { class: "form-grid" }), err = h("div", { class: "form-err", role: "alert" }), pv = h("div", { class: "pcf-pv-wrap" });
    function fakeProject() { var x = { id: "preview:" + p.id, name: p.name, flow: clone(p.flow), approvers: p.approvers, teams: [], budget: p.budget }; var id = dr.id || "__new"; var cc = Object.assign(clone(dr), { id: id }); x.flow.classes = x.flow.classes.filter(function (k) { return k.id !== id; }).concat([cc]); return { proj: x, id: id }; }
    function paintPv() {
      G.clear(pv);
      var fp = fakeProject();
      var route = G.route(fp.proj, fp.id), gates = G.routeGates(fp.proj, fp.id);
      var chip = h("span", { class: "cls cls-sm " + (dr.custom ? dr.token : "cls-" + dr.id) + " pcf-shape-" + (dr.shape || "bar") }, h("span", { class: "cls-mark", "aria-hidden": "true" }), dr.name || "New class");
      G.append(pv, [h("div", { class: "pcf-pv-head" }, h("span", { class: "kicker" }, "Preview"), chip),
        G.miniBelt({ project: fp.proj, cls: fp.id, wos: [], labels: true }),
        h("p", { class: "small", "aria-live": "polite" }, route.map(function (sid) { return G.find.station(sid).name; }).join(" → "), h("br"), h("span", { class: "muted" }, "Gates " + (gates.map(function (g) { return G.gateDef(g).label; }).join(", ") || "none") + " · SLA " + dr.slaH + " h · " + dr.priority))]);
    }
    function draw() {
      G.clear(holder);
      var name = h("input", { id: "pcf-cl-name", class: "input", value: dr.name, placeholder: "Data migration", autocomplete: "off", disabled: !isNew && !dr.custom });
      name.addEventListener("input", function () { dr.name = name.value; paintPv(); });
      var sla = h("input", { id: "pcf-cl-sla", type: "number", min: "1", max: "720", class: "input mono pcf-num", value: String(dr.slaH) }); sla.addEventListener("input", function () { dr.slaH = parseInt(sla.value, 10) || 72; paintPv(); });
      var hints = h("input", { id: "pcf-cl-hints", class: "input", value: dr.hintsText, placeholder: "migrate, backfill, schema" }); hints.addEventListener("input", function () { dr.hintsText = hints.value; });
      var tokenLocked = !dr.custom;
      G.append(holder, [
        h("div", { class: "form-row" }, G.field("Class name", name, !isNew && !dr.custom ? "Built-in classes keep their name." : null),
          G.field("Colour", G.select("pcf-cl-token", TOKENS.map(function (t) { return { value: t[0], label: t[1] }; }), dr.token || "cls-" + dr.id, function (v) { dr.token = v; paintPv(); }, { disabled: tokenLocked, "aria-label": "Colour token" }), tokenLocked ? "Built-in classes keep their colour." : null),
          G.field("Mark shape", G.select("pcf-cl-shape", SHAPES.map(function (t) { return { value: t[0], label: t[1] }; }), dr.shape || "bar", function (v) { dr.shape = v; paintPv(); }, { disabled: tokenLocked, "aria-label": "Mark shape" }))),
        h("div", { class: "form-row" },
          G.field("Priority", G.select("pcf-cl-prio", ["P0", "P1", "P2", "P3"], dr.priority, function (v) { dr.priority = v; paintPv(); })),
          G.field("SLA (hours)", sla),
          G.field("Typical size", G.select("pcf-cl-est", ["S", "M", "L", "XL"], dr.est || "M", function (v) { dr.est = v; }))),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Route: stations it travels"), h("div", { class: "check-grid" }, f.stations.map(function (s) {
          var id = "pcf-cl-st-" + s.id, fixed = s.id === "intake" || s.id === "close";
          return h("label", { class: "check", for: id, "data-tip": fixed ? s.name + " is on every route." : !s.enabled ? s.name + " is off for the whole project." : null },
            h("input", { type: "checkbox", id: id, checked: dr.skips.indexOf(s.id) < 0, disabled: fixed, onChange: function (e) { dr.skips = e.target.checked ? dr.skips.filter(function (x) { return x !== s.id; }) : dr.skips.concat([s.id]); paintPv(); } }), s.no + " " + s.name, s.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null);
        }))),
        h("div", { class: "field" }, h("div", { class: "field-label" }, "Required human gates"), h("p", { class: "small muted" }, "Leave all unticked to require every human gate on the route. Automatic gates always run."),
          h("div", { class: "check-grid" }, f.gates.filter(function (g) { return g.id !== "G0G1" && g.kind !== "auto"; }).map(function (g) {
            var id = "pcf-cl-g-" + g.id;
            return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: dr.gates.indexOf(g.id) >= 0, onChange: function (e) { dr.gates = e.target.checked ? dr.gates.concat([g.id]) : dr.gates.filter(function (x) { return x !== g.id; }); paintPv(); } }), g.label + " " + g.name);
          }))),
        G.field("Classifier hints", hints, "Comma-separated words. When a request mentions one, the Intake agent proposes this class."),
        pv, err]);
      paintPv();
    }
    draw();
    G.dialog({ title: isNew ? "Add a work class to " + p.name : "Edit " + dr.name, kicker: "Work classes · " + p.name, wide: true, body: h("div", null, G.lockNote(d, "Editing work classes"), holder),
      actions: [{ label: "Cancel" }, { label: isNew ? "Add class" : "Save class", kind: "primary", submit: true, id: "pcf-cl-ok", guard: d, onClick: function (close) {
        if (dr.name.trim().length < 2) { err.textContent = "Name the class."; return; }
        var hintsArr = dr.hintsText.split(",").map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
        var patch = { skips: dr.skips, priority: dr.priority, slaH: dr.slaH, est: dr.est, hints: hintsArr, gates: dr.gates };
        if (dr.custom) { patch.token = dr.token; patch.shape = dr.shape; }
        var r = isNew ? G.ops.addClass(p.id, Object.assign({ name: dr.name.trim() }, patch)) : G.ops.updateClass(p.id, c.id, dr.custom ? Object.assign({ name: dr.name.trim() }, patch) : patch);
        if (!r.ok) { err.textContent = r.msg; return; }
        if (isNew && r.cls) ui.flowCls = r.cls.id;
        G.toast(r.msg, "ok"); close();
      } }] });
  }
  function classesTab(p) {
    var d = G.me("class.edit", { project: p.id });
    var td = G.me("trust.criteria");
    var wos = G.store.get("workOrders").filter(function (w) { return w.project === p.id; });
    var live = wos.filter(G.homeKit.inFlight);
    var f = G.flowOf(p);
    var rows = p.flow.classes.map(function (c) {
      var rt = routeText(p, c.id);
      var inUse = live.filter(function (w) { return w.cls === c.id; }).length;
      var ceil = G.trust.ceiling(p.id, c.id, null);
      var own = projectCeiling(p, c.id);
      var ceilSel = G.select("pcf-cl-ceil-" + c.id, [{ value: "", label: "No project cap" }].concat([0, 1, 2, 3, 4].map(function (l) { return { value: String(l), label: "Cap at L" + l + " " + G.trust.level(l).name }; })), own ? String(own.max) : "", function (v) {
        var r;
        if (v === "") r = own ? G.ops.removeCeiling(own.id) : { ok: true, msg: "No project cap." };
        else r = G.ops.saveCeiling({ id: own ? own.id : undefined, text: c.name + " on " + p.name + " is capped at L" + v, when: { project: p.id, cls: c.id }, max: +v, enabled: true });
        res(r); focusLater("pcf-cl-ceil-" + c.id);
      }, { disabled: !td.allowed, "aria-label": "Trust ceiling for " + c.name });
      if (!td.allowed) G.guard(ceilSel, td);
      var others = ceil.ceilings.filter(function (x) { return !own || x.id !== own.id; });
      return h("tr", { class: c.enabled === false ? "is-disabled" : "" },
        h("th", { scope: "row" }, chipOf(c), c.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null),
        h("td", null, G.toggle("pcf-cl-en-" + c.id, c.enabled !== false, function (v) { res(G.ops.updateClass(p.id, c.id, { enabled: v })); focusLater("pcf-cl-en-" + c.id); }, d.allowed && c.enabled !== false && inUse ? { allowed: false, reason: inUse + " open work order" + (inUse > 1 ? "s use " : " uses ") + c.name + ". Reclassify or finish them first.", needs: "" } : d, c.name + " enabled")),
        h("td", { class: "small" }, rt.skipped.length ? "skips " + rt.skipped.join(", ") : "every station", c.endsAfter ? h("div", { class: "muted" }, "ends after " + G.find.station(c.endsAfter).name) : null),
        h("td", { class: "small mono pcf-nowrap" }, (c.gates && c.gates.length ? c.gates.map(function (g) { return (G.gateDef(g) || { label: g }).label; }).join(", ") : "all on route")),
        h("td", { class: "num mono" }, (c.slaH || "-") + " h"),
        h("td", { class: "mono" }, c.priority || "-"),
        h("td", { class: "small" }, c.hints && c.hints.length ? c.hints.join(", ") : h("span", { class: "muted" }, "keyword model")),
        h("td", { class: "pcf-ceil" }, ceilSel, others.length ? h("div", { class: "muted small", "data-tip": others.map(function (x) { return x.id + ": " + x.text; }).join("; "), tabindex: "0" }, "Effective L" + ceil.max + " (" + others.map(function (x) { return x.id; }).join(", ") + ")") : h("div", { class: "muted small" }, "Effective L" + ceil.max)),
        h("td", { class: "num mono" }, String(inUse)),
        h("td", null, G.btn("Edit", { small: true, kind: "ghost", id: "pcf-cl-edit-" + c.id, aria: "Edit " + c.name, guard: d, onClick: function () { classDialog(p, c); } })));
    });
    return h("div", { class: "pcf-stack" }, G.lockNote(d, "Work classes"),
      G.panel("Work classes on " + p.name, h("div", null,
        h("p", { class: "small muted pcf-pad" }, f.classes.length + " of " + p.flow.classes.length + " classes on. The class decides the route, which human gates apply, the SLA and how the Intake agent recognises it. The trust cap limits how far agents may run unattended for that class here; factory-wide ceilings still apply."),
        h("div", { class: "table-scroll" }, h("table", { class: "table table-compact pcf-cl-table" },
          h("thead", null, h("tr", null, h("th", null, "Class"), h("th", null, "On"), h("th", null, "Route"), h("th", null, "Human gates"), h("th", { class: "num" }, "SLA"), h("th", null, "Priority"), h("th", null, "Classifier hints"), h("th", null, "Trust cap"), h("th", { class: "num" }, "Open"), h("th", null, ""))),
          h("tbody", null, rows)))), { flush: true, tools: G.btn("Add class", { small: true, icon: "plus", id: "pcf-add-class", guard: d, onClick: function () { classDialog(p, null); } }) }),
      td.allowed ? null : h("p", { class: "small muted" }, G.icon("lock"), " Trust caps need ", h("span", { class: "mono" }, "trust.criteria"), " (Factory Admin). They are shown read-only."));
  }

  /* ---------- approvers ---------- */
  function draftFor(p, gid) { var k = p.id + ":" + gid; if (!ui.drafts[k]) ui.drafts[k] = clone(p.approvers[gid]); return ui.drafts[k]; }
  function isDirty(p, gid) { var k = p.id + ":" + gid; return !!ui.drafts[k] && JSON.stringify(ui.drafts[k]) !== JSON.stringify(p.approvers[gid]); }
  function eligible(p, rule, extra) {
    return members(p).filter(function (x) {
      if (x.status !== "active") return false;
      var roles = G.rolesIn(x, p.id);
      return rule.people.indexOf(x.id) >= 0 || rule.roles.some(function (r) { return roles.indexOf(r) >= 0; }) || (extra && extra(x, roles));
    });
  }
  function condText(c) {
    var w = c.when.type === "class" ? (G.find.cls(c.when.value) || { name: c.when.value }).name : c.when.type === "path" ? "Changes under " + c.when.value : (c.when.value === "high" ? "High-risk changes" : "Normal-risk changes");
    var needs = c.needs.roles.map(roleName).concat(c.needs.people.map(G.actorName));
    return w + " need" + (c.when.type === "class" ? "s" : "") + " " + (needs.join(" or ") || "an approver") + (c.needs.oncall ? " who is on call" : "");
  }
  function approversTab(p) {
    var d = G.me("approvers.edit", { project: p.id });
    var locked = !d.allowed;
    var fg = G.flowOf(p).gates;
    var g = fg.find(function (x) { return x.id === ui.gate; }) || fg.find(function (x) { return x.id === "G5"; }) || fg[0];
    var wos = G.store.get("workOrders").filter(function (w) { return w.project === p.id && G.homeKit.inFlight(w); });
    var list = h("ul", { class: "pcf-gates", role: "list" }, fg.map(function (x) {
      var r = p.approvers[x.id];
      var gs = G.gateState(p, x.id, wos);
      var sum = G.gateKind(p, x.id) === "auto" ? "Automatic checks" : x.id === "G0G1" ? "Submitter confirms" : r.required + " of " + (r.roles.map(roleName).concat(r.people.map(G.actorName)).join(", ") || "nobody") + (r.conditions.length ? " · " + r.conditions.length + " condition" + (r.conditions.length > 1 ? "s" : "") : "");
      return h("li", null, h("button", { type: "button", id: "pcf-ap-g-" + x.id, class: "pcf-gate-btn" + (x.id === g.id ? " is-sel" : ""), "aria-current": x.id === g.id ? "true" : null, onClick: function () { ui.gate = x.id; G.rerender(); } },
        G.gateDiamond({ gateId: x.id, state: gs.state, count: gs.waiting || gs.failing, size: "sm" }),
        h("span", { class: "pcf-gate-main" }, h("span", null, h("span", { class: "mono" }, x.label), " " + x.name, x.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null, isDirty(p, x.id) ? h("span", { class: "chip chip-warn" }, "unsaved") : null), h("span", { class: "muted small" }, sum))));
    }));
    var editor;
    if (G.gateKind(p, g.id) === "auto") {
      editor = G.panel(g.label + " " + g.name, h("div", { class: "form-grid" }, h("p", null, g.purpose), h("p", { class: "muted small" }, "This gate is automatic in " + p.name + ". It passes when its checks pass; nobody approves it. Change its mode on the Flow tab."), g.checks.length ? h("ul", { class: "checklist" }, g.checks.map(function (c) { return h("li", { class: "ok" }, c); })) : h("p", { class: "muted small" }, "No checks: it passes straight through.")));
    } else editor = ruleEditor(p, g, d, locked);
    return h("div", { class: "pcf-stack" }, G.lockNote(d, "Approver rules"),
      h("div", { class: "pcf-ap" }, G.panel("Gates", list, { flush: true, cls: "pcf-ap-list" }), editor));
  }
  function ruleEditor(p, g, d, locked) {
    var gid = g.id;
    var r = draftFor(p, gid);
    var dirty = isDirty(p, gid);
    var mem = members(p);
    var elig = eligible(p, r);
    var err = h("div", { class: "form-err", role: "alert" });
    function upd(fn) { fn(r); G.rerender(); }
    var rolesGrid = h("div", { class: "check-grid" }, PROJECT_ROLES().map(function (ro) {
      var id = "pcf-ap-role-" + ro.id;
      return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: r.roles.indexOf(ro.id) >= 0, disabled: locked, onChange: function (e) { var on = e.target.checked; upd(function (x) { x.roles = on ? x.roles.concat([ro.id]) : x.roles.filter(function (y) { return y !== ro.id; }); }); } }), ro.name, ro.custom ? h("span", { class: "tag pcf-tag-custom" }, "custom") : null);
    }));
    var peopleGrid = h("div", { class: "check-grid" }, mem.map(function (x) {
      var id = "pcf-ap-person-" + x.id;
      return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id: id, checked: r.people.indexOf(x.id) >= 0, disabled: locked, onChange: function (e) { var on = e.target.checked; upd(function (y) { y.people = on ? y.people.concat([x.id]) : y.people.filter(function (z) { return z !== x.id; }); }); } }), x.name);
    }));
    var conds = h("ol", { class: "pcf-conds" }, r.conditions.map(function (c, i) {
      var idp = "pcf-ap-c" + i;
      var valueCtl = c.when.type === "class" ? G.select(idp + "-val", G.classesOf(p).map(function (x) { return { value: x.id, label: x.name }; }), c.when.value, function (v) { upd(function () { c.when.value = v; c.text = condText(c); }); }, { disabled: locked, "aria-label": "Class" })
        : c.when.type === "risk" ? G.select(idp + "-val", [{ value: "high", label: "High risk" }, { value: "normal", label: "Normal risk" }], c.when.value, function (v) { upd(function () { c.when.value = v; c.text = condText(c); }); }, { disabled: locked, "aria-label": "Risk" })
        : (function () { var inp = h("input", { id: idp + "-val", class: "input mono", value: c.when.value, disabled: locked, "aria-label": "Path prefix", placeholder: "/payments" }); inp.addEventListener("change", function () { upd(function () { c.when.value = inp.value.trim() || "/"; c.text = condText(c); }); }); return inp; })();
      return h("li", { class: "pcf-cond" },
        h("div", { class: "pcf-cond-when" }, h("span", { class: "kv-k" }, "When"),
          G.select(idp + "-type", [{ value: "class", label: "Class is" }, { value: "path", label: "Path under" }, { value: "risk", label: "Risk is" }], c.when.type, function (v) { upd(function () { c.when.type = v; c.when.value = v === "class" ? "hotfix" : v === "risk" ? "high" : "/payments"; c.text = condText(c); }); }, { disabled: locked, "aria-label": "Condition type" }),
          valueCtl),
        h("div", { class: "pcf-cond-needs" }, h("span", { class: "kv-k" }, "Also needs"),
          PROJECT_ROLES().filter(function (ro) { return ro.id !== "viewer"; }).map(function (ro) {
            var id = idp + "-r-" + ro.id;
            return h("label", { class: "check small", for: id }, h("input", { type: "checkbox", id: id, checked: c.needs.roles.indexOf(ro.id) >= 0, disabled: locked, onChange: function (e) { var on = e.target.checked; upd(function () { c.needs.roles = on ? c.needs.roles.concat([ro.id]) : c.needs.roles.filter(function (y) { return y !== ro.id; }); c.text = condText(c); }); } }), ro.name);
          }),
          h("label", { class: "check small", for: idp + "-oncall" }, h("input", { type: "checkbox", id: idp + "-oncall", checked: c.needs.oncall, disabled: locked, onChange: function (e) { var on = e.target.checked; upd(function () { c.needs.oncall = on; c.text = condText(c); }); } }), "who is on call")),
        h("div", { class: "pcf-cond-foot" }, h("span", { class: "small" }, G.icon("chevron"), " " + (c.text || condText(c))),
          G.btn("Remove", { small: true, kind: "ghost", icon: "x", id: idp + "-del", guard: d, onClick: function () { upd(function (x) { x.conditions.splice(i, 1); }); } })));
    }));
    function addCond(c) { upd(function (x) { c.id = "c" + Date.now().toString(36) + x.conditions.length; c.text = c.text || condText(c); x.conditions.push(c); }); }
    var people = G.store.get("people").filter(function (x) { return x.status === "active"; });
    var save = function () {
      if (gid !== "G0G1" && r.required < 1) { err.textContent = "A human gate needs at least one approval."; return; }
      if (!r.roles.length && !r.people.length) { err.textContent = "Pick at least one role or named person."; return; }
      if (r.required > elig.length) { err.textContent = "Needs " + r.required + " approvals but only " + elig.length + " eligible " + (elig.length === 1 ? "person is" : "people are") + " in " + p.name + "."; return; }
      if (r.conditions.some(function (c) { return !c.needs.roles.length && !c.needs.people.length; })) { err.textContent = "Every condition needs at least one role."; return; }
      var saved = (p.approvers[gid] && p.approvers[gid].conditions) || [];
      r.conditions.forEach(function (c) {
        var o = saved.find(function (x) { return x.id === c.id; });
        var same = o && JSON.stringify(o.when) === JSON.stringify(c.when) && JSON.stringify(o.needs) === JSON.stringify(c.needs);
        if (!c.text || (o && !same)) c.text = condText(c);
      });
      var x = G.ops.setProject(p.id, "approvers." + gid, clone(r));
      if (!x.ok) { err.textContent = x.msg; return; }
      delete ui.drafts[p.id + ":" + gid];
      G.toast(g.label + " approver rule saved.", "ok");
    };
    /* who-can-approve scenario */
    var sc = ui.scen;
    var fake = { cls: sc.cls, risk: sc.risk, paths: sc.path ? [sc.path] : [], repo: "", title: "" };
    var scConds = r.conditions.filter(function (c) { return c.when.type === "class" ? fake.cls === c.when.value : c.when.type === "risk" ? fake.risk === c.when.value : fake.paths.some(function (x) { return x.indexOf(c.when.value) === 0; }); });
    var pathIn = h("input", { id: "pcf-sc-path", class: "input mono", value: sc.path, placeholder: "/payments/refunds" });
    pathIn.addEventListener("change", function () { sc.path = pathIn.value.trim(); G.rerender(); });
    var away = elig.filter(function (x) { return x.away && x.away.to > Date.now(); });
    return h("section", { class: "panel pcf-rule", "aria-label": g.label + " approver rule" },
      h("div", { class: "panel-head" }, h("h2", { class: "panel-title" }, h("span", { class: "mono" }, g.label), " " + g.name), dirty ? h("span", { class: "chip chip-warn" }, "Unsaved changes") : h("span", { class: "muted small mono" }, "APR-" + gid)),
      h("div", { class: "panel-body form-grid" },
        h("p", { class: "small" }, g.purpose, r.note ? h("span", { class: "muted" }, " " + r.note) : null),
        h("fieldset", { class: "pcf-fs" }, h("legend", { class: "sub-h" }, "Who may approve"),
          G.field("Roles on " + p.name, rolesGrid), mem.length ? G.field("Named people", peopleGrid, "Named people may approve even without a listed role.") : null),
        h("fieldset", { class: "pcf-fs" }, h("legend", { class: "sub-h" }, "How many"),
          h("div", { class: "pcf-nofm" }, numInput("pcf-ap-required", r.required, gid === "G0G1" ? 1 : 1, 9, function (v) { upd(function (x) { x.required = v; }); }, d, "Approvals required"),
            h("span", null, "of " + elig.length + " eligible: "), h("span", { class: "small" }, elig.map(function (x) { return x.name + (x.oncall ? " (on call)" : "") + (x.away && x.away.to > Date.now() ? " (away)" : ""); }).join(", ") || "nobody yet")),
          h("div", { class: "toggle-row" }, h("label", { for: "pcf-ap-sod" }, "Author cannot approve (separation of duties)"), G.toggle("pcf-ap-sod", r.sod, function (v) { upd(function (x) { x.sod = v; }); }, d))),
        h("fieldset", { class: "pcf-fs" }, h("legend", { class: "sub-h" }, "Conditions"),
          r.conditions.length ? conds : h("p", { class: "muted small" }, "No conditions. Add one for classes, paths or risk that need extra approvers."),
          h("div", { class: "pcf-cond-add" },
            G.btn("Add condition", { small: true, icon: "plus", id: "pcf-ap-add", guard: d, onClick: function () { addCond({ when: { type: "class", value: "hotfix" }, needs: { roles: ["release_manager"], people: [], oncall: false } }); } }),
            G.btn("Hotfix needs Release Manager + on-call", { small: true, kind: "ghost", id: "pcf-ap-add-hotfix", guard: d, onClick: function () { addCond({ when: { type: "class", value: "hotfix" }, needs: { roles: ["release_manager"], people: [], oncall: true } }); } }),
            G.btn("Changes under /payments need Security", { small: true, kind: "ghost", id: "pcf-ap-add-path", guard: d, onClick: function () { addCond({ when: { type: "path", value: "/payments" }, needs: { roles: ["approver"], people: [], oncall: false }, text: "Changes under /payments need Security" }); } }))),
        h("fieldset", { class: "pcf-fs" }, h("legend", { class: "sub-h" }, "Escalation and delegation"),
          h("div", { class: "form-row pcf-esc" },
            G.field("Escalate after (hours)", numInput("pcf-ap-esc", r.escalateH || 0, 0, 240, function (v) { upd(function (x) { x.escalateH = v; }); }, d, "Escalate after hours"), "0 means never."),
            G.field("Fallback approver", G.select("pcf-ap-fallback", [{ value: "", label: "Project owner (" + G.actorName(p.owner) + ")" }].concat(people.map(function (x) { return { value: x.id, label: x.name }; })), r.fallback || "", function (v) { upd(function (x) { x.fallback = v || null; }); }, { disabled: locked }))),
          h("div", { class: "pcf-deleg" }, h("div", { class: "small strong" }, "Away and delegates"),
            h("ul", { class: "plain-list" }, elig.map(function (x) {
              var isAway = x.away && x.away.to > Date.now();
              return h("li", { class: "pcf-deleg-row" }, h("span", null, x.name), h("span", { class: "small " + (isAway ? "warn-text" : "muted") }, isAway ? "away until " + G.fmt.istDate(x.away.to) + ", " + G.actorName(x.away.delegate) + " approves instead" : "present"),
                G.btn(isAway ? "Change" : "Set away", { small: true, kind: "ghost", id: "pcf-away-" + x.id, guard: d, onClick: function () { awayDialog(p, x); } }),
                isAway ? G.btn("Clear", { small: true, kind: "ghost", id: "pcf-away-clr-" + x.id, guard: d, onClick: function () { setAway(p, x, null); } }) : null);
            })),
            away.length ? null : h("p", { class: "muted small" }, "Nobody eligible is away."))),
        h("fieldset", { class: "pcf-fs pcf-scen" }, h("legend", { class: "sub-h" }, "Try a work order"),
          h("div", { class: "form-row" },
            G.field("Class", G.select("pcf-sc-cls", G.classesOf(p).map(function (x) { return { value: x.id, label: x.name }; }), sc.cls, function (v) { sc.cls = v; G.rerender(); })),
            G.field("Risk", G.select("pcf-sc-risk", ["normal", "high"], sc.risk, function (v) { sc.risk = v; G.rerender(); })),
            G.field("Changed path", pathIn)),
          h("p", { class: "small", "aria-live": "polite" }, r.required + " approval" + (r.required > 1 ? "s" : "") + " from " + (r.roles.map(roleName).concat(r.people.map(G.actorName)).join(", ") || "nobody") + (r.sod ? ", not the author" : "") + (scConds.length ? "; plus: " + scConds.map(condText).join("; ") : "; no conditions apply") + ".")),
        err,
        h("div", { class: "form-actions" },
          G.btn("Save " + g.label + " rule", { kind: "primary", icon: "check", id: "pcf-ap-save", guard: d, disabledReason: !locked && !dirty ? "No unsaved changes." : null, onClick: save }),
          dirty ? G.btn("Discard changes", { kind: "ghost", id: "pcf-ap-discard", onClick: function () { delete ui.drafts[p.id + ":" + gid]; G.rerender(); } }) : null),
        h("div", { class: "sub-h" }, "Rule history"),
        G.historyList({ type: "gaterule", id: p.id + ":" + gid, limit: 6 })));
  }
  /* Local op: set or clear a person's away window and delegate. Audited through G.ops.change. */
  function setAway(p, person, away) {
    var r = G.ops.setAway(person.id, away, p.id);
    return res(r);
  }
  function awayDialog(p, person) {
    var opts = members(p).filter(function (x) { return x.id !== person.id && x.status === "active"; });
    var del = G.select("pcf-away-del", opts.map(function (x) { return { value: x.id, label: x.name + " · " + G.rolesIn(x, p.id).map(roleName).join(", ") }; }), person.away ? person.away.delegate : (opts[0] || {}).id);
    var days = G.select("pcf-away-days", [{ value: "1", label: "1 day" }, { value: "3", label: "3 days" }, { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }], "3");
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: person.name + " is away", kicker: "Delegation · " + p.name, sub: "While away, the delegate may approve wherever " + person.name + " could. Audited.",
      body: h("div", { class: "form-grid" }, G.field("Delegate", del), G.field("Away for", days), err),
      actions: [{ label: "Cancel" }, { label: "Set delegation", kind: "primary", submit: true, id: "pcf-away-ok", guard: G.me("approvers.edit", { project: p.id }), onClick: function (close) {
        if (!del.value) { err.textContent = "Pick a delegate."; return; }
        var r = setAway(p, person, { from: Date.now(), to: Date.now() + parseInt(days.value, 10) * G.DAY, delegate: del.value });
        if (r.ok) close(); else err.textContent = r.msg;
      } }] });
  }

  function notificationsTab(p) {
    var d = G.me("notify.edit", { project: p.id });
    var routes = p.notifications;
    var dl = G.store.get("deliveries").filter(function (x) { return x.project === p.id; }).slice(-6).reverse();
    function evName(id) { return G.notifyEventName(id); }
    return h("div", { class: "pcf-stack" }, G.lockNote(d, "Notification routes"),
      G.panel("Routes", h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
        h("thead", null, h("tr", null, h("th", null, "Event"), h("th", null, "Destinations"), h("th", null, "Conditions"), h("th", null, "On"))),
        h("tbody", null, routes.map(function (rt, i) {
          var c = rt.cond;
          var lockKill = (rt.event === "kill" || rt.event === "restore") && rt.enabled;
          return h("tr", null, h("td", null, evName(rt.event), h("div", { class: "mono small muted" }, rt.id)),
            h("td", { class: "small" }, rt.dest.map(function (x) { return h("div", { class: "mono" }, x.channel + " " + x.target); })),
            h("td", { class: "small" }, [c.classes.length ? c.classes.join(", ") : "any class", c.priority.length ? c.priority.join(", ") : "any priority", c.hours === "business" ? "business hours" : "any time"].join(" · ")),
            h("td", null, G.toggle("pcf-nr-" + rt.id, rt.enabled, function (v) { var arr = clone(routes); arr[i].enabled = v; res(G.ops.setProject(p.id, "notifications", arr), evName(rt.event) + " route " + (v ? "on." : "off.")); }, lockKill && d.allowed ? { allowed: false, reason: "Kill and restore notices must stay on.", needs: "" } : d, evName(rt.event) + " route on")));
        })))), { flush: true, tools: G.canSeeRoute("notifications") ? G.btn("Edit routes and cards", { small: true, kind: "ghost", id: "pcf-to-notify", onClick: function () { location.hash = "notifications"; } }) : null }),
      G.panel("Recent deliveries (simulated)", dl.length ? h("ul", { class: "plain-list small" }, dl.map(function (x) { return h("li", { class: "pcf-dl" }, h("span", { class: "mono muted" }, G.fmt.ist(x.at)), h("span", null, evName(x.event)), h("span", { class: "mono" }, x.channel + " " + x.target), h("span", { class: "outcome o-" + (x.status === "delivered" ? "ok" : "failed") }, x.status)); })) : G.empty("No deliveries yet", "Deliveries for this project appear here.")));
  }

  function mcpTab(p) {
    var d = G.me("project.config", { project: p.id });
    var servers = G.store.get("mcp");
    return h("div", { class: "pcf-stack" }, G.lockNote(d, "MCP servers for this project"),
      G.panel("MCP servers available to " + p.name, h("div", { class: "table-scroll" }, h("table", { class: "table table-compact" },
        h("thead", null, h("tr", null, h("th", null, "Server"), h("th", null, "Health"), h("th", null, "Sensitivity"), h("th", { class: "num" }, "Tools"), h("th", null, "Factory scope"), h("th", null, "Enabled here"))),
        h("tbody", null, servers.map(function (s) {
          var on = p.mcp.indexOf(s.id) >= 0;
          var scopeOk = s.projects === "all" || (s.projects || []).indexOf(p.id) >= 0;
          var dec = d.allowed && !scopeOk && !on ? { allowed: false, reason: s.name + " is not scoped to " + p.name + ". Change its scope in MCP servers first.", needs: "" } : d;
          return h("tr", null, h("th", { scope: "row" }, s.name, h("div", { class: "mono small muted" }, s.url)),
            h("td", null, h("span", { class: "pcf-health pcf-h-" + s.health }, G.icon(s.health === "healthy" ? "st-done" : "alert"), s.health)),
            h("td", { class: "small" }, s.sensitivity),
            h("td", { class: "num mono" }, s.tools.length + " (" + s.tools.filter(function (t) { return t.write; }).length + " write)"),
            h("td", { class: "small" }, s.projects === "all" ? "all projects" : (s.projects || []).length + " projects"),
            h("td", null, G.toggle("pcf-mcp-" + s.id, on, function (v) { res(G.ops.setProject(p.id, "mcp", v ? p.mcp.concat([s.id]) : p.mcp.filter(function (x) { return x !== s.id; })), s.name + (v ? " enabled for " : " disabled for ") + p.name + "."); }, dec, s.name + " enabled for " + p.name)));
        })))), { flush: true, tools: G.canSeeRoute("mcp") ? G.btn("Manage servers", { small: true, kind: "ghost", id: "pcf-to-mcp", onClick: function () { location.hash = "mcp"; } }) : null }));
  }

  function budgetTab(p) {
    var d = G.me("project.config", { project: p.id });
    var b = p.budget;
    var wos = G.store.get("workOrders").filter(function (w) { return w.project === p.id; });
    var byStation = G.flowOf(p).stations.map(function (s) { return { s: s, v: wos.reduce(function (a, w) { return a + w.history.filter(function (e) { return e.station === s.id; }).reduce(function (x, e) { return x + (e.cost || 0); }, 0); }, 0) }; });
    var max = Math.max.apply(null, byStation.map(function (x) { return x.v; })) || 1;
    var top = wos.map(function (w) { return { w: w, t: G.woTotals(w) }; }).sort(function (a, b2) { return b2.t.cost - a.t.cost; }).slice(0, 5);
    var ratio = b.monthly ? b.mtd / b.monthly : 0;
    return h("div", { class: "two-col" },
      G.panel("Monthly budget", h("div", { class: "form-grid" }, G.lockNote(d, "Budget"),
        h("div", { class: "pcf-bud-big" }, h("span", { class: "big-num" }, G.fmt.money0(b.mtd)), h("span", { class: "muted" }, " of " + G.fmt.money0(b.monthly) + " this month · " + G.fmt.pct(ratio))),
        G.meter(b.mtd, b.monthly, "Budget used", b.alertAt),
        ratio >= b.alertAt ? h("div", { class: "callout callout-warn small" }, G.icon("alert"), h("span", null, "Past the alert line. Project admins are emailed by the budget route.")) : null,
        h("div", { class: "form-row" },
          G.field("Monthly budget (USD)", numInput("pcf-bud-monthly", b.monthly, 100, 100000, function (v) { res(G.ops.setProject(p.id, "budget.monthly", v), "Monthly budget set to " + G.fmt.money0(v) + "."); }, d, "Monthly budget")),
          G.field("Alert at", G.select("pcf-bud-alert", [0.5, 0.7, 0.8, 0.9, 1].map(function (x) { return { value: String(x), label: G.fmt.pct(x) }; }), String(b.alertAt), function (v) { res(G.ops.setProject(p.id, "budget.alertAt", parseFloat(v)), "Budget alert at " + G.fmt.pct(parseFloat(v)) + "."); }, { disabled: !d.allowed }))))),
      h("div", { class: "pcf-stack" },
        G.panel("Agent spend by station (work orders on record)", h("ul", { class: "hm-bars" }, byStation.map(function (x) {
          var tip = x.s.name + ": " + G.fmt.money(x.v);
          return h("li", { class: "hm-bar-row is-ok", tabindex: "0", "data-tip": tip, "aria-label": tip, id: "pcf-bud-st-" + x.s.id }, h("span", { class: "hm-bar-l" }, x.s.no + " " + x.s.name), h("span", { class: "hm-bar-track", "aria-hidden": "true" }, h("span", { class: "hm-bar-fill", style: "width:" + (x.v / max * 100).toFixed(1) + "%" })), h("span", { class: "hm-bar-v mono" }, G.fmt.money(x.v)));
        }))),
        G.panel("Most expensive work orders", h("table", { class: "table table-compact" }, h("tbody", null, top.map(function (x) {
          return h("tr", null, h("td", null, h("button", { type: "button", class: "linkish mono", id: "pcf-bud-wo-" + x.w.id, onClick: function () { G.openTraveler(x.w.id); } }, x.w.id)), h("td", { class: "small" }, x.w.title), h("td", { class: "num mono" }, G.fmt.money(x.t.cost)));
        }))), { flush: true })));
  }

  function dangerTab(p) {
    var f = G.store.get("factory").killed;
    var imp = G.ops.killImpact("project", p.id);
    var kd = G.me("kill.project", { project: p.id }), rd = G.me("restore.project", { project: p.id }), ad = G.me("project.archive", { project: p.id });
    var archived = p.status === "archived";
    return h("div", { class: "pcf-stack pcf-danger" },
      h("section", { class: "panel pcf-dz" + (p.killed ? " is-killed" : ""), "aria-label": "Project kill switch" },
        h("div", { class: "panel-head" }, h("h2", { class: "panel-title" }, p.killed ? "Project killed" : "Kill this project"), h("span", { class: "mono small muted" }, "kill.project · restore.project")),
        h("div", { class: "panel-body form-grid" },
          p.killed ? h("div", { class: "pcf-kill-state" }, G.icon("st-kill"), h("div", null, h("strong", null, "KILLED"), " by " + G.actorName(p.killed.by) + ", " + G.fmt.stamp(p.killed.at) + ". " + p.killed.reason + " · work " + (p.killed.mode === "cancel" ? "cancelled" : "held in place")))
            : h("p", null, "A hard stop for " + p.name + ": " + imp.workOrders + " work orders, " + imp.running + " running agents, " + imp.slots + " coding slots and " + imp.prs + " open PRs. New submissions are refused until someone restores it. For a soft pause, pull the andon cord on the floor."),
          f ? h("div", { class: "callout callout-block small" }, G.icon("st-kill"), h("span", null, "The whole factory is killed. Restore it from the admin home.")) : null,
          G.lockNote(p.killed ? rd : kd, p.killed ? "Restoring this project" : "This kill switch"),
          h("div", { class: "form-actions" }, p.killed ? G.btn("Restore " + p.name, { kind: "primary", icon: "power", id: "pcf-restore", guard: rd, onClick: function () { G.restoreDialog("project", p.id); } })
            : G.btn("Kill " + p.name, { kind: "danger", icon: "st-kill", id: "pcf-kill", guard: archived ? { allowed: false, reason: p.name + " is archived.", needs: "" } : kd, onClick: function () { G.killDialog("project", p.id); } })))),
      h("section", { class: "panel pcf-dz", "aria-label": "Archive project" },
        h("div", { class: "panel-head" }, h("h2", { class: "panel-title" }, archived ? "Archived" : "Archive this project"), h("span", { class: "mono small muted" }, "project.archive")),
        h("div", { class: "panel-body form-grid" },
          h("p", null, archived ? p.name + " is archived. It is read-only, hidden from people without a factory role, and refuses new work." : "Archiving makes " + p.name + " read-only, hides it from project members and refuses new work orders. In-flight work stops. You must type the project name to confirm."),
          G.lockNote(ad, "Archiving"),
          archived ? h("div", { class: "form-actions" }, G.btn("Unarchive " + p.name, { kind: "primary", icon: "undo", id: "pcf-unarchive", guard: ad, onClick: function () { res(G.ops.unarchiveProject(p.id)); } })) : h("div", { class: "form-actions" }, G.btn("Archive " + p.name, { kind: "danger", icon: "lock", id: "pcf-archive", guard: ad, onClick: function () {
            G.typedConfirm({ title: "Archive " + p.name, kicker: "Danger zone", sub: "This stops " + imp.workOrders + " work orders and hides the project from its members.", phrase: p.name, okLabel: "Archive project", guard: ad,
              onOk: function (text) { var r = G.ops.archiveProject(p.id, text); if (r.ok) G.toast(r.msg, "warn"); return r; } });
          } })))));
  }

  function render() {
    var p = G.currentProject();
    if (!p) return h("div", { class: "view" }, G.empty("No project", "Pick a project in the top bar."));
    if (ui.pid !== p.id) { ui.pid = p.id; ui.gate = "G5"; ui.add.person = ""; }
    if (G.homeKit && G.homeKit.cfgTab) { ui.tab = G.homeKit.cfgTab; G.homeKit.cfgTab = null; }
    var pr = G.store.get("prefs");
    if (pr.configTab || pr.configGate) {
      var tab = pr.configTab, gate = pr.configGate;
      if (TABS.some(function (t) { return t[0] === tab; })) ui.tab = tab;
      if (gate && G.flowOf(p).gates.some(function (x) { return x.id === gate; })) { ui.gate = gate; if (!tab) ui.tab = "approvers"; }
      pr.configTab = null; pr.configGate = null;
      if (gate) setTimeout(function () { var el = document.getElementById("pcf-ap-g-" + gate); if (el) { el.scrollIntoView({ block: "nearest" }); el.focus(); } }, 60);
    }
    var body = { overview: overview, members: membersTab, flow: flowTab, classes: classesTab, approvers: approversTab, notifications: notificationsTab, mcp: mcpTab, budget: budgetTab, history: function (x) { return G.panel("History for " + x.name, G.historyList({ type: "project", id: x.id, limit: 80 })); }, danger: dangerTab }[ui.tab] || overview;
    var dirtyN = Object.keys(ui.drafts).filter(function (k) { return k.indexOf(p.id + ":") === 0 && isDirty(p, k.split(":")[1]); }).length;
    return h("div", { class: "view pcf" },
      G.pageHeader({ id: "pcf-head", kicker: "Project · " + p.key + " · Config", title: p.name, sub: p.desc, crumbs: [{ label: "Projects", href: "#projects" }, { label: p.name }],
        meta: [["Status", p.killed ? "killed" : p.halted ? "halted" : p.status], ["Owner", G.actorName(p.owner)], ["Slots", String(p.flow.slots)], ["Budget", G.fmt.money0(p.budget.mtd) + " / " + G.fmt.money0(p.budget.monthly)]],
        actions: [G.homeKit ? G.homeKit.healthChip(p) : null, G.btn("Open floor", { icon: "belt", kind: "ghost", id: "pcf-to-floor", onClick: function () { location.hash = "floor"; } })] }),
      G.tabBar({ id: "pcf-tab", items: TABS.map(function (t) { return { id: t[0], label: t[1], count: t[0] === "approvers" && dirtyN ? dirtyN : t[0] === "members" ? members(p).length : t[0] === "classes" ? G.classesOf(p).length : t[0] === "flow" ? G.flowOf(p).stations.length : null }; }), active: ui.tab, onChange: function (id) { ui.tab = id; if (G.tip) G.tip.hide(); G.rerender(); } }),
      h("div", { class: "pcf-body", id: "pcf-tab-panel", role: "tabpanel", "aria-labelledby": "pcf-tab-" + ui.tab }, body(p)));
  }

  G.views["project-config"] = {
    title: "Project config",
    render: render,
    keys: ["projects", "people", "repos", "workOrders", "templates", "mcp", "deliveries", "audit", "trust", "agents", "matrix"]
  };
})(window.G);
