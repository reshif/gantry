/* Sign-in screen (simulated SSO, GitHub, MFA, demo accounts) and idle-timeout warning.
   Nothing here talks to an identity provider; the screens say so. */
(function (G) {
  "use strict";
  var h = G.h;
  var ui = { step: "main", email: "", person: null, method: null, err: "" };

  G.DEMO_ACCOUNTS = [
    ["p-asha", "Factory Admin", "Sees and controls everything. MFA step."],
    ["p-daniel", "Project Admin", "Payments Platform and Storefront. MFA step."],
    ["p-meera", "Line Lead", "Payments Platform. Away; Priya is her delegate."],
    ["p-tomas", "Engineer", "Payments Platform only."],
    ["p-fatima", "Reviewer", "Storefront (also Engineer there)."],
    ["p-kenji", "Release Manager", "Payments, Storefront, Risk."],
    ["p-sam", "Auditor", "Read-only across the factory."],
    ["p-priya", "Two teams, two roles", "Reviewer on Payments, Line Lead on Risk."],
    ["p-lena", "Project Admin, on call", "Identity (new project). MFA step."],
    ["p-omar", "Factory Admin (second)", "Second approver for a factory restore. MFA step."]
  ];

  function needsMfa(p) {
    var pol = G.store.get("security").mfa.policy;
    if (pol === "off") return false;
    if (pol === "all") return true;
    return p.roles.some(function (g) { return g.role === "factory_admin" || g.role === "project_admin"; });
  }
  function finish(p, method) {
    if (needsMfa(p) && ui.step !== "mfa") { ui.person = p.id; ui.method = method; ui.step = "mfa"; ui.err = ""; G.renderSignIn(); return; }
    var r = G.ops.signIn(p.id, method, { mfa: ui.step === "mfa" });
    if (!r.ok) { ui.err = r.msg; ui.step = "main"; G.renderSignIn(); return; }
    ui = { step: "main", email: "", person: null, method: null, err: "" };
    G.toast(r.msg, "ok");
  }

  G.renderSignIn = function () {
    var root = document.getElementById("auth");
    G.clear(root);
    var brand = h("section", { class: "auth-brand", "aria-label": "About Gantry" },
      h("div", { class: "auth-logo" }, G.logo(), h("span", { class: "brand-name" }, "Gantry")),
      h("h1", { class: "auth-title" }, "Software factory"),
      h("p", { class: "auth-lede" }, "Run AI coding agents against your repos. People hold the gates, decide who can do what, and can stop the line at any time."),
      h("ol", { class: "auth-belt", "aria-label": "Stations" }, G.STATIONS.map(function (s) { return h("li", null, h("span", { class: "mono" }, s.no), s.name); })),
      h("p", { class: "auth-demo-note" }, G.icon("alert"), h("span", null, "Demo workspace with sample data. Sign-in is simulated: no identity provider, GitHub or password is involved.")));
    var panel = h("section", { class: "auth-panel", "aria-label": "Sign in" });
    if (ui.step === "main") {
      var email = h("input", { id: "auth-email", class: "input", type: "email", autocomplete: "username", placeholder: "you@acme.dev", value: ui.email });
      var form = h("form", { class: "form-grid", id: "auth-sso" },
        G.field("Work email", email, "We look up your organisation and send you to its identity provider."),
        G.btn("Continue with SSO", { kind: "primary", type: "submit", id: "auth-sso-go", icon: "key" }));
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var v = email.value.trim().toLowerCase(); ui.email = v;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { ui.err = "Enter a work email address."; G.renderSignIn(); return; }
        var dom = v.split("@")[1];
        if (G.store.get("security").domains.indexOf(dom) < 0) { G.ops.recordSignInFailure(v, "sso", "Domain not allowed"); ui.err = dom + " is not linked to an organisation in this Gantry."; G.renderSignIn(); return; }
        ui.step = "sso"; ui.err = ""; G.renderSignIn();
      });
      var gh = G.btn("Continue with GitHub", { id: "auth-gh", icon: "github", disabledReason: G.store.get("security").githubLogin ? null : "GitHub sign-in is turned off in Security settings.", onClick: function () { ui.step = "github"; ui.err = ""; G.renderSignIn(); } });
      panel.appendChild(h("div", null, h("div", { class: "kicker" }, "Sign in"), h("h2", { class: "auth-h" }, "Acme Payments")));
      if (ui.err) panel.appendChild(h("div", { class: "callout callout-block", role: "alert" }, G.icon("alert"), h("span", null, ui.err)));
      panel.appendChild(form);
      panel.appendChild(h("div", { class: "auth-or" }, h("span", null, "or")));
      panel.appendChild(gh);
      panel.appendChild(h("div", { class: "auth-demo" }, h("h3", { class: "sub-h" }, "Demo accounts · one click, demo only"),
        h("ul", { class: "demo-list" }, G.DEMO_ACCOUNTS.map(function (d) {
          var p = G.find.person(d[0]);
          return h("li", null, h("button", { type: "button", class: "demo-acc", id: "demo-" + d[0], onClick: function () { ui.step = "main"; finish(p, "demo"); } },
            G.avatar(p.id, "sm"), h("span", { class: "demo-main" }, h("strong", null, p.name), h("span", { class: "muted small" }, d[1] + " · " + d[2])), G.icon("chevron")));
        }))));
    } else if (ui.step === "sso") {
      var matches = G.store.get("people").filter(function (p) { return p.email === ui.email; });
      var sec = G.store.get("security").sso;
      panel.appendChild(h("div", { class: "idp" },
        h("div", { class: "kicker" }, "Simulated identity provider"),
        h("h2", { class: "auth-h" }, sec.provider + " · acme"),
        h("p", { class: "muted small mono" }, sec.entity),
        matches.length ? h("p", null, "Sign in to Gantry as ", h("strong", null, matches[0].name), " <" + ui.email + ">?") : h("p", null, "No Acme account matches " + ui.email + "."),
        h("div", { class: "auth-actions" },
          matches.length ? G.btn("Continue as " + matches[0].name, { kind: "primary", id: "idp-ok", onClick: function () { finish(matches[0], "sso"); } }) : null,
          G.btn("Deny access", { id: "idp-deny", onClick: function () { G.ops.recordSignInFailure(ui.email, "sso", "IdP returned access_denied"); ui.step = "main"; ui.err = "The identity provider denied access."; G.renderSignIn(); } }),
          G.btn("Back", { kind: "ghost", id: "idp-back", onClick: function () { ui.step = "main"; G.renderSignIn(); } }))));
    } else if (ui.step === "github") {
      var sel = G.select("gh-acct", G.store.get("people").filter(function (p) { return p.status === "active"; }).map(function (p) { return { value: p.id, label: p.github + " (" + p.name + ")" }; }), "p-tomas");
      panel.appendChild(h("div", { class: "idp" },
        h("div", { class: "kicker" }, "Simulated GitHub authorisation"),
        h("h2", { class: "auth-h" }, "Authorize Gantry Factory"),
        h("p", null, "Gantry Factory wants to read your GitHub identity and org membership in ", h("strong", null, "acme"), "."),
        G.field("Signed in to GitHub as", sel),
        h("div", { class: "auth-actions" },
          G.btn("Authorize", { kind: "primary", id: "gh-ok", onClick: function () { finish(G.find.person(sel.value), "github"); } }),
          G.btn("Cancel", { kind: "ghost", id: "gh-back", onClick: function () { ui.step = "main"; G.renderSignIn(); } }))));
    } else if (ui.step === "mfa") {
      var code = h("input", { id: "mfa-code", class: "input mono", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456" });
      var f2 = h("form", { class: "form-grid", id: "mfa-form" }, G.field("Six-digit code", code, "Any six digits work in this demo."), G.btn("Verify", { kind: "primary", type: "submit", id: "mfa-go" }));
      f2.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!/^\d{6}$/.test(code.value.trim())) { ui.err = "Enter six digits."; G.ops.recordSignInFailure(G.find.person(ui.person).email, ui.method, "MFA code rejected"); G.renderSignIn(); return; }
        finish(G.find.person(ui.person), ui.method);
      });
      panel.appendChild(h("div", { class: "idp" }, h("div", { class: "kicker" }, "Multi-factor authentication"), h("h2", { class: "auth-h" }, "Check your authenticator"),
        h("p", null, G.find.person(ui.person).name + " is an admin, so the MFA policy asks for a second factor."),
        ui.err ? h("div", { class: "callout callout-block", role: "alert" }, G.icon("alert"), h("span", null, ui.err)) : null, f2,
        G.btn("Cancel", { kind: "ghost", id: "mfa-back", onClick: function () { ui.step = "main"; ui.err = ""; G.renderSignIn(); } })));
    }
    root.appendChild(h("div", { class: "auth-wrap" }, brand, panel));
    setTimeout(function () { var f = root.querySelector("input,button"); if (f && !root.contains(document.activeElement)) f.focus(); }, 20);
  };

  /* idle warning: called by the Security view's "Simulate idle" control */
  G.simulateIdle = function (seconds) {
    seconds = seconds || 20;
    var left = seconds, timer;
    var count = h("strong", { class: "mono" }, String(left));
    var dlg = G.dialog({ title: "Are you still there?", kicker: "Session", sub: "You will be signed out for inactivity (idle timeout " + G.store.get("security").idleMin + " min, simulated).",
      body: h("p", null, "Signing out in ", count, " seconds."), onClose: function () { clearInterval(timer); },
      actions: [{ label: "Sign out now", id: "idle-out", onClick: function (close) { close(); G.signOut("signed out from idle warning"); } }, { label: "Stay signed in", kind: "primary", id: "idle-stay", onClick: function (close) { G.audit("session.extend", "Stayed signed in after idle warning", "factory", "ok", { category: "auth" }); close(); } }] });
    timer = setInterval(function () { left--; count.textContent = String(left); if (left <= 0) { clearInterval(timer); dlg.close(); G.signOut("idle timeout"); } }, 1000);
    G.audit("session.idle", "Idle warning shown (simulated)", "factory", "ok", { category: "auth" });
  };
  G.signOut = function (reason) {
    G.drawer.close();
    while (G.closeTopDialog()) { /* close all */ }
    var r = G.ops.signOut(reason);
    if (r.ok) G.toast(reason === "idle timeout" ? "Signed out after inactivity." : "Signed out.");
  };
})(window.G);
