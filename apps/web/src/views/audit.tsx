/** Audit (#audit): the append-only ledger of human, agent, API and trigger actions, denied attempts included. In the Control Room prototype's layout (ported from legacy/js/views/audit.js). */
import { FACTORY_READ } from "../lib/routes";
import { useEffect, useState } from "react";
import { fmt } from "@gantry/domain";
import { useHash } from "../lib/router";
import { useQueryState } from "../lib/queryState";
import { useAuditVerify, useMe, useProjects } from "../api/queries";
import { useCan } from "../api/can";
import { DataTable } from "../ui/DataTable";
import { Btn, SearchBox, Select } from "../ui/primitives";
import { CrIcon, Page } from "../ui/cr";
import { Async } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { ActorCell, AuditDrawer } from "./audit/Detail";
import { useAuditFeed, type AuditRow, type Filters } from "./audit/data";

const BASE_CATS = ["auth", "access", "flow", "onboarding", "approvals", "config", "integrations", "api", "agents", "kill"];
const QS = ["q", "cat", "out", "actor", "proj", "via", "topic", "diff"] as const;

const useDebounced = <T,>(v: T, ms: number): T => {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return x;
};

/** "15 Jan 15:30" (24-hour, India time like the rest of the product). */
const whenText = (at: number): string => new Date(at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).replace(",", "");

