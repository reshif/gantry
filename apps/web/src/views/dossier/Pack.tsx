/**
 * The Dossier page (#dossier/<WO>[/<tab>]): the evidence pack of one work order, as the prototype draws it. Summary (four figures, the
 * verdict and the evidence trail), Criteria, Brief versions, Checks and the Audit trail. Every figure comes from the record, changes and
 * audit reads; what the server does not record is shown as "not available", never invented.
 */
import { type Catalog } from "@gantry/domain";
import { useAudit } from "../../api/queries";
import { Btn, Tabs, Who, Empty } from "../../ui/primitives";
import { Page, Card, Stats } from "../../ui/cr";
import { DataTable, type Col } from "../../ui/DataTable";
import { Async, Loading } from "../../ui/async";
import { useActors } from "../../ui/actors";
import { navigate, useHash } from "../../lib/router";
import { Picker } from "../record/Picker";
import { useExportRecord } from "../record/Lifecycle";
import { briefDiff, critStatus, useRecordData, type RecordData } from "../record/data";
import type { TWo } from "../traveler/model";
import { NotFound, splitParam, statusOf, when } from "./kit";

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "criteria", label: "Criteria" },
  { id: "brief", label: "Brief versions" },
  { id: "checks", label: "Checks" },
  { id: "audit", label: "Audit" },
] as const;
type PackTab = (typeof TABS)[number]["id"];
const NA = "not available";
const VERB: Record<string, string> = { approve: "approved", reject: "rejected", changes: "changes requested", decline: "declined" };
const CRIT_TONE: Record<string, string> = { met: "ok", failed: "bad", pending: "warn", untested: "idle" };

/** The checks the gates recorded, one row per named check (its latest run) with the gate that ran it. */
const checksOf = (rec: RecordData) => {
  const by = new Map<string, { gate: string; name: string; ok: boolean }>();
  for (const g of rec.gates) for (const c of g.basis.checks ?? []) by.set(c.name, { gate: g.gate, name: c.name, ok: c.ok }); // the latest run of each check
  return [...by.values()];
};

function Summary({ wo, rec, cat }: { wo: TWo; rec: RecordData; cat: Catalog }) {
  const actor = useActors();
  const crit = rec.criteria ?? [];
  const met = crit.filter((c) => critStatus(c).id === "met").length;
  const checks = checksOf(rec);
  const passed = checks.filter((c) => c.ok).length;
  const d = rec.code.diff;
  const sens = rec.code.files.filter((f) => f.protected).length;
  const specV = rec.briefVersions.at(-1);
  const t = rec.code.tests;
  const trail = rec.gates.filter((g) => g.decision || g.status === "waiting").filter((g) => g.decision?.detail?.mode !== "auto");
  const gname = (id: string) => cat.gates.find((x) => x.id === id);
  return (
    <>
      <Stats items={[
        { l: "Criteria met", v: crit.length ? `${met}/${crit.length}` : NA, ...(crit.length ? { tone: met === crit.length ? "ok" as const : "warn" as const } : {}) },
        { l: "Checks passed", v: checks.length ? `${passed}/${checks.length}` : NA, ...(checks.length ? { tone: passed === checks.length ? "ok" as const : "warn" as const } : {}) },
        { l: "Review findings", v: NA },
        { l: "Diff", v: d.files ? `+${d.plus} −${d.minus}` : NA },
      ]} />
      <div className="grid g2">
        <Card title="Verdict">
          <p>{`${wo.title} is ${wo.state === "done" ? "released" : "in flight"}. The evidence below is what each gate approver saw. Agents produced it; people decided.`}</p>
          <dl className="kv">
            <dt>Spec</dt><dd>{specV ? `v${specV.v}, ${when(specV.at)}` : NA}</dd>
            <dt>Plan</dt><dd>{NA}</dd>
            <dt>Tests</dt><dd>{t.passed + t.failed + t.added ? `${t.passed} passed, ${t.failed} failed, ${t.added} added` : NA}</dd>
            <dt>Sensitive paths</dt><dd>{rec.code.files.length ? (sens ? `${sens} touched` : "none touched") : NA}</dd>
          </dl>
        </Card>
        <Card title="Evidence trail">
          {trail.length ? (
            <div className="tl">
              {trail.map((g) => (
                <div key={g.id} className={g.status === "waiting" ? "warn" : g.decision?.decision === "reject" ? "bad" : "ok"}>
                  <div>{g.status === "waiting" ? `${gname(g.gate)?.name ?? g.gate} is waiting for a decision` : `${gname(g.gate)?.name ?? g.gate}: ${VERB[g.decision?.decision ?? ""] ?? g.decision?.decision ?? g.status}${g.decision?.decided_by ? ` by ${actor(g.decision.decided_by).name}` : ""}`}</div>
                  <div className="when">{gname(g.gate)?.label ?? g.gate}</div>
                </div>
              ))}
            </div>
          ) : <p className="muted small">No gate decisions recorded yet.</p>}
        </Card>
      </div>
    </>
  );
}

