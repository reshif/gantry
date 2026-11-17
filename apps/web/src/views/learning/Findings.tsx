/** Findings tab: repeated signals grouped by kind, agent and project, each with its evidence and the proposals drafted from it. */
import { type LearningFinding, type LearningProposal } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useState } from "react";
import { Avatar, Btn, Chip, FilterBar, SearchBox, Select, Status } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
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
  const { agName, projName } = useLn();
  const perm = dec(useCan("learning.apply"));
  const [q, setQ] = useState("");
  const [sig, setSig] = useState("");
  const term = q.trim().toLowerCase();
  const list = findings.slice().sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.lastAt - a.lastAt)
    .filter((f) => (!sig || f.signal === sig) && (!term || `${f.title} ${f.id} ${f.agent ? agName(f.agent) : ""}`.toLowerCase().includes(term)));
  const refresh = async () => { const r = await ops.refreshFindings(); ui.toast(r.msg, r.ok ? "ok" : "error"); };
  const cols: SortCol<LearningFinding>[] = [
    { key: "id", label: "ID", sort: (f) => f.id, render: (f) => <span className="mono nowrap" id={hi === f.id ? `ln-f-hi-${f.id}` : undefined}>{f.id}</span> },
    { key: "title", label: "Finding", sort: (f) => f.title.toLowerCase(), render: (f) => <span className="stack" style={{ gap: 0 }}><span className="ell" style={{ maxWidth: 340 }} title={f.title}>{f.title}</span><span className="dim ell" style={{ fontSize: 11 }}>{`${projName(f.project)} \u00b7 ${f.count} signals${f.count < 3 ? " \u00b7 small sample" : ""}`}</span>{proposals.some((lp) => lp.finding === f.id) ? <span className="row nowrap" style={{ fontSize: 11 }}>{proposals.filter((lp) => lp.finding === f.id).map((lp) => <button key={lp.id} type="button" className="linkish ln-plink" id={`ln-f-p-${lp.id}`} onClick={() => onFocusProposal(lp.id)}>{`${lp.id} (${(STATUS[lp.status] ?? lp.status).toLowerCase()})`}</button>)}</span> : null}</span> },
    { key: "signal", label: "Signal", sort: (f) => f.signal, render: (f) => <Chip text={(SIGNALS[f.signal] ?? [f.signal])[0]} cls="agent" /> },
    { key: "agent", label: "Agent", sort: (f) => f.agent ?? "", render: (f) => f.agent ? <span className="row nowrap"><Avatar id={f.agent} size="sm" />{agName(f.agent)}</span> : <span className="dim">{"\u2013"}</span> },
    { key: "ev", label: "Evidence", render: (f) => <ChipList ids={f.evidence} max={2} project={f.project} /> },
    { key: "st", label: "Status", sort: (f) => f.status, render: (f) => <Status tone={f.status === "open" ? "wait" : "done"}>{f.status === "open" ? "Open" : "Addressed"}</Status> },
    { key: "act", label: "", render: (f) => <Btn label="Draft proposal" small icon="plus" id={`ln-draft-${f.id}`} guard={dec(perm)} disabledReason={proposalsOn ? null : "Learning proposals are switched off. Turn them on first."} onClick={() => ui.open((close) => <DraftDialog f={f} close={close} onDrafted={onDrafted} />)} /> },
  ];
  return (
    <div className="ln-findings">
      <FilterBar label="Filter findings" count={`${list.length} of ${findings.length}`} actions={<Btn label="Refresh findings" small icon="refresh" id="ln-refresh" guard={perm} onClick={() => void refresh()} />}>
        <SearchBox id="ln-search" value={q} onChange={setQ} placeholder="Search findings" />
        <Select id="ln-sig" aria-label="Signal" value={sig} onChange={setSig} options={[{ value: "", label: "Signal: all" }, ...Object.keys(SIGNALS).map((k) => ({ value: k, label: `Signal: ${SIGNALS[k]![0]}` }))]} />
      </FilterBar>
      <DataTable id="ln-f-table" caption="Findings" columns={cols} rows={list} rowKey={(f) => f.id} rowId={(f) => `ln-f-${f.id}`} pageSize={10} pager empty={{ title: "No findings", text: "Findings appear when the same kind of signal repeats." }} />
    </div>
  );
}
