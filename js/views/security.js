/* Security (Factory Admins; Auditor read-only): SSO, MFA, session lifetime and idle timeout
   with Simulate idle, allowed domains, IP allow-list, active sessions with revoke, sign-in history.
   Every change goes through G.ops.setSecurity / G.ops.revokeSession, which audit. */
(function (G) {
  "use strict";
  var h = G.h;
  G.views = G.views || {};
  var ui = { tab: "signin", sso: null, newDomain: "", newIp: "", sesShow: "active", hist: "all", histMethod: "all", histLimit: 40, err: {} };
  var THIS_IP = "10.4.0.12";
  var PROVIDERS = ["Okta", "Microsoft Entra ID", "Google Workspace", "OneLogin"];
  function S(k) { return G.store.get(k); }
  function lockd(reason, needs) { return { allowed: false, reason: reason, needs: needs || "" }; }
  function set(path, value, msg) { var r = G.ops.setSecurity(path, value); G.toast(r.ok ? (msg || r.msg) : r.msg, r.ok ? "ok" : "error"); return r; }

  /* IPv4 CIDR helpers (local; the foundation has none) */
  function ipNum(ip) { var p = String(ip).split("."); if (p.length !== 4) return null; var n = 0; for (var i = 0; i < 4; i++) { var x = +p[i]; if (!/^\d{1,3}$/.test(p[i]) || x > 255) return null; n = n * 256 + x; } return n; }
  function parseCidr(c) { var m = String(c).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/); if (!m) return null; var base = ipNum(m[1]); var bits = m[2] == null ? 32 : +m[2]; if (base == null || bits > 32) return null; return { base: base, bits: bits, text: m[1] + "/" + bits }; }
  function inCidr(ip, c) { var p = parseCidr(c), n = ipNum(ip); if (!p || n == null) return false; if (p.bits === 0) return true; var size = Math.pow(2, 32 - p.bits); return Math.floor(n / size) === Math.floor(p.base / size); }

  /* ---------- sign-in tab ---------- */
  function ssoPanel(perm, sec) {
    if (!ui.sso) ui.sso = { provider: sec.sso.provider, domain: sec.sso.domain, entity: sec.sso.entity };
    var d = ui.sso;
    var prov = G.select("sec-sso-provider", PROVIDERS, d.provider, function (v) { d.provider = v; G.rerender(); }, perm.allowed ? {} : { disabled: true });
    var dom = h("input", { id: "sec-sso-domain", class: "input mono", value: d.domain, disabled: !perm.allowed, autocomplete: "off" });
    dom.addEventListener("input", function () { d.domain = dom.value; });
    var ent = h("input", { id: "sec-sso-entity", class: "input mono", value: d.entity, disabled: !perm.allowed, autocomplete: "off" });
    ent.addEventListener("input", function () { d.entity = ent.value; });
    var dirty = d.provider !== sec.sso.provider || d.domain !== sec.sso.domain || d.entity !== sec.sso.entity;
    var err = h("div", { class: "form-err", role: "alert" }, ui.err.sso || "");
    return G.panel("Single sign-on", h("div", { class: "form-grid" },
      h("div", { class: "form-row" }, G.field("Identity provider", prov), G.field("SSO domain", dom)),
      G.field("SAML entity / metadata URL", ent, "Simulated: no identity provider is contacted in this demo."),
      h("div", { class: "toggle-grid" },
        h("div", { class: "toggle-row" }, h("label", { for: "sec-sso-enforced" }, h("span", { class: "strong" }, "Require SSO"), h("span", { class: "muted small" }, "Email and password sign-in is refused.")),
          G.toggle("sec-sso-enforced", sec.sso.enforced, function (v) { set("sso.enforced", v, v ? "SSO is required." : "SSO is optional now."); }, perm)),
        h("div", { class: "toggle-row" }, h("label", { for: "sec-gh" }, h("span", { class: "strong" }, "Allow GitHub sign-in"), h("span", { class: "muted small" }, "People can sign in with their linked GitHub account.")),
          G.toggle("sec-gh", sec.githubLogin, function (v) { set("githubLogin", v, v ? "GitHub sign-in allowed." : "GitHub sign-in turned off."); }, perm))),
      err,
      h("div", { class: "form-actions" },
        G.btn("Save SSO settings", { kind: "primary", small: true, id: "sec-sso-save", guard: !perm.allowed ? perm : !dirty ? lockd("Nothing changed yet.") : null, onClick: function () {
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d.domain.trim())) { ui.err.sso = "Enter a domain such as acme.dev."; G.rerender(); return; }
          if (!/^https:\/\/\S+$/.test(d.entity.trim())) { ui.err.sso = "The metadata URL must start with https://."; G.rerender(); return; }
          ui.err.sso = "";
          var ok = true;
          ["provider", "domain", "entity"].forEach(function (k) { if (d[k].trim() !== sec.sso[k]) ok = G.ops.setSecurity("sso." + k, d[k].trim()).ok && ok; });
          G.toast(ok ? "SSO settings saved." : "Some SSO settings were not saved.", ok ? "ok" : "error");
          ui.sso = null;
        } }),
        dirty ? G.btn("Discard", { small: true, kind: "ghost", id: "sec-sso-discard", onClick: function () { ui.sso = null; ui.err.sso = ""; G.rerender(); } }) : null,
        G.btn("Test sign-in (simulated)", { small: true, kind: "ghost", icon: "play", id: "sec-sso-test", guard: perm, onClick: function () {
          G.audit("security.sso.test", sec.sso.provider + " test sign-in (simulated)", "factory", "ok", { category: "auth" });
          G.toast(sec.sso.provider + " answered with a valid assertion for " + sec.sso.domain + " (simulated).", "ok");
        } }))));
  }

  function mfaPanel(perm, sec) {
    var opts = [["off", "Nobody", "MFA is optional for everyone."], ["admins", "Admins", "Factory and Project Admins must use MFA."], ["all", "Everyone", "Every person must use MFA."]];
    var mine = G.viewer();
    var cards = h("div", { class: "radio-cards", role: "radiogroup", "aria-label": "MFA policy" }, opts.map(function (o) {
      var input = h("input", { type: "radio", name: "sec-mfa", id: "sec-mfa-" + o[0], value: o[0], checked: sec.mfa.policy === o[0], disabled: !perm.allowed });
      input.addEventListener("change", function () { set("mfa.policy", o[0], "MFA required for: " + o[1].toLowerCase() + "."); });
      return h("label", { class: "radio-card" + (perm.allowed ? "" : " is-locked"), for: "sec-mfa-" + o[0] }, input, h("span", { class: "rc-t" }, o[1]), h("span", { class: "rc-d muted small" }, o[2]));
    }));
    var methods = [["totp", "Authenticator app (TOTP)"], ["webauthn", "Security key or passkey (WebAuthn)"], ["sms", "SMS code"]];
    var mbox = h("div", { class: "check-grid" }, methods.map(function (m) {
      var on = sec.mfa.methods.indexOf(m[0]) >= 0;
      var last = on && sec.mfa.methods.length === 1;
      var cb = h("input", { type: "checkbox", id: "sec-mfa-m-" + m[0], checked: on, disabled: !perm.allowed || last });
      cb.addEventListener("change", function () {
        var next = sec.mfa.methods.filter(function (x) { return x !== m[0]; });
        if (cb.checked) next.push(m[0]);
        set("mfa.methods", next, m[1] + (cb.checked ? " allowed." : " no longer allowed."));
      });
      return h("label", { class: "check", for: "sec-mfa-m-" + m[0], title: last ? "Keep at least one method." : null }, cb, m[1]);
    }));
    var enrolled = S("people").filter(function (p) { return p.mfa; }).length;
    return G.panel("Multi-factor authentication", h("div", { class: "form-grid" }, cards,
      h("div", { class: "field" }, h("div", { class: "field-label" }, "Allowed methods"), mbox, h("div", { class: "field-hint" }, "SMS is weaker than an app or a key. At least one method stays on.")),
      h("p", { class: "small muted" }, enrolled + " of " + S("people").length + " people enrolled." + (mine && !mine.mfa && sec.mfa.policy === "all" ? " You are not enrolled: your next sign-in will ask you to set it up." : ""))));
  }

  function sessionPanel(perm, sec) {
    var hours = [4, 8, 12, 24, 72], idle = [10, 15, 30, 60, 120];
    return G.panel("Session lifetime and idle timeout", h("div", { class: "form-grid" },
      h("div", { class: "form-row" },
        G.field("Session lifetime", G.select("sec-hours", hours.map(function (x) { return { value: x, label: x + " hours" }; }), sec.sessionHours, function (v) { set("sessionHours", +v, "Sessions now last " + v + " hours."); }, perm.allowed ? {} : { disabled: true }), "After this, people sign in again."),
        G.field("Idle timeout", G.select("sec-idle", idle.map(function (x) { return { value: x, label: x + " minutes" }; }), sec.idleMin, function (v) { set("idleMin", +v, "Idle timeout set to " + v + " minutes."); }, perm.allowed ? {} : { disabled: true }), "A warning appears 20 seconds before sign-out.")),
      h("div", { class: "sec-idle-demo" },
        h("div", null, h("div", { class: "strong" }, "Try the idle warning"), h("div", { class: "small muted" }, "Shows the warning you would see after " + sec.idleMin + " idle minutes, with a 20-second countdown. If it runs out you are signed out.")),
        G.btn("Simulate idle", { icon: "clock", id: "sec-sim-idle", onClick: function () { G.simulateIdle(20); } })),
      h("div", { class: "toggle-row" }, h("label", { for: "sec-two" }, h("span", { class: "strong" }, "Factory restore needs two Factory Admins"), h("span", { class: "muted small" }, "After a factory kill, two different Factory Admins must approve the restore.")),
        G.toggle("sec-two", sec.restoreFactoryNeedsTwo, function (v) { set("restoreFactoryNeedsTwo", v, v ? "Factory restore needs two Factory Admins." : "One Factory Admin can restore the factory."); }, perm))));
  }

  /* ---------- network tab ---------- */
  function domainsPanel(perm, sec) {
    var mine = G.viewer() ? G.viewer().email.split("@")[1] : null;
    var input = h("input", { id: "sec-dom-new", class: "input mono", placeholder: "Domain, e.g. partner.example", value: ui.newDomain, disabled: !perm.allowed, autocomplete: "off", "aria-label": "Domain to allow" });
    input.addEventListener("input", function () { ui.newDomain = input.value; });
    var form = h("form", { class: "inline-form", id: "sec-dom-form" }, input, G.btn("Allow domain", { type: "submit", small: true, icon: "plus", id: "sec-dom-add", guard: perm }));
    form.addEventListener("submit", function (e) {
      e.preventDefault(); if (!perm.allowed) return;
      var v = ui.newDomain.trim().toLowerCase();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) { ui.err.dom = "Enter a domain such as contractor.acme.dev."; G.rerender(); return; }
      if (sec.domains.indexOf(v) >= 0) { ui.err.dom = v + " is already allowed."; G.rerender(); return; }
      ui.err.dom = ""; ui.newDomain = "";
      set("domains", sec.domains.concat([v]), v + " allowed.");
    });
    return G.panel("Allowed email domains", h("div", { class: "form-grid" },
      h("p", { class: "small muted" }, "Sign-in and invites are refused for any other domain."),
      h("ul", { class: "sec-list" }, sec.domains.map(function (d) {
        var users = S("people").filter(function (p) { return p.email.split("@")[1] === d; }).length;
        var g = !perm.allowed ? perm : d === mine ? lockd("You signed in with " + d + "; removing it would lock you out.") : sec.domains.length === 1 ? lockd("Keep at least one allowed domain.") : null;
        return h("li", null, G.icon("check"), h("span", { class: "mono" }, d), h("span", { class: "muted small" }, users + " people"),
          G.btn("Remove", { small: true, kind: "ghost", icon: "x", id: "sec-dom-rm-" + d.replace(/\W/g, "_"), guard: g, onClick: function () { set("domains", sec.domains.filter(function (x) { return x !== d; }), d + " removed. People on it can no longer sign in."); } }));
      })),
      form, h("div", { class: "form-err", role: "alert" }, ui.err.dom || "")));
  }
  function ipPanel(perm, sec) {
    var input = h("input", { id: "sec-ip-new", class: "input mono", placeholder: "CIDR, e.g. 198.51.100.0/24", value: ui.newIp, disabled: !perm.allowed, autocomplete: "off", "aria-label": "Address range to allow" });
    input.addEventListener("input", function () { ui.newIp = input.value; });
    var form = h("form", { class: "inline-form", id: "sec-ip-form" }, input, G.btn("Add range", { type: "submit", small: true, icon: "plus", id: "sec-ip-add", guard: perm }));
    form.addEventListener("submit", function (e) {
      e.preventDefault(); if (!perm.allowed) return;
      var p = parseCidr(ui.newIp);
      if (!p) { ui.err.ip = "Enter an IPv4 address or CIDR range such as 192.0.2.0/24."; G.rerender(); return; }
      if (sec.ipAllow.indexOf(p.text) >= 0) { ui.err.ip = p.text + " is already on the list."; G.rerender(); return; }
      ui.err.ip = ""; ui.newIp = "";
      set("ipAllow", sec.ipAllow.concat([p.text]), p.text + " added to the allow-list.");
    });
    var covered = sec.ipAllow.filter(function (c) { return inCidr(THIS_IP, c); });
    return G.panel("IP allow-list", h("div", { class: "form-grid" },
      h("div", { class: "sec-here " + (covered.length ? "is-ok" : "is-bad") }, G.icon(covered.length ? "check" : "alert"), h("span", null, "This browser connects from ", h("span", { class: "mono" }, THIS_IP), covered.length ? ", inside " + covered.join(", ") + "." : ", outside every range.")),
      h("ul", { class: "sec-list" }, sec.ipAllow.map(function (c) {
        var lockout = covered.length === 1 && covered[0] === c;
        var g = !perm.allowed ? perm : lockout ? lockd("This is the only range covering your address " + THIS_IP + "; removing it would lock you out.") : null;
        var sess = S("sessions").filter(function (x) { return !x.revoked && inCidr(x.ip, c); }).length;
        return h("li", null, G.icon("shield"), h("span", { class: "mono" }, c), h("span", { class: "muted small" }, sess + " active sessions"),
          G.btn("Remove", { small: true, kind: "ghost", icon: "x", id: "sec-ip-rm-" + c.replace(/\W/g, "_"), guard: g, onClick: function () { set("ipAllow", sec.ipAllow.filter(function (x) { return x !== c; }), c + " removed from the allow-list."); } }));
      })),
      form, h("div", { class: "form-err", role: "alert" }, ui.err.ip || ""),
      h("p", { class: "footnote" }, "Simulated: requests are not filtered in this demo; the list and the lock-out checks are real.")));
  }

  /* ---------- sessions tab ---------- */
  function revoke(ses) {
    var cur = S("session") && S("session").id === ses.id;
    if (cur) {
      G.dialog({ title: "Revoke your current session?", kicker: "Sessions", sub: "This signs you out of this browser now.",
        actions: [{ label: "Cancel" }, { label: "Revoke and sign out", kind: "danger", id: "sec-ses-self-ok", onClick: function (close) { close(); var r = G.ops.revokeSession(ses.id); if (r.ok) { G.drawer.close(); while (G.closeTopDialog()) { /* close all */ } G.toast("Session revoked. You are signed out.", "warn"); } else G.toast(r.msg, "error"); } }] });
      return;
    }
    var r = G.ops.revokeSession(ses.id); G.toast(r.msg, r.ok ? "ok" : "error");
  }
  function sessionsTab(perm) {
    var cur = S("session");
    var list = S("sessions").slice().sort(function (a, b) { return b.lastSeen - a.lastSeen; });
    var maxAge = S("security").sessionHours * G.HOUR;
    var rows = list.filter(function (x) { return ui.sesShow === "all" || !x.revoked; });
    var others = list.filter(function (x) { return !x.revoked && (!cur || x.id !== cur.id); });
    var seg = G.segmented("sec-ses-show", [{ id: "active", label: "Active (" + list.filter(function (x) { return !x.revoked; }).length + ")" }, { id: "all", label: "All (" + list.length + ")" }], ui.sesShow, function (v) { ui.sesShow = v; G.rerender(); }, "Sessions shown");
    return h("div", null,
      h("div", { class: "toolbar sec-toolbar" }, seg,
        G.btn("Revoke all other sessions", { small: true, kind: "danger", icon: "logout", id: "sec-ses-all", guard: !perm.allowed ? perm : !others.length ? lockd("No other active sessions.") : null, onClick: function () {
          G.dialog({ title: "Revoke " + others.length + " sessions?", kicker: "Sessions", sub: "Everyone except you is signed out and must sign in again.",
            actions: [{ label: "Cancel" }, { label: "Revoke " + others.length, kind: "danger", id: "sec-ses-all-ok", onClick: function (close) { var n = 0; others.forEach(function (x) { if (G.ops.revokeSession(x.id).ok) n++; }); close(); G.toast(n + " sessions revoked.", "ok"); } }] });
        } })),
      h("div", { class: "table-scroll", "data-keep-scroll": "sec-sessions" }, h("table", { class: "table table-compact sec-table" },
        h("thead", null, h("tr", null, ["Person", "Method", "Device", "IP", "Started (IST)", "Last seen", "State", ""].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, rows.map(function (x) {
          var isCur = cur && cur.id === x.id;
          var expired = !x.revoked && Date.now() - x.started > maxAge;
          var own = x.person === G.viewerId();
          var g = x.revoked ? lockd("Already ended.") : !perm.allowed && !own ? perm : null;
          var st = x.revoked ? h("span", { class: "sec-st is-ended" }, G.icon("x"), "Ended") : expired ? h("span", { class: "sec-st is-exp" }, G.icon("clock"), "Past lifetime") : h("span", { class: "sec-st is-live" }, G.icon("check"), isCur ? "This session" : "Active");
          return h("tr", { class: (isCur ? "is-selected" : "") + (x.revoked ? " sec-ended" : "") },
            h("td", null, G.who(x.person)), h("td", { class: "mono" }, x.method), h("td", null, x.device), h("td", { class: "mono" }, x.ip),
            h("td", { class: "mono nowrap" }, G.fmt.istDate(x.started) + " " + G.fmt.ist(x.started)), h("td", { class: "nowrap" }, G.fmt.ago(x.lastSeen)), h("td", null, st),
            h("td", null, G.btn(isCur ? "Revoke (signs you out)" : "Revoke", { small: true, kind: "ghost", icon: "logout", id: "sec-ses-rv-" + x.id, guard: g, onClick: function () { revoke(x); } })));
        })))));
  }

  /* ---------- history tab ---------- */
  function historyTab() {
    var all = S("signins").slice().reverse();
    var rows = all.filter(function (x) { return (ui.hist === "all" || x.outcome === ui.hist) && (ui.histMethod === "all" || x.method === ui.histMethod); });
    var fails24 = all.filter(function (x) { return x.outcome === "failure" && Date.now() - x.at < G.DAY; }).length;
    var methods = []; all.forEach(function (x) { if (methods.indexOf(x.method) < 0) methods.push(x.method); });
    return h("div", null,
      h("div", { class: "toolbar sec-toolbar" },
        G.segmented("sec-hist", [{ id: "all", label: "All" }, { id: "success", label: "Succeeded" }, { id: "failure", label: "Failed" }], ui.hist, function (v) { ui.hist = v; ui.histLimit = 40; G.rerender(); }, "Outcome"),
        G.field("Method", G.select("sec-hist-method", [{ value: "all", label: "Any method" }].concat(methods.map(function (m) { return { value: m, label: m }; })), ui.histMethod, function (v) { ui.histMethod = v; G.rerender(); })),
        h("span", { class: "small muted" }, rows.length + " sign-ins · " + fails24 + " failures in the last 24 h")),
      h("div", { class: "table-scroll", "data-keep-scroll": "sec-hist" }, h("table", { class: "table table-compact sec-table" },
        h("thead", null, h("tr", null, ["When (IST)", "Who", "Method", "Outcome", "Detail", "IP", "Device"].map(function (x) { return h("th", { scope: "col" }, x); }))),
        h("tbody", null, rows.slice(0, ui.histLimit).map(function (x) {
          return h("tr", { class: x.outcome === "failure" ? "sec-fail" : "" },
            h("td", { class: "mono nowrap" }, G.fmt.iso(x.at)),
            h("td", null, x.person ? G.who(x.person) : h("span", { class: "mono" }, x.email)),
            h("td", { class: "mono" }, x.method),
            h("td", null, h("span", { class: "sec-st " + (x.outcome === "success" ? "is-live" : "is-fail") }, G.icon(x.outcome === "success" ? "check" : "alert"), x.outcome === "success" ? "Succeeded" : "Failed")),
            h("td", { class: "small" }, x.reason || ""), h("td", { class: "mono" }, x.ip), h("td", { class: "small" }, x.device));
        })))),
      rows.length > ui.histLimit ? h("div", { class: "more" }, G.btn("Show more", { small: true, id: "sec-hist-more", onClick: function () { ui.histLimit += 40; G.rerender(); } })) : null);
  }

  function render() {
    var sec = S("security");
    var perm = G.me("security.manage");
    var active = S("sessions").filter(function (x) { return !x.revoked; }).length;
    var fails = S("signins").filter(function (x) { return x.outcome === "failure" && Date.now() - x.at < G.DAY; }).length;
    var tabs = G.tabBar({ id: "sec-tab", active: ui.tab, onChange: function (t) { ui.tab = t; G.rerender(); }, items: [{ id: "signin", label: "Sign-in and sessions" }, { id: "network", label: "Domains and network" }, { id: "sessions", label: "Active sessions", count: active }, { id: "history", label: "Sign-in history", count: S("signins").length }] });
    var body;
    if (ui.tab === "network") body = h("div", { class: "two-col sec-cols" }, domainsPanel(perm, sec), ipPanel(perm, sec));
    else if (ui.tab === "sessions") body = G.panel(null, sessionsTab(perm), { flush: false });
    else if (ui.tab === "history") body = G.panel(null, historyTab());
    else body = h("div", { class: "two-col sec-cols" }, h("div", { class: "sec-stack" }, ssoPanel(perm, sec), mfaPanel(perm, sec)), sessionPanel(perm, sec));
    return h("div", { class: "view view-security" },
      G.pageHeader({ id: "sec-head", kicker: "Govern · Security", title: "Security", sub: "How people get in and how long they stay. Identity providers are simulated; every change here is audited under auth.",
        meta: [["SSO", sec.sso.enforced ? sec.sso.provider + ", required" : "optional"], ["MFA", sec.mfa.policy === "all" ? "everyone" : sec.mfa.policy === "admins" ? "admins" : "off"], ["Idle timeout", sec.idleMin + " min"], ["Active sessions", String(active)], ["Failed sign-ins 24 h", String(fails)]] }),
      !perm.allowed ? h("div", { class: "sec-lock" }, G.lockNote(perm, "Security settings"), G.explainDenial ? G.explainDenial({ id: "sec-explain", person: G.viewerId(), action: "security.manage", decision: perm }) : null) : null,
      tabs, h("div", { id: "sec-tab-panel", role: "tabpanel" }, body));
  }

  G.views.security = { title: "Security", render: render, keys: ["security", "sessions", "signins", "people", "session"] };
})(window.G);
