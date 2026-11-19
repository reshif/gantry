/**
 * The conversation's own scroll area: it opens at the newest message and follows new ones, unless the person scrolled up to read; then `away` is set
 * (the page offers "New messages") and nothing moves under them. Only the area scrolls, never the page.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";

const NEAR = 80;

export function useStickyScroll(key: string, ...deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const toEnd = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setAway(false);
  }, []);
  // a different conversation opens at its end
  useLayoutEffect(() => { pinned.current = true; setAway(false); }, [key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (pinned.current) toEnd(); else setAway(true); }, [key, ...deps]);
  // late growth (a card that loads, an expanding block) keeps a pinned thread at its end
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  });
  const onScroll = (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    pinned.current = near;
    if (near) setAway(false);
  };
  return { ref, inner, onScroll, away, toEnd, stick: () => { pinned.current = true; } };
}
