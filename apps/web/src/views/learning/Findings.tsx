/** Findings tab: repeated signals grouped by kind, agent and project, each with its evidence and the proposals drafted from it. */
import { fmt, type LearningFinding, type LearningProposal } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
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
  const perm = dec(useCan("learning.apply"));
  const list = findings.slice().sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.lastAt - a.lastAt);
  const refresh = async () => { const r = await ops.refreshFindings(); ui.toast(r.msg, r.ok ? "ok" : "error"); };
  return (
    <div className="ln-findings">
      <div className="toolbar">
        <span className="small muted">Findings group repeated signals by agent and project. Refreshing recounts evidence from live work orders.</span>
        <Btn label="Refresh findings" small icon="refresh" id="ln-refresh" guard={perm} onClick={() => void refresh()} />
      </div>
      {list.length ? (
        <ul className="ln-list">{list.map((f) => <FindingCard key={f.id} f={f} props={proposals.filter((lp) => lp.finding === f.id)} hi={hi === f.id} onFocusProposal={onFocusProposal} onDrafted={onDrafted} proposalsOn={proposalsOn} />)}</ul>
      ) : (
        <div className="empty empty-state" id="ln-f-empty">
          <div className="empty-icon" aria-hidden="true"><Icon name="learn" /></div>
          <div className="empty-title">No findings</div>
          <p>Findings appear when the same kind of signal repeats.</p>
        </div>
      )}
    </div>
  );
}

function FindingCard({ f, props, hi, onFocusProposal, onDrafted, proposalsOn }: { f: LearningFinding; props: LearningProposal[]; hi: boolean; onFocusProposal: (id: string) => void; onDrafted: (id: string) => void; proposalsOn: boolean }) {
  const ui = useUI();
  const { projName, agName } = useLn();
  const perm = dec(useCan("learning.apply", f.project ? { project: f.project } : {}));
  const sg = SIGNALS[f.signal] ?? [f.signal, "alert"];
  const thin = f.count < 3;
  return (
    <li className={`panel ln-card ln-finding is-${f.status}${hi ? " is-hi" : ""}`} id={`ln-f-${f.id}`}>
      <div className="ln-card-top">
        <span className="mono strong">{f.id}</span>
        <span className={`chip ln-sig ln-sig-${f.signal}`}><Icon name={sg[1]} />{sg[0]}</span>
        <h3 className="ln-title">{f.title}</h3>
        <span className={`chip${f.status === "open" ? " chip-warn" : ""}`}>{f.status === "open" ? "Open" : "Addressed"}</span>
      </div>
      <dl className="ln-kv ln-kv-row">
        <div><dt>Agent</dt><dd>{f.agent ? agName(f.agent) : "–"}</dd></div>
        <div><dt>Project</dt><dd>{projName(f.project)}</dd></div>
        <div><dt>Signals</dt><dd className="mono">{String(f.count)}{thin ? <span className="small muted"> · small sample</span> : null}</dd></div>
        <div><dt>Seen</dt><dd className="small">{fmt.istDate(f.firstAt) + (f.lastAt !== f.firstAt ? ` to ${fmt.istDate(f.lastAt)}` : "")}</dd></div>
      </dl>
      <div><div className="kicker">Evidence: work order records</div><ChipList ids={f.evidence} max={10} project={f.project} /></div>
      <div className="ln-card-foot">
        <span className="small">
          {props.length ? <span>Proposals: {props.map((lp) => <button key={lp.id} type="button" className="linkish ln-plink" id={`ln-f-p-${lp.id}`} onClick={() => onFocusProposal(lp.id)}>{`${lp.id} (${(STATUS[lp.status] ?? lp.status).toLowerCase()})`}</button>)}</span> : <span className="muted">No proposal yet.</span>}
        </span>
        <span className="ln-acts">
          <Btn label="Draft proposal" small icon="plus" id={`ln-draft-${f.id}`} guard={perm} disabledReason={proposalsOn ? null : "Learning proposals are switched off. Turn them on first."} onClick={() => ui.open((close) => <DraftDialog f={f} close={close} onDrafted={onDrafted} />)} />
        </span>
      </div>
    </li>
  );
}
