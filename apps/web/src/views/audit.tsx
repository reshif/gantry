/** Audit (#audit): the append-only ledger of human, agent, API and trigger actions, denied attempts included. Ported from legacy/js/views/audit.js. */
import { FACTORY_READ } from "../lib/routes";
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { useHash } from "../lib/router";
import { useAuditVerify, useMe, useProjects } from "../api/queries";
import { useCan } from "../api/can";
import { DataTable } from "../ui/DataTable";
import { Btn, Empty, FilterBar, SearchBox, Select, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { ActorCell, AuditDrawer, CatChip } from "./audit/Detail";
import { CAT_NAME, NO_FILTERS, TOPICS, useAuditFeed, type AuditRow, type Filters } from "./audit/data";

const BASE_CATS = ["auth", "access", "flow", "onboarding", "approvals", "config", "integrations", "api", "agents", "kill"];

const useDebounced = <T,>(v: T, ms: number): T => {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return x;
};

export default function AuditView() {
  const ui = useUI();
  const me = useMe();
  const perm = useCan("audit.view");
  const projects = (useProjects().data ?? []) as Array<{ id: string; name: string }>;
  // "#audit/console" opens the ledger on what this person did through the Console (linked from the Console's side panel).
  const asConsole = useHash().param === "console";
  const myId = me?.person.id;
  const [f, setF] = useState<Filters>(NO_FILTERS);
  useEffect(() => {
    if (asConsole && myId) setF((x) => ({ ...x, via: "console", actor: myId }));
  }, [asConsole, myId]);
  const [typed, setTyped] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; msg: string; at: number } | null>(null);
  const q = useDebounced(typed, 250);
  const filters = useMemo(() => ({ ...f, q }), [f, q]);
  const feed = useAuditFeed(filters);
  const verify = useAuditVerify(false);
  const rows: AuditRow[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const first = feed.data?.pages[0];
  const sum = first?.summary;
  const total = first?.total ?? 0;
  const projectName = (id: string | null): string => (id ? projects.find((p) => p.id === id)?.name ?? id : "factory");
  const canVerify = !!me?.person.roles.some((g) => g.scope === "factory" && (FACTORY_READ as readonly string[]).includes(g.role));
  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const dirty = typed || f.project !== "all" || f.cat !== "all" || f.topic !== "all" || f.actor !== "all" || f.outcome !== "all" || f.via !== "all" || f.changes;
  const clear = () => {
    setTyped("");
    setF(NO_FILTERS);
  };

  const open = (seq: number) => ui.drawer.open(`audit:${seq}`, (close) => <AuditDrawer seq={seq} projectName={projectName} close={close} />);

  const cats = [...BASE_CATS, ...Object.keys(sum?.categories ?? {}).filter((c) => !BASE_CATS.includes(c))];
  const actorOpts = [
    { value: "all", label: "Anyone" }, { value: "human", label: "People" }, { value: "agent", label: "Agents" }, { value: "system", label: "API keys, triggers, system" },
    ...(sum?.facets.actors ?? []).map((a) => ({ value: a.id, label: a.name })),
  ];
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
  // The ledger views: the same filters as below, one click away.
  const view = f.outcome === "denied" ? "denied" : f.cat === "config" ? "config" : f.outcome === "all" && f.cat === "all" ? "all" : "";
  const pickView = (id: string) => set(id === "denied" ? { outcome: "denied", cat: "all" } : id === "config" ? { cat: "config", outcome: "all" } : { cat: "all", outcome: "all" });

  return (
    <div className="view view-audit">
      <ViewHead
        kicker="Govern"
        title="Audit ledger"
        sub="An append-only record of every decision and change. Entries are chained; the chain is verified hourly."
        actions={canVerify ? <Btn label={checking ? "Verifying..." : "Verify chain"} kind="primary" icon="shield" id="aud-verify" guard={checking ? { allowed: false, reason: "Checking the chain now." } : null} onClick={() => void runVerify()} /> : undefined}
      />
      <StatRow id="aud-stats">
        <Stat label="Entries" value={qState(feed, () => String(sum?.entries ?? 0))} />
        <Stat label="Denied" value={qState(feed, () => String(sum?.denied ?? 0))} />
        <Stat label="Config changes" value={qState(feed, () => String(sum?.changes ?? 0))} />
        {feed.data === undefined || sum?.head ? <Stat label="Head digest" value={qState(feed, () => (sum?.head ?? "").slice(0, 8))} /> : null}
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
      <Tabs idPrefix="aud-view" active={view} onChange={pickView} items={[{ id: "all", label: "All entries", count: sum?.entries ?? 0 }, { id: "denied", label: "Denied", count: sum?.denied ?? 0 }, { id: "config", label: "Config changes", count: sum?.changes ?? 0 }]} />
      <FilterBar
        label="Ledger filters"
        count={<><span className="mono">{String(total)}</span>{" matching"}</>}
        actions={<>
          <label className="check aud-chk" htmlFor="aud-changes">
            <input type="checkbox" id="aud-changes" checked={f.changes} onChange={(e) => set({ changes: e.target.checked })} />
            Only with before/after
          </label>
          {dirty ? <Btn label="Clear filters" small kind="ghost" id="aud-clear" onClick={clear} /> : null}
        </>}
      >
        <SearchBox id="aud-q" label="Search" placeholder="Search action, target, person" value={typed} onChange={setTyped} />
        <Select id="aud-cat" aria-label="Category" value={f.cat} onChange={(v) => set({ cat: v })} options={[{ value: "all", label: "Category: all" }, ...cats.filter((c) => BASE_CATS.includes(c) || (sum?.categories[c] ?? 0) > 0).map((c) => ({ value: c, label: `${CAT_NAME[c] ?? c} (${sum?.categories[c] ?? 0})` }))]} />
        <Select id="aud-outcome" aria-label="Outcome" value={f.outcome} onChange={(v) => set({ outcome: v })} options={[{ value: "all", label: "Outcome: all" }, ...(sum?.facets.outcomes ?? []).map((k) => ({ value: k, label: k }))]} />
        <Select id="aud-actor" aria-label="Actor" value={f.actor} onChange={(v) => set({ actor: v })} options={actorOpts.map((o) => (o.value === "all" ? { ...o, label: "Actor: all" } : o))} />
        <Select id="aud-project" aria-label="Project" value={f.project} onChange={(v) => set({ project: v })} options={[{ value: "all", label: "Project: all" }, { value: "factory", label: "Factory-wide only" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
        <Select id="aud-via" aria-label="Channel" value={f.via} onChange={(v) => set({ via: v })} options={[{ value: "all", label: "Channel: all" }, ...(sum?.facets.channels ?? []).map((k) => ({ value: k, label: k }))]} />
        <Select id="aud-topic" aria-label="Topic" value={f.topic} onChange={(v) => set({ topic: v })} options={[{ value: "all", label: "Topic: all" }, ...TOPICS.map((t) => ({ value: t.id, label: `${t.name} (${sum?.topics[t.id] ?? 0})` }))]} />
      </FilterBar>
      <Async
        query={feed}
        what="the audit ledger"
        id="aud"
        isEmpty={(d) => !d.pages.some((pg) => pg.items.length)}
        empty={<Empty id="aud-empty" icon="ledger" title={dirty ? "No entries match" : "The ledger is empty"} text={dirty ? "Clear the filters to see the full ledger." : "Every change, denial and sign-in is written here as it happens."} />}
      >{() => (
        <DataTable
          id="aud-ledger"
          caption="Audit ledger"
          rows={rows}
          rowKey={(e) => String(e.seq)}
          rowId={(e) => `aud-row-${e.seq}`}
          onRow={(e) => open(e.seq)}
          rowLabel={(e) => `Open audit entry ${e.seq}: ${e.action}`}
          hasMore={!!feed.hasNextPage}
          onLoadMore={() => void feed.fetchNextPage()}
          loadingMore={feed.isFetchingNextPage}
          total={total}
          columns={[
            { key: "seq", label: "#", render: (e) => <span className="mono dim">{String(e.seq)}</span> },
            { key: "at", label: "When", render: (e) => <span className="mono nowrap">{fmt.iso(e.at)}</span> },
            { key: "actor", label: "Actor", render: (e) => <ActorCell id={e.actor} name={e.actorName} /> },
            { key: "action", label: "Action", render: (e) => <span className="mono">{e.action}</span> },
            { key: "target", label: "Target", hideSmall: true, render: (e) => <span className="ell aud-target">{e.target}</span> },
            { key: "project", label: "Project", hideSmall: true, render: (e) => (e.project ? <span className="tag">{projectName(e.project)}</span> : <span className="dim">factory</span>) },
            { key: "cat", label: "Category", hideSmall: true, render: (e) => <CatChip c={e.category} /> },
            { key: "outcome", label: "Outcome", render: (e) => <><span className={`chip ${e.outcome === "ok" ? "ok" : e.outcome === "denied" ? "bad" : "warn"}`}>{e.outcome}</span>{e.before != null || e.after != null ? <span className="aud-has-diff" title="Has before/after"><Icon name="swap" />diff</span> : null}</> },
            { key: "digest", label: "Digest", hideSmall: true, render: (e) => <span className="mono dim digest" data-tip={`prev ${e.prev.slice(0, 8)}`}>{e.digest.slice(0, 8)}</span> },
          ]}
        />
      )}</Async>
      <p className="footnote">Each entry carries a SHA-256 digest of its fields and the digest before it, written by the database. Any edit or removal breaks every digest after it, and Verify chain finds the first break.</p>
    </div>
  );
}
