/**
 * Audit ledger (#audit): the append-only record of human, agent, API and trigger actions, denied attempts included.
 * Laid out as the Blueprint draws it: four tiles over the whole ledger, one flush panel with the filter bar (search, Category, Outcome,
 * Actor in the URL), the sortable table, 15 rows a page, and the entry drawer opened from the action button. "Verify chain" stays (KEEP.md).
 * Entries are read from the server a page at a time; "Load older entries" asks for the next page.
 */
import { FACTORY_READ } from "../lib/routes";
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { useHash } from "../lib/router";
import { useAuditVerify, useMe, useProjects } from "../api/queries";
import { useCan } from "../api/can";
import { Btn, Chip, Empty, Panel, Stat, StatRow, ViewHead } from "../ui/primitives";
import { Async, failureOf } from "../ui/async";
import { DataTable, type Col } from "../ui/DataTable";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { navigate } from "../lib/router";
import { AuditDrawer, useActorName } from "./audit/Detail";
import { NO_FILTERS, useAuditFeed, useAuditStats, type AuditRow } from "./audit/data";
import { ListBar, dayMon } from "./govern/listkit";
import { useQueryParam } from "./floor/urlState";
import "../styles/views/audit.css";

const useDebounced = <T,>(v: T, ms: number): T => {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return x;
};

const csvCell = (c: unknown): string => `"${String(c).replace(/"/g, '""')}"`;

