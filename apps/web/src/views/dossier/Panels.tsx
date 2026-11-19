/** The Document tab's first panels and the Gates and Runs tabs of a work order page (Blueprint prototype: Brief, Acceptance criteria, Plan; Gate decisions; Station runs). */
import { gateLabelOf } from "../../lib/gate-label";
import { fmt, type Catalog, type Criterion } from "@gantry/domain";
import { Btn, Chip, Empty, Panel } from "../../ui/primitives";
import { useActionSpecs } from "../traveler/Actions";
import { DataTable, type Col } from "../../ui/SortTable";
import { useActors } from "../../ui/actors";
import type { TWo } from "../traveler/model";
import { ago, minutes, plainName } from "./time";
import { PromptsPanel } from "./Prompts";
import { EditBriefBtn } from "./BriefEdit";
import { useUI } from "../../ui/overlay-context";
import { Dialog } from "../../ui/Overlay";
import { RunTimelineView } from "../documents/Timeline";
import { DocViewer } from "../documents/DocViewer";
import { GateDetail } from "../work/GateDetail";
import { gatePendingTitle } from "@gantry/domain";

const label = (k: string): string => k.replace(/([A-Z])/g, " $1");

export function BriefPanel({ wo }: { wo: TWo }) {
  const b: Record<string, unknown> | undefined = { ...wo.brief };
  const entries = Object.entries(b ?? {}).filter(([k, v]) => k !== "route" && v && (!Array.isArray(v) || v.length));
  return (
    <Panel title="Brief" tools={<EditBriefBtn wo={wo} />}>
      {entries.length ? (
        <div className="stack" id="dz-brief">
          {entries.map(([k, v]) => (
            <div key={k}>
              <div className="micro">{label(k)}</div>
              {Array.isArray(v) ? <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{v.map((x, i) => <li key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</li>)}</ul> : <p>{typeof v === "object" ? JSON.stringify(v) : String(v)}</p>}
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No brief yet" text="The Intake agent writes it once the conversation completes." />
      )}
    </Panel>
  );
}

/** What Verify recorded for a criterion, in the words a person reads: the server says "met", "not met" or "not tested". */
export const CRITERION: Record<string, { label: string; cls: string }> = {
  met: { label: "Passed", cls: "ok" }, passing: { label: "Passed", cls: "ok" },
  "not met": { label: "Failed", cls: "bad" }, failing: { label: "Failed", cls: "bad" },
  "not tested": { label: "Not tested", cls: "plain" },
};

/** Acceptance criteria with Verify's verdict for each and the test counts of the record (`criteria` and `tests` come from GET .../record, which carries Verify's report). */
export function CriteriaPanel({ wo, criteria, tests }: { wo: TWo; criteria?: Criterion[]; tests?: { passed: number; failed: number; added: number } }) {
  const verified = criteria?.length ? criteria : wo.criteria?.length ? wo.criteria : [];
  // Before Verify has reported, the criteria are the ones the Brief lists (the same source the Brief panel and the Record read), shown without a verdict.
  const fromBrief = (wo.brief?.ac ?? []).filter((x) => typeof x === "string" && x.trim());
  const list: Criterion[] = verified.length ? verified : fromBrief.map((text, i) => ({ id: `AC${i + 1}`, text, status: "", tests: [] }));
  const ran = (tests?.passed ?? 0) + (tests?.failed ?? 0);
  return (
    <Panel title="Acceptance criteria" flush>
      {list.length ? (
        <>
          <ul className="list" id="dz-criteria">
            {list.map((c) => {
              const st = CRITERION[c.status] ?? { label: c.status, cls: "plain" };
              return (
                <li key={c.id}>
                  <span className="mono small">{c.id}</span>
                  <div className="grow">
                    <div>{c.text}</div>
                    {c.tests?.length ? <div className="small muted mono">{c.tests.map((t) => `${t.name} ${t.result === "pass" ? "passed" : "failed"}`).join(" · ")}</div> : null}
                  </div>
                  {c.status ? <Chip text={st.label} cls={st.cls} /> : null}
                </li>
              );
            })}
          </ul>
          {tests ? (
            <p className="small muted" id="dz-test-counts" style={{ padding: "8px 12px", margin: 0 }}>
              {ran ? `${tests.passed} test${tests.passed === 1 ? "" : "s"} passed, ${tests.failed} failed${tests.added ? `, ${tests.added} added` : ""}.` : `No tests were run${tests.added ? ` (${tests.added} added)` : ""}, so criteria that were not tested stay unconfirmed.`}
            </p>
          ) : null}
        </>
      ) : <div className="empty">None recorded yet.</div>}
    </Panel>
  );
}

export function PlanPanel({ wo }: { wo: TWo }) {
  const list = wo.plan ?? [];
  return (
    <Panel title="Plan" flush>
      {list.length ? (
        <ol className="list" style={{ paddingLeft: 0 }}>
          {list.map((p) => (
            <li key={p.id}>
              <span className="mono small">{p.id}</span>
              <div className="grow">
                <div>{p.text}</div>
                <div className="small muted mono">{(p.files ?? []).join(", ")}</div>
              </div>
              {(p.ac ?? []).map((a) => <Chip key={a} text={a} cls="plain" />)}
            </li>
          ))}
        </ol>
      ) : <div className="empty">The Plan station has not written a plan yet.</div>}
    </Panel>
  );
}

export function GatesPanel({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const actor = useActors();
  const specs = useActionSpecs(wo, true);
  const decide = (specs ?? []).filter((x) => x.group === "decide");
  const rows = Object.entries(wo.gates ?? {}).map(([k, g]) => ({ k, ...g }));
  const def = (k: string) => cat.gates.find((x) => x.id === k);
  const cols: Col<(typeof rows)[number]>[] = [
    { key: "k", label: "Gate", render: (g) => <span className="pri-cell"><b className="mono">{gateLabelOf(def(g.k)?.label, g.k)}</b><span className="sub">{def(g.k)?.name}</span></span> },
    { key: "kind", label: "Kind", render: (g) => def(g.k)?.kind ?? "" },
    { key: "n", label: "Approvals", render: (g) => { const p = wo.gateProgress?.[g.k]; return def(g.k)?.kind === "auto" ? "—" : p ? <span className="num" id={`gt-count-${g.k}`}>{`${g.status === "passed" ? Math.max(p.have, p.need) : p.have} of ${p.need} approvals`}</span> : "—"; } },
    { key: "s", label: "Status", render: (g) => <Chip text={g.status} cls={g.status === "passed" ? "ok" : g.status === "waiting" ? "warn" : g.status === "failed" ? "bad" : "plain"} /> },
    { key: "by", label: "Decided by", render: (g) => { const d = g.approvals[0] ?? g.rejections[0]; return d ? actor(d.by).name : g.decision?.mode === "auto" ? "Automatic" : g.decision?.mode === "trust" ? "Under trust" : "—"; } },
    { key: "at", label: "When", render: (g) => { const d = g.approvals[0] ?? g.rejections[0]; return d ? ago(d.at) : "—"; } },
    { key: "a", label: "", align: "end", render: (g) => (g.status === "waiting" && wo.state === "waiting" && decide.length ? <div className="row" style={{ justifyContent: "flex-end" }}>{decide.map((a) => <Btn key={a.key} label={a.label} small {...(a.kind ? { kind: a.kind } : {})} id={`gt-${a.key}-${g.k}`} guard={a.guard} onClick={a.onClick} />)}</div> : null) },
  ];
  return (
    <div className="stack">
      <Panel title="Gate decisions" flush>
        <DataTable id="dz-gates" caption={`Gate decisions for ${wo.id}`} columns={cols} rows={rows} rowKey={(g) => g.k} pageSize={20} range />
      </Panel>
      {rows.filter((g) => g.status === "waiting").map((g) => {
        const d = def(g.k);
        return (
          <Panel key={g.k} title={d ? gatePendingTitle(d) : g.k} id={`gt-open-${g.k}`}>
            <GateDetail woId={wo.id} gate={g.k} project={wo.project} />
          </Panel>
        );
      })}
    </div>
  );
}

export function RunsPanel({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const actor = useActors();
  const ui = useUI();
  const cols: Col<TWo["history"][number]>[] = [
    { key: "station", label: "Station", render: (x) => cat.stations.find((s) => s.id === x.station)?.name ?? x.station },
    { key: "agent", label: "Agent", render: (x) => plainName(actor(x.agent).name) + (x.agentVersion ? ` v${x.agentVersion}` : "") },
    { key: "model", label: "Model", render: (x) => <span className="mono small">{x.model}</span> },
    { key: "dur", label: "Duration", align: "end", render: (x) => (x.endedAt ? minutes(x.endedAt - x.startedAt) : "running") },
    { key: "tok", label: "Tokens", align: "end", render: (x) => <span className="num">{fmt.k(x.tokens)}</span> },
    { key: "cost", label: "Cost", align: "end", render: (x) => <span className="num">{fmt.money(x.cost)}</span> },
    { key: "o", label: "Outcome", render: (x) => (x.outcome ? <Chip text={x.outcome} cls={x.outcome === "passed" ? "ok" : "bad"} /> : <Chip text="active" cls="info" />) },
  ];
  return (
    <div className="stack">
      <Panel
        title="Station runs"
        flush
        tools={
          <>
            <Btn label="Run timeline" small icon="clock" id="dz-run-timeline" onClick={() => void ui.open((close) => <Dialog wide title={`Run timeline · ${wo.id}`} sub="The files each run read, the pages it fetched, what it wrote and what it cost." onClose={close} body={<RunTimelineView woId={wo.id} />} />)} />
            <Btn label="Station documents" small icon="record" id="dz-run-docs" onClick={() => void ui.open((close) => <Dialog wide title={`Station documents · ${wo.id}`} onClose={close} body={<DocViewer woId={wo.id} project={wo.project} />} />)} />
          </>
        }
      >
        <DataTable id="dz-runs" caption={`Station runs for ${wo.id}`} columns={cols} rows={wo.history} rowKey={(x) => `${x.station}-${x.startedAt}`} pageSize={20} range />
      </Panel>
      <PromptsPanel woId={wo.id} />
    </div>
  );
}
