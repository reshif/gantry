/** Versions tab in the Blueprint layout: one "Version history" panel; a retired version has Roll back, a candidate (when one exists) has Promote. */
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
  const out = useOutcome();
  const rows = a.versions.slice().reverse();
  const cols: SortCol<AgentVersionRow>[] = [
    { key: "v", label: "Version", render: (v) => <span className="mono">v{v.v}</span> },
    { key: "at", label: "Date", render: (v) => new Date(v.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) },
    { key: "n", label: "Change", render: (v) => <div>{v.note}<span className="sub mono">{v.diff}</span></div> },
    { key: "s", label: "Suite", align: "end", render: (v) => (v.suiteScore == null ? "—" : fmt.pct(v.suiteScore)) },
    { key: "l", label: "State", render: (v) => (v.live ? <Chip text="live" cls="ok" /> : v.rc ? <Chip text="candidate" cls="warn" /> : <Chip text="retired" cls="plain" />) },
    { key: "a", label: "", align: "end", render: (v) => {
      if (v.live) return null;
      const vid = v.v.replace(/\W/g, "");
      if (v.rc) {
        const g: Decision | null = !perm.allowed ? perm : !v.eligibility.ok ? { allowed: false, needs: "A passing run of its suite", reason: `${v.eligibility.text}.` } : null;
        return <Btn label="Promote" small kind="primary" id={`ag-promote-${vid}`} aria={`Promote ${v.v}`} guard={g} onClick={() => { void ops.promoteAgent(a.id, v.v, { ifMatch: a.rev }).then((r) => out(r)); }} />;
      }
      return <Btn label="Roll back" small id={`ag-rollback-${vid}`} aria={`Roll back to ${v.v}`} guard={perm} onClick={() => ui_.open((close) => <RollbackDialog a={a} ver={v} perm={perm} close={close} />)} />;
    } },
  ];
  return (
    <Panel title="Version history" flush>
      <DataTable id="ag-vers" caption="Version history" columns={cols} rows={rows} rowKey={(v) => v.v} pageSize={12} pager sortSelect={false} />
    </Panel>
  );
}
