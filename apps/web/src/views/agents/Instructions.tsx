/** Instructions tab in the Blueprint layout: one panel with the text, Save as new version and Revert. Saving writes the text, then cuts a version from it. */
import { useState } from "react";
import { Btn, Panel } from "../../ui/primitives";
import type { TabProps } from "./Config";

export function InstructionsTab({ a, ro, perm, saveAsVersion }: TabProps) {
  const [text, setText] = useState(a.instructions ?? "");
  return (
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
  );
}
