/* Audit: append-only ledger of human, agent, API and trigger actions, including denied attempts.
   Filter by project, category, actor, outcome and channel; detail drawer with before/after.
   Each entry carries a chained digest computed in the page so tampering would show. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { q: "", project: "all", cat: "all", topic: "all", actor: "all", outcome: "all", via: "all", changes: false, limit: 60 };
  /* round-three topics cut across the base categories: trust and learning entries are filed under Agents,
     catalogue changes under Config, Access or Integrations. The topic filter finds them directly. */
  var TOPICS = [
    { id: "trust", name: "Trust", icon: "trust", test: function (a) { return /^trust\./.test(a) || a === "gate.trust"; } },
    { id: "learning", name: "Learning", icon: "learn", test: function (a) { return /^learning\./.test(a) || a === "eval.case"; } },
    { id: "catalogue", name: "Catalogue", icon: "tool", test: function (a) { return /^(station|class|bay|vendor)\./.test(a) || /^role\.(add|edit|remove)$/.test(a) || ["gate.add", "flow.gate", "integration.type", "integration.add", "integration.remove", "model.add", "model.remove", "card.template"].indexOf(a) >= 0; } },
    { id: "record", name: "Records", icon: "record", test: function (a) { return /^(record|outcome)\./.test(a); } }
  ];
  function topicOf(a) { var t = TOPICS.find(function (x) { return x.test(a); }); return t ? t.id : null; }
  var CAT_ICON = { auth: "key", access: "lock", flow: "belt", onboarding: "branch", approvals: "gate", config: "tool", integrations: "plug", api: "api", agents: "agent", kill: "kill" };
  var CAT_NAME = { auth: "Auth", access: "Access", flow: "Flow", onboarding: "Onboarding", approvals: "Approvals", config: "Config", integrations: "Integrations", api: "API", agents: "Agents", kill: "Kill" };

  function fnv(str) { var x = 0x811c9dc5; for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return ("0000000" + x.toString(16)).slice(-8); }
  var chainCache = { n: -1, rows: null, head: "00000000" };
  function chain(list) {
    if (chainCache.n === list.length && chainCache.rows) return chainCache;
    var prev = "00000000";
    var rows = list.map(function (e, i) { var d = fnv(prev + "|" + e.at + "|" + e.actor + "|" + e.action + "|" + e.target + "|" + e.where + "|" + e.outcome + "|" + e.before + "|" + e.after); var r = { seq: i + 1, e: e, digest: d, prev: prev }; prev = d; return r; });
    chainCache = { n: list.length, rows: rows, head: prev, byId: {} };
    rows.forEach(function (r) { chainCache.byId[r.e.id] = r; });
    return chainCache;
  }
  function actorKind(id) { return G.find.person(id) ? "human" : G.find.agent(id) ? "agent" : /^key-|^TR-/.test(id) ? "system" : id === "system" ? "system" : "human"; }
  function factoryWide() { var v = G.viewer(); return !!v && v.roles.some(function (g) { return g.scope === "factory"; }); }
  function scopeFilter(list) {
    if (factoryWide()) return list;
    var vis = G.visibleProjects(G.viewerId()).map(function (p) { return p.id; }), me = G.viewerId();
    return list.filter(function (e) { return (e.project && vis.indexOf(e.project) >= 0) || e.actor === me; });
  }
  function catChip(c) { return h("span", { class: "aud-cat aud-cat-" + c }, G.icon(CAT_ICON[c] || "dots"), CAT_NAME[c] || c); }

  /* ---------- before/after ---------- */
  function parse(v) { if (v == null) return { raw: null }; try { return { val: JSON.parse(v), raw: v }; } catch (e) { return { raw: v }; } }
  function pretty(v) { return typeof v === "string" ? v : JSON.stringify(v, null, 2); }
  function diffView(e) {
    if (e.before == null && e.after == null) return h("p", { class: "muted small" }, "No before/after recorded for this entry. Config changes record both.");
    var b = parse(e.before), a = parse(e.after);
    var isObj = function (x) { return x && x.val && typeof x.val === "object" && !Array.isArray(x.val); };
    if (isObj(b) && isObj(a)) {
      var keys = Object.keys(b.val).concat(Object.keys(a.val)).filter(function (k, i, arr) { return arr.indexOf(k) === i; });
      var changed = keys.filter(function (k) { return JSON.stringify(b.val[k]) !== JSON.stringify(a.val[k]); });
      return h("div", { class: "aud-diff" },
        h("p", { class: "small muted" }, changed.length + " of " + keys.length + " fields changed"),
        h("table", { class: "table table-compact aud-kdiff" }, h("thead", null, h("tr", null, h("th", { scope: "col" }, "Field"), h("th", { scope: "col" }, "Before"), h("th", { scope: "col" }, "After"))),
          h("tbody", null, keys.map(function (k) {
            var ch = changed.indexOf(k) >= 0;
            return h("tr", { class: ch ? "is-changed" : "" }, h("th", { scope: "row", class: "mono" }, (ch ? "~ " : "  ") + k),
              h("td", null, h("pre", { class: "aud-pre aud-del" }, b.val[k] === undefined ? "(none)" : pretty(b.val[k]))),
              h("td", null, h("pre", { class: "aud-pre aud-ins" }, a.val[k] === undefined ? "(none)" : pretty(a.val[k]))));
          }))));
    }
    return h("div", { class: "aud-ba" },
      h("div", null, h("div", { class: "kicker" }, "Before"), h("pre", { class: "aud-pre aud-del" }, b.raw == null ? "(nothing)" : b.val !== undefined ? pretty(b.val) : b.raw)),
      h("div", { class: "aud-arrow", "aria-hidden": "true" }, "→"),
      h("div", null, h("div", { class: "kicker" }, "After"), h("pre", { class: "aud-pre aud-ins" }, a.raw == null ? "(nothing)" : a.val !== undefined ? pretty(a.val) : a.raw)));
  }

  function entityLink(e) {
    var en = e.entity; if (!en) return null;
    function go(hash, fn) { return function () { if (fn) fn(); G.drawer.close(); location.hash = hash; }; }
    var setProj = function (pid) { return function () { if (pid && G.find.project(pid)) G.store.update("prefs", function (p) { p.project = pid; }); }; };
    if (en.type === "wo" && G.find.wo(en.id)) return h("span", { class: "row gap-sm" }, G.btn("Open record for " + en.id, { small: true, icon: "record", id: "aud-ent-record", onClick: function () { G.drawer.close(); G.openRecord(en.id); } }), G.btn("Open traveler", { small: true, kind: "ghost", icon: "page", id: "aud-ent-open", onClick: function () { G.openTraveler(en.id); } }));
    if (en.type === "role" && G.canSeeRoute("access")) return G.btn("Open Access", { small: true, icon: "lock", id: "aud-ent-open", onClick: go("access") });
    if ((en.type === "trust" || en.type === "cell" || en.type === "trustCell" || /^trust\./.test(e.action)) && G.canSeeRoute("trust")) return G.btn("Open Trust", { small: true, icon: "trust", id: "aud-ent-open", onClick: go("trust", function () { var cid = String(en.id); var c = G.find.trustCell(cid); G.store.update("prefs", function (p) { if (c) p.project = c.project; p.trustFocus = c ? { cell: c.id, project: c.project, cls: c.cls, proposal: null } : null; }); }) });
    if (/^learning\./.test(e.action) && G.canSeeRoute("learning")) return G.btn("Open Learning", { small: true, icon: "learn", id: "aud-ent-open", onClick: go("learning") });
    if ((en.type === "class" || en.type === "station" || en.type === "bay" || en.type === "gate") && e.project && G.find.project(e.project)) return G.btn("Open project config", { small: true, icon: "tool", id: "aud-ent-open", onClick: go("project-config", setProj(e.project)) });
    if (en.type === "repo" && G.find.repo(en.id)) return G.btn("Open onboarding", { small: true, icon: "branch", id: "aud-ent-open", onClick: go("onboarding", setProj(G.find.repo(en.id).project)) });
    if ((en.type === "project" || en.type === "gaterule") && G.find.project(String(en.id).split(":")[0])) return G.btn("Open project config", { small: true, icon: "tool", id: "aud-ent-open", onClick: go("project-config", setProj(String(en.id).split(":")[0])) });
    if (en.type === "agent" && G.find.agent(en.id)) return G.btn("Open agent", { small: true, icon: "agent", id: "aud-ent-open", onClick: go("agents", function () { G.store.update("prefs", function (p) { p.agent = en.id; }); }) });
    if (en.type === "person" && G.canSeeRoute("people")) return G.btn("Open People", { small: true, icon: "people", id: "aud-ent-open", onClick: go("people", function () { if (G.peopleSelect) G.peopleSelect(en.id); }) });
    return null;
  }

  function openDetail(id) {
    G.drawer.open("audit:" + id, function (close) {
      var c = chain(G.store.get("audit"));
      var r = c.byId[id]; if (!r) return null;
      var e = r.e;
      var p = e.project && G.find.project(e.project);
      function kv(k, v) { return h("div", { class: "aud-kv" }, h("dt", null, k), h("dd", null, v)); }
      return h("div", { class: "drawer-inner aud-drawer" },
        h("div", { class: "drawer-head" }, h("div", null, h("div", { class: "kicker" }, "Audit entry · " + (CAT_NAME[e.category] || e.category)),
          h("div", { class: "drawer-id" }, h("span", { class: "mono big-id" }, "#" + r.seq), h("span", { class: "outcome o-" + e.outcome }, e.outcome)),
          h("h2", { class: "drawer-title" }, e.target)),
          h("button", { type: "button", class: "icon-btn drawer-close", id: "aud-drawer-close", "aria-label": "Close", onClick: close }, G.icon("x"))),
        h("div", { class: "drawer-scroll" },
          h("dl", { class: "aud-kvs" },
            kv("When", h("span", { class: "mono" }, G.fmt.iso(e.at) + " IST")),
            kv("Actor", h("span", null, G.who(e.actor), h("span", { class: "muted small" }, " · " + actorKind(e.actor)))),
            kv("Action", h("span", { class: "mono" }, e.action)),
            kv("Category", h("span", { class: "row gap-sm" }, catChip(e.category), topicOf(e.action) ? h("span", { class: "chip" }, TOPICS.find(function (t) { return t.id === topicOf(e.action); }).name) : null)),
            kv("Project", p ? p.name : "Factory-wide"),
            kv("Where", h("span", { class: "mono" }, e.where)),
            kv("Via", h("span", { class: "mono" }, e.via)),
            e.entity ? kv("Entity", h("span", { class: "mono" }, e.entity.type + " " + e.entity.id)) : null),
          e.outcome === "denied" ? h("div", { class: "callout callout-block" }, G.icon("lock"), " The policy engine refused this attempt. Nothing changed.") : null,
          h("h3", { class: "sub-h" }, "Before and after"), diffView(e),
          h("div", { class: "drawer-actions aud-actions" }, entityLink(e)),
          h("h3", { class: "sub-h" }, "Chain"),
          h("dl", { class: "aud-kvs" }, kv("Digest", h("span", { class: "mono digest" }, r.digest)), kv("Previous", h("span", { class: "mono digest" }, r.prev))),
          e.entity ? h("div", null, h("h3", { class: "sub-h" }, "Other entries for this " + e.entity.type), G.historyList({ type: e.entity.type, id: e.entity.id, limit: 12 })) : null));
    });
  }

  function render() {
    var s = G.store.get();
    var perm = G.me("audit.view");
    var c = chain(s.audit);
    var scoped = scopeFilter(c.rows.map(function (r) { return r.e; }));
    var inScope = {}; scoped.forEach(function (e) { inScope[e.id] = 1; });
    var base = c.rows.filter(function (r) { return inScope[r.e.id]; });
    var q = ui.q.trim().toLowerCase();
    function pass(r, skipCat) {
      var e = r.e;
      if (ui.project !== "all" && (ui.project === "factory" ? !!e.project : e.project !== ui.project)) return false;
      if (!skipCat && ui.cat !== "all" && e.category !== ui.cat) return false;
      if (ui.topic !== "all" && topicOf(e.action) !== ui.topic) return false;
      if (ui.actor !== "all") { if (["human", "agent", "system"].indexOf(ui.actor) >= 0 ? actorKind(e.actor) !== ui.actor : e.actor !== ui.actor) return false; }
      if (ui.outcome !== "all" && e.outcome !== ui.outcome) return false;
      if (ui.via !== "all" && e.via !== ui.via) return false;
      if (ui.changes && e.before == null && e.after == null) return false;
      if (q && (G.actorName(e.actor) + " " + e.action + " " + e.target + " " + e.where + " " + e.via + " " + (e.before || "") + " " + (e.after || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }
    var rows = base.filter(function (r) { return pass(r); }).reverse();
    var catCounts = {}; base.forEach(function (r) { if (pass(r, true)) catCounts[r.e.category] = (catCounts[r.e.category] || 0) + 1; });
    var shown = rows.slice(0, ui.limit);
    function reset() { ui.limit = 60; G.rerender(); }
    var search = h("input", { id: "aud-q", class: "input", type: "search", placeholder: "Actor, action, target, value", value: ui.q, autocomplete: "off" });
    search.addEventListener("input", function () { ui.q = search.value; reset(); });
    function sel(id, key, opts) { return G.select(id, opts, ui[key], function (v) { ui[key] = v; reset(); }); }
    var outcomes = [], vias = [], actors = [];
    base.forEach(function (r) { var e = r.e; if (outcomes.indexOf(e.outcome) < 0) outcomes.push(e.outcome); if (vias.indexOf(e.via) < 0) vias.push(e.via); if (G.find.person(e.actor) && actors.indexOf(e.actor) < 0) actors.push(e.actor); });
    var projects = factoryWide() ? s.projects : G.visibleProjects(G.viewerId());
    var changesCb = h("input", { type: "checkbox", id: "aud-changes", checked: ui.changes });
    changesCb.addEventListener("change", function () { ui.changes = changesCb.checked; reset(); });

    var catBar = h("div", { class: "aud-cats", role: "group", "aria-label": "Category" },
      [["all", "All", base.filter(function (r) { return pass(r, true); }).length]].concat(G.AUDIT_CATEGORIES.map(function (k) { return [k, CAT_NAME[k] || k, catCounts[k] || 0]; })).map(function (x) {
        return h("button", { type: "button", id: "aud-cat-" + x[0], class: "aud-catbtn aud-cat-" + x[0] + (ui.cat === x[0] ? " is-on" : ""), "aria-pressed": ui.cat === x[0] ? "true" : "false", onClick: function () { ui.cat = x[0]; reset(); } },
          x[0] !== "all" ? G.icon(CAT_ICON[x[0]]) : null, h("span", null, x[1]), h("span", { class: "mono aud-n" }, String(x[2])));
      }));

    var topicCounts = {}; base.forEach(function (r) { var t = topicOf(r.e.action); if (t) topicCounts[t] = (topicCounts[t] || 0) + 1; });
    var topicBar = h("div", { class: "aud-topics", role: "group", "aria-label": "Round-three topic" }, h("span", { class: "kicker" }, "Topic"),
      [{ id: "all", name: "Any" }].concat(TOPICS).map(function (t) {
        return h("button", { type: "button", id: "aud-topic-" + t.id, class: "aud-topic" + (ui.topic === t.id ? " is-on" : ""), "aria-pressed": ui.topic === t.id ? "true" : "false", onClick: function () { ui.topic = t.id; reset(); } },
          t.icon ? G.icon(t.icon) : null, h("span", null, t.name), t.id !== "all" ? h("span", { class: "mono aud-n" }, String(topicCounts[t.id] || 0)) : null);
      }));
    var denied = base.filter(function (r) { return r.e.outcome === "denied"; }).length;
    return h("div", { class: "view view-audit" },
      G.pageHeader({ id: "aud-head", kicker: "Govern · Audit", title: "Audit", sub: "Append-only ledger of every human, agent, API key and trigger action, including denied attempts. Nothing here can be edited or deleted.",
        meta: [["Entries", String(base.length)], ["Denied", String(denied)], ["Config changes", String(base.filter(function (r) { return r.e.before != null || r.e.after != null; }).length)], ["Head digest", c.head]] }),
      !perm.allowed ? h("div", { class: "lock-note", role: "note" }, G.icon("lock"), h("span", null, "You see entries for your own projects and your own actions. The full ledger needs the audit.view right (Factory Admin or Auditor).")) :
        !factoryWide() ? h("div", { class: "lock-note", role: "note" }, G.icon("lock"), h("span", null, "Showing entries for your projects (" + projects.map(function (p) { return p.name; }).join(", ") + ") and your own actions.")) : null,
      catBar, topicBar,
      h("div", { class: "toolbar aud-filters" }, h("div", { class: "filters" },
        G.field("Search", search),
        G.field("Project", sel("aud-project", "project", [{ value: "all", label: "All projects" }, { value: "factory", label: "Factory-wide only" }].concat(projects.map(function (p) { return { value: p.id, label: p.name }; })))),
        G.field("Actor", sel("aud-actor", "actor", [{ value: "all", label: "Anyone" }, { value: "human", label: "People" }, { value: "agent", label: "Agents" }, { value: "system", label: "API keys, triggers, system" }].concat(actors.map(function (a) { return { value: a, label: G.actorName(a) }; })))),
        G.field("Outcome", sel("aud-outcome", "outcome", [{ value: "all", label: "Any outcome" }].concat(outcomes.sort().map(function (k) { return { value: k, label: k }; })))),
        G.field("Via", sel("aud-via", "via", [{ value: "all", label: "Any channel" }].concat(vias.sort().map(function (k) { return { value: k, label: k }; })))),
        h("label", { class: "check aud-chk", for: "aud-changes" }, changesCb, "Only entries with before/after")),
        h("div", { class: "aud-count" }, h("span", { class: "mono" }, String(rows.length)), " matching",
          (ui.q || ui.project !== "all" || ui.cat !== "all" || ui.topic !== "all" || ui.actor !== "all" || ui.outcome !== "all" || ui.via !== "all" || ui.changes) ? G.btn("Clear filters", { small: true, kind: "ghost", id: "aud-clear", onClick: function () { ui.q = ""; ui.project = ui.cat = ui.topic = ui.actor = ui.outcome = ui.via = "all"; ui.changes = false; reset(); } }) : null)),
      rows.length ? h("div", { class: "table-scroll ledger", "data-keep-scroll": "aud-ledger" }, h("table", { class: "table table-compact aud-table" },
        h("thead", null, h("tr", null, ["#", "When (IST)", "Actor", "Category", "Action", "Target", "Project", "Outcome", "Change", "Digest"].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, shown.map(function (r) {
          var e = r.e, p = e.project && G.find.project(e.project);
          var tr = h("tr", { class: "row-link aud-row o-row-" + e.outcome },
            h("td", { class: "mono muted" }, h("button", { type: "button", class: "linkish mono", id: "aud-row-" + e.id, "aria-label": "Open audit entry " + r.seq + ": " + e.action }, String(r.seq))),
            h("td", { class: "mono nowrap" }, G.fmt.iso(e.at)),
            h("td", null, G.who(e.actor)),
            h("td", null, catChip(e.category)),
            h("td", { class: "mono" }, e.action),
            h("td", { class: "cell-title aud-target" }, e.target),
            h("td", { class: "small" }, p ? p.name : h("span", { class: "muted" }, "factory")),
            h("td", null, h("span", { class: "outcome o-" + e.outcome }, e.outcome)),
            h("td", null, e.before != null || e.after != null ? h("span", { class: "aud-has-diff", title: "Has before/after" }, G.icon("swap"), "diff") : null),
            h("td", { class: "mono muted digest", "data-tip": "prev " + r.prev }, r.digest));
          tr.addEventListener("click", function () { openDetail(e.id); });
          return tr;
        }))))
        : G.emptyState({ id: "aud-empty", icon: "ledger", title: "No entries match", text: "Clear the filters to see the full ledger." }),
      rows.length > ui.limit ? h("div", { class: "more" }, G.btn("Show " + Math.min(60, rows.length - ui.limit) + " more", { id: "aud-more", onClick: function () { ui.limit += 60; G.rerender(); } })) : null,
      h("p", { class: "footnote" }, "Digests are computed in the page for the demo. A real deployment writes the ledger to append-only storage and signs each block."));
  }

  G.views.audit = { title: "Audit", render: render, keys: ["audit"] };
  /* deep link: an audit entry or its id */
  G.openAuditEntry = function (x) { openDetail(x && typeof x === "object" ? x.id : x); };
})(window.G);
