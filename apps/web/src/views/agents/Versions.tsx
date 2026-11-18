/** Versions tab and the rollback dialog (legacy versionsTab and rollbackDialog): candidate creation from the saved configuration, eval-gated promotion, rollback, and a link to run the suite. */
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useAgentSuites } from "../../api/queries";
import { Btn, Chip, Field, Panel, type Decision } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { useOutcome } from "../govern/data";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { dropDraft } from "../../lib/useDraft";
import { evalsFocus } from "../evals/kit";
import { nextVersion, rerender, ui, type AgentRow, type AgentVersionRow } from "./kit";

import { Dialog } from "../../ui/Overlay";
export function RollbackDialog({ a, ver, perm, close }: { a: AgentRow; ver: AgentVersionRow; perm: Decision; close: () => void }) {
  const out = useOutcome();
  const ui_ = useUI();
  return (
    <Dialog title={`Roll back to v${ver.v}?`} onClose={close}
      body={<p>The previous version stops serving new runs.</p>}
      actions={[
        { label: "Cancel" },
        { label: "Confirm", kind: "primary", icon: "undo", id: "ag-rollback-ok", guard: perm,
          onClick: (done) => { void ops.rollbackAgent(a.id, ver.v, { ifMatch: a.rev }).then((r) => { if (r.ok) { dropDraft("agent", a.id); rerender(); ui_.toast(`Rolled back to v${ver.v}`, "ok"); done(); } else out(r); }); } },
      ]}
    />
  );
}

export function VersionsTab({ a, dirty, perm }: { a: AgentRow; dirty: boolean; perm: Decision }) {
  const ui_ = useUI();
  const out = useOutcome();
  const suite = (useAgentSuites().data ?? []).find((x) => x.id === a.suite) ?? null;
  if (!ui.newVer || a.versions.some((v) => v.v === ui.newVer)) ui.newVer = nextVersion(a);
  const createGuard: Decision | null = !perm.allowed ? perm : dirty ? { allowed: false, needs: "", reason: "Save or discard your changes first. A version snapshots the saved configuration." } : null;
  const rows = a.versions.slice().reverse();
  const cols: SortCol<AgentVersionRow>[] = [
    { key: "v", label: "Version", render: (v) => <span className="mono">v{v.v}</span> },
    { key: "at", label: "Date", render: (v) => new Date(v.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) },
    { key: "n", label: "Change", render: (v) => <div>{v.note}<span className="sub mono">{v.diff}</span></div> },
    { key: "s", label: "Suite", align: "end", render: (v) => (v.suiteScore == null ? "—" : fmt.pct(v.suiteScore)) },
    { key: "l", label: "State", render: (v) => (v.live ? <Chip text="live" cls="ok" /> : v.rc ? <Chip text="candidate" cls="warn" /> : <Chip text="retired" cls="plain" />) },
    { key: "a", label: "", align: "end", render: (v) => {
      const vid = v.v.replace(/\W/g, "");
      const promoteGuard: Decision | null = !perm.allowed ? perm : !v.eligibility.ok ? { allowed: false, needs: `Needs a passing run of ${suite ? suite.id : "its suite"}`, reason: `${v.eligibility.text}.` } : null;
      return (
        <span className="row">
          {v.rc ? <Btn label="Promote" small kind="primary" id={`ag-promote-${vid}`} aria={`Promote ${v.v}`} guard={promoteGuard} onClick={() => { void ops.promoteAgent(a.id, v.v, { ifMatch: a.rev }).then((r) => out(r)); }} /> : null}
          {v.live ? "—" : <Btn label="Roll back" small id={`ag-rollback-${vid}`} aria={`Roll back to ${v.v}`} guard={perm} onClick={() => ui_.open((close) => <RollbackDialog a={a} ver={v} perm={perm} close={close} />)} />}
          <Btn label="Run suite" small kind="ghost" id={`ag-runsuite-${vid}`} aria={`Run suite on ${v.v}`} onClick={() => { evalsFocus({ agent: a.id, suite: a.suite, version: v.v }); navigate("evals"); }} />
        </span>
      );
    } },
  ];
  return (
    <>
      <Panel title="Version history" flush>
        <DataTable id="ag-vers" caption="Version history" columns={cols} rows={rows} rowKey={(v) => v.v} pageSize={12} pager />
      </Panel>
      <Panel title="New candidate">
        <p className="muted small">{`Promotion needs the latest run of ${suite ? `${suite.id} (${suite.name}) at ${fmt.pct(suite.threshold)} or better` : "its suite"}. Rollback skips the gate: the old version already passed.`}</p>
        <div className="ag-newver">
          <Field label="New version" htmlFor="ag-newver"><input id="ag-newver" className="input mono" value={ui.newVer} disabled={!perm.allowed} onChange={(e) => { ui.newVer = e.target.value; rerender(); }} /></Field>
          <Field label="Note" htmlFor="ag-newnote"><input id="ag-newnote" className="input" value={ui.newNote} placeholder="What changed, in one line" disabled={!perm.allowed} onChange={(e) => { ui.newNote = e.target.value; rerender(); }} /></Field>
          <Btn label="Create candidate" icon="plus" id="ag-newver-go" guard={createGuard} onClick={() => {
            void ops.newAgentVersion(a.id, ui.newVer.trim(), ui.newNote.trim(), { ifMatch: a.rev }).then((r) => { out(r); if (r.ok) { ui.newNote = ""; ui.newVer = ""; rerender(); } });
          }} />
        </div>
      </Panel>
    </>
  );
}