const csvCell = (v: unknown): string => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export default function AuditView() {
  const ui = useUI();
  const me = useMe();
  const perm = useCan("audit.view");
  const projects = (useProjects().data ?? []) as Array<{ id: string; name: string; key?: string }>;
  // "#audit/console" opens the ledger on what this person did through the Console (linked from the Console's side panel).
  const asConsole = useHash().param === "console";
  const myId = me?.person.id;
  const qs = useQueryState(QS);
  const v = qs.values;
  useEffect(() => {
    if (asConsole && myId) qs.set({ via: "console", actor: myId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asConsole, myId]);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; msg: string; at: number } | null>(null);
  const [typed, setTyped] = useState(v.q);
  useEffect(() => setTyped(v.q), [v.q]);
  const q = useDebounced(typed, 250);
  useEffect(() => { if (q !== v.q) qs.set({ q: q || null }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const f: Filters = { q: v.q, project: v.proj || "all", cat: v.cat || "all", topic: v.topic || "all", actor: v.actor || "all", outcome: v.out || "all", via: v.via || "all", changes: v.diff === "1" };
  const feed = useAuditFeed(f);
  const verify = useAuditVerify(false);
  const rows: AuditRow[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const first = feed.data?.pages[0];
  const sum = first?.summary;
  const total = first?.total ?? 0;
  const projectName = (id: string | null): string => (id ? projects.find((p) => p.id === id)?.name ?? id : "factory");
  const projectKey = (id: string | null): string => (id ? projects.find((p) => p.id === id)?.key ?? id : "factory");
  const canVerify = !!me?.person.roles.some((g) => g.scope === "factory" && (FACTORY_READ as readonly string[]).includes(g.role));
  const dirty = !!(v.q || v.cat || v.out || v.actor || v.proj || v.via || v.topic || v.diff);
  const clear = () => { setTyped(""); qs.clear(); };

  const open = (seq: number) => ui.drawer.open(`audit:${seq}`, (close) => <AuditDrawer seq={seq} projectName={projectName} close={close} />);

  const cats = [...BASE_CATS, ...Object.keys(sum?.categories ?? {}).filter((c) => !BASE_CATS.includes(c))].filter((c) => BASE_CATS.includes(c) || (sum?.categories[c] ?? 0) > 0);
  const actorOpts = [
    { value: "human", label: "People" }, { value: "agent", label: "Agents" }, { value: "system", label: "API keys, triggers, system" },
    ...(sum?.facets.actors ?? []).map((a) => ({ value: a.id, label: a.name })),
  ];
  const scoped = !perm.pending && !perm.allowed;

  const runVerify = async (quiet = false) => {
    setChecking(true);
    const r = await verify.refetch();
    setChecking(false);
    const d = r.data as { ok: boolean; msg?: string } | undefined;
    const res = d ? { ok: d.ok, msg: d.msg ?? (d.ok ? "Chain intact." : "The chain is broken."), at: Date.now() } : { ok: false, msg: "The chain could not be verified.", at: Date.now() };
    setChecked(res);
    if (!quiet || !res.ok) ui.toast(res.msg, res.ok ? "ok" : "error");
  };
  // The prototype shows the verified banner on arrival: check once, quietly, when the person may.
  useEffect(() => { if (canVerify && !checked) void runVerify(true); }, [canVerify]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportCsv = async () => {
    try {
      // every entry the filters match, not only the pages loaded so far
      let all = rows;
      let more = !!feed.hasNextPage;
      while (more) {
        const r = await feed.fetchNextPage();
        all = r.data?.pages.flatMap((p) => p.items) ?? all;
        more = !!r.hasNextPage;
      }
      const csv = "id,at,actor,action,target,outcome\n" + all.map((e) => [e.seq, new Date(e.at).toISOString(), e.actor, e.action, e.target, e.outcome].map(csvCell).join(",")).join("\n");
      const l = document.createElement("a");
      l.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      l.download = "audit.csv";
      l.click();
      ui.toast(`Exported ${all.length} entries`, "ok");
    } catch {
      ui.toast("The export could not be created.", "error");
    }
  };
  return (
    <Page
      cls="view-audit"
      eyebrow="Govern"
      title="Audit ledger"
      sub="An append-only record of every decision and change. Entries are chained; the chain is verified hourly."
      acts={<>
        <Btn label={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><CrIcon name="dl" />Export CSV</span>} aria="Export CSV" id="aud-export" onClick={() => void exportCsv()} />
      </>}
    >
      <div className={`banner ${checked ? (checked.ok ? "ok" : "bad") : "info"}`} role="status" id="aud-verified">
        <Icon name={checked ? (checked.ok ? "check" : "alert") : "shield"} />
        <div className="grow">
          <b>{checked ? (checked.ok ? "Ledger verified" : "The chain is broken") : "Ledger not checked in this session"}</b>{" "}
          <span className="mono">{checked ? `${sum?.entries ?? total} entries, last check ${fmt.ago(checked.at, Date.now())}, ${checked.ok ? "no gaps" : checked.msg}` : `${sum?.entries ?? total} entries. Press Verify chain to check them now.`}</span>
        </div>
        {canVerify ? <Btn label={checking ? "Verifying..." : "Verify chain"} small kind="ghost" id="aud-verify" guard={checking ? { allowed: false, reason: "Checking the chain now." } : null} onClick={() => void runVerify(false)} /> : null}
      </div>
      {scoped ? (
        <div className="lock-note" role="note">
          <Icon name="lock" />
          <span>You see entries for your own projects and your own actions. The full ledger needs the audit.view right (Factory Admin or Auditor).</span>
        </div>
      ) : null}
      <div className="filterbar fb" role="search" aria-label="Ledger filters" style={{ "--fn": 3 } as React.CSSProperties}>
        <SearchBox id="aud-q" label="Search" placeholder="Search action, target, person" value={typed} onChange={setTyped} />
        <Select id="aud-cat" aria-label="Category" value={f.cat} onChange={(x) => qs.set({ cat: x === "all" ? null : x })} options={[{ value: "all", label: "Category: all" }, ...cats.map((c) => ({ value: c, label: c }))]} />
        <Select id="aud-outcome" aria-label="Outcome" value={f.outcome} onChange={(x) => qs.set({ out: x === "all" ? null : x })} options={[{ value: "all", label: "Outcome: all" }, ...(sum?.facets.outcomes ?? []).map((k) => ({ value: k, label: k }))]} />
        <Select id="aud-actor" aria-label="Actor" value={f.actor} onChange={(x) => qs.set({ actor: x === "all" ? null : x })} options={[{ value: "all", label: "Actor: all" }, ...actorOpts]} />
        <div className="meta">
          <span role="status">{`${rows.length} of ${total}`}</span>
          {dirty ? <Btn label="Clear" small kind="ghost" id="aud-clear" onClick={clear} /> : null}
        </div>
      </div>
      <Async query={feed} what="the audit ledger" id="aud">{() => (
        <DataTable
          id="aud-ledger"
          caption="Audit ledger"
          rows={rows}
          rowKey={(e) => String(e.seq)}
          rowId={(e) => `aud-row-${e.seq}`}
          onRow={(e) => open(e.seq)}
          rowLabel={(e) => `Open audit entry ${e.seq}: ${e.action}`}
          pageSize={15}
          pager
          sort={{ key: "at", dir: -1 }}
          hasMore={!!feed.hasNextPage}
          onLoadMore={() => void feed.fetchNextPage()}
          loadingMore={feed.isFetchingNextPage}
          total={total}
          empty={{ title: "Nothing matches", text: dirty ? "Try clearing the filters." : "Every change, denial and sign-in is written here as it happens.", action: dirty ? <Btn label="Clear filters" small id="aud-empty-clear" onClick={clear} /> : undefined }}
          columns={[
            { key: "seq", label: "#", sort: (e) => e.seq, render: (e) => <span className="mono dim">{String(e.seq)}</span> },
            { key: "at", label: "When", sort: (e) => e.at, render: (e) => <span className="mono nowrap">{whenText(e.at)}</span> },
            { key: "actor", label: "Actor", sort: (e) => e.actorName, width: "190px", render: (e) => <ActorCell id={e.actor} name={e.actorName} /> },
            { key: "action", label: "Action", sort: (e) => e.action, render: (e) => <a className="rl mono" href="#audit" onClick={(ev) => { ev.preventDefault(); open(e.seq); }}>{e.action}</a> },
            { key: "target", label: "Target", sort: (e) => e.target, hideSmall: true, render: (e) => <span className="ell aud-target">{e.target}</span> },
            { key: "project", label: "Project", sort: (e) => projectKey(e.project), hideSmall: true, render: (e) => (e.project ? <span className="tag">{projectKey(e.project)}</span> : <span className="dim">factory</span>) },
            { key: "cat", label: "Category", sort: (e) => e.category, hideSmall: true, render: (e) => <span>{e.category}</span> },
            { key: "outcome", label: "Outcome", sort: (e) => e.outcome, render: (e) => <><span className={`chip ${e.outcome === "ok" ? "ok" : e.outcome === "denied" ? "bad" : "warn"}`}>{e.outcome}</span>{e.before != null || e.after != null ? <span className="aud-has-diff" title="Has before/after"><Icon name="swap" />diff</span> : null}</> },
          ]}
        />
      )}</Async>
    </Page>
  );
}
