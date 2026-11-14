/** The traveler's Brief, Artefacts and History tabs (legacy traveler.js brief, artefacts, history). */
import type { ReactNode } from "react";
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { useAudit } from "../../api/queries";
import type { AuditEntry, Page } from "../../api/types";
import { Avatar, Empty } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useOpenTraveler } from "../../shell/useTraveler";
import { Who } from "../../ui/primitives";
import { useName } from "../record/bits";
import { useChangesRead, useRecordRead } from "../record/data";
import { stName, stNo, type TWo } from "./model";

const Sec = ({ title, items, empty }: { title: string; items: string[] | undefined; empty?: string }) => (
  <section className="trv-sec">
    <h3 className="sub-h">{title}</h3>
    {items && items.length ? (
      <ul className="art-list trv-ul">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    ) : (
      <p className="muted small">{empty || "None."}</p>
    )}
  </section>
);

export function BriefTab({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const name = useName();
  const b = wo.brief;
  const g = wo.gates.G0G1;
  const confirmed = !!g && g.status === "passed";
  const route = b.route && b.route.length ? b.route : wo.route;
  return (
    <div className="trv-brief">
      <div className={`callout ${confirmed ? "callout-ok" : "callout-warn"}`}>
        <Icon name={confirmed ? "check" : "alert"} />
        <span>{confirmed ? `Brief confirmed at G0+G1${g!.approvals[0] ? ` by ${name(g!.approvals[0].by)}, ${fmt.stamp(g!.approvals[0].at)}` : ""}.` : "Draft. The brief is confirmed at G0+G1 once the intake conversation is done."}</span>
      </div>
      <section className="trv-sec">
        <h3 className="sub-h">Goal</h3>
        <p>{b.goal || wo.title}</p>
      </section>
      <div className="trv-2col">
        <Sec title="In scope" items={b.scopeIn} />
        <Sec title="Out of scope" items={b.scopeOut} />
      </div>
      <Sec title="Acceptance criteria" items={b.ac} empty="No acceptance criteria yet." />
      <div className="trv-2col">
        <Sec title="Risks" items={b.risks} />
        <Sec title="Open questions" items={b.open} />
      </div>
      <Sec title="Decisions" items={b.decisions} />
      <section className="trv-sec">
        <h3 className="sub-h">Estimate and route</h3>
        <div className="trv-route">
          <span className="chip">{`Estimate ${b.estimate || "?"}`}</span>
          {route.map((sid, i) => (
            <span key={sid} style={{ display: "contents" }}>
              {i ? <Icon name="chevron" className="trv-route-sep" /> : null}
              <span className="trv-route-st mono">{`${stNo(cat, sid)} ${stName(cat, sid)}`}</span>
            </span>
          ))}
        </div>
      </section>
      {(b.children && b.children.length) || wo.children.length ? <Sec title="Child work orders" items={wo.children.length ? wo.children : b.children.map((c) => `${c} (proposed)`)} /> : null}
    </div>
  );
}

/** Audit before and after values can be whole records; the ledger line shows the start of each. */
const clip = (v: unknown, n = 48): string => {
  const t = String(v ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const kv = (k: string, v: ReactNode, cls?: string) => (
  <div className="kv" key={k}>
    <div className="kv-k">{k}</div>
    <div className={`kv-v mono ${cls ?? ""}`}>{v}</div>
  </div>
);

/** What the agents handed over, and what Gantry observed: the station outputs, the change, the tests and the pull request. */
export function ArtefactsTab({ wo }: { wo: TWo; project: Project }) {
  const rec = useRecordRead(wo.id).data;
  const ch = useChangesRead(wo.id).data;
  const outputs = ((wo as unknown as { outputs?: Record<string, Record<string, unknown>> }).outputs ?? {}) as Record<string, Record<string, unknown>>;
  const arts: Array<{ k: string; body: ReactNode }> = [];
  const goal = wo.brief.goal || wo.title;
  arts.push({ k: "Brief", body: <p className="small">{`${wo.gates.G0G1 && wo.gates.G0G1.status === "passed" ? "Confirmed brief. " : "Draft brief. "}${goal} See the Brief tab.`}</p> });
  for (const [station, out] of Object.entries(outputs)) {
    const keys = Object.keys(out).filter((k) => k !== "_labels");
    if (!keys.length) continue;
    const labels = (out._labels ?? {}) as { agentReported?: string[]; systemObserved?: string[] };
    arts.push({
      k: `${station.charAt(0).toUpperCase()}${station.slice(1)} output`,
      body: (
        <div className="art-doc">
          {keys.map((k) => (
            <p key={k}>
              <strong>{`${k}. `}</strong>
              {typeof out[k] === "string" ? (out[k] as string) : <span className="mono small">{JSON.stringify(out[k])}</span>}
              <span className="muted small">{labels.systemObserved?.includes(k) ? " · observed by Gantry" : labels.agentReported?.includes(k) ? " · reported by the agent" : ""}</span>
            </p>
          ))}
        </div>
      ),
    });
  }
  for (const [i, e] of wo.history.entries())
    for (const a of e.artefacts ?? []) arts.push({ k: `${a.title}`, body: <pre className="rec-art" key={`${i}-${a.title}`}>{a.body}</pre> });
  const files = ch?.files ?? rec?.code.files ?? [];
  const plus = files.length ? files.reduce((t, f) => t + f.plus, 0) : wo.diff.plus;
  const minus = files.length ? files.reduce((t, f) => t + f.minus, 0) : wo.diff.minus;
  if (files.length || wo.diff.plus || wo.diff.minus)
    arts.push({
      k: "Diff summary",
      body: (
        <div>
          <div className="diffstat">
            <span className="plus mono">{`+${plus}`}</span>
            <span className="minus mono">{`−${minus}`}</span>
            <span className="muted">{`${files.length || wo.diff.files} files`}</span>
          </div>
          <ul className="files">
            {files.map((f) => (
              <li key={f.path}>
                <span className="mono">{f.path}</span>
                <span className="plus mono">{`+${f.plus}`}</span>
                <span className="minus mono">{`−${f.minus}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ),
    });
  const tests = rec && (rec.code.tests.passed || rec.code.tests.failed) ? rec.code.tests : wo.tests;
  if (tests.passed || tests.failed) arts.push({ k: "Test results", body: <div className="kv-row">{[kv("Passed", fmt.num(tests.passed)), kv("Failed", String(tests.failed), tests.failed ? "neg" : ""), kv("Added", String(tests.added))]}</div> });
  const prs = rec?.code.pullRequests ?? [];
  if (prs.length || wo.pr)
    arts.push({
      k: "Pull request",
      body: (
        <div>
          {prs.map((p) => (
            <div key={p.number}>
              <div className="mono pr-line">{`${wo.repo}#${p.number}  ${p.title}`}</div>
              <div className="kv-row">{[kv("State", p.draft && p.state === "open" ? "draft" : p.state, p.draft ? "neg" : ""), kv("Head", p.headSha ? p.headSha.slice(0, 7) : "–"), kv("Tag", wo.pr?.tag || "none")]}</div>
              {p.url ? <p className="small"><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></p> : null}
            </div>
          ))}
          {!prs.length && wo.pr ? <div className="kv-row">{[kv("State", wo.pr.state), kv("Checks", wo.pr.checks), kv("Tag", wo.pr.tag || "none")]}</div> : null}
        </div>
      ),
    });
  return (
    <div className="arts">
      {arts.map((a, i) => (
        <section className="art" key={i}>
          <h3 className="art-k">{a.k}</h3>
          {a.body}
        </section>
      ))}
      {arts.length < 3 ? <p className="muted small">More artefacts appear as the work order passes Research, Spec, Design, Plan, Build and Verify.</p> : null}
    </div>
  );
}

export function HistoryTab({ wo }: { wo: TWo }) {
  const name = useName();
  const q = useAudit({ project: wo.project, q: wo.id, limit: 100 });
  const raw = q.data as AuditEntry[] | Page<AuditEntry> | undefined;
  const all = Array.isArray(raw) ? raw : (raw?.items ?? []);
  const list = all.filter((e) => (e.entity && e.entity.id === wo.id) || String(e.target || "").includes(wo.id)).slice(0, 40);
  return (
    <div className="trv-hist">
      <h3 className="sub-h">Audit ledger</h3>
      {list.length ? (
        <ol className="history">
          {list.map((e) => (
            <li key={e.id}>
              <span className="mono muted">{fmt.iso(e.at)}</span>
              <Who id={e.actor} />
              <span className="mono">{e.action}</span>
              <span>{e.target}</span>
              {e.before != null || e.after != null ? (
                <span className="diff-ba mono small" title={`${e.before ?? ""} → ${e.after ?? ""}`}>
                  <del>{clip(e.before)}</del>
                  {" → "}
                  <ins>{clip(e.after)}</ins>
                </span>
              ) : null}
              <span className={`outcome o-${e.outcome}`}>{e.outcome}</span>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="No history yet" text="Changes to this work order are written to the audit ledger and appear here." />
      )}
      <h3 className="sub-h">Floor log</h3>
      <ol className="log">
        {wo.log
          .slice()
          .reverse()
          .map((l, i) => (
            <li key={i}>
              <span className="mono muted">{fmt.ist(l.at)}</span>
              <Avatar id={l.who} size="sm" />
              <span>
                <strong>{`${name(l.who)} `}</strong>
                {l.text}
              </span>
            </li>
          ))}
      </ol>
    </div>
  );
}
void useOpenTraveler;
