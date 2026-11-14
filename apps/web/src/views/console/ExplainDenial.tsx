/**
 * "Explain" a policy decision in plain language (legacy G.explainDenial). Asks the console's explain endpoint, which returns the policy engine's own trace
 * and, only when a model is configured, a model's explanation of it. Without a model it says so and shows the trace: nothing is made up.
 */
import { useRef, useState } from "react";
import { Btn } from "../../ui/primitives";
import { explain } from "./api";
import type { ExplainResult } from "./types";

export function ExplainDenial({ id, action, project, repo, person, time }: { id: string; action: string; project?: string | null; repo?: string | null; person?: string; time?: number }) {
  const [state, setState] = useState<{ pending: boolean; res: ExplainResult | null; error: string }>({ pending: false, res: null, error: "" });
  const run = useRef(0);
  const go = async (): Promise<void> => {
    if (state.pending) return;
    const mine = ++run.current;
    setState({ pending: true, res: null, error: "" });
    const r = await explain({ action, ...(person ? { person } : {}), ...(project ? { project } : {}), ...(repo ? { repo } : {}), ...(time ? { time } : {}) });
    if (mine !== run.current) return;
    setState(r.ok ? { pending: false, res: r as unknown as ExplainResult, error: "" } : { pending: false, res: null, error: r.msg });
  };
  const stop = (): void => {
    run.current++;
    setState({ pending: false, res: null, error: "" });
  };
  const res = state.res;
  return (
    <div className="explain">
      <div className="row gap-sm">
        <Btn label="Explain" small kind="ghost" icon="chat" id={id} title="Explain this decision in plain language" onClick={() => void go()} />
        {state.pending ? <Btn label="Stop" small kind="ghost" id={`${id}-stop`} onClick={stop} /> : null}
      </div>
      <div className="explain-out" id={`${id}-out`} aria-live="polite">
        {state.pending ? <p className="explain-text is-thinking">Working it out…</p> : null}
        {state.error ? <p className="explain-text">{state.error}</p> : null}
        {res ? <p className="explain-text">{res.explanation ?? res.trace.join(" ")}</p> : null}
        {res ? <div className="explain-mode small muted">{res.note}</div> : null}
      </div>
    </div>
  );
}
