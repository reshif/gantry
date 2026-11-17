/**
 * Detects a closed step-up sign-in popup. A person who closes the window without finishing never produces a message, so the
 * dialog would wait forever. After the window reports `closed`, a short grace period lets a late success message (postMessage or
 * BroadcastChannel) win; only then `onClosed` fires. Returns the stop function.
 */
export interface PopupWatchOptions {
  pollMs?: number;
  graceMs?: number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (t: ReturnType<typeof setInterval>) => void;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (t: ReturnType<typeof setTimeout>) => void;
}

export function watchPopupClosed(win: Pick<Window, "closed">, onClosed: () => void, o: PopupWatchOptions = {}): () => void {
  const setI = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = o.clearInterval ?? ((t) => clearInterval(t));
  const setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimeout ?? ((t) => clearTimeout(t));
  let grace: ReturnType<typeof setTimeout> | null = null;
  const poll = setI(() => {
    let closed = false;
    try {
      closed = win.closed;
    } catch {
      closed = true;
    }
    if (!closed || grace) return;
    clearI(poll);
    grace = setT(onClosed, o.graceMs ?? 600);
  }, o.pollMs ?? 500);
  return () => {
    clearI(poll);
    if (grace) clearT(grace);
    grace = null;
  };
}
