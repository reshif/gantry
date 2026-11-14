/**
 * Factory Admin break-glass (user decision 2026-11-14): when an approval would not pass a gate under its rule (author under separation of
 * duties, N of M, requester alone), the server refuses with `needs: "override_reason"`. This prompt asks for the reason once and the API
 * client re-sends the same request with it; the gate then passes and the override is audited.
 */
import { useEffect, useRef, useState } from "react";
import { setReasonHandler, type CommandRefusal } from "../api/client";
import { Dialog } from "./Overlay";
import { Field } from "./primitives";
import { useUI } from "./overlay-context";

function OverridePrompt({ refusal, done }: { refusal: CommandRefusal; done: (reason: string | null) => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const submit = (): void => {
    const v = text.trim();
    if (v.length < 5) return setErr("Give a reason of at least 5 characters.");
    done(v);
  };
  return (
    <Dialog
      title="Override as Factory Admin"
      kicker="Break-glass"
      sub={refusal.msg}
      onClose={() => done(null)}
      body={
        <div className="form-grid">
          <Field label="Reason (recorded in the audit and on the work order)" htmlFor="ovr-reason">
            <textarea id="ovr-reason" className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
      actions={[{ label: "Cancel", onClick: () => done(null) }, { label: "Override and pass the gate", kind: "danger", submit: true, id: "ovr-ok", onClick: submit }]}
    />
  );
}

/** Mounted once in the app shell, next to the step-up handler. */
export function useInstallOverrideReason(): void {
  const ui = useUI();
  const uiRef = useRef(ui);
  uiRef.current = ui;
  useEffect(() => {
    setReasonHandler((refusal) =>
      new Promise<string | null>((resolve) => {
        let handle: { close: () => void } | null = null;
        let settled = false;
        const done = (r: string | null): void => {
          if (settled) return;
          settled = true;
          handle?.close();
          resolve(r);
        };
        handle = uiRef.current.open(() => <OverridePrompt refusal={refusal} done={done} />);
      }),
    );
    return () => setReasonHandler(null);
  }, []);
}
