/**
 * Step-up sign-in (spec 14.1), one mechanism for every screen.
 *
 * The API client (api/client.ts `command`) hands every `needs: "step_up"` refusal to `useInstallStepUp`'s handler, which shows one prompt
 * over whatever dialog is open. "Sign in again" opens the identity provider in a small popup; when it finishes, the popup page tells this
 * window (postMessage to the app origin, BroadcastChannel as a backstop) and the client repeats the original request once, so the dialog
 * just completes. If the browser blocks the popup, the whole page goes to the sign-in instead and a registered draft (kill/restore
 * dialogs) is restored on return. Callers need no step-up code; if the person cancels they receive the refusal.
 */
import { useEffect, useRef, useState } from "react";
import { stepUpUrl } from "../api/ops";
import { setStepUpHandler, type CommandRefusal, type StepUpOutcome } from "../api/client";
import { Dialog } from "./Overlay";
import { useUI } from "./overlay-context";

const KEY = "gantry.stepup.draft";
const MAX_AGE_MS = 15 * 60_000;

export interface StepUpDraft {
  /** The dialog to reopen: "kill" or "restore". */
  kind: "kill" | "restore";
  scope: string;
  id: string | null;
  values: Record<string, unknown>;
  at: number;
}

const store = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

export function saveStepUpDraft(d: Omit<StepUpDraft, "at">): void {
  try {
    store()?.setItem(KEY, JSON.stringify({ ...d, at: Date.now() }));
  } catch {
    /* storage unavailable: the person retypes */
  }
}
export function peekStepUpDraft(): StepUpDraft | null {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as StepUpDraft;
    return d && typeof d.at === "number" && Date.now() - d.at <= MAX_AGE_MS ? d : null;
  } catch {
    return null;
  }
}
export function clearStepUpDraft(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
/** The saved values for this dialog, if a step-up round trip left some. */
export function draftFor(kind: StepUpDraft["kind"], scope: string, id: string | null): Record<string, unknown> | null {
  const d = peekStepUpDraft();
  return d && d.kind === kind && d.scope === scope && (d.id ?? null) === (id ?? null) ? d.values : null;
}

export const isStepUp = (r: { ok: boolean; needs?: string | undefined } | null | undefined): boolean => !!r && !r.ok && r.needs === "step_up";

const span = (sec: number): string => {
  if (sec < 60) return "less than a minute";
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} days`;
};

/** "For safety, kill needs a sign-in within the last 5 minutes. You signed in 42 min ago." */
export function stepUpText(r: { rule?: CommandRefusal["rule"] }, what: string): string {
  const win = r.rule?.windowSec ?? 300;
  const ago = r.rule?.signedInSecAgo;
  return `For safety, ${what} needs a sign-in within the last ${span(win)}.${typeof ago === "number" ? ` You signed in ${span(ago)} ago.` : ""}`;
}

/** Inline prompt for a dialog: why, and a button that signs in again and returns to this same dialog. */
export function StepUpNotice({ result, what, draft }: { result: CommandRefusal; what: string; draft?: Omit<StepUpDraft, "at"> }) {
  return (
    <div className="stepup-note" role="alert" id="stepup-note">
      <p className="strong">{stepUpText(result, what)}</p>
      <p className="muted small">This protects against a stolen or left-open session. You will come back to this dialog with what you typed kept, then confirm.</p>
      <button
        type="button"
        className="btn btn-primary"
        id="stepup-go"
        onClick={() => {
          if (draft) saveStepUpDraft(draft);
          window.location.assign(stepUpUrl());
        }}
      >
        Sign in again
      </button>
    </div>
  );
}

/** Mounted once in the app shell: after a step-up sign-in, reopens the dialog the person left. */
export function useResumeStepUp(open: (d: StepUpDraft) => void, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const d = peekStepUpDraft();
    if (d) open(d);
    // opened once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}

/* ---------- the central prompt ---------- */

export const STEP_UP_MESSAGE = "gantry-step-up";
const CHANNEL = "gantry-step-up";
const POPUP_URL = "/auth/login?step_up=1&popup=1";

type Draft = Omit<StepUpDraft, "at">;
let draftProvider: (() => Draft | null) | null = null;
/** A dialog with typed-in state registers what to keep when the popup is blocked and the page has to leave. Returns the unregister. */
export function registerStepUpDraft(fn: () => Draft | null): () => void {
  draftProvider = fn;
  return () => {
    if (draftProvider === fn) draftProvider = null;
  };
}

/** Opens the sign-in popup. Resolves when the popup reports (message from this origin only), or null when the popup was blocked. */
export function openStepUpPopup(): { result: Promise<StepUpOutcome>; cancel: () => void } | null {
  const win = window.open(POPUP_URL, "gantry-step-up", "popup,width=520,height=720");
  if (!win) return null;
  let finish: (o: StepUpOutcome) => void = () => undefined;
  const result = new Promise<StepUpOutcome>((res) => (finish = res));
  let bc: BroadcastChannel | null = null;
  const handle = (d: unknown): void => {
    const m = d as { type?: unknown; ok?: unknown; msg?: unknown } | null;
    if (!m || m.type !== STEP_UP_MESSAGE) return;
    stop();
    finish(m.ok === true ? { ok: true } : { ok: false, ...(typeof m.msg === "string" && m.msg ? { error: m.msg } : {}) });
  };
  const onMessage = (e: MessageEvent): void => {
    // only the app's own origin may say the sign-in worked
    if (e.origin !== window.location.origin) return;
    handle(e.data);
  };
  const stop = (): void => {
    window.removeEventListener("message", onMessage);
    bc?.close();
  };
  window.addEventListener("message", onMessage);
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => handle(e.data);
  } catch {
    bc = null;
  }
  return {
    result,
    cancel: () => {
      stop();
      try {
        win.close();
      } catch {
        /* cross-origin window: ignore */
      }
    },
  };
}

/** Falls back to a full-page sign-in, keeping a registered dialog draft for the return. */
function redirectToSignIn(): void {
  const d = draftProvider?.();
  if (d) saveStepUpDraft(d);
  window.location.assign(stepUpUrl());
}

function StepUpPrompt({ refusal, done }: { refusal: CommandRefusal; done: (o: StepUpOutcome) => void }) {
  const [phase, setPhase] = useState<"ask" | "wait" | "error">("ask");
  const [error, setError] = useState("");
  const popup = useRef<ReturnType<typeof openStepUpPopup>>(null);
  const win = refusal.rule?.windowSec ?? 900;
  const ago = refusal.rule?.signedInSecAgo;
  const cancel = (): void => {
    popup.current?.cancel();
    done({ ok: false });
  };
  const go = (): void => {
    const p = openStepUpPopup();
    if (!p) {
      redirectToSignIn();
      return;
    }
    popup.current = p;
    setPhase("wait");
    void p.result.then((o) => {
      if (o.ok) done(o);
      else {
        setError(o.error ?? "The sign-in did not complete.");
        setPhase("error");
      }
    });
  };
  return (
    <Dialog
      title="Sign in again to confirm"
      kicker="Fresh sign-in needed"
      onClose={cancel}
      body={
        <div id="stepup-prompt" role="alert">
          <p className="strong">{`This change needs a recent sign-in (within ${span(win)}).${typeof ago === "number" ? ` You signed in ${span(ago)} ago.` : ""}`}</p>
          {phase === "wait" ? (
            <p className="muted small">Sign in in the window that opened. This page stays as it is and the change completes when you are done.</p>
          ) : (
            <p className="muted small">This protects against a stolen or left-open session. A small window opens for you to sign in; your work here is kept.</p>
          )}
          {phase === "error" ? <p className="field-err" id="stepup-error">{error}</p> : null}
        </div>
      }
      actions={[
        { label: "Cancel", kind: "ghost", id: "stepup-cancel", onClick: cancel },
        { label: phase === "wait" ? "Reopen sign-in window" : phase === "error" ? "Try again" : "Sign in again", kind: "primary", id: "stepup-go-popup", onClick: go },
      ]}
    />
  );
}

/** Mounted once in the app shell: installs the handler the API client calls for every step-up refusal. Simultaneous refusals share one prompt. */
export function useInstallStepUp(): void {
  const ui = useUI();
  const uiRef = useRef(ui);
  uiRef.current = ui;
  useEffect(() => {
    let pending: Promise<StepUpOutcome> | null = null;
    setStepUpHandler((refusal) => {
      if (pending) return pending;
      pending = new Promise<StepUpOutcome>((resolve) => {
        let handle: { close: () => void } | null = null;
        const done = (o: StepUpOutcome): void => {
          handle?.close();
          pending = null;
          resolve(o);
        };
        handle = uiRef.current.open(() => <StepUpPrompt refusal={refusal} done={done} />);
      });
      return pending;
    });
    return () => setStepUpHandler(null);
  }, []);
}

/** The page the sign-in popup lands on (`/?step_up_popup=ok|error`): tells the opener, then closes. */
export function StepUpPopupDone({ ok, msg }: { ok: boolean; msg: string }) {
  useEffect(() => {
    const m = { type: STEP_UP_MESSAGE, ok, ...(msg ? { msg } : {}) };
    try {
      window.opener?.postMessage(m, window.location.origin);
    } catch {
      /* opener gone */
    }
    try {
      const bc = new BroadcastChannel(CHANNEL);
      bc.postMessage(m);
      bc.close();
    } catch {
      /* no BroadcastChannel */
    }
    const t = setTimeout(() => window.close(), 150);
    return () => clearTimeout(t);
  }, [ok, msg]);
  return <div className="boot">{ok ? "Signed in. You can close this window." : msg || "The sign-in did not complete. You can close this window."}</div>;
}
