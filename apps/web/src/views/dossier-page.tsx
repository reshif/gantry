/**
 * Dossier (#/p/<project>/dossier/WO-x[/tab]): the evidence pack for one work order, as the prototype's page with Summary, Criteria,
 * Brief versions, Checks and Audit. Everything shown is read from the work order record; nothing here writes.
 */
import { fmt } from "@gantry/domain";
import { hashFor, navigate, useHash } from "../lib/router";
import { Btn, Tabs } from "../ui/primitives";
import { Card, CrEmpty, CrIcon, Page, Stats } from "../ui/cr";
import { DataTable } from "../ui/DataTable";
import { Loading } from "../ui/async";
import { Who } from "../ui/primitives";
import { Picker } from "./record/Picker";
import { critStatus, useRecordData } from "./record/data";
import { stName, toRecEvent } from "./traveler/model";

const TABS = [{ id: "summary", label: "Summary" }, { id: "criteria", label: "Criteria" }, { id: "brief", label: "Brief versions" }, { id: "checks", label: "Checks" }, { id: "audit", label: "Audit" }];
const TONE: Record<string, string> = { met: "ok", failed: "bad", pending: "warn", untested: "idle" };

export default function DossierPage() {
  const hash = useHash();
  const [rawId = "", rawTab = ""] = (hash.param ?? "").split("/");
  const id = rawId.toUpperCase();
  const tab = TABS.find((t) => t.id === rawTab)?.id ?? "summary";
  const d = useRecordData(id || null);
  if (!id) return <Picker />;
  if (d.loading) return <div className="view rec-view"><Loading id="dz-page-loading" label="the dossier" /></div>;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) return <Picker note={`${id} was not found, or it belongs to a project outside your access. Pick a work order you can see.`} />;
  const { wo, rec, cat } = d;
  const crit = rec.criteria;
  const met = crit.filter((c) => critStatus(c).id === "met").length;
  const t = rec.code.tests;
  const checks = rec.gates.flatMap((g) => (g.basis.checks ?? []).map((c) => ({ key: `${g.id}-${c.name}`, name: c.name, gate: g.gate, ok: c.ok })));
  const versions = rec.briefVersions;
  const cur = versions[versions.length - 1];
  const prev = versions.length > 1 ? versions[versions.length - 2] : undefined;
  const protectedFiles = rec.code.files.filter((f) => f.protected).length;
  let body;
  if (tab === "summary") {
    body = (
      <>
        <Stats items={[
          { l: "Criteria met", v: crit.length ? `${met}/${crit.length}` : "n/a", tone: crit.length && met === crit.length ? "ok" : "warn" },
          { l: "Checks passed", v: t.passed + t.failed ? `${t.passed}/${t.passed + t.failed}` : "n/a", tone: t.failed ? "bad" : "ok" },
          { l: "Review findings", v: "n/a", tone: "info", d: "Not recorded" },
          { l: "Diff", v: `+${rec.code.diff.plus} −${rec.code.diff.minus}` },
        ]} />
        <div className="grid g2">
          <Card title="Verdict">
            <p>{`${wo.title} is ${wo.state === "done" ? "released" : "in flight"}. The evidence below is what each gate approver saw. Agents produced it; people decided.`}</p>
            <dl className="kv">
              <dt>Spec</dt><dd>{cur ? `v${cur.v}` : "No brief yet"}</dd>
              <dt>Plan</dt><dd>{rec.completeness.sections.plan ? "Written" : "Not written"}</dd>
              <dt>Tests</dt><dd>{`${t.passed} passed, ${t.failed} failed, ${t.added} added`}</dd>
              <dt>Sensitive paths</dt><dd>{protectedFiles ? `${protectedFiles} touched` : "none touched"}</dd>
            </dl>
          </Card>
          <Card title="Evidence trail">
            {rec.gates.length ? (
              <div className="tl">
                {rec.gates.map((g) => (
                  <div key={g.id} className={g.status === "open" ? "warn" : "ok"}>
                    <div>{g.status === "open" ? `${g.gate} waiting` : `${g.gate} ${g.decision?.decision ?? g.status}${g.decision?.decided_by ? ` by ${g.decision.decided_by}` : ""}`}</div>
                    <div className="when">{g.gate}</div>
                  </div>
                ))}
              </div>
            ) : <CrEmpty title="No gate decisions yet" icon="inbox" />}
          </Card>
        </div>
      </>
    );
  } else if (tab === "criteria") {
    body = (
      <Card title="Acceptance criteria against evidence" flush>
        {crit.length ? (
          <div className="list">
            {crit.map((c) => (
              <div className="li" key={c.id}>
                <span className="mono dim">{c.id}</span>
                <div className="main1"><span className="t1" style={{ whiteSpace: "normal" }}>{c.text}</span><span className="t2">{c.tests.length ? `test: ${c.tests.map((x) => x.name).join(", ")}` : "No test linked"}</span></div>
                <span className={`chip ${TONE[critStatus(c).id] ?? "idle"}`}>{critStatus(c).id === "met" ? "Pass" : critStatus(c).label}</span>
              </div>
            ))}
          </div>
        ) : <CrEmpty title="No acceptance criteria" icon="inbox" />}
      </Card>
    );
  } else if (tab === "brief") {
    const lines = (b: typeof cur) => (b ? [`Goal: ${b.brief.goal}`, ...b.brief.scopeIn.map((x) => `In scope: ${x}`), ...b.brief.ac.map((x) => `Criterion: ${x}`)] : []);
    const before = new Set(lines(prev));
    const after = new Set(lines(cur));
    const diff = (title: string, ls: string[], other: Set<string>, sign: string) => (
      <Card title={title}>
        <pre className="code diff" style={{ padding: 8 }}>{ls.length ? ls.map((l) => <div key={l} className={other.has(l) ? "" : sign === "+" ? "add" : "del"}>{`${other.has(l) ? " " : sign} ${l}`}</div>) : <div>No brief recorded.</div>}</pre>
      </Card>
    );
    body = <div className="grid g2">{diff(prev ? `Brief v${prev.v} (before)` : "Brief (before)", [...before], after, "-")}{diff(cur ? `Brief v${cur.v} (approved)` : "Brief", [...after], before, "+")}</div>;
  } else if (tab === "checks") {
    body = (
      <Card title="Checks" flush>
        {checks.length ? (
          <div className="list">
            {checks.map((c) => (
              <div className="li" key={c.key}>
                <span className={`lamp ${c.ok ? "ok" : "bad"}`} />
                <div className="main1"><span className="t1">{c.name}</span><span className="t2 mono">{c.gate}</span></div>
                <span className={`chip ${c.ok ? "ok" : "bad"}`}>{c.ok ? "Passed" : "Failed"}</span>
              </div>
            ))}
          </div>
        ) : <CrEmpty title="No checks recorded" text="Gate checks appear here once a gate has opened." icon="inbox" />}
      </Card>
    );
  } else {
    const rows = rec.events.map(toRecEvent).sort((a, b) => b.at - a.at).slice(0, 40);
    body = (
      <Card title={`Audit trail for ${wo.id}`} flush>
        <DataTable
          id="dz-audit-table"
          caption={`Audit trail for ${wo.id}`}
          rows={rows}
          rowKey={(e) => String(e.seq)}
          empty={{ title: "No events yet" }}
          columns={[
            { key: "at", label: "When", render: (e) => <span className="mono dim">{fmt.stamp(e.at)}</span> },
            { key: "by", label: "Who", render: (e) => (e.by ? <Who id={e.by} /> : "") },
            { key: "type", label: "Action", render: (e) => <span className="mono">{`${e.type}${e.station ? ` ${stName(cat, e.station)}` : ""} ${wo.id}`}</span> },
          ]}
        />
      </Card>
    );
  }
  return (
    <Page
      eyebrow={`Work order · ${wo.id}`}
      title="Dossier"
      sub={`The evidence pack for ${wo.title}`}
      acts={
        <>
          <a className="btn" id="dz-back" href={hashFor("record", wo.id, wo.project)}>Back to record</a>
          <Btn label="Export PDF" id="dz-export" onClick={() => window.print()}><CrIcon name="dl" /></Btn>
        </>
      }
    >
      <Tabs idPrefix="dzp-tab" items={TABS} active={tab} onChange={(x) => navigate("dossier", x === "summary" ? id : `${id}/${x}`, wo.project)} />
      {body}
    </Page>
  );
}
