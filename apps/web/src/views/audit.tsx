/** Audit (#audit): the append-only ledger of human, agent, API and trigger actions, denied attempts included. Ported from legacy/js/views/audit.js. */
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { useAuditVerify, useMe, useProjects } from "../api/queries";
import { useCan } from "../api/can";
import { Btn, Empty, Field, Select, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { ActorCell, AuditDrawer, CatChip } from "./audit/Detail";
import { CAT_ICON, CAT_NAME, NO_FILTERS, PAGE, TOPICS, useAuditFeed, type AuditRow, type Filters } from "./audit/data";

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
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed, 250);
  const filters = useMemo(() => ({ ...f, q }), [f, q]);
  const feed = useAuditFeed(filters);
  const verify = useAuditVerify(false);
  const rows: AuditRow[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const first = feed.data?.pages[0];
  const sum = first?.summary;
  const total = first?.total ?? 0;
  const projectName = (id: string | null): string => (id ? projects.find((p) => p.id === id)?.name ?? id : "factory");
  const canVerify = !!me?.person.roles.some((g) => g.scope === "factory" && (g.role === "auditor" || g.role === "factory_admin"));
  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const dirty = typed || f.project !== "all" || f.cat !== "all" || f.topic !== "all" || f.actor !== "all" || f.outcome !== "all" || f.via !== "all" || f.changes;
  const clear = () => {
    setTyped("");
    setF(NO_FILTERS);
  };

  const open = (seq: number) => ui.drawer.open(`audit:${seq}`, (close) => <AuditDrawer seq={seq} projectName={projectName} close={close} />);

  const cats = [...BASE_CATS, ...Object.keys(sum?.categories ?? {}).filter((c) => !BASE_CATS.includes(c))];
  const allCount = Object.values(sum?.categories ?? {}).reduce((a, b) => a + b, 0);
  const actorOpts = [
    { value: "all", label: "Anyone" }, { value: "human", label: "People" }, { value: "agent", label: "Agents" }, { value: "system", label: "API keys, triggers, system" },
    ...(sum?.facets.actors ?? []).map((a) => ({ value: a.id, label: a.name })),
  ];
  const scoped = !perm.pending && !perm.allowed;

  const runVerify = async () => {
    const r = await verify.refetch();
    const d = r.data as { ok: boolean; msg?: string } | undefined;
    if (d) ui.toast(d.msg ?? (d.ok ? "Chain intact." : "The chain is broken."), d.ok ? "ok" : "error");
    else ui.toast("The chain could not be verified.", "error");
  };

  return (
    <div className="view view-audit">
      <ViewHead
        title="Audit"
        sub="Append-only ledger of every human, agent, API key and trigger action, including denied attempts. Nothing here can be edited or deleted."
        meta={[["Entries", qState(feed, () => String(sum?.entries ?? 0))], ["Denied", qState(feed, () => String(sum?.denied ?? 0))], ["Config changes", qState(feed, () => String(sum?.changes ?? 0))], ...(feed.data === undefined || sum?.head ? [["Head digest", qState(feed, () => (sum?.head ?? "").slice(0, 8))] as [string, React.ReactNode]] : [])]}
        actions={canVerify ? <Btn label="Verify chain" kind="ghost" icon="shield" id="aud-verify" onClick={() => void runVerify()} /> : undefined}
      />
      {scoped ? (
        <div className="lock-note" role="note">
          <Icon name="lock" />
          <span>You see entries for your own projects and your own actions. The full ledger needs the audit.view right (Factory Admin or Auditor).</span>
        </div>
      ) : null}
      <div className="aud-cats" role="group" aria-label="Category">
        {[{ id: "all", name: "All", n: allCount }, ...cats.filter((c) => BASE_CATS.includes(c) || (sum?.categories[c] ?? 0) > 0).map((c) => ({ id: c, name: CAT_NAME[c] ?? c, n: sum?.categories[c] ?? 0 }))].map((x) => (
          <button key={x.id} type="button" id={`aud-cat-${x.id}`} className={`aud-catbtn aud-cat-${x.id}${f.cat === x.id ? " is-on" : ""}`} aria-pressed={f.cat === x.id} onClick={() => set({ cat: x.id })}>
            {x.id !== "all" ? <Icon name={CAT_ICON[x.id] ?? "dots"} /> : null}
            <span>{x.name}</span>
            <span className="mono aud-n">{String(x.n)}</span>
          </button>
        ))}
      </div>
      <div className="aud-topics" role="group" aria-label="Round-three topic">
        <span className="kicker">Topic</span>
        {[{ id: "all", name: "Any", icon: "" }, ...TOPICS].map((t) => (
          <button key={t.id} type="button" id={`aud-topic-${t.id}`} className={`aud-topic${f.topic === t.id ? " is-on" : ""}`} aria-pressed={f.topic === t.id} onClick={() => set({ topic: t.id })}>
            {t.icon ? <Icon name={t.icon} /> : null}
            <span>{t.name}</span>
            {t.id !== "all" ? <span className="mono aud-n">{String(sum?.topics[t.id] ?? 0)}</span> : null}
          </button>
        ))}
      </div>
      <div className="toolbar aud-filters">
        <div className="filters">
          <Field label="Search" htmlFor="aud-q">
            <input id="aud-q" className="input" type="search" placeholder="Actor, action, target, value" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <Field label="Project" htmlFor="aud-project">
            <Select id="aud-project" value={f.project} onChange={(v) => set({ project: v })} options={[{ value: "all", label: "All projects" }, { value: "factory", label: "Factory-wide only" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
          <Field label="Actor" htmlFor="aud-actor"><Select id="aud-actor" value={f.actor} onChange={(v) => set({ actor: v })} options={actorOpts} /></Field>
          <Field label="Outcome" htmlFor="aud-outcome"><Select id="aud-outcome" value={f.outcome} onChange={(v) => set({ outcome: v })} options={[{ value: "all", label: "Any outcome" }, ...(sum?.facets.outcomes ?? []).map((k) => ({ value: k, label: k }))]} /></Field>
          <Field label="Via" htmlFor="aud-via"><Select id="aud-via" value={f.via} onChange={(v) => set({ via: v })} options={[{ value: "all", label: "Any channel" }, ...(sum?.facets.channels ?? []).map((k) => ({ value: k, label: k }))]} /></Field>
          <label className="check aud-chk" htmlFor="aud-changes">
            <input type="checkbox" id="aud-changes" checked={f.changes} onChange={(e) => set({ changes: e.target.checked })} />
            Only entries with before/after
          </label>
        </div>
        <div className="aud-count">
          <span className="mono">{String(total)}</span>{" matching"}
          {dirty ? <Btn label="Clear filters" small kind="ghost" id="aud-clear" onClick={clear} /> : null}
        </div>
      </div>
      <Async
        query={feed}
        what="the audit ledger"
        id="aud"
        isEmpty={(d) => !d.pages.some((pg) => pg.items.length)}
        empty={<Empty id="aud-empty" icon="ledger" title={dirty ? "No entries match" : "The ledger is empty"} text={dirty ? "Clear the filters to see the full ledger." : "Every change, denial and sign-in is written here as it happens."} />}
      >{() => (
        <div className="table-scroll ledger" data-keep-scroll="aud-ledger">
          <table className="table table-compact aud-table">
            <thead>
              <tr>{["#", "When (IST)", "Actor", "Category", "Action", "Target", "Project", "Outcome", "Change", "Digest"].map((x) => <th key={x} scope="col">{x}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.seq} className={`row-link aud-row o-row-${e.outcome}`} onClick={() => open(e.seq)}>
                  <td className="mono muted"><button type="button" className="linkish mono" id={`aud-row-${e.seq}`} aria-label={`Open audit entry ${e.seq}: ${e.action}`}>{String(e.seq)}</button></td>
                  <td className="mono nowrap">{fmt.iso(e.at)}</td>
                  <td><ActorCell id={e.actor} name={e.actorName} /></td>
                  <td><CatChip c={e.category} /></td>
                  <td className="mono">{e.action}</td>
                  <td className="cell-title aud-target">{e.target}</td>
                  <td className="small">{e.project ? projectName(e.project) : <span className="muted">factory</span>}</td>
                  <td><span className={`outcome o-${e.outcome}`}>{e.outcome}</span></td>
                  <td>{e.before != null || e.after != null ? <span className="aud-has-diff" title="Has before/after"><Icon name="swap" />diff</span> : null}</td>
                  <td className="mono muted digest" data-tip={`prev ${e.prev.slice(0, 8)}`}>{e.digest.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}</Async>
      {feed.hasNextPage ? (
        <div className="more">
          <Btn label={`Show ${Math.min(PAGE, total - rows.length)} more`} id="aud-more" onClick={() => void feed.fetchNextPage()} />
        </div>
      ) : null}
      <p className="footnote">Each entry carries a SHA-256 digest of its fields and the digest before it, written by the database. Any edit or removal breaks every digest after it, and Verify chain finds the first break.</p>
    </div>
  );
}
