/** Versions tab and the rollback dialog (legacy versionsTab and rollbackDialog): candidate creation from the saved configuration, eval-gated promotion, rollback, and a link to run the suite. */
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useAgentSuites } from "../../api/queries";
import { Btn, Field, LockNote, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useOutcome } from "../govern/data";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { liveVersion, nextVersion, rerender, same, ui, type AgentRow, type AgentVersionRow } from "./kit";

export function RollbackDialog({ a, ver, live, perm, close }: { a: AgentRow; ver: AgentVersionRow; live: AgentVersionRow | undefined; perm: Decision; close: () => void }) {
  const out = useOutcome();
  const snap = ver.snapshot ? (JSON.parse(String(ver.snapshot)) as Record<string, unknown>) : null;
  return (
    <Dialog
      title={`Roll back ${a.name} to ${ver.v}`} kicker="Agent · rollback" onClose={close}
      sub={`The floor switches from ${live?.v} to ${ver.v} immediately. Work already at a station finishes on the version it started with.`}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Rollback" />
          <dl className="titleblock">
            <div><dt>From</dt><dd className="mono">{live?.v}</dd></div>
            <div><dt>To</dt><dd className="mono">{ver.v}</dd></div>
            <div><dt>Suite score</dt><dd className="mono">{fmt.pct(ver.suiteScore || 0)}</dd></div>
          </dl>
          {snap ? <p className="small">{`Restores the saved configuration: ${Object.keys(snap).join(", ")}.`}</p> : <p className="small muted">This version has no saved configuration snapshot, so only the live version number changes.</p>}
        </div>
      )}
      actions={[
        { label: "Cancel" },
        { label: "Roll back", kind: "danger", icon: "undo", id: "ag-rollback-ok", guard: perm,
          onClick: (done) => { void ops.rollbackAgent(a.id, ver.v, { ifMatch: a.rev }).then((r) => { out(r); if (r.ok) { ui.draft = null; rerender(); done(); } }); } },
      ]}
    />
  );
}

export function VersionsTab({ a, dirty, perm }: { a: AgentRow; dirty: boolean; perm: Decision }) {
  const ui_ = useUI();
  const out = useOutcome();
  const suite = (useAgentSuites().data ?? []).find((x) => x.id === a.suite) ?? null;
  const live = liveVersion(a);
  if (!ui.newVer || a.versions.some((v) => v.v === ui.newVer)) ui.newVer = nextVersion(a);
  const createGuard: Decision | null = !perm.allowed ? perm : dirty ? { allowed: false, needs: "", reason: "Save or discard your changes first. A version snapshots the saved configuration." } : null;
  return (
    <div className="cfg">
      <section className="cfg-sec ag-wide">
        <h3 className="cfg-h">Versions</h3>
        <p className="muted small">{`Promotion needs the latest run of ${suite ? `${suite.id} (${suite.name}) at ${fmt.pct(suite.threshold)} or better` : "its suite"}. Rollback skips the gate: the old version already passed.`}</p>
        <div className="ag-newver">
          <Field label="New version" htmlFor="ag-newver"><input id="ag-newver" className="input mono" value={ui.newVer} disabled={!perm.allowed} onChange={(e) => { ui.newVer = e.target.value; rerender(); }} /></Field>
          <Field label="Note" htmlFor="ag-newnote"><input id="ag-newnote" className="input" value={ui.newNote} placeholder="What changed, in one line" disabled={!perm.allowed} onChange={(e) => { ui.newNote = e.target.value; rerender(); }} /></Field>
          <Btn label="Create candidate" icon="plus" id="ag-newver-go" guard={createGuard} onClick={() => {
            void ops.newAgentVersion(a.id, ui.newVer.trim(), ui.newNote.trim(), { ifMatch: a.rev }).then((r) => { out(r); if (r.ok) { ui.newNote = ""; ui.newVer = ""; rerender(); } });
          }} />
        </div>
        <ol className="ag-vers">
          {a.versions.slice().reverse().map((ver) => {
            const el = ver.eligibility;
            const snap = ver.snapshot ? (JSON.parse(String(ver.snapshot)) as Record<string, unknown>) : null;
            const deltas: string[] = [];
            if (snap) for (const k of Object.keys(snap)) if (!same(snap[k], (a as unknown as Record<string, unknown>)[k])) deltas.push(k);
            const state = ver.live ? "live" : ver.rc ? "candidate" : "retired";
            const vid = ver.v.replace(/\W/g, "");
            const promoteGuard: Decision | null = !perm.allowed ? perm : !el.ok ? { allowed: false, needs: `Needs a passing run of ${suite ? suite.id : "its suite"}`, reason: `${el.text}.` } : null;
            return (
              <li key={ver.v} className={`ag-ver is-${state}`}>
                <div className="ag-ver-rail" aria-hidden="true"><span className="ag-ver-dot" /></div>
                <div className="ag-ver-body">
                  <div className="ag-ver-top">
                    <span className="mono strong ag-ver-v">{ver.v}</span>
                    <span className={`chip ag-ver-state ag-st-${state}`}>{state === "live" ? "On the floor" : state === "candidate" ? "Candidate" : "Retired"}</span>
                    <span className="muted small">{fmt.istDate(ver.at)}</span><span className="small">{ver.note}</span>
                  </div>
                  <div className="mono small ag-diff"><span className="muted">Diff: </span>{ver.diff || "no summary"}{deltas.length ? <span className="muted">{` · differs from current in ${deltas.join(", ")}`}</span> : null}</div>
                  <div className={`elig ${el.ok ? "pos" : "neg"}`}><Icon name={el.ok ? "check" : "lock"} /><span>{el.text}</span></div>
                  <div className="ag-ver-actions">
                    {!ver.rc ? null : <Btn label={`Promote ${ver.v}`} small kind={el.ok ? "primary" : undefined} icon="rocket" id={`ag-promote-${vid}`} guard={promoteGuard} onClick={() => { void ops.promoteAgent(a.id, ver.v, { ifMatch: a.rev }).then((r) => out(r)); }} />}
                    {ver.live || ver.rc ? null : <Btn label={`Roll back to ${ver.v}`} small icon="undo" id={`ag-rollback-${vid}`} guard={perm} onClick={() => ui_.open((close) => <RollbackDialog a={a} ver={ver} live={live} perm={perm} close={close} />)} />}
                    <Btn label="Run suite" small kind="ghost" icon="eval" id={`ag-runsuite-${vid}`} onClick={() => navigate("evals")} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
