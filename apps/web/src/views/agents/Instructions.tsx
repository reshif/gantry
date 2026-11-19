/** Instructions tab in the Blueprint layout: one panel with the text, Save as new version and Revert. Saving writes the text, then cuts a version from it. */
import { useMemo, useState } from "react";
import { diffStats, lineDiff } from "../../ui/linediff";
import { Btn, Panel } from "../../ui/primitives";
import type { TabProps } from "./Config";
import { liveVersion } from "./kit";

/** The text the live version carries: its snapshot is the saved configuration at the time, as JSON. */
function liveInstructions(a: TabProps["a"]): string | null {
  const snap = liveVersion(a)?.snapshot;
  if (snap == null) return null;
  try {
    const o = (typeof snap === "string" ? JSON.parse(snap) : snap) as { instructions?: unknown };
    return typeof o.instructions === "string" ? o.instructions : null;
  } catch { return null; }
}

export function InstructionsTab({ a, ro, perm, saveAsVersion }: TabProps) {
  const [text, setText] = useState(a.instructions ?? "");
  const live = liveInstructions(a);
  const diff = useMemo(() => (live === null ? null : lineDiff(live, text)), [live, text]);
  const st = diff ? diffStats(diff) : null;
  return (
    <>
    <Panel title="Instructions">
      <div>
        <textarea id="ag-instr" className="input" rows={8} style={{ lineHeight: 1.6, padding: "8px 10px" }} aria-label="Instructions" disabled={ro} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <Btn label="Save as new version" kind="primary" id="ag-instr-save" guard={ro ? perm : null} onClick={() => saveAsVersion(text)} />
          <Btn label="Revert" id="ag-instr-revert" onClick={() => setText(a.instructions ?? "")} />
          <span className="small muted">Changes ship as a new version and run the eval suite before going live.</span>
        </div>
      </div>
    </Panel>
    <Panel title="Draft against live">
      {diff && st ? (
        <div id="ag-instr-diff">
          <p className="small muted">{st.add || st.del ? `Your draft against the live version v${liveVersion(a)?.v}: ${st.add} line${st.add === 1 ? "" : "s"} added, ${st.del} removed.` : `Your draft is the same as the live version v${liveVersion(a)?.v}.`}</p>
          <pre className="doc-diff-body" aria-label="Draft against live instructions">
            {diff.map((l, i) => <div key={i} className={`doc-dl is-${l.op}`}><span className="doc-dl-op" aria-hidden="true">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>{l.text || " "}</div>)}
          </pre>
        </div>
      ) : <p className="small muted" id="ag-instr-diff">The live version carries no saved text to compare against.</p>}
    </Panel>
    </>
  );
}
