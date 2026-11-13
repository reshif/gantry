/* UI kit: element builder, icons, guarded controls, dialogs, drawer, toasts,
   tooltips and hand-drawn SVG charts. All text goes through text nodes or esc(). */
(function (G) {
  "use strict";

  var esc = G.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  /* h(tag, attrs, ...children). attrs: class, style, on<Event>, html (trusted static only), any attribute. */
  var h = G.h = function (tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (k === "selected") el.selected = !!v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  };
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  G.append = append;
  G.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /* ---------- icons (stroke, 24 grid) ---------- */
  var P = {
    floor: '<path d="M3 20h18M5 20V9l4 3V9l4 3V9l4 3V5h2v15"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    console: '<path d="M4 5h16v14H4z"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
    agent: '<rect x="5" y="7" width="14" height="11" rx="2"/><path d="M12 3v4M9 12h.01M15 12h.01M9.5 15.5h5"/>',
    model: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    eval: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2"/><path d="M16 4.6a3 3 0 010 6M18 14.8c1.7.6 2.7 2.4 3 5.2"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    ledger: '<path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5h4"/>',
    halt: '<path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z"/><path d="M8 12h8"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M19.5 14.5A8 8 0 019.5 4.5a8 8 0 1010 10z"/>',
    auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" stroke="none"/>',
    github: '<path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.3 4.3 0 00-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 00-6.2 0C6.6 2.8 5.6 3.1 5.6 3.1a4.3 4.3 0 00-.1 3.2A4.6 4.6 0 004.2 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
    slack: '<path d="M9.5 3a1.5 1.5 0 010 3H8V4.5A1.5 1.5 0 019.5 3zM3 9.5A1.5 1.5 0 014.5 8H11v3H4.5A1.5 1.5 0 013 9.5zM14.5 21a1.5 1.5 0 010-3H16v1.5a1.5 1.5 0 01-1.5 1.5zM21 14.5a1.5 1.5 0 01-1.5 1.5H13v-3h6.5a1.5 1.5 0 011.5 1.5zM13 4.5a1.5 1.5 0 013 0V11h-3zM11 19.5a1.5 1.5 0 01-3 0V13h3z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3.5 6l8.5 7 8.5-7"/>',
    gate: '<path d="M4 21V5M20 21V5M4 9h16M4 9l4-4M20 9l-4-4M12 9v12"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.5 7"/>',
    send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
    pin: '<path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0014.5 4h-9A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    shield: '<path d="M12 3l8 3v6c0 4.6-3.3 7.9-8 9-4.7-1.1-8-4.4-8-9V6z"/>',
    dots: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    sparkle: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    tag: '<path d="M3 12V3h9l9 9-9 9z"/><path d="M7.5 7.5h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    kill: '<circle cx="12" cy="12" r="8.5"/><path d="M8 8l8 8M16 8l-8 8"/>',
    power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1011.4 0"/>',
    tool: '<path d="M14.5 6.5a4 4 0 00-5.2 5.2L4 17l3 3 5.3-5.3a4 4 0 005.2-5.2l-2.5 2.5-2.5-.5-.5-2.5z"/>',
    human: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5 20c.8-4 3.5-6 7-6s6.2 2 7 6"/>',
    diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
    project: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M8 4v5"/>',
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    rocket: '<path d="M12 3c4 2 6 6 6 10l-3 3H9l-3-3c0-4 2-8 6-10z"/><circle cx="12" cy="10" r="1.6"/><path d="M9 19l-2 2M15 19l2 2"/>',
    skill: '<path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.8z"/>',
    server: '<rect x="4" y="4" width="16" height="6" rx="1"/><rect x="4" y="14" width="16" height="6" rx="1"/><path d="M8 7h.01M8 17h.01"/>',
    api: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    bell2: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5h4"/>',
    logout: '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4M18 12H9"/>',
    board: '<rect x="3" y="4" width="5" height="16"/><rect x="10" y="4" width="5" height="11"/><rect x="17" y="4" width="4" height="7"/>',
    belt: '<path d="M3 7h15a3 3 0 010 6H6a3 3 0 000 6h15"/>',
    teams: '<rect x="3" y="6" width="11" height="12" rx="1"/><path d="M6 10h5M8.5 10v5"/><circle cx="18" cy="8" r="2.5"/><path d="M15.5 13h5v4a2.5 2.5 0 01-5 0z"/>',
    webhook: '<circle cx="7" cy="17" r="2.5"/><circle cx="17" cy="17" r="2.5"/><circle cx="12" cy="7" r="2.5"/><path d="M10.5 9.5L8 15M13.5 9.5L16 15M9.5 17h5"/>',
    page: '<path d="M4 18h16M6 18V11a6 6 0 0112 0v7"/><path d="M12 3v2M3 8l1.5 1M21 8l-1.5 1"/>',
    grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
    move: '<path d="M5 12h14M15 8l4 4-4 4"/>',
    /* state glyphs: distinct shapes, not just colours */
    "st-park": '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M10 16V8h3a2.5 2.5 0 010 5h-3"/>',
    "st-kill": '<circle cx="12" cy="12" r="8.5"/><path d="M5.8 5.8l12.4 12.4"/>',
    "st-run": '<circle cx="12" cy="12" r="8"/><path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor"/>',
    "st-wait": '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/><path d="M12 8v4.5M12 15.5h.01"/>',
    "st-block": '<path d="M8.2 3.5h7.6l4.7 4.7v7.6l-4.7 4.7H8.2l-4.7-4.7V8.2z"/><path d="M8 12h8"/>',
    "st-fail": '<path d="M12 3.5l9 16H3z"/><path d="M9.6 11.6l4.8 4.8M14.4 11.6l-4.8 4.8"/>',
    "st-done": '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12.5l3 3 5.5-6"/>',
    trust: '<path d="M7 3v18M17 3v18M7 7h10M7 12h10M7 17h10"/>',
    learn: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    workload: '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><path d="M4 19h16"/>',
    record: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
    rail: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    replay: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/><path d="M12 8v4l3 2"/>'
  };
  G.icon = function (name, cls) {
    var s = h("span", { class: "ic " + (cls || ""), "aria-hidden": "true" });
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || P.dots) + "</svg>";
    return s;
  };
  G.logo = function () {
    var s = h("span", { class: "logo", "aria-hidden": "true" });
    s.innerHTML = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M4 28V6h24v22"/><path d="M4 10h24"/><path d="M14 10v8"/><rect x="11" y="18" width="6" height="5"/><path d="M8 6l4 4M24 6l-4 4"/></svg>';
    return s;
  };

  /* ---------- state badges ---------- */
  G.stateChip = function (state, compact) {
    var def = G.STATES[state] || { label: state, glyph: "dots" };
    return h("span", { class: "state state-" + state + (compact ? " compact" : "") }, G.icon(def.glyph), compact ? null : h("span", null, def.label));
  };
  G.chip = function (text, cls) { return h("span", { class: "chip " + (cls || "") }, text); };
  G.mono = function (text, cls) { return h("span", { class: "mono " + (cls || "") }, text); };

  G.avatar = function (id, size) {
    var p = G.find.person(id), a = !p && G.find.agent(id);
    var initials = p ? p.name.split(" ").map(function (w) { return w[0]; }).join("").slice(0, 2) : a ? a.initials : "?";
    return h("span", { class: "av " + (a ? "av-agent" : "av-person") + (size ? " av-" + size : ""), title: G.actorName(id), "aria-hidden": "true" }, initials);
  };
  G.who = function (id) {
    return h("span", { class: "who" }, G.avatar(id, "sm"), h("span", null, G.actorName(id).replace(" (agent)", "")));
  };

  /* ---------- guarded controls ----------
     decision: result of G.can / G.me. Forbidden controls stay visible and focusable,
     carry aria-disabled and show the reason as a tooltip on hover and focus. */
  G.guard = function (el, decision) {
    if (decision && !decision.allowed) {
      el.setAttribute("aria-disabled", "true");
      el.classList.add("is-locked");
      el.setAttribute("data-reason", (decision.needs ? decision.needs + ". " : "") + decision.reason);
    }
    return el;
  };
  G.btn = function (label, opts) {
    opts = opts || {};
    var b = h("button", { type: opts.type || "button", class: "btn " + (opts.kind ? "btn-" + opts.kind : "") + (opts.small ? " btn-sm" : "") + (opts.cls ? " " + opts.cls : ""), id: opts.id, "aria-label": opts.aria, title: opts.title },
      opts.icon ? G.icon(opts.icon) : null, label ? h("span", null, label) : null);
    if (opts.disabledReason) { b.setAttribute("aria-disabled", "true"); b.classList.add("is-locked"); b.setAttribute("data-reason", opts.disabledReason); }
    if (opts.guard) G.guard(b, opts.guard);
    b.addEventListener("click", function (e) {
      if (b.getAttribute("aria-disabled") === "true") { e.preventDefault(); e.stopPropagation(); G.tip.show(b); return; }
      if (opts.onClick) opts.onClick(e);
    });
    return b;
  };

  /* switch (checkbox with role=switch) */
  G.toggle = function (id, checked, onChange, decision, label) {
    var input = h("input", { type: "checkbox", role: "switch", id: id, class: "switch-input", checked: checked, "aria-label": label || null });
    var wrap = h("span", { class: "switch" }, input, h("span", { class: "switch-track", "aria-hidden": "true" }));
    if (decision && !decision.allowed) {
      G.guard(input, decision);
      wrap.classList.add("is-locked");
      input.addEventListener("click", function (e) { e.preventDefault(); G.tip.show(input); });
    } else if (onChange) {
      input.addEventListener("change", function () { onChange(input.checked); });
    }
    return wrap;
  };

  G.select = function (id, options, value, onChange, attrs) {
    var s = h("select", Object.assign({ id: id, class: "input" }, attrs || {}),
      options.map(function (o) {
        if (typeof o === "string") o = { value: o, label: o };
        return h("option", { value: o.value, selected: String(o.value) === String(value), disabled: o.disabled }, o.label);
      }));
    if (onChange) s.addEventListener("change", function () { onChange(s.value); });
    return s;
  };
  G.field = function (label, control, hint, forId) {
    var cid = forId || (control && control.id) || (control && control.querySelector && control.querySelector("[id]") && control.querySelector("[id]").id);
    return h("div", { class: "field" },
      h("label", { class: "field-label", for: cid || null }, label),
      control,
      hint ? h("div", { class: "field-hint" }, hint) : null);
  };
  G.lockNote = function (decision, what) {
    if (!decision || decision.allowed) return null;
    return h("div", { class: "lock-note", role: "note" }, G.icon("lock"), h("span", null, (what ? "Read-only for you: " + what.charAt(0).toLowerCase() + what.slice(1) + ". " : "") + (decision.needs ? decision.needs + ". " : "") + decision.reason));
  };

  G.tabs = function (items, active, onChange, idPrefix) {
    var bar = h("div", { class: "tabs", role: "tablist" });
    items.forEach(function (it) {
      var id = (idPrefix || "tab") + "-" + it.id;
      var b = h("button", { type: "button", role: "tab", id: id, class: "tab" + (it.id === active ? " is-active" : ""), "aria-selected": it.id === active ? "true" : "false" },
        it.label, it.count != null ? h("span", { class: "tab-count" }, String(it.count)) : null);
      b.addEventListener("click", function () { onChange(it.id); });
      bar.appendChild(b);
    });
    bar.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var tabs = Array.prototype.slice.call(bar.querySelectorAll(".tab"));
      var i = tabs.indexOf(document.activeElement); if (i < 0) return;
      var n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); n.click();
    });
    return bar;
  };

  /* ---------- tooltip for reasons ---------- */
  G.tip = (function () {
    var el, timer;
    function show(target) {
      el = el || document.getElementById("tip");
      var text = target.getAttribute("data-reason") || target.getAttribute("data-tip");
      if (!text || !el) return;
      el.textContent = text; el.hidden = false;
      var r = target.getBoundingClientRect();
      var w = Math.min(320, window.innerWidth - 16);
      el.style.maxWidth = w + "px";
      var tw = el.offsetWidth, th = el.offsetHeight;
      var left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
      var top = r.bottom + 8;
      if (top + th > window.innerHeight - 8) top = r.top - th - 8;
      el.style.left = left + "px"; el.style.top = Math.max(8, top) + "px";
      clearTimeout(timer);
    }
    var sticky = null;
    function hide() { if (el) { clearTimeout(timer); timer = setTimeout(function () { el.hidden = true; sticky = null; }, 60); } }
    /* shown by a click on a locked control: hide after a few seconds, on the next pointer down or on Escape */
    var stickyTimer;
    function flash(target) { show(target); sticky = target; clearTimeout(stickyTimer); stickyTimer = setTimeout(function () { if (el && sticky === target) el.hidden = true; sticky = null; }, 2600); }
    document.addEventListener("pointerdown", function (e) { if (sticky && !sticky.contains(e.target)) { if (el) el.hidden = true; sticky = null; } }, true);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && el && !el.hidden) { el.hidden = true; sticky = null; } });
    document.addEventListener("mouseover", function (e) {
      var t = e.target.closest && e.target.closest("[data-reason],[data-tip]");
      if (t) show(t); else if (!sticky) hide();
    });
    document.addEventListener("focusin", function (e) {
      var t = e.target.closest && e.target.closest("[data-reason],[data-tip]");
      if (t && t.matches(":focus-visible")) show(t); else hide();
    });
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    return { show: flash, hover: show, hide: hide };
  })();

  /* ---------- toasts ---------- */
  G.toast = function (text, kind) {
    var box = document.getElementById("toasts");
    var t = h("div", { class: "toast toast-" + (kind || "info") }, G.icon(kind === "error" ? "alert" : kind === "warn" ? "halt" : "check"), h("span", null, text),
      h("button", { type: "button", class: "toast-x", "aria-label": "Dismiss" }, G.icon("x")));
    t.querySelector(".toast-x").addEventListener("click", function () { t.remove(); });
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () { t.classList.add("out"); setTimeout(function () { t.remove(); }, 300); }, 4600);
  };

  /* ---------- focus trap helper ---------- */
  function trap(container, onEsc) {
    container.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); onEsc(); return; }
      if (e.key !== "Tab") return;
      var f = Array.prototype.slice.call(container.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'))
        .filter(function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* ---------- dialog ----------
     G.dialog({ title, sub, body: Node|fn(close), actions:[{label, kind, onClick(close), guard, submit}], wide, onClose })
     If any action has submit:true, body is wrapped in a form and Enter submits. */
  var dialogStack = [];
  G.dialog = function (o) {
    var layer = document.getElementById("layer-dialog");
    var prev = document.activeElement;
    var titleId = "dlg-title-" + Date.now();
    var closed = false;
    function close() {
      if (closed) return; closed = true;
      wrap.remove(); dialogStack.pop();
      if (o.onClose) o.onClose();
      if (prev && prev.focus && document.body.contains(prev)) prev.focus();
    }
    var body = typeof o.body === "function" ? o.body(close) : o.body;
    var form = h("form", { class: "dlg-form", novalidate: true });
    var footer = h("div", { class: "dlg-foot" });
    (o.actions || [{ label: "Close", kind: "ghost", onClick: function (c) { c(); } }]).forEach(function (a) {
      var b = G.btn(a.label, { kind: a.kind || "ghost", type: a.submit ? "submit" : "button", guard: a.guard, icon: a.icon, id: a.id,
        onClick: a.submit ? null : function () { a.onClick ? a.onClick(close) : close(); } });
      footer.appendChild(b);
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var sa = (o.actions || []).find(function (a) { return a.submit; });
      if (!sa) return;
      if (sa.guard && !sa.guard.allowed) return;
      if (sa.onClick) sa.onClick(close);
    });
    var panel = h("div", { class: "dlg" + (o.wide ? " dlg-wide" : ""), role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
      h("div", { class: "dlg-head" },
        h("div", null, o.kicker ? h("div", { class: "kicker" }, o.kicker) : null, h("h2", { id: titleId, class: "dlg-title" }, o.title), o.sub ? h("p", { class: "dlg-sub" }, o.sub) : null),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Close dialog", onClick: close }, G.icon("x"))),
      form);
    form.appendChild(h("div", { class: "dlg-body" }, body));
    form.appendChild(footer);
    var wrap = h("div", { class: "dlg-wrap" }, h("div", { class: "scrim", onClick: close }), panel);
    layer.appendChild(wrap);
    dialogStack.push(close);
    trap(panel, close);
    setTimeout(function () {
      var f = panel.querySelector("input:not([type=hidden]):not([type=checkbox]),select,textarea") || panel.querySelector(".dlg-foot .btn-primary") || panel.querySelector("button");
      if (f) f.focus();
    }, 20);
    return { close: close, panel: panel, form: form, body: form.querySelector(".dlg-body"), footer: footer };
  };
  G.closeTopDialog = function () { if (dialogStack.length) { dialogStack[dialogStack.length - 1](); return true; } return false; };

  /* ---------- drawer (single, right side) ---------- */
  var drawerState = null;
  G.drawer = {
    open: function (key, render) {
      var layer = document.getElementById("layer-drawer");
      if (drawerState) { drawerState.key = key; drawerState.render = render; G.drawer.refresh(); return; }
      var prev = document.activeElement;
      var panel = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": "Details" });
      var wrap = h("div", { class: "drawer-wrap" }, h("div", { class: "scrim", onClick: G.drawer.close }), panel);
      layer.appendChild(wrap);
      drawerState = { key: key, render: render, panel: panel, wrap: wrap, prev: prev };
      trap(panel, G.drawer.close);
      G.drawer.refresh();
      setTimeout(function () { var c = panel.querySelector(".drawer-close"); if (c) c.focus(); }, 20);
    },
    refresh: function () {
      if (!drawerState) return;
      var p = drawerState.panel;
      var scroller = p.querySelector(".drawer-scroll");
      var top = scroller ? scroller.scrollTop : 0;
      var active = document.activeElement && p.contains(document.activeElement) ? document.activeElement.id : null;
      G.clear(p);
      var node = drawerState.render(G.drawer.close);
      if (!node) { G.drawer.close(); return; }
      p.appendChild(node);
      var s2 = p.querySelector(".drawer-scroll"); if (s2) s2.scrollTop = top;
      if (active) { var a = document.getElementById(active); if (a) a.focus(); }
    },
    close: function () {
      if (!drawerState) return;
      drawerState.wrap.remove();
      var prev = drawerState.prev; drawerState = null;
      if (prev && prev.focus && document.body.contains(prev)) prev.focus();
    },
    isOpen: function (key) { return !!drawerState && (!key || drawerState.key === key); }
  };

  /* ---------- popover anchored under a button ---------- */
  G.popover = function (anchor, content, onClose) {
    var layer = document.getElementById("layer-pop");
    G.clear(layer);
    var r = anchor.getBoundingClientRect();
    var pop = h("div", { class: "pop", role: "dialog", "aria-label": anchor.getAttribute("aria-label") || "Menu" }, content);
    var shield = h("div", { class: "pop-shield" });
    function close() { G.clear(layer); anchor.setAttribute("aria-expanded", "false"); if (onClose) onClose(); anchor.focus(); }
    shield.addEventListener("click", close);
    layer.appendChild(shield); layer.appendChild(pop);
    var w = Math.min(380, window.innerWidth - 16);
    pop.style.width = w + "px";
    pop.style.top = (r.bottom + 6) + "px";
    pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
    anchor.setAttribute("aria-expanded", "true");
    trap(pop, close);
    setTimeout(function () { var f = pop.querySelector("button,select,input,a"); if (f) f.focus(); }, 10);
    return close;
  };

  /* ---------- charts ---------- */
  G.spark = function (values, opts) {
    opts = opts || {};
    var w = opts.w || 84, hgt = opts.h || 22, pad = 2;
    var min = opts.min != null ? opts.min : Math.min.apply(null, values), max = opts.max != null ? opts.max : Math.max.apply(null, values);
    if (max === min) { max += 1; min -= 1; }
    var pts = values.map(function (v, i) {
      return [pad + i * (w - pad * 2) / (values.length - 1), hgt - pad - (v - min) / (max - min) * (hgt - pad * 2)];
    });
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("");
    var area = d + "L" + pts[pts.length - 1][0].toFixed(1) + " " + (hgt - pad) + "L" + pad + " " + (hgt - pad) + "Z";
    var last = pts[pts.length - 1];
    var s = h("span", { class: "spark" + (opts.cls ? " " + opts.cls : ""), role: "img", "aria-label": opts.label || ("Trend, latest " + values[values.length - 1]) });
    s.innerHTML = '<svg viewBox="0 0 ' + w + " " + hgt + '" width="' + w + '" height="' + hgt + '"><path d="' + area + '" class="spark-area"/><path d="' + d + '" class="spark-line"/><circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.4" class="spark-dot"/></svg>';
    return s;
  };

  /* Area chart with faint grid, labelled axes, emphasised endpoint.
     opts: { values:[], labels:[], fmt(v), yLabel, min, max, threshold, threshLabel, w, h, compare:[] } */
  G.areaChart = function (o) {
    var W = o.w || 520, H = o.h || 210, L = 48, R = 64, T = 24, B = 30;
    var vals = o.values, all = vals.concat(o.compare || []);
    if (o.threshold != null) all = all.concat([o.threshold]);
    var min = o.min != null ? o.min : Math.min.apply(null, all), max = o.max != null ? o.max : Math.max.apply(null, all);
    if (o.min == null) { var span = (max - min) || 1; min -= span * 0.15; max += span * 0.1; }
    var fmt = o.fmt || function (v) { return String(v); };
    function x(i) { return L + i * (W - L - R) / (vals.length - 1); }
    function y(v) { return T + (1 - (v - min) / (max - min)) * (H - T - B); }
    var s = "";
    for (var g = 0; g <= 4; g++) {
      var gv = min + (max - min) * g / 4, gy = y(gv);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '" class="ch-grid"/>';
      s += '<text x="' + (L - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" class="ch-tick" text-anchor="end">' + esc(fmt(gv)) + "</text>";
    }
    (o.labels || []).forEach(function (lb, i) {
      if (vals.length > 8 && i % 2 && i !== vals.length - 1) return;
      s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - B + 16) + '" class="ch-tick" text-anchor="middle">' + esc(lb) + "</text>";
    });
    if (o.threshold != null) {
      var ty = y(o.threshold);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ty.toFixed(1) + '" y2="' + ty.toFixed(1) + '" class="ch-thresh"/>';
      s += '<text x="' + (W - R + 4) + '" y="' + (ty + 3.5).toFixed(1) + '" class="ch-tick ch-thresh-l">' + esc(o.threshLabel || "threshold") + "</text>";
    }
    function path(arr) { return arr.map(function (v, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); }).join(""); }
    if (o.compare) s += '<path d="' + path(o.compare) + '" class="ch-line-2"/>';
    var line = path(vals);
    s += '<path d="' + line + "L" + x(vals.length - 1).toFixed(1) + " " + (H - B) + "L" + L + " " + (H - B) + 'Z" class="ch-area"/>';
    s += '<path d="' + line + '" class="ch-line"/>';
    var lx = x(vals.length - 1), ly = y(vals[vals.length - 1]);
    s += '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="4" class="ch-end"/>';
    s += '<text x="' + (lx + 8).toFixed(1) + '" y="' + (ly + 4).toFixed(1) + '" class="ch-end-l">' + esc(fmt(vals[vals.length - 1])) + "</text>";
    s += '<line x1="' + L + '" x2="' + L + '" y1="' + T + '" y2="' + (H - B) + '" class="ch-axis"/>';
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" class="ch-axis"/>';
    if (o.yLabel) s += '<text x="' + 4 + '" y="' + 11 + '" class="ch-ylabel">' + esc(o.yLabel) + "</text>";
    var fig = h("figure", { class: "chart" });
    var svgWrap = h("div", { class: "chart-svg", role: "img", "aria-label": (o.title || "Chart") + ". Latest " + fmt(vals[vals.length - 1]) });
    svgWrap.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">' + s + "</svg>";
    if (o.title) fig.appendChild(h("figcaption", { class: "chart-title" }, o.title, o.legend ? h("span", { class: "chart-legend" }, o.legend) : null));
    fig.appendChild(svgWrap);
    return fig;
  };

  /* horizontal bar chart: o { title, rows:[{label,value,note}], min, max, fmt, xLabel, threshold, threshLabel, emphasis:"max"|"min", ticks } */
  G.barChart = function (o) {
    var rows = o.rows, n = rows.length;
    var W = 560, rowH = 24, T = 10, B = 34, L = Math.min(210, 14 + 6.3 * Math.max.apply(null, rows.map(function (r) { return String(r.label).length; }))), R = 70;
    var H = T + B + n * rowH;
    var min = o.min != null ? o.min : 0, max = o.max != null ? o.max : Math.max.apply(null, rows.map(function (r) { return r.value; })) * 1.1 || 1;
    var fmt = o.fmt || function (v) { return String(v); };
    function x(v) { return L + (Math.max(min, Math.min(max, v)) - min) / (max - min) * (W - L - R); }
    var ticks = o.ticks || 4, s = "";
    for (var g = 0; g <= ticks; g++) {
      var gv = min + (max - min) * g / ticks, gx = x(gv);
      s += '<line x1="' + gx.toFixed(1) + '" x2="' + gx.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" class="ch-grid"/>';
      s += '<text x="' + gx.toFixed(1) + '" y="' + (H - B + 14) + '" class="ch-tick" text-anchor="middle">' + G.esc(fmt(gv)) + "</text>";
    }
    var ext = rows.reduce(function (best, r, i) { return best < 0 || (o.emphasis === "max" ? r.value > rows[best].value : r.value < rows[best].value) ? i : best; }, -1);
    rows.forEach(function (r, i) {
      var y = T + i * rowH, bw = x(r.value) - L, em = i === ext && o.emphasis;
      s += '<text x="' + (L - 8) + '" y="' + (y + rowH / 2 + 4).toFixed(1) + '" class="ch-tick bar-cat" text-anchor="end">' + G.esc(r.label) + "</text>";
      s += '<rect x="' + L + '" y="' + (y + 5) + '" width="' + Math.max(1, bw).toFixed(1) + '" height="' + (rowH - 10) + '" class="bar' + (em ? " is-em" : "") + '"/>';
      if (em) s += '<rect x="' + (L + bw - 3).toFixed(1) + '" y="' + (y + 2) + '" width="6" height="' + (rowH - 4) + '" class="bar-end"/>';
      s += '<text x="' + (L + bw + 7).toFixed(1) + '" y="' + (y + rowH / 2 + 4).toFixed(1) + '" class="' + (em ? "ch-end-l" : "ch-tick bar-val") + '">' + G.esc(fmt(r.value) + (r.note ? "  " + r.note : "")) + "</text>";
    });
    if (o.threshold != null) {
      var tx = x(o.threshold);
      s += '<line x1="' + tx.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y1="' + (T - 4) + '" y2="' + (H - B) + '" class="ch-thresh"/>';
      s += '<text x="' + (tx + 4).toFixed(1) + '" y="' + (T + 2) + '" class="ch-tick ch-thresh-l">' + G.esc(o.threshLabel || "") + "</text>";
    }
    s += '<line x1="' + L + '" x2="' + L + '" y1="' + T + '" y2="' + (H - B) + '" class="ch-axis"/>';
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" class="ch-axis"/>';
    if (o.xLabel) s += '<text x="' + ((L + W - R) / 2).toFixed(1) + '" y="' + (H - 4) + '" class="ch-ylabel" text-anchor="middle">' + G.esc(o.xLabel) + "</text>";
    var fig = h("figure", { class: "chart chart-bars" });
    if (o.title) fig.appendChild(h("figcaption", { class: "chart-title" }, o.title));
    var wrap = h("div", { class: "chart-svg", role: "img", "aria-label": (o.title || "Bar chart") + ": " + rows.map(function (r) { return r.label + " " + fmt(r.value); }).join(", ") });
    wrap.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">' + s + "</svg>";
    fig.appendChild(wrap);
    return fig;
  };

  /* horizontal meter (value vs budget) */
  G.meter = function (value, max, label, warnAt) {
    var pct = max ? Math.min(1, value / max) : 0;
    return h("div", { class: "meter" + (pct >= (warnAt || 0.85) ? " meter-warn" : ""), role: "meter", "aria-valuemin": "0", "aria-valuemax": String(max), "aria-valuenow": String(Math.round(value)), "aria-label": label || "Usage" },
      h("span", { class: "meter-fill", style: "width:" + (pct * 100).toFixed(1) + "%" }));
  };

  G.empty = function (title, text, action) {
    return h("div", { class: "empty" }, h("div", { class: "empty-title" }, title), h("p", null, text), action || null);
  };

  /* section header used across views */
  G.viewHead = function (o) {
    return h("header", { class: "vhead" },
      h("div", { class: "vhead-main" },
        h("div", { class: "kicker" }, o.kicker),
        h("h1", { class: "vtitle" }, o.title),
        o.sub ? h("p", { class: "vsub" }, o.sub) : null),
      o.meta ? h("dl", { class: "titleblock" }, o.meta.map(function (m) { return h("div", null, h("dt", null, m[0]), h("dd", null, m[1])); })) : null,
      o.actions ? h("div", { class: "vhead-actions" }, o.actions) : null);
  };

  G.panel = function (title, body, opts) {
    opts = opts || {};
    return h("section", { class: "panel " + (opts.cls || ""), "aria-label": typeof title === "string" ? title : null },
      title ? h("div", { class: "panel-head" }, h("h2", { class: "panel-title" }, title), opts.tools ? h("div", { class: "panel-tools" }, opts.tools) : null) : null,
      h("div", { class: "panel-body" + (opts.flush ? " flush" : "") }, body));
  };

  G.copy = function (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { G.toast("Copied " + text); }, function () { G.toast("Copy is not available in this frame", "warn"); });
      } else G.toast("Copy is not available in this frame", "warn");
    } catch (e) { G.toast("Copy is not available in this frame", "warn"); }
  };

  /* segmented control (radio group styled as buttons) */
  G.segmented = function (name, items, value, onChange, label) {
    var wrap = h("div", { class: "seg", role: "radiogroup", "aria-label": label || name });
    items.forEach(function (it) {
      var id = name + "-" + it.id;
      var input = h("input", { type: "radio", name: name, id: id, value: it.id, checked: it.id === value, class: "seg-input" });
      input.addEventListener("change", function () { onChange(it.id); });
      wrap.appendChild(input);
      wrap.appendChild(h("label", { for: id, class: "seg-label" }, it.icon ? G.icon(it.icon) : null, h("span", null, it.label)));
    });
    return wrap;
  };

  /* menu of actions in a popover; items: {label, onClick, guard, hint} */
  G.menu = function (anchor, title, items) {
    var close;
    var list = h("ul", { class: "menu", role: "menu" }, items.map(function (it) {
      if (it.sep) return h("li", { class: "menu-sep", role: "separator" });
      var locked = it.guard && !it.guard.allowed;
      var b = h("button", { type: "button", role: "menuitem", class: "menu-item" + (locked ? " is-locked" : ""), "aria-disabled": locked ? "true" : null, "data-reason": locked ? ((it.guard.needs ? it.guard.needs + ". " : "") + it.guard.reason) : null },
        it.icon ? G.icon(it.icon) : null, h("span", { class: "menu-l" }, it.label), it.hint ? h("span", { class: "menu-h" }, locked ? "locked" : it.hint) : (locked ? h("span", { class: "menu-h" }, "locked") : null));
      b.addEventListener("click", function () { if (locked) { G.tip.show(b); return; } close(); it.onClick(); });
      return h("li", { role: "none" }, b);
    }));
    list.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      var all = Array.prototype.slice.call(list.querySelectorAll(".menu-item"));
      var i = all.indexOf(document.activeElement);
      var n = all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]; if (n) n.focus();
    });
    close = G.popover(anchor, h("div", null, title ? h("div", { class: "pop-head" }, h("strong", null, title)) : null, list));
    return close;
  };

  /* reason prompt dialog returning text through a callback */
  G.reasonDialog = function (o) {
    var ta = h("textarea", { id: "rsn-text", class: "input", rows: "3", placeholder: o.placeholder || "" });
    var err = h("div", { class: "form-err", role: "alert" });
    G.dialog({ title: o.title, kicker: o.kicker, sub: o.sub, body: h("div", { class: "form-grid" }, o.extra || null, G.field(o.label || "Reason", ta), err),
      actions: [{ label: "Cancel" }, { label: o.ok || "Confirm", kind: o.kind || "primary", submit: true, id: "rsn-ok", guard: o.guard, onClick: function (close) {
        var v = ta.value.trim();
        if (v.length < (o.min || 3)) { err.textContent = "Give a reason of at least " + (o.min || 3) + " characters."; return; }
        var r = o.onOk(v);
        if (r && r.ok === false) { err.textContent = r.msg; return; }
        close();
      } }] });
  };

  G.reducedMotion = function () {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  };
})(window.G);
