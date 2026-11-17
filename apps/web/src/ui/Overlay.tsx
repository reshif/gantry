/**
 * Toasts, modal dialogs, the single right-hand drawer and anchored popovers/menus (legacy
 * G.toast, G.dialog, G.drawer, G.popover, G.menu), as React. Same DOM and classes, same focus
 * rules: dialogs trap focus, Escape closes the top layer, focus returns to the opener.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Btn, Field, guardProps } from "./primitives";
import { UIContext, type DialogAction, type DialogOpts, type MenuItem, type ToastAction, type ToastKind, type UIApi } from "./overlay-context";
import { tip } from "./Tip";
import { DirtyScope, useLeaveGuard, type DirtyScopeApi } from "../lib/useLeaveGuard";
import "../lib/data.css";
import { Modal, useModalLayer, useScrimClose } from "./Modal";

/* ---------- focus trap ---------- */

const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

function trapKeys(getContainer: () => HTMLElement | null, onEsc: () => void) {
  return (e: KeyboardEvent) => {
    const container = getContainer();
    if (e.key === "Escape") {
      e.stopPropagation();
      onEsc();
      return;
    }
    if (e.key !== "Tab" || !container) return;
    const f = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
    const first = f[0];
    const last = f[f.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/* ---------- Dialog (declarative) ---------- */

export interface DialogProps extends Omit<DialogOpts, "onClose"> {
  onClose: () => void;
}

/** A modal dialog (see ui/Modal for the layer rules). Render it while open; call onClose to dismiss. Also used by ui.dialog(). */
export function Dialog({ title, kicker, sub, wide, cls, dirty, body, actions, onClose }: DialogProps) {
  // Forms inside mark themselves with useLeaveGuard(dirty); the dialog is dirty while any of them is, so every dismissal asks first.
  const dirtyIds = useRef(new Set<symbol>());
  const [marked, setMarked] = useState(false);
  const scope = useMemo<DirtyScopeApi>(() => ({ mark: (id, d) => { if (d) dirtyIds.current.add(id); else dirtyIds.current.delete(id); setMarked(dirtyIds.current.size > 0); } }), []);
  const list: DialogAction[] = actions ?? [{ label: "Close", kind: "ghost" }];
  const submitAction = list.find((a) => a.submit);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!submitAction) return;
    if (submitAction.guard && !submitAction.guard.allowed) return;
    submitAction.onClick?.(onClose);
  };
  const content = typeof body === "function" ? body(onClose) : body;
  return (
    <Modal title={title} kicker={kicker} sub={sub} wide={wide} cls={cls} dirty={dirty || marked} onClose={onClose} onSubmit={onSubmit}
      footer={(ask) => list.map((a, i) => (
        <Btn key={a.id ?? `${a.label}-${i}`} label={a.label} kind={a.kind ?? "ghost"} type={a.submit ? "submit" : "button"} guard={a.guard} icon={a.icon} id={a.id} onClick={a.submit ? undefined : () => (a.onClick ? a.onClick(ask) : ask())} />
      ))}
    >
      <DirtyScope.Provider value={scope}>{content}</DirtyScope.Provider>
    </Modal>
  );
}

/* ---------- Drawer ---------- */

function DrawerView({ render, onClose }: { render: (close: () => void) => ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useModalLayer({ ref: panel, requestClose: onClose, initialFocus: (p) => p.querySelector<HTMLElement>(".drawer-close") });
  const scrim = useScrimClose(onClose);
  return (
    <div className="drawer-wrap">
      <div className="scrim" {...scrim} />
      <aside ref={panel} className="drawer" role="dialog" aria-modal="true" aria-label="Details">
        {render(onClose)}
      </aside>
    </div>
  );
}

/* ---------- Popover and menu ---------- */

interface PopState {
  anchor: HTMLElement;
  render: (close: () => void) => ReactNode;
  onClose?: (() => void) | undefined;
  rect: DOMRect;
}

function PopoverView({ state, onClose }: { state: PopState; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const { anchor, rect } = state;
  const w = Math.min(380, window.innerWidth - 16);
  useEffect(() => {
    anchor.setAttribute("aria-expanded", "true");
    const t = setTimeout(() => pop.current?.querySelector<HTMLElement>("button,select,input,a")?.focus(), 10);
    return () => clearTimeout(t);
  }, [anchor]);
  return (
    <>
      <div className="pop-shield" onClick={onClose} />
      <div ref={pop} className="pop" role="dialog" aria-label={anchor.getAttribute("aria-label") || "Menu"} style={{ width: w, top: rect.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w)) }} onKeyDown={trapKeys(() => pop.current, onClose)}>
        {state.render(onClose)}
      </div>
    </>
  );
}

function MenuList({ title, items, close }: { title: string | null; items: MenuItem[]; close: () => void }) {
  const list = useRef<HTMLUListElement>(null);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = Array.from(list.current?.querySelectorAll<HTMLElement>(".menu-item") ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  };
  return (
    <div>
      {title ? (
        <div className="pop-head">
          <strong>{title}</strong>
        </div>
      ) : null}
      <ul className="menu" role="menu" ref={list} onKeyDown={onKey}>
        {items.map((it, i) => {
          if (it.sep) return <li key={i} className="menu-sep" role="separator" />;
          const g = guardProps(it.guard);
          return (
            <li key={i} role="none">
              <button
                type="button"
                role="menuitem"
                className={`menu-item${g.locked ? " is-locked" : ""}${it.kind === "danger" || it.kind === "andon" ? " menu-item-danger" : ""}`}
                aria-disabled={g["aria-disabled"]}
                data-reason={g["data-reason"]}
                onClick={(e) => {
                  if (g.locked) {
                    tip.show(e.currentTarget);
                    return;
                  }
                  close();
                  it.onClick?.();
                }}
              >
                {it.icon ? <Icon name={it.icon} /> : null}
                <span className="menu-l">{it.label}</span>
                {it.hint ? <span className="menu-h">{g.locked ? "locked" : it.hint}</span> : g.locked ? <span className="menu-h">locked</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------- reason / typed confirm dialogs ---------- */

type Outcome = void | { ok: boolean; msg?: string };

function useSubmit(onClose: () => void) {
  const [err, setErr] = useState("");
  const run = useCallback(
    async (fn: () => Outcome | Promise<Outcome>) => {
      const r = await fn();
      if (r && r.ok === false) {
        setErr(r.msg ?? "That did not work.");
        return;
      }
      onClose();
    },
    [onClose],
  );
  return { err, setErr, run };
}

/** Marks the enclosing dialog as holding unsaved input while `dirty`. */
function DirtyMark({ dirty }: { dirty: boolean }) {
  useLeaveGuard(dirty);
  return null;
}

function ReasonView({ o, onClose }: { o: Parameters<UIApi["reasonDialog"]>[0]; onClose: () => void }) {
  const [text, setText] = useState("");
  const { err, setErr, run } = useSubmit(onClose);
  const min = o.min ?? 3;
  return (
    <Dialog
      title={o.title}
      kicker={o.kicker}
      sub={o.sub}
      onClose={onClose}
      body={
        <div className="form-grid">
          <DirtyMark dirty={text.trim() !== ""} />
          {o.extra ?? null}
          <Field label={o.label || "Reason"} htmlFor="rsn-text">
            <textarea id="rsn-text" className="input" rows={3} placeholder={o.placeholder || ""} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[
        { label: "Cancel" },
        {
          label: o.ok || "Confirm",
          kind: o.kind || "primary",
          submit: true,
          id: "rsn-ok",
          guard: o.guard,
          onClick: () => {
            const v = text.trim();
            if (v.length < min) {
              setErr(`Give a reason of at least ${min} characters.`);
              return;
            }
            void run(() => o.onOk(v));
          },
        },
      ]}
    />
  );
}

function TypedView({ o, onClose }: { o: Parameters<UIApi["typedConfirm"]>[0]; onClose: () => void }) {
  const [text, setText] = useState("");
  const { err, setErr, run } = useSubmit(onClose);
  return (
    <Dialog
      title={o.title}
      kicker={o.kicker}
      sub={o.sub}
      wide={o.wide}
      onClose={onClose}
      body={
        <div className="form-grid">
          <DirtyMark dirty={text !== ""} />
          {o.body ?? null}
          <Field label={`Type ${o.phrase} to confirm`} htmlFor="tc-input">
            <input id="tc-input" className="input mono" autoComplete="off" placeholder={o.phrase} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[
        { label: "Cancel" },
        {
          label: o.okLabel || "Confirm",
          kind: o.kind || "danger",
          submit: true,
          id: "tc-ok",
          guard: o.guard,
          onClick: () => {
            if (text !== o.phrase) {
              setErr(`Type ${o.phrase} exactly.`);
              return;
            }
            void run(() => o.onOk(text));
          },
        },
      ]}
    />
  );
}

/* ---------- provider ---------- */

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  out: boolean;
  action?: ToastAction | undefined;
}
interface StackItem {
  id: number;
  render: (close: () => void) => ReactNode;
}

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [stack, setStack] = useState<StackItem[]>([]);
  const [drawer, setDrawer] = useState<{ key: string; render: (close: () => void) => ReactNode } | null>(null);
  const [pop, setPop] = useState<PopState | null>(null);
  const seq = useRef(1);
  const stackRef = useRef<StackItem[]>([]);
  const popRef = useRef<PopState | null>(null);
  const drawerRef = useRef(drawer);
  stackRef.current = stack;
  popRef.current = pop;
  drawerRef.current = drawer;

  const toast = useCallback((text: string, kind: ToastKind = "info", action?: ToastAction) => {
    const id = seq.current++;
    setToasts((l) => [...l, { id, text, kind, out: false, action }].slice(-3));
    setTimeout(() => {
      setToasts((l) => l.map((t) => (t.id === id ? { ...t, out: true } : t)));
      setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), 300);
    }, action ? 10_000 : 4600);
  }, []);

  const closePopover = useCallback(() => {
    const p = popRef.current;
    if (!p) return;
    popRef.current = null;
    setPop(null);
    p.anchor.setAttribute("aria-expanded", "false");
    p.onClose?.();
    p.anchor.focus();
  }, []);

  const api = useMemo<UIApi>(() => {
    const open: UIApi["open"] = (render) => {
      const id = seq.current++;
      const close = () => setStack((s) => s.filter((x) => x.id !== id));
      setStack((s) => [...s, { id, render }]);
      return { close };
    };
    const dialog: UIApi["dialog"] = (o) => {
      let closed = false;
      let handle: { close: () => void } | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        handle?.close();
        o.onClose?.();
      };
      handle = open(() => <Dialog {...o} onClose={close} />);
      return { close };
    };
    return {
      toast,
      open,
      dialog,
      closeTopDialog: () => {
        const top = stackRef.current[stackRef.current.length - 1];
        if (!top) return false;
        setStack((s) => s.filter((x) => x.id !== top.id));
        return true;
      },
      closeAllDialogs: () => setStack([]),
      drawer: {
        open: (key, render) => setDrawer({ key, render }),
        close: () => setDrawer(null),
        isOpen: (key) => !!drawerRef.current && (!key || drawerRef.current.key === key),
      },
      popover: (anchor, render, onClose) => {
        setPop({ anchor, render, onClose, rect: anchor.getBoundingClientRect() });
        return closePopover;
      },
      menu: (anchor, title, items) => {
        setPop({ anchor, render: (close) => <MenuList title={title} items={items} close={close} />, rect: anchor.getBoundingClientRect() });
        return closePopover;
      },
      closePopover,
      confirm: (o) =>
        new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (v: boolean) => {
            if (!done) {
              done = true;
              resolve(v);
            }
          };
          open((close) => (
            <Dialog
              title={o.title}
              kicker={o.kicker}
              body={o.body ?? null}
              onClose={() => {
                close();
                finish(false);
              }}
              actions={[
                { label: "Cancel", onClick: (c) => c() },
                {
                  label: o.ok ?? "Confirm",
                  kind: o.kind ?? "primary",
                  submit: true,
                  id: "confirm-ok",
                  onClick: () => {
                    finish(true);
                    close();
                  },
                },
              ]}
            />
          ));
        }),
      reasonDialog: (o) => void open((close) => <ReasonView o={o} onClose={close} />),
      typedConfirm: (o) => void open((close) => <TypedView o={o} onClose={close} />),
    };
  }, [toast, closePopover]);

  // legacy: a route change closes the drawer and any popover
  useEffect(() => {
    const onHash = () => {
      setDrawer(null);
      closePopover();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [closePopover]);

  const drawerClose = useCallback(() => setDrawer(null), []);

  return (
    <UIContext.Provider value={api}>
      {children}
      <div id="layer-drawer">{drawer ? <DrawerView key="drawer" render={drawer.render} onClose={drawerClose} /> : null}</div>
      <div id="layer-dialog">
        {stack.map((s) => (
          <Fragment2 key={s.id} item={s} onClose={() => setStack((l) => l.filter((x) => x.id !== s.id))} />
        ))}
      </div>
      <div id="layer-pop" data-inert-exempt="">{pop ? <PopoverView state={pop} onClose={closePopover} /> : null}</div>
      <div className="toasts" id="toasts" role="status" aria-live="polite" data-inert-exempt="">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}${t.out ? " out" : ""}`}>
            <Icon name={t.kind === "error" ? "alert" : t.kind === "warn" ? "halt" : "check"} />
            <span>{t.text}</span>
            {t.action ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost toast-act"
                id={t.action.id}
                onClick={() => {
                  setToasts((l) => l.filter((x) => x.id !== t.id));
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </UIContext.Provider>
  );
}

function Fragment2({ item, onClose }: { item: StackItem; onClose: () => void }) {
  return <>{item.render(onClose)}</>;
}

