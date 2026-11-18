/** The Guidelines tab as the Blueprint draws it: one switch per guideline (Required or Advisory), and what the agent may never do. The versioned editor stays behind "Edit". */
import { useGuidelines } from "../../api/queries";
import { commands } from "../../api/commands";
import { useCan } from "../../api/can";
import { useCommand } from "../../lib/useCommand";
import { Btn, Panel } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Async } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import type { Project } from "@gantry/domain";
import { ToggleRow } from "../projects/proto";
import { AgentTab } from "./Agent";

export function GuidelinesPanel({ project }: { project: Project }) {
  const ui = useUI();
  const q = useGuidelines();
  const dec = useCan("agent.edit");
  const save = useCommand(commands.saveGuidelines, { ok: false });
  return (
    <Async query={q} what="the onboarding guidelines" id="onb-guidelines">
      {(g) => (
        <Panel
          title="What a repository needs before agents may work on it"
          tools={<Btn small kind="ghost" icon="edit" id="onb-gl-edit" label="Edit" onClick={() => ui.open((close) => <Dialog title="Guidelines and agent" wide onClose={close} actions={[{ label: "Close" }]} body={<AgentTab project={project} />} />)} />}
        >
          <div>
            {g.items.map((it) => (
              <ToggleRow
                key={it.id} id={`onb-gl-sw-${it.id}`} label={it.text} hint={it.required ? "Required" : "Advisory"} checked={it.required} decision={dec}
                onChange={async (c) => {
                  const items = g.items.map((x) => ({ id: x.id, text: x.text, required: x.id === it.id ? c : x.required }));
                  const r = await save.run({ items }, c ? "Marked required" : "Marked advisory", null, { ifMatch: g.version });
                  if (r?.ok) ui.toast(c ? "Now required" : "Now advisory", "ok");
                }}
              />
            ))}
            <div className="callout" style={{ marginTop: 12 }}><b>The agent may never</b>{g.mayNot}</div>
          </div>
        </Panel>
      )}
    </Async>
  );
}
