/**
 * Modal layer behaviour and the Modal primitive.
 *
 * `useModalLayer` gives any overlay (dialog, drawer) the same rules:
 *  - everything outside the layer is `inert` while it is open (no tabbing out, no screen-reader browsing out, no clicks through);
 *    elements marked `data-inert-exempt` (the toast live region) stay live
 *  - one document-level key handler, scoped to the top layer only (nested layers do not fight)
 *  - focus moves in on mount (no timer) and returns to the opener on close
 *  - Escape and scrim clicks ask `requestClose`, which a dirty form can turn into a "discard changes?" step
 */
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "./Icon";
import { Btn } from "./primitives";

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
const EXEMPT = "[data-inert-exempt]";

/** Open layers, bottom to top. Only the last one handles keys. */
const layers: HTMLElement[] = [];

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !(x as HTMLButtonElement).disabled && !x.hidden && x.getAttribute("aria-hidden") !== "true" && !x.closest("[inert]"));
}

/** Marks every sibling of `el` and of each ancestor inert, except exempt ones. Returns the undo. */
export function inertOutside(el: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== document.body && node.parentElement) {
    for (const sib of Array.from(node.parentElement.children)) {
      if (sib === node || !(sib instanceof HTMLElement) || sib.hasAttribute("inert") || sib.matches(EXEMPT) || sib.matches("script,style")) continue;
      sib.setAttribute("inert", "");
      changed.push(sib);
    }
    node = node.parentElement;
  }
  return () => changed.forEach((s) => s.removeAttribute("inert"));
}

export interface ModalLayerOpts {
  /** The element that holds the layer (the panel). */
  ref: RefObject<HTMLElement | null>;
  /** Escape, scrim click and the close button call this. */
  requestClose: () => void;
  /** Where focus goes on open. Default: first field, else the primary action, else the first control. */
  initialFocus?: (panel: HTMLElement) => HTMLElement | null | undefined;
}

export function useModalLayer({ ref, requestClose, initialFocus }: ModalLayerOpts): void {
  const close = useRef(requestClose);
  close.current = requestClose;
  const pick = useRef(initialFocus);
  pick.current = initialFocus;
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // the layer root is the panel's wrapper, so the scrim stays inside the live region
    const root = panel.parentElement ?? panel;
    const undo = inertOutside(root);
    layers.push(panel);
    const target = pick.current?.(panel) ?? panel.querySelector<HTMLElement>("input:not([type=hidden]):not([type=checkbox]):not([disabled]),select:not([disabled]),textarea:not([disabled])") ?? panel.querySelector<HTMLElement>(".dlg-foot .btn-primary") ?? focusables(panel)[0];
    if (target) target.focus();
    else {
      panel.tabIndex = -1;
      panel.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (layers[layers.length - 1] !== panel) return;
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables(panel);
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      // focus can sit on non-focusable text inside the layer (a click on a paragraph); Tab must still stay inside
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = layers.lastIndexOf(panel);
      if (i >= 0) layers.splice(i, 1);
      undo();
      if (opener && document.body.contains(opener)) opener.focus();
    };
  }, [ref]);
}

/** Scrim that only closes on a full click that started on it (a text selection that ends outside the panel is not a dismissal). */
export function useScrimClose(requestClose: () => void): { onPointerDown: (e: React.PointerEvent) => void; onClick: (e: React.MouseEvent) => void } {
  const down = useRef(false);
  return {
    onPointerDown: (e) => {
      down.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      if (down.current && e.target === e.currentTarget) requestClose();
      down.current = false;
    },
  };
}

export interface ModalProps {
  title: ReactNode;
  kicker?: ReactNode;
  sub?: ReactNode;
  wide?: boolean;
  cls?: string;
  /** True while the body holds unsaved input: Escape, the scrim and the close button then ask before discarding. */
  dirty?: boolean;
  onClose: () => void;
  /** Wrap body and footer in a form with this submit handler. */
  onSubmit?: (e: React.FormEvent) => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ title, kicker, sub, wide, cls, dirty, onClose, onSubmit, children, footer }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = `dlg-title-${useId().replace(/:/g, "")}`;
  const [asking, setAsking] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) setAsking(true);
    else onClose();
  }, [dirty, onClose]);
  useModalLayer({ ref: panel, requestClose });
  const scrim = useScrimClose(requestClose);
  const inner = (
    <>
      <div className="dlg-body">{children}</div>
      {asking ? (
        <div className="dlg-discard" role="alertdialog" aria-labelledby={`discard-${titleId}`}>
          <span id={`discard-${titleId}`}>Discard your unsaved changes?</span>
          <Btn label="Keep editing" kind="ghost" small onClick={() => setAsking(false)} />
          <Btn label="Discard" kind="danger" small onClick={onClose} />
        </div>
      ) : null}
      {footer ? <div className="dlg-foot">{footer}</div> : null}
    </>
  );
  return (
    <div className="dlg-wrap">
      <div className="scrim" {...scrim} />
      <div ref={panel} className={`dlg${wide ? " dlg-wide" : ""}${cls ? ` ${cls}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dlg-head">
          <div>
            {kicker ? <div className="kicker">{kicker}</div> : null}
            <h2 id={titleId} className="dlg-title">{title}</h2>
            {sub ? <p className="dlg-sub">{sub}</p> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={requestClose}>
            <Icon name="x" />
          </button>
        </div>
        {onSubmit ? <form className="dlg-form" noValidate onSubmit={onSubmit}>{inner}</form> : <div className="dlg-form">{inner}</div>}
      </div>
    </div>
  );
}
