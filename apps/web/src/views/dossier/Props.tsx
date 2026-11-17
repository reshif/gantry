/** The side column of a work order page: its properties, what waits on the viewer, the brief as it stands, the outline of the document and the export. */
import { useState, type ReactNode } from "react";
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Chip, StateChip, Who } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { ClassChip, classOf } from "../projects/kit";
import { useRepoName } from "../traveler/repo";
import { bayLabel, stName, stNo, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import { Meter, useCopyMarkdown, useExportRecord } from "../record/Lifecycle";
import type { RecordData, SectionId } from "../record/data";
import { srcName } from "../record/data";

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="dz-row">
    <dt>{k}</dt>
    <dd>{children}</dd>
  </div>
);

/** What waits on the viewer: the gate they may decide, and the proposals and questions in the conversation that are theirs. */
export function waitingOnYou(wo: TWo, cat: Catalog, s: WoSession | undefined): Array<{ key: string; text: string; go: "decide" | "activity"; target?: string }> {
  const out: Array<{ key: string; text: string; go: "decide" | "activity"; target?: string }> = [];
  const ap = wo.allowed.approve;
  const g = ap && ap.allowed ? cat.gates.find((x) => x.id === ap.gate) : undefined;
  if (g && !wo.bay && wo.state === "waiting") out.push({ key: `gate-${g.id}`, text: g.id === "G0G1" ? "Confirm the brief" : `Decide ${g.label} ${g.name}`, go: "decide" });
  for (const p of s?.pending ?? []) out.push({ key: `p-${p.id}`, text: p.title, go: "activity", target: `wos-prop-${p.id}` });
  for (const q of s?.dialogue.questions ?? []) if (q.status === "open" && q.mine) out.push({ key: `q-${q.id}`, text: q.question, go: "activity", target: `sq-${q.id.replace(/[^A-Za-z0-9_-]/g, "-")}` });
  return out;
}

export function Props({ wo, rec, cat, project, session, onJump, onActivity, onDecide }: { wo: TWo; rec: RecordData; cat: Catalog; project: Project; session: WoSession | undefined; onJump: (s: SectionId) => void; onActivity: (target?: string) => void; onDecide: () => void }) {
  const copy = useCopyMarkdown();
  const exportRec = useExportRecord();
  const repo = useRepoName(wo.project, wo.repo);
  const tot = wo.history.reduce((t, e) => ({ tokens: t.tokens + e.tokens, cost: t.cost + e.cost }), { tokens: 0, cost: 0 });
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const where = wo.state === "done" ? (wo.split ? "Split into children" : `Shipped ${fmt.stamp(wo.doneAt ?? 0)}`) : wo.bay ? bayLabel(cat, wo.bay) : `${stNo(cat, st?.id)} ${stName(cat, st?.id)}`.trim();
  const open = wo.history[wo.history.length - 1];
  const wait = waitingOnYou(wo, cat, session);
  const b = wo.brief;
  const ruleBased = session?.agent.mode === "rule-based";
  // on a narrow screen the properties start folded, so the document comes first
  const [open2, setOpen2] = useState(() => { try { return !window.matchMedia("(max-width: 1100px)").matches; } catch { return true; } });
  return (
    <aside className="dz-side" aria-label="Properties" id="dz-side">
      <details className="dz-props" open={open2} onToggle={(e) => setOpen2(e.currentTarget.open)}>
        <summary>Properties</summary>
        <div className="props">
          <section>
            <dl className="dz-kv">
              <Row k="Status"><StateChip state={wo.state} /></Row>
              <Row k="Station or bay">{where}</Row>
              <Row k="Agent now">{session ? (ruleBased ? "Rule-based (no agent)" : <>{session.agent.name}<span className="muted">{` v${session.agent.mode === "agent" ? session.agent.version : ""} · ${session.agent.mode === "agent" ? session.agent.model : ""}`}</span></>) : open ? <Who id={open.agent} /> : "none"}</Row>
              <Row k="Class"><span className="dz-cls"><ClassChip cls={classOf(cat, project, wo.cls)} /><span className="muted">{`${Math.round(wo.clsConfidence * 100)}%`}</span>{wo.clsOverridden ? <Chip text="overridden" cls="chip-warn" /> : null}</span></Row>
              <Row k="Repo"><span className="mono">{repo}</span></Row>
              <Row k="Requested by"><Who id={wo.requestedBy} /><span className="muted">{` via ${srcName(wo.source)}`}</span></Row>
              <Row k="Created">{fmt.stamp(wo.createdAt)}</Row>
              <Row k="SLA due">{wo.slaDue ? fmt.stamp(wo.slaDue) : "none"}</Row>
              <Row k="Pull request">{wo.pr ? `#${wo.pr.number} ${wo.pr.state}` : "not yet"}</Row>
              <Row k="Coding slot">{wo.slot ? `${wo.slot} of ${project.flow.slots}` : "none"}</Row>
              <Row k="Risk">{wo.risk || "normal"}</Row>
              <Row k="Tokens and spend"><span className="mono">{`${fmt.k(tot.tokens)} tok · ${fmt.money(tot.cost)}`}</span>{session ? <span className="muted">{` · budget ${fmt.money(session.budget.limitUsd)}`}</span> : null}</Row>
            </dl>
          </section>
          <section>
            <h3 className="dz-lab">Waiting on you</h3>
            {wait.length ? (
              <ul className="dz-wy-list">
                {wait.map((w) => (
                  <li key={w.key}><button type="button" className="linkish dz-wy" onClick={() => (w.go === "decide" ? onDecide() : onActivity(w.target))}><Icon name="check" /><span>{w.text}</span></button></li>
                ))}
              </ul>
            ) : <p className="dz-none">Nothing waits on you.</p>}
          </section>
          <section>
            <h3 className="dz-lab">Brief</h3>
            {b.goal ? (
              <div className="dz-bb">
                <b>{b.goal}</b>
                <span className="muted">{`${b.ac.length} acceptance ${b.ac.length === 1 ? "criterion" : "criteria"} · ${b.open.length} open ${b.open.length === 1 ? "question" : "questions"}`}</span>
                <button type="button" className="linkish" onClick={() => onJump("agreement")}>Read the brief</button>
              </div>
            ) : <p className="dz-none">Not drafted yet.</p>}
          </section>
          <section>
            <h3 className="dz-lab">Outline</h3>
            <Meter rec={rec} pre="rec-" onJump={onJump} />
          </section>
          <section>
            <h3 className="dz-lab">Export</h3>
            <div className="dz-exp">
              <Btn label="Copy as Markdown" small icon="copy" id="rec-copy" onClick={() => void copy(wo.id)} />
              <Btn label="Export" small icon="ledger" id="rec-export" onClick={() => void exportRec(wo.id)} />
            </div>
          </section>
        </div>
      </details>
    </aside>
  );
}
