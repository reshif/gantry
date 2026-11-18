/**
 * The Control Room matrix: one level per agent and project (the highest of its class cells), in the prototype's bordered scroller with a sticky header and first
 * column. A level opens "Propose a change": a new level and a reason. A lower level is applied at once, a higher one only within the ceilings; the ladder behind
 * the level stays one link away.
 */
import { useState, type CSSProperties } from "react";
import type { Project } from "@gantry/domain";
import { useCan } from "../../api/can";
import { applyTrustLevel } from "./Ladder";
import { Textarea } from "../../ui/Textarea";
import { Card, CrIcon } from "../../ui/cr";
import { Field, Select, Table } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { setUrlParams } from "../urlState";
import { code, rerender, trustUi, type CellOut } from "./kit";

interface Target { agent: { id: string; name: string }; project: Project; cells: CellOut[]; switchOn: boolean }

const levelOf = (cells: CellOut[]): number => (cells.length ? Math.max(...cells.map((c) => c.effective ?? c.level)) : 0);
const capOf = (cells: CellOut[]): { max: number; ids: string[] } => {
  const max = cells.length ? Math.min(...cells.map((c) => c.ceiling.max)) : 4;
  return { max, ids: [...new Set(cells.filter((c) => c.ceiling.max === max).flatMap((c) => c.ceiling.ids))] };
};

/** Why a level cannot be set, or null. Reductions are always allowed. */
export function blockedReason(to: number, now: number, cap: { max: number; ids: string[] }, switchOn: boolean): string | null {
  if (to <= now) return null;
  if (to > 3) return "L4 (unattended including release) cannot be granted in this version.";
  if (to > cap.max) return `Blocked by ceiling ${cap.ids.join(", ") || "policy"} (max ${code(cap.max)}).`;
  if (to > 1 && !switchOn) return "Trust levels above L1 are switched off. Turn them on under Ceilings.";
  return null;
}

function ProposeBody({ t, form }: { t: Target; form: { to: string; why: string; setErr: (s: string) => void } }) {
  const now = levelOf(t.cells);
  const cap = capOf(t.cells);
  const [to, setTo] = useState(form.to);
  const [why, setWhy] = useState(form.why);
  const [err, setErr] = useState("");
  form.setErr = setErr;
  const ev = t.cells.map((c) => c.evidence);
  const clean = ev.length ? Math.max(...ev.map((e) => e.cleanRuns)) : 0;
  const score = ev.length ? ev.reduce((n, e) => n + e.evalScore, 0) / ev.length : 0;
  const capped = cap.max < 4 && (t.project.regulated || cap.ids.length);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className={`banner${capped ? " warn" : ""}`}>
        <CrIcon name="info" />
        <div className="grow">
          {capped ? `${t.project.regulated ? "Regulated project: capped" : "Capped"} at ${code(cap.max)}${cap.ids.length ? ` by ${cap.ids.join(", ")}` : ""}.` : `Evidence: ${clean} clean runs, eval ${score.toFixed(2)}`}
          {" "}<a href="#trust" id="tr-mx-ladder" onClick={(e) => { e.preventDefault(); trustUi.project = t.project.id; setUrlParams({ tab: "ladder" }); rerender(); }}>Open the ladder</a>
        </div>
      </div>
      <Field label="New level" htmlFor="tr-mx-to">
        <Select id="tr-mx-to" value={to} options={[0, 1, 2, 3, 4].map((l) => ({ value: String(l), label: `L${l}` }))} onChange={(v) => { setTo(v); form.to = v; }} />
      </Field>
      <Field label="Reason" htmlFor="tr-mx-why" required error={err || undefined} hint={`At least 10 characters. Now ${code(now)}.`}>
        <Textarea id="tr-mx-why" rows={3} value={why} onChange={(v) => { setWhy(v); form.why = v; }} />
      </Field>
    </div>
  );
}

