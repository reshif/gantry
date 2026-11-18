/** Sizes an element to the rest of the viewport below its own top edge, so the page never scrolls and the pane's composer stays on screen (a fixed `calc(100dvh - N)` ignores the real header and title height). */
import { useEffect, useState } from "react";

const GAP = 16;

export function useFitViewport<T extends HTMLElement>() {
  const [el, ref] = useState<T | null>(null);
  useEffect(() => {
    if (!el) return;
    const fit = () => {
      // the shell scrolls inside #main (with the status bar below it): fit to that region's visible bottom, else to the window
      const main = el.closest<HTMLElement>("#main");
      const pad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const bottom = main && main.clientHeight > 0 ? main.getBoundingClientRect().top + main.clientHeight - pad : window.innerHeight;
      const top = el.getBoundingClientRect().top;
      const room = Math.floor(bottom - top - GAP);
      if (room <= 0) return;
      el.style.height = `${room}px`;
      // whatever the page adds below the panes (its own bottom padding) would still make the region scroll: take it off
      const over = main ? main.scrollHeight - main.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
      if (over > 0 && room - over > 200) el.style.height = `${room - over}px`;
    };
    fit();
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(fit) : 0;
    window.addEventListener("resize", fit);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    ro?.observe(document.body);
    return () => {
      window.removeEventListener("resize", fit);
      ro?.disconnect();
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    };
  }, [el]);
  return ref;
}
