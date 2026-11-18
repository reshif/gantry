/**
 * The conversation scrolls inside its own box: it lands on the newest message when it opens and follows new messages, unless the person scrolled up
 * to read; then `unseen` says there is something new below and `jump` takes them there.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const NEAR = 80;

export function useStickyEnd<T extends HTMLElement>(...deps: unknown[]) {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  const first = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const toEnd = useCallback(() => {
    const t = ref.current;
    if (!t) return;
    t.scrollTop = t.scrollHeight;
    stuck.current = true;
    setUnseen(false);
  }, []);
  const onScroll = useCallback(() => {
    const t = ref.current;
    if (!t) return;
    stuck.current = t.scrollHeight - t.scrollTop - t.clientHeight < NEAR;
    if (stuck.current) setUnseen(false);
  }, []);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    if (first.current || stuck.current) {
      toEnd();
      // late layout (markdown, fonts) can grow the thread after this frame: stay at the end while the person has not scrolled
      if (first.current && typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (stuck.current) toEnd(); });
      first.current = false;
    } else setUnseen(true);
    // the caller's values are the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ref, onScroll, unseen, jump: toEnd };
}