export default function AuditView() {
  const ui = useUI();
  const me = useMe();
  const perm = useCan("audit.view");
  const projectsQ = useProjects();
  const projects = (projectsQ.data ? projectsQ.data : []) as Array<{ id: string; name: string }>;
  const name = useActorName();
  // "#audit/console" opens the ledger on what this person did through the Console (linked from the Console's side panel).
  const asConsole = useHash().param === "console";
  const myId = me?.person.id;
  const [qp, setQ] = useQueryParam("q");
  const [cp, setC] = useQueryParam("cat");
  const [op, setO] = useQueryParam("outcome");
  const [ap, setA] = useQueryParam("actor");
  const [pp, setP] = useQueryParam("project"); // `#/audit?project=payments`: Project config links here
  const [via, setVia] = useState("all");
  useEffect(() => {
    if (asConsole && myId) {
      setVia("console");
      setA(myId);
    }
  }, [asConsole, myId, setA]);
  const q = qp ?? "";
  const cat = cp ?? "all";
  const outcome = op ?? "all";
  const actor = ap ?? "all";
  const project = pp ?? "all";
  const typed = useDebounced(q, 250);
  const filters = useMemo(() => ({ ...NO_FILTERS, q: typed, cat, outcome, actor, via, project }), [typed, cat, outcome, actor, via, project]);
  const feed = useAuditFeed(filters);
  const stats = useAuditStats();
  const verify = useAuditVerify(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; msg: string; at: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const rows: AuditRow[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const first = feed.data?.pages[0];
  const sum = first?.summary;
  const total = first?.total ?? 0;
  const all = sum?.entries ?? total;
  const projectName = (id: string | null): string => (id ? projects.find((p) => p.id === id)?.name ?? id : "factory");
  const canVerify = !!me?.person.roles.some((g) => g.scope === "factory" && (FACTORY_READ as readonly string[]).includes(g.role));
  const dirtyExtra = via !== "all" || project !== "all";
  const clear = () => {
    setQ(null);
    setC(null);
    setO(null);
    setA(null);
    setP(null);
    setVia("all");
  };
  const hidden = !feed.data && feed.isError && failureOf(feed.error).hidden;

  const open = (seq: number) => ui.drawer.open(`audit:${seq}`, (close) => <AuditDrawer seq={seq} projectName={projectName} close={close} />);

  const scoped = !perm.pending && !perm.allowed;
  const runVerify = async () => {
    setChecking(true);
    const r = await verify.refetch();
    setChecking(false);
    const d = r.data as { ok: boolean; msg?: string } | undefined;
    const res = d ? { ok: d.ok, msg: d.msg ?? (d.ok ? "Chain intact." : "The chain is broken."), at: Date.now() } : { ok: false, msg: "The chain could not be verified.", at: Date.now() };
    setChecked(res);
    ui.toast(res.msg, res.ok ? "ok" : "error");
  };

  /** Every entry the viewer may see, oldest page last: reads all pages, then writes the prototype's eight columns. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      let list = rows;
      let more = feed.hasNextPage;
      for (let i = 0; more && i < 200; i++) {
        const r = await feed.fetchNextPage();
        list = r.data?.pages.flatMap((p) => p.items) ?? list;
        more = !!r.hasNextPage;
      }
      const out = [["id", "at", "actor", "action", "target", "category", "outcome", "via"]].concat(list.map((a) => [String(a.id), new Date(a.at).toISOString(), name(a.actor, a.actorName), a.action, a.target, a.category, a.outcome, a.via]));
      const csv = out.map((r) => r.map(csvCell).join(",")).join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "gantry-audit.csv";
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      ui.toast(`Exported ${out.length} rows`, "ok");
    } finally {
      setExporting(false);
    }
  };

  const known = stats && stats !== "error" ? stats : undefined;
  const CAT_ORDER = ["access", "config", "agents", "integrations", "auth", "onboarding", "approvals", "kill", "flow", "api"];
  const cats = [...(known?.cats ?? Object.keys(sum?.categories ?? {}))].sort((a, b) => { const ia = CAT_ORDER.indexOf(String(a)), ib = CAT_ORDER.indexOf(String(b)); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  if (cat !== "all" && !cats.includes(cat)) cats.push(cat);
  const actorOpts = [{ value: "all", label: "All" }, ...(known?.actors ?? sum?.facets.actors ?? []).map((a) => ({ value: a.id, label: a.name }))];
  if (actor !== "all" && !actorOpts.some((o) => o.value === actor)) actorOpts.push({ value: actor, label: name(actor) });
  const outcomes = ["ok", "denied", "error", ...(sum?.facets.outcomes ?? [])].filter((o, i, a) => a.indexOf(o) === i);

  const cols: Col<AuditRow>[] = [
    { key: "at", label: "When", sort: (e) => e.at, render: (e) => <span className="mono small" style={{ whiteSpace: "nowrap" }}>{dayMon(e.at)}</span> },
    { key: "actor", label: "Actor", sort: (e) => name(e.actor, e.actorName).toLowerCase(), render: (e) => name(e.actor, e.actorName) },
    { key: "action", label: "Action", sort: (e) => e.action, render: (e) => <Btn label={e.action} small kind="ghost" cls="mono" id={`aud-row-${e.seq}`} aria={`Open entry ${e.seq}`} onClick={() => open(e.seq)} /> },
    { key: "target", label: "Target", render: (e) => <span className="aud-target">{e.target}</span> },
    { key: "cat", label: "Category", render: (e) => <Chip text={e.category} cls="plain" /> },
    { key: "o", label: "Outcome", render: (e) => <Chip text={e.outcome} cls={e.outcome === "ok" ? "ok" : "bad"} /> },
  ];

  const statVal = (f: (s: { entries: number; access: number; agents: number; failures: number }) => number): string => (stats === undefined ? "…" : stats === "error" ? "–" : String(f(stats)));
  const failures = stats && stats !== "error" ? stats.failures : 0;

  if (hidden) {
    return (
      <div className="view view-audit">
        <ViewHead title="Audit ledger" kicker="All lines" />
        <Empty id="aud-no-access" icon="lock" title="No access to this sheet" text={<>Your role cannot open Audit ledger.<br />{failureOf(feed.error).msg}<br />Ask a factory admin for the audit.view permission.</>} action={<Btn label="Back to Home" id="aud-home" onClick={() => navigate("home")} />} />
      </div>
    );
  }

  return (
    <div className="view view-audit">
      <ViewHead
        title="Audit ledger"
        kicker="All lines"
        sub="An append-only record of every decision and change. Entries cannot be edited."
        actions={<>
          <Btn label="Export CSV" icon="dl" id="aud-export" guard={exporting ? { allowed: false, reason: "Exporting now." } : null} onClick={() => void exportCsv()} />
        </>}
      />
      <StatRow id="aud-stats">
        <Stat label="Entries" value={statVal((s) => s.entries)} sub="in ledger" tone="info" />
        <Stat label="Access changes" value={statVal((s) => s.access)} />
        <Stat label="Agent changes" value={statVal((s) => s.agents)} />
        <Stat label="Failures" value={statVal((s) => s.failures)} tone={failures ? "block" : "done"} />
      </StatRow>
      {checked ? (
        <div className={`callout aud-verified ${checked.ok ? "callout-ok" : "callout-block"}`} role="status" id="aud-verified">
          <Icon name={checked.ok ? "shield" : "alert"} />
          <div><strong>{checked.ok ? "No break found" : "The chain is broken"}</strong><span>{` ${checked.msg} Checked ${fmt.stamp(checked.at)}.`}</span></div>
          <Btn label="Dismiss" small id="aud-verified-dismiss" onClick={() => setChecked(null)} />
        </div>
      ) : null}
      {scoped ? (
        <div className="lock-note" role="note">
          <Icon name="lock" />
          <span>You see entries for your own projects and your own actions. The full ledger needs the audit.view right (Factory Admin or Auditor).</span>
        </div>
      ) : null}
      <Panel flush id="aud-panel">
        <ListBar
          id="aud" label="Ledger filters" q={q} onQ={(v) => setQ(v || null)} shown={total} total={all} noun="entry" onClear={clear}
          extra={project !== "all" ? <><span className="chip plain" id="aud-via-note" title="Opened from Project config">{projectName(project)}</span><Btn small kind="ghost" id="aud-project-clear" label="All projects" onClick={() => setP(null)} /></> : dirtyExtra ? <span className="chip plain" id="aud-via-note" title="Opened from the Console">{`via ${via}`}</span> : undefined}
          filters={[
            { id: "category", label: "Category", value: cat, onChange: (v) => setC(v === "all" ? null : v), options: [{ value: "all", label: "All" }, ...cats] },
            { id: "outcome", label: "Outcome", value: outcome, onChange: (v) => setO(v === "all" ? null : v), options: [{ value: "all", label: "All" }, ...outcomes] },
            { id: "actor", label: "Actor", value: actor, onChange: (v) => setA(v === "all" ? null : v), options: actorOpts },
          ]}
        />
        <Async
          query={feed}
          what="the audit ledger"
          id="aud"
          isEmpty={(d) => !d.pages.some((pg) => pg.items.length)}
          empty={<Empty id="aud-empty" icon="ledger" title={q || cat !== "all" || outcome !== "all" || actor !== "all" || dirtyExtra ? "Nothing matches these filters" : "Nothing here yet"} text={q || cat !== "all" || outcome !== "all" || actor !== "all" || dirtyExtra ? "Loosen the search or clear the filters." : "Every change, denial and sign-in is written here as it happens."} action={q || cat !== "all" || outcome !== "all" || actor !== "all" || dirtyExtra ? <Btn label="Clear filters" id="aud-empty-clear" onClick={clear} /> : undefined} />}
        >{() => (
          <>
            <DataTable sortHint noSortSelect id="aud-table" caption="Audit ledger" columns={cols} rows={rows} rowKey={(e) => String(e.seq)} sort={{ key: "at", dir: -1 }} pageSize={15} pager />
            {feed.hasNextPage ? <div className="tfoot"><span className="muted small">{`${rows.length} of ${total} loaded`}</span><Btn label="Load older entries" small id="aud-more" onClick={() => void feed.fetchNextPage()} /></div> : null}
          </>
        )}</Async>
      </Panel>
      {canVerify ? <div className="footnote" id="aud-verify-row"><Btn small label={checking ? "Verifying..." : "Verify chain"} icon="shield" id="aud-verify" guard={checking ? { allowed: false, reason: "Checking the chain now." } : null} onClick={() => void runVerify()} /></div> : null}
      <p className="footnote">Each entry carries a SHA-256 digest of its fields and the digest before it, written by the database. Any edit or removal breaks every digest after it, and Verify chain finds the first break.</p>
    </div>
  );
}
