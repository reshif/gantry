/**
 * Tooltip for reasons (legacy G.tip): shows `data-reason` / `data-tip` of the hovered or focused
 * element in the single #tip node. Locked controls call tip.show(el) on click so the reason
 * stays visible for a moment.
 */
import { useEffect } from "react";

let el: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let stickyTimer: ReturnType<typeof setTimeout> | undefined;
let sticky: Element | null = null;

function node(): HTMLElement | null {
  el = el && el.isConnected ? el : document.getElementById("tip");
  return el;
}

function place(target: Element): void {
  const tip = node();
  const text = target.getAttribute("data-reason") || target.getAttribute("data-tip");
  if (!text || !tip) return;
  tip.textContent = text;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  tip.style.maxWidth = `${w}px`;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
  let top = r.bottom + 8;
  if (top + th > window.innerHeight - 8) top = r.top - th - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(8, top)}px`;
  clearTimeout(timer);
}

function hide(): void {
  const tip = node();
  if (!tip) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    tip.hidden = true;
    sticky = null;
  }, 60);
}

export const tip = {
  /** Show the reason after a click on a locked control; hides after a few seconds. */
  show(target: Element): void {
    place(target);
    sticky = target;
    clearTimeout(stickyTimer);
    stickyTimer = setTimeout(() => {
      const t = node();
      if (t && sticky === target) t.hidden = true;
      sticky = null;
    }, 2600);
  },
  hover: place,
  hide,
};

const closestTip = (t: EventTarget | null): Element | null =>
  t instanceof Element ? t.closest("[data-reason],[data-tip]") : null;

export function Tip() {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (sticky && e.target instanceof Node && !sticky.contains(e.target)) {
        const t = node();
        if (t) t.hidden = true;
        sticky = null;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const t = node();
      if (e.key === "Escape" && t && !t.hidden) {
        t.hidden = true;
        sticky = null;
      }
    };
    const onOver = (e: MouseEvent) => {
      const t = closestTip(e.target);
      if (t) place(t);
      else if (!sticky) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = closestTip(e.target);
      if (t && t.matches(":focus-visible")) place(t);
      else hide();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mouseover", onOver);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
    };
  }, []);
  return <div className="tip" id="tip" role="tooltip" hidden />;
}
