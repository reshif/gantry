/**
 * THE write path. Every state-changing call from a view goes through `useCommand`, which wraps one
 * command (an `ops.*` function or anything returning `{ ok, msg, status }`) in TanStack `useMutation`:
 *
 *  - a ref guard refuses a second run while one is in flight (a double click cannot send twice);
 *  - it is pessimistic: nothing is shown as done until the server said so (no optimistic writes here);
 *  - it is unmount-safe: the state lives in the mutation, and the toast goes to the app-level UI;
 *  - a refusal is a value with a `kind` (401/403/404/409/412/422/429/0/5xx) and a plain-words message.
 *    `refusal` stays set until the next run or `reset()`, so a view can show it as a sticky `role=alert`
 *    (see ui/CommandError.tsx) instead of relying on a toast that disappears.
 */
import { useCallback, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { refusalKindOf, type CommandRefusal, type RefusalKind } from "../api/client";
import { useUI } from "../ui/overlay-context";

type Result = { ok: boolean; msg: string; status?: number; kind?: RefusalKind; retryAfter?: number };

/** The sentence a person reads for a refusal. Server messages win; the mapping fills the gaps and adds the next step. */
export function describeRefusal(r: { msg: string; status?: number; retryAfter?: number }): string {
  const kind = refusalKindOf(r.status ?? 0);
  const msg = r.msg.trim();
  switch (kind) {
    case "unauthenticated":
      return "Your session has ended. Sign in again; your draft is kept.";
    case "rate_limited":
      return r.retryAfter ? `Too many requests. Try again in ${r.retryAfter} second${r.retryAfter === 1 ? "" : "s"}.` : msg || "Too many requests. Wait a moment and try again.";
    case "conflict":
      return msg || "This changed since you loaded it. Reload and try again.";
    case "unreachable":
      return msg || "Could not reach Gantry, so it may not have gone through. Check before you try again.";
    default:
      return msg || "That did not work. Try again.";
  }
}

interface CommandOptions<R extends Result> {
  /** Toast shown when it worked. Defaults to the server's message; `false` shows nothing. */
  ok?: string | false | ((r: R) => string | false);
  /** Toast the refusal (default). Turn off when the screen shows `refusal` inline. */
  toastFail?: boolean;
}

export function useCommand<A extends unknown[], R extends Result>(fn: (...args: A) => Promise<R>, o: CommandOptions<R> = {}) {
  const ui = useUI();
  const inFlight = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(o);
  optsRef.current = o;
  const m = useMutation<R, Error, A>({ mutationFn: (args) => fnRef.current(...args) });
  const { mutateAsync, reset: resetMutation } = m;

  const run = useCallback(
    async (...args: A): Promise<R | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      try {
        const r = await mutateAsync(args);
        const opts = optsRef.current;
        if (r.ok) {
          const msg = typeof opts.ok === "function" ? opts.ok(r) : opts.ok === undefined ? r.msg : opts.ok;
          if (msg) ui.toast(msg, "ok");
        } else if (opts.toastFail !== false) ui.toast(describeRefusal(r), "error");
        return r;
      } catch (e) {
        // A command resolves to a refusal value; reaching here is a programmer error. Surface it as a refusal, not an unhandled rejection.
        const r = { ok: false, msg: e instanceof Error ? e.message : "That did not work.", status: 0 } as R;
        if (optsRef.current.toastFail !== false) ui.toast(describeRefusal(r), "error");
        return r;
      } finally {
        inFlight.current = false;
      }
    },
    [mutateAsync, ui],
  );

  const last: R | null = m.data ?? null;
  const refusal: R | null = last && !last.ok ? last : null;
  /** A refusal reason for a button while this command runs: `<Btn disabledReason={save.wait("Saving…")}>`. */
  const wait = (why = "Wait for the last change to finish."): string | null => (m.isPending ? why : null);
  const reset = useCallback(() => resetMutation(), [resetMutation]);
  return { run, busy: m.isPending, last, refusal, /** Sticky, plain-words text of the last refusal. */ error: refusal ? describeRefusal(refusal) : null, wait, reset };
}

export type { CommandRefusal };
