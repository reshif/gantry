/** Findings tab: the prototype's "Patterns noticed" table (finding, signal, count, evidence, status) with search, Signal and Status filters; refresh and Draft proposal are the real commands on top. */
import type { LearningFinding, LearningProposal } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { Btn, Chip, Panel } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
import { DataView } from "../dataview";
import { DraftDialog } from "./Draft";
import { ChipList, SIGNALS, STATUS, useLn } from "./kit";

export function FindingsTab({ findings, proposals, hi, onFocusProposal, onDrafted, proposalsOn }: {
  findings: LearningFinding[];
  proposals: LearningProposal[];
  hi: string | null;
  onFocusProposal: (id: string) => void;
  onDrafted: (id: string) => void;
  proposalsOn: boolean;
}) {
  const ui = useUI();
  const { projName, agName } = useLn();
  const perm = dec(useCan("learning.apply"));
  const refresh = async () => { const r = await ops.refreshFindings(); ui.toast(r.msg, r.ok ? "ok" : "error"); };
  const signals = [...new Set(findings.map((f) => f.signal))];
  const statuses = [...new Set(findings.map((f) => f.status))];
  return (
    <Panel title="Patterns noticed" flush tools={<Btn label="Refresh findings" small kind="ghost" icon="refresh" id="ln-refresh" guard={perm} onClick={() => void refresh()} />}>
      <DataView id="ln-find" noun="finding" rows={findings} rowKey={(f) => f.id} rowId={(f) => `ln-f-${f.id}`} pageSize={12} text={(f) => `${f.title} ${f.signal} ${f.id}`}
        filters={[
          { k: "signal", label: "Signal", opts: signals.map((s) => [s, SIGNALS[s]?.[0] ?? s]), fn: (f, v) => f.signal === v },
          { k: "status", label: "Status", opts: statuses.map((s) => [s, s]), fn: (f, v) => f.status === v },
        ]}
        empty={{ title: "No findings", text: "Findings appear when the same kind of signal repeats." }}
        columns={[
          { key: "t", label: "Finding", sort: (f) => f.title.toLowerCase(), render: (f) => <div className={hi === f.id ? "is-hi" : undefined}><span>{f.title}</span><span className="sub">{`${f.agent ? agName(f.agent) : "–"}${f.project ? ` · ${projName(f.project)}` : ""}`}</span></div> },
          { key: "s", label: "Signal", sort: (f) => f.signal, render: (f) => <Chip text={SIGNALS[f.signal]?.[0] ?? f.signal} cls="plain" /> },
          { key: "c", label: "Count", align: "end", sort: (f) => f.count, render: (f) => <span className="num">{f.count}</span> },
          { key: "e", label: "Evidence", render: (f) => <ChipList ids={f.evidence} max={3} project={f.project} /> },
          { key: "st", label: "Status", sort: (f) => f.status, render: (f) => <Chip text={f.status} cls={f.status === "open" ? "warn" : "ok"} /> },
          { key: "act", label: "", align: "end", render: (f) => {
            const props = proposals.filter((lp) => lp.finding === f.id);
            return (
              <span className="row ln-acts">
                {props.map((lp) => <button key={lp.id} type="button" className="linkish small ln-plink" id={`ln-f-p-${lp.id}`} onClick={() => onFocusProposal(lp.id)}>{`${lp.id} (${(STATUS[lp.status] ?? lp.status).toLowerCase()})`}</button>)}
                <Btn label="Draft proposal" small kind="ghost" icon="plus" id={`ln-draft-${f.id}`} guard={perm} disabledReason={proposalsOn ? null : "Learning proposals are switched off. Turn them on first."} onClick={() => ui.open((close) => <DraftDialog f={f} close={close} onDrafted={onDrafted} />)} />
              </span>
            );
          } },
        ]} />
    </Panel>
  );
}
