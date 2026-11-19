/** Versions tab in the Blueprint layout: one "Version history" panel; every non-live version has Roll back. */
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Btn, Chip, Panel, type Decision } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { Dialog } from "../../ui/Overlay";
import { useOutcome } from "../govern/data";
import { useUI } from "../../ui/overlay-context";
import { rerender, type AgentRow, type AgentVersionRow } from "./kit";

export function RollbackDialog({ a, ver, perm, close }: { a: AgentRow; ver: AgentVersionRow; perm: Decision; close: () => void }) {
  const out = useOutcome();
  const ui_ = useUI();
  return (
    <Dialog title={`Roll back to v${ver.v}?`} onClose={close}
      body={<p>The previous version stops serving new runs.</p>}
      actions={[
        { label: "Cancel" },
        { label: "Confirm", kind: "primary", icon: "undo", id: "ag-rollback-ok", guard: perm,
          onClick: (done) => { void ops.rollbackAgent(a.id, ver.v, { ifMatch: a.rev }).then((r) => { if (r.ok) { rerender(); ui_.toast(`Rolled back to v${ver.v}`, "ok"); done(); } else out(r); }); } },
      ]}
    />
  );
}

export function VersionsTab({ a, perm }: { a: AgentRow; perm: Decision }) {
  const ui_ = useUI();
  const rows = a.versions.slice().reverse();
  const cols: SortCol<AgentVersionRow>[] = [
    { key: "v", label: "Version", render: (v) => <span className="mono">v{v.v}</span> },
    { key: "at", label: "Date", render: (v) => new Date(v.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) },
    { key: "n", label: "Change", render: (v) => <div>{v.note}<span className="sub mono">{v.diff}</span></div> },
    { key: "s", label: "Suite", align: "end", render: (v) => (v.suiteScore == null ? "—" : fmt.pct(v.suiteScore)) },
    { key: "l", label: "State", render: (v) => (v.live ? <Chip text="live" cls="ok" /> : <Chip text="retired" cls="plain" />) },
    { key: "a", label: "", align: "end", render: (v) => {
      if (v.live) return <span className="muted">—</span>;
      const vid = v.v.replace(/\W/g, "");
      return <Btn label="Roll back" small id={`ag-rollback-${vid}`} aria={`Roll back to ${v.v}`} guard={perm} onClick={() => ui_.open((close) => <RollbackDialog a={a} ver={v} perm={perm} close={close} />)} />;
    } },
  ];
  return (
    <Panel title="Version history" flush>
      <DataTable id="ag-vers" caption="Version history" columns={cols} rows={rows} rowKey={(v) => v.v} pageSize={12} pager sortSelect={false} />
    </Panel>
  );
}
