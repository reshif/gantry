/**
 * Findings tab: the prototype's "Patterns noticed" table (finding, signal, count, evidence, status) with search, Signal and Status filters.
 * A finding's own page (every evidence record, the proposals drafted from it, Draft proposal and Refresh findings, the real commands) opens from its row.
 */
import type { LearningFinding, LearningProposal } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { Btn, Chip, Panel } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
import { DataView } from "../dataview";
import { DraftDialog } from "./Draft";
import { STATUS, WoLink, useLn } from "./kit";

function FindingPage({ f, proposals, proposalsOn, onFocusProposal, onDrafted, close }: { f: LearningFinding; proposals: LearningProposal[]; proposalsOn: boolean; onFocusProposal: (id: string) => void; onDrafted: (id: string) => void; close: () => void }) {
  const ui = useUI();
  const { projName, agName } = useLn();
  const perm = dec(useCan("learning.apply"));
  const props = proposals.filter((lp) => lp.finding === f.id);
  return (
    <div className="form-grid ln-finding-page">
      <p className="small muted">{`${f.agent ? agName(f.agent) : "–"}${f.project ? ` · ${projName(f.project)}` : ""} · ${f.signal} · ${f.count} signal${f.count === 1 ? "" : "s"} · ${f.status}`}</p>
      <div><h3 className="sub-h">Evidence</h3><div className="row">{f.evidence.map((id) => <WoLink key={id} id={id} project={f.project} />)}</div></div>
      <div>
        <h3 className="sub-h">Proposals from this finding</h3>
        {props.length ? <ul className="plain-list small">{props.map((lp) => <li key={lp.id}><button type="button" className="linkish" id={`ln-f-p-${lp.id}`} onClick={() => { close(); onFocusProposal(lp.id); }}>{`${lp.id} (${(STATUS[lp.status] ?? lp.status).toLowerCase()})`}</button>{` ${lp.title}`}</li>)}</ul> : <p className="small muted">None yet.</p>}
      </div>
      <div className="dlg-actions-inline">
        <Btn label="Refresh findings" kind="ghost" icon="refresh" id="ln-refresh" guard={perm} onClick={() => { void ops.refreshFindings().then((r) => ui.toast(r.msg, r.ok ? "ok" : "error")); }} />
        <Btn label="Draft proposal" kind="primary" icon="plus" id={`ln-draft-${f.id}`} guard={perm} disabledReason={proposalsOn ? null : "Learning proposals are switched off. Turn them on first."} onClick={() => { close(); ui.open((c2) => <DraftDialog f={f} close={c2} onDrafted={onDrafted} />); }} />
      </div>
    </div>
  );
}

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
  const signals = [...new Set(findings.map((f) => f.signal))];
  const statuses = [...new Set(findings.map((f) => f.status))];
  const open = (f: LearningFinding): void => { ui.dialog({ title: f.title, kicker: `Learning · ${f.id}`, wide: true, body: (close) => <FindingPage f={f} proposals={proposals} proposalsOn={proposalsOn} onFocusProposal={onFocusProposal} onDrafted={onDrafted} close={close} />, actions: [{ label: "Close" }] }); };
  return (
    <Panel title="Patterns noticed" flush>
      <DataView id="ln-find" noun="finding" rows={findings} rowKey={(f) => f.id} rowId={(f) => `ln-f-${f.id}`} pageSize={12} text={(f) => `${f.title} ${f.signal} ${f.id}`} onRow={open}
        filters={[
          { k: "signal", label: "Signal", opts: signals.map((s) => [s, s]), fn: (f, v) => f.signal === v },
          { k: "status", label: "Status", opts: statuses.map((s) => [s, s]), fn: (f, v) => f.status === v },
        ]}
        empty={{ title: "No findings", text: "Findings appear when the same kind of signal repeats." }}
        columns={[
          { key: "t", label: "Finding", sort: (f) => f.title.toLowerCase(), render: (f) => <div className={hi === f.id ? "is-hi" : undefined}><span>{f.title}</span><span className="sub">{`${f.agent ? agName(f.agent) : "–"}${f.project ? ` · ${projName(f.project)}` : ""}`}</span></div> },
          { key: "s", label: "Signal", render: (f) => <Chip text={f.signal} cls="plain" /> },
          { key: "c", label: "Count", align: "end", sort: (f) => f.count, render: (f) => <span className="num">{f.count}</span> },
          { key: "e", label: "Evidence", render: (f) => <div className="row">{f.evidence.slice(0, 3).map((id) => <WoLink key={id} id={id} project={f.project} />)}</div> },
          { key: "st", label: "Status", render: (f) => <Chip text={f.status} cls={f.status === "open" ? "warn" : "ok"} /> },
        ]} />
    </Panel>
  );
}