function BriefVersions({ rec }: { rec: RecordData }) {
  const vs = rec.briefVersions;
  const a = vs.at(-2);
  const b = vs.at(-1);
  if (!b) return <div className="card"><Empty icon="page" title="No brief versions" text="The brief has not been written yet." /></div>;
  const diff = briefDiff(a?.brief, b.brief);
  const block = (title: string, lines: Array<{ t: string; text: string }>, empty: string) => (
    <Card title={title}>
      {lines.length ? <pre className="code diff" style={{ padding: 8 }}>{lines.map((l, i) => <div key={i} className={l.t === "+" ? "add" : l.t === "-" ? "del" : ""}>{`${l.t} ${l.text}`}</div>)}</pre> : <p className="muted small">{empty}</p>}
    </Card>
  );
  return (
    <div className="grid g2">
      {block(a ? `Brief v${a.v} (before)` : "Before", diff.filter((l) => l.t === "-").map((l) => ({ t: "-", text: `${l.field}: ${l.text}` })), a ? "Nothing was removed." : "There is no earlier version.")}
      {block(`Brief v${b.v} (latest)`, diff.filter((l) => l.t === "+").map((l) => ({ t: "+", text: `${l.field}: ${l.text}` })), "Nothing was added.")}
    </div>
  );
}

function AuditTrail({ wo }: { wo: TWo }) {
  const actor = useActors();
  const q = useAudit({ project: wo.project, q: wo.id, limit: 100 });
  type Row = { id: number; at: number; actor: string; action: string };
  const cols: Col<Row>[] = [
    { key: "at", label: "When", render: (r) => <span className="mono dim">{when(r.at)}</span> },
    { key: "actor", label: "Who", render: (r) => <Who id={r.actor} /> },
    { key: "action", label: "Action", render: (r) => <span className="mono">{`${r.action} ${wo.id}`}</span> },
  ];
  void actor;
  return (
    <Card title={`Audit trail for ${wo.id}`} flush id="dz-audit">
      <Async query={q} what={`the audit trail of ${wo.id}`} id="dz-audit-read">
        {(data) => {
          const items = Array.isArray(data) ? data : data.items;
          const rows = items.filter((e) => e.target.includes(wo.id) || e.entity?.id === wo.id).slice(0, 40).map((e) => ({ id: e.id, at: e.at, actor: e.actor, action: e.action }));
          return <DataTable id="dz-audit-table" caption={`Audit trail of ${wo.id}`} columns={cols} rows={rows} rowKey={(r) => String(r.id)} empty={{ title: "No audit entries", text: "Nothing has been recorded against this work order." }} />;
        }}
      </Async>
    </Card>
  );
}

export default function PackView() {
  const hash = useHash();
  const { id, sub } = splitParam(hash.param);
  const tab: PackTab = TABS.find((t) => t.id === sub)?.id ?? "summary";
  const exportRecord = useExportRecord();
  const d = useRecordData(id || null);
  if (!id) return <Picker />;
  if (d.loading) return <div className="page"><Loading id="pack-loading" label="the dossier" /></div>;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const s = statusOf(d.error);
    return s === 403 || s === 404 || (!d.error && !d.wo) ? <NotFound id={id} /> : <Picker note={`Could not load the dossier of ${id}.`} />;
  }
  const { wo, rec } = d;
  const checks = checksOf(rec);
  return (
    <Page
      id="dossier-pack"
      eyebrow={`Work order · ${wo.id}`}
      title="Dossier"
      sub={`The evidence pack for ${wo.title}`}
      acts={
        <>
          <Btn label="Back to record" id="pack-back" onClick={() => navigate("record", wo.id, wo.project)} />
          <Btn label="Export PDF" icon="dl" id="pack-export" onClick={() => void exportRecord(wo.id)} />
        </>
      }
    >
      <Tabs idPrefix="pack-tab" items={TABS.map((t) => ({ id: t.id, label: t.label }))} active={tab} onChange={(t) => navigate("dossier", t === "summary" ? wo.id : `${wo.id}/${t}`, wo.project)} />
      <div role="tabpanel" aria-labelledby={`pack-tab-${tab}`}>
        {tab === "summary" ? <Summary wo={wo} rec={rec} cat={d.cat} />
        : tab === "criteria" ? (
          <Card title="Acceptance criteria against evidence" flush>
            {(rec.criteria ?? []).length ? (
              <div className="list">
                {rec.criteria.map((c) => {
                  const s = critStatus(c);
                  return (
                    <div className="li" key={c.id}>
                      <span className="mono dim">{c.id}</span>
                      <div className="main1">
                        <span className="t1" style={{ whiteSpace: "normal" }}>{c.text}</span>
                        <span className="t2">{c.tests.length ? `test: ${c.tests.map((t) => t.name).join(", ")}` : "not run yet"}</span>
                      </div>
                      <span className={`chip ${CRIT_TONE[s.id] ?? "idle"}`}>{s.id === "met" ? "Pass" : s.label}</span>
                    </div>
                  );
                })}
              </div>
            ) : <Empty icon="page" title="No acceptance criteria" text="The brief has none yet." />}
          </Card>
        )
        : tab === "brief" ? <BriefVersions rec={rec} />
        : tab === "checks" ? (
          <Card title="Checks" flush>
            {checks.length ? (
              <div className="list">
                {checks.map((c, i) => (
                  <div className="li" key={`${c.gate}-${c.name}-${i}`}>
                    <span className={`lamp ${c.ok ? "ok" : "warn"}`} />
                    <div className="main1"><span className="t1">{c.name}</span><span className="t2 mono">{`last run at ${c.gate}`}</span></div>
                    <span className={`chip ${c.ok ? "ok" : "warn"}`}>{c.ok ? "Passed" : "Failed"}</span>
                  </div>
                ))}
              </div>
            ) : <Empty icon="page" title="No checks recorded" text="The server records the checks a gate ran; none has run on this work order yet." />}
          </Card>
        )
        : <AuditTrail wo={wo} />}
      </div>
    </Page>
  );
}
