/** Findings tab (prototype): search, a Signal select, and a flat table. The proposals drafted from a finding are reached from the Proposals tab and the row action. */
import { type LearningFinding } from "@gantry/domain";
import { useCan } from "../../api/can";
import { Avatar, Btn, Chip, FilterBar, SearchBox, Select } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
import { DraftDialog } from "./Draft";
import { ChipList, SIGNALS, useLn } from "./kit";

export interface LnUrl { tab: string; q: string; sig: string; sort: string; dir: string; st: string }

export function FindingsTab({ findings, hi, onDrafted, proposalsOn, url, setUrl }: {
  findings: LearningFinding[];
  hi: string | null;
  onFocusProposal?: (id: string) => void;
  onDrafted: (id: string) => void;
  proposalsOn: boolean;
  url: LnUrl;
  setUrl: (p: Partial<LnUrl>) => void;
}) {
  const ui = useUI();
  const { agName } = useLn();
  const perm = dec(useCan("learning.apply"));
  const term = url.q.trim().toLowerCase();
  const list = findings.filter((f) => (!url.sig || url.sig === "all" || f.signal === url.sig) && (!term || `${f.title} ${f.id} ${f.agent ? agName(f.agent) : ""}`.toLowerCase().includes(term)));
  const clear = (): void => setUrl({ q: "", sig: "" });
  const cols: SortCol<LearningFinding>[] = [
    { key: "id", label: "ID", sort: (f) => f.id, render: (f) => <span className="mono nowrap" id={hi === f.id ? `ln-f-hi-${f.id}` : undefined}>{f.id}</span> },
    { key: "title", label: "Finding", sort: (f) => f.title.toLowerCase(), render: (f) => <a href="#learning" className="ell" id={`ln-open-${f.id}`} style={{ maxWidth: 340, color: "inherit" }} title={`${f.title}. Draft a proposal from this finding.`} aria-label={`Draft a proposal from ${f.id}: ${f.title}`}
      onClick={(e) => { e.preventDefault(); if (!proposalsOn) { ui.toast("Learning proposals are switched off. Turn them on first.", "warn"); return; } if (!perm.allowed) { ui.toast(perm.reason || "You may not apply learning proposals.", "warn"); return; } ui.open((close) => <DraftDialog f={f} close={close} onDrafted={onDrafted} />); }}>{f.title}</a> },
    { key: "signal", label: "Signal", sort: (f) => f.signal, render: (f) => <Chip text={f.signal} cls="agent plain" /> },
    { key: "agent", label: "Agent", sort: (f) => f.agent ?? "", render: (f) => f.agent ? <span className="who"><Avatar id={f.agent} size="sm" /><span>{agName(f.agent)}</span></span> : <span className="dim">{"\u2013"}</span> },
    { key: "ev", label: "Evidence", render: (f) => <ChipList ids={f.evidence} max={3} project={f.project} /> },
    { key: "st", label: "Status", sort: (f) => f.status, render: (f) => <Chip text={f.status === "open" ? "Open" : "Triaged"} cls={f.status === "open" ? "warn" : "ok"} /> },
  ];
  const sort = { key: url.sort || "id", dir: (url.dir === "desc" ? -1 : 1) as 1 | -1 };
  return (
    <div className="ln-findings">
      <FilterBar label="Filter findings" count={`${list.length} of ${findings.length}`} actions={url.q || url.sig ? <Btn label="Clear" small kind="ghost" id="ln-clear" onClick={clear} /> : undefined}>
        <SearchBox id="ln-search" value={url.q} onChange={(v) => setUrl({ q: v })} placeholder="Search findings" />
        <Select id="ln-sig" aria-label="Signal" value={url.sig} onChange={(v) => setUrl({ sig: v })} options={[{ value: "", label: "Signal: all" }, ...Object.keys(SIGNALS).map((k) => ({ value: k, label: `Signal: ${SIGNALS[k]![0]}` }))]} />
      </FilterBar>
      <DataTable id="ln-f-table" caption="Findings" columns={cols} rows={list} rowKey={(f) => f.id} rowId={(f) => `ln-f-${f.id}`} pageSize={10} pager sort={sort}
        onSort={(s) => setUrl({ sort: s.key, dir: s.dir === -1 ? "desc" : "asc" })}
        empty={{ title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="ln-clear-empty" onClick={clear} /> }} />
    </div>
  );
}
