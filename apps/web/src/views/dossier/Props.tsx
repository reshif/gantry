/** The Properties panel of a work order page (prototype: Station, Class, Priority, Repo, SLA due, Cost, Tokens, PR, Diff, Tests) and what waits on the viewer. */
import type { ReactNode } from "react";
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { Panel } from "../../ui/primitives";
import { classOf } from "../projects/kit";
import { useRepoName } from "../traveler/repo";
import { hashFor, navigate } from "../../lib/router";
import { bayLabel, stName, stNo, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import { fmtDate } from "./time";

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <>
    <dt>{k}</dt>
    <dd>{children}</dd>
  </>
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

export function Props({ wo, cat, project }: { wo: TWo; cat: Catalog; project: Project }) {
  const repo = useRepoName(wo.project, wo.repo);
  const tot = wo.history.reduce((t, e) => ({ tokens: t.tokens + e.tokens, cost: t.cost + e.cost }), { tokens: 0, cost: 0 });
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const where = wo.bay ? bayLabel(cat, wo.bay) : `${stNo(cat, st?.id)} ${stName(cat, st?.id)}`.trim();
  const dossier = hashFor("dossier", wo.repo, wo.project);
  return (
    <div id="dz-side">
      <Panel title="Properties">
        <dl className="kv">
          <Row k="Station">{where}</Row>
          <Row k="Class">{`${classOf(cat, project, wo.cls).name} (${Math.round(wo.clsConfidence * 100)}%)`}</Row>
          <Row k="Priority">{wo.priority}</Row>
          <Row k="Repo">{wo.repo ? <a href={dossier} onClick={(e) => { e.preventDefault(); navigate("dossier", wo.repo, wo.project); }}>{repo}</a> : "—"}</Row>
          <Row k="SLA due">{fmtDate(wo.slaDue)}</Row>
          <Row k="Cost">{fmt.money(tot.cost)}</Row>
          <Row k="Tokens">{fmt.k(tot.tokens)}</Row>
          <Row k="PR">{wo.pr ? `#${wo.pr.number} · ${wo.pr.state} · checks ${wo.pr.checks}` : "—"}</Row>
          <Row k="Diff">{wo.diff ? <span className="num">{`+${wo.diff.plus} −${wo.diff.minus} · ${wo.diff.files} files`}</span> : "—"}</Row>
          <Row k="Tests">{wo.tests ? `${wo.tests.passed} passed, ${wo.tests.failed} failed, ${wo.tests.added} added` : "—"}</Row>
        </dl>
      </Panel>
    </div>
  );
}