function useProposeDialog() {
  const ui = useUI();
  return (t: Target, canGrant: boolean): void => {
    const now = levelOf(t.cells);
    const form = { to: String(Math.min(3, now + 1)), why: "", setErr: (_s: string) => {} };
    const submit = async (close: () => void): Promise<void> => {
      const to = Number(form.to);
      const why = form.why.trim();
      if (why.length < 10) { form.setErr("Give a reason of at least 10 characters."); return; }
      if (to === now) { form.setErr("Pick a different level."); return; }
      const why2 = blockedReason(to, now, capOf(t.cells), t.switchOn);
      if (why2) { form.setErr(why2); ui.toast(why2, "warn"); return; }
      const lower = to < now;
      const targets = t.cells.filter((c) => (lower ? (c.effective ?? c.level) > to || c.level > to : c.level < to));
      for (const c of targets) {
        const r = await applyTrustLevel(c, to, why, lower);
        if (!r.ok) { form.setErr(r.msg); ui.toast(r.msg, "error"); return; }
      }
      ui.toast(lower ? "Lowered immediately: reductions need no approval." : `${t.agent.name} set to ${code(to)} on ${t.project.name}. Audited.`, "ok");
      close();
    };
    ui.dialog({
      title: `Propose a change: ${t.agent.name}`, sub: `${t.project.name} · currently ${code(now)}`,
      body: <ProposeBody t={t} form={form} />,
      actions: [{ label: "Cancel" }, { label: "Submit proposal", kind: "primary", submit: true, guard: canGrant ? null : { allowed: false, needs: "Grant trust levels", reason: "You may not change trust levels on this project." }, onClick: (close) => { void submit(close); } }],
    });
  };
}

export function MatrixTab({ cells, projects, agents, switchOn }: { cells: CellOut[]; projects: Project[]; agents: Array<{ id: string; name: string }>; switchOn: boolean }) {
  const open = useProposeDialog();
  const grant = useCan("trust.grant");
  const withCells = projects.filter((p) => cells.some((c) => c.project === p.id));
  const cols = (withCells.length ? withCells : projects).slice(0, 4);
  return (
    <Card title="Autonomy by agent and project" hint="Click a cell to propose a change">
      <div className="matrix" id="tr-agent-matrix" style={{ overflow: "auto", maxWidth: "100%" }}>
        <Table>
          <thead><tr><th scope="col" style={{ fontFamily: "var(--mono, monospace)", fontSize: 11, fontWeight: 500, letterSpacing: ".04em", textTransform: "none" }}>Agent</th>{cols.map((p) => <th key={p.id} scope="col" style={{ textAlign: "center", fontFamily: "var(--mono, monospace)", fontSize: 11, fontWeight: 500, letterSpacing: ".04em", textTransform: "none" }}>{p.name}</th>)}</tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td><b>{a.name}</b></td>
                {cols.map((p) => {
                  const mine = cells.filter((c) => c.agent === a.id && c.project === p.id);
                  if (!mine.length) return <td key={p.id} style={{ textAlign: "center" }}><span className="dim">{"–"}</span></td>;
                  const l = levelOf(mine);
                  return (
                    <td key={p.id} style={{ textAlign: "center" }}>
                      <a className="lvl" href="#trust" style={{ "--l": l } as CSSProperties} id={`tr-mx-${a.id}-${p.id}`} aria-label={`${a.name} on ${p.name}: level ${l}`}
                        onClick={(e) => { e.preventDefault(); open({ agent: a, project: p, cells: mine, switchOn }, grant.allowed); }}>{`L${l}`}</a>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <style>{".mx-swipe{display:none;font:500 11px var(--mono);color:var(--text-3);padding:6px 2px 0}@media (max-width:760px){.mx-swipe{display:block}}"}</style>
      <div className="mx-swipe">Swipe sideways for more {"\u2192"}</div>
      <div className="row dim mono" style={{ marginTop: 12, fontSize: 11 }}><span>L0 every output reviewed</span><span>{"·"}</span><span>L2 sample reviewed</span><span>{"·"}</span><span>L3 decided by checks</span></div>
    </Card>
  );
}
