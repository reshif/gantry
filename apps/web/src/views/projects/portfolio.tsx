/**
 * The portfolio (legacy G.portfolio in home.js, shared by Home and Projects): layout, group, sort, filters and saved views.
 * Layout and filters are per signed-in person and remembered in prefs.portfolio (view state, not audited). Saved views are
 * stored on the server (`/saved-views`), so they follow the person across browsers.
 */
import { useState } from "react";
import { fmt, type Catalog } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useMe, useSavedViews, useTemplates } from "../../api/queries";
import { useCan } from "../../api/can";
import { useActors } from "../../ui/actors";
import { Btn, Chip, Field, IconBtn, FilterBar, Meter, SearchBox, Segmented, Select, Tabs } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { getPrefs, updatePrefs } from "../../lib/prefs";
import { DataTable, EmptyState, HealthChip, MiniBelt, goProject, metricsOf, useCatalog, useTeams, type Col, type PView } from "./kit";
import type { SavedView } from "../../api/types";

const HEALTH_ORDER: Record<string, number> = { killed: 0, halted: 1, attention: 2, new: 3, onboarding: 4, ok: 5, archived: 6 };
export const HEALTH_LABEL: Record<string, string> = { killed: "Killed", halted: "Halted", attention: "Needs attention", new: "Setting up", onboarding: "Onboarding repos", ok: "Healthy", archived: "Archived" };
const MIN_EFF = 3;
const MIN_COV = 10;

interface PfState {
  layout: "cards" | "rows";
  group: string;
  sort: string;
  dir: 1 | -1;
  q: string;
  health: string;
  team: string;
  tpl: string;
  archived: boolean;
  view: string;
}
const PF_DEFAULT: PfState = { layout: "cards", group: "none", sort: "health", dir: 1, q: "", health: "all", team: "all", tpl: "all", archived: false, view: "v-all" };
type ViewKeys = Pick<PfState, "group" | "sort" | "dir" | "health" | "team" | "tpl" | "archived">;
const VIEW_KEYS = ["group", "sort", "dir", "health", "team", "tpl", "archived"] as const;
interface ViewDef {
  id: string;
  name: string;
  builtIn?: boolean;
  version?: number;
  s: Partial<ViewKeys>;
}
const PF_BUILTIN: ViewDef[] = [
  { id: "v-all", name: "All active", builtIn: true, s: { group: "none", sort: "health", dir: 1, health: "all", team: "all", tpl: "all", archived: false } },
  { id: "v-att", name: "Needs attention", builtIn: true, s: { group: "none", sort: "gates", dir: -1, health: "attention", team: "all", tpl: "all", archived: false } },
  { id: "v-team", name: "By team", builtIn: true, s: { group: "team", sort: "name", dir: 1, health: "all", team: "all", tpl: "all", archived: false } },
  { id: "v-spend", name: "Spend first", builtIn: true, s: { group: "none", sort: "spend", dir: -1, health: "all", team: "all", tpl: "all", archived: false } },
];

type Mem = Record<string, { ctx?: Record<string, PfState> }>;
const memOf = (): Mem => {
  const p = getPrefs().portfolio;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Mem) : {};
};

/** Remembered state of one portfolio context for this person. */
function usePfState(who: string, ctx: string, layout: PfState["layout"]): [PfState, (patch: Partial<PfState>) => void] {
  const [, force] = useState(0);
  const mine = memOf()[who]?.ctx?.[ctx];
  const st: PfState = { ...PF_DEFAULT, layout, ...(mine ?? {}) };
  const set = (patch: Partial<PfState>) => {
    const all = memOf();
    const entry = all[who] ?? {};
    const next = { ...st, ...patch };
    updatePrefs({ portfolio: { ...all, [who]: { ...entry, ctx: { ...(entry.ctx ?? {}), [ctx]: next } } } });
    force((n) => n + 1);
  };
  return [st, set];
}

interface Row {
  p: PView;
  m: ReturnType<typeof metricsOf>;
  spend: number;
  team: string;
}

const effLow = (m: Row["m"]) => m.effN < MIN_EFF || m.eff === null;
const covLow = (m: Row["m"]) => m.cov.total < MIN_COV;
/** A dash, not a percentage, while the sample is too small to mean anything; the tooltip says why. */
const effText = (m: Row["m"]) => (effLow(m) ? "—" : fmt.pct(m.eff!));
const covText = (m: Row["m"]) => (covLow(m) ? "—" : fmt.pct(m.cov.share));
const effTip = (m: Row["m"]) => `Agent working time over lead time, ${m.effN} work order${m.effN === 1 ? "" : "s"} shipped in 7 days${effLow(m) ? `. Too few to tell yet: needs ${MIN_EFF}.` : "."}`;
const covTip = (m: Row["m"]) => `${m.cov.auto} of ${m.cov.total} gate decisions in 7 days passed under trust${covLow(m) ? `. Too few to tell yet: needs ${MIN_COV}.` : "."}`;

const SORTS: Array<{ id: string; label: string; v: (r: Row) => number | string }> = [
  { id: "health", label: "Health", v: (r) => (HEALTH_ORDER[r.m.health.id] ?? 9) * 1000 - r.m.gates },
  { id: "name", label: "Name", v: (r) => r.p.name.toLowerCase() },
  { id: "wip", label: "Work in flight", v: (r) => r.m.wip + r.m.bays },
  { id: "gates", label: "Gates waiting", v: (r) => r.m.gates * 1e9 + r.m.oldest / 1000 },
  { id: "eff", label: "Flow efficiency", v: (r) => (r.m.effN < MIN_EFF || r.m.eff === null ? -1 : r.m.eff) },
  { id: "trust", label: "Trust coverage", v: (r) => (r.m.cov.total < MIN_COV ? -1 : r.m.cov.share) },
  { id: "spend", label: "Spend vs budget", v: (r) => r.spend },
];
const GROUPS = [{ id: "none", label: "No grouping" }, { id: "health", label: "Health" }, { id: "team", label: "Owning team" }, { id: "template", label: "Template" }];

function ProjectActions({ p, ctx }: { p: PView; ctx: string }) {
  const ui = useUI();
  const d = useCan("project.archive", { project: p.id });
  if (p.status === "archived") {
    return (
      <div className="pf-acts">
        <Btn small icon="undo" id={`${ctx}-unarch-${p.id}`} aria={`Unarchive ${p.name}`} guard={d} label="Unarchive" onClick={async () => { const r = await ops.unarchiveProject(p.id, { ifMatch: p.version }); ui.toast(r.msg, r.ok ? "ok" : "error"); }} />
        <Btn small kind="ghost" id={`${ctx}-cfg-${p.id}`} aria={`Configure ${p.name}`} label="Config" onClick={() => goProject(p.id, "project-config")} />
      </div>
    );
  }
  return (
    <div className="pf-acts">
      <Btn small icon="belt" id={`${ctx}-floor-${p.id}`} aria={`Open the floor for ${p.name}`} label="Floor" onClick={() => goProject(p.id, "floor")} />
      <Btn small kind="ghost" id={`${ctx}-cfg-${p.id}`} aria={`Configure ${p.name}`} label="Config" onClick={() => goProject(p.id, "project-config")} />
    </div>
  );
}

/** The project card, as the prototype draws it: key and name, what it builds, flow counts, budget meter, owner, actions. */
export function ProjectCard({ r }: { cat?: Catalog; r: Row }) {
  const { p, m } = r;
  const hl = m.health;
  const onb = m.onboarding;
  return (
    <article className={`card hm-proj hk-card-${hl.id}`} aria-label={p.name}>
      <div className="row">
        <span className="mono small hm-key" style={{ border: "1px solid var(--accent)", color: "var(--accent)", padding: "0 6px" }}>{p.key}</span>
        <h3 className="grow">{p.name}</h3>
      </div>
      <div className="row">
        {p.regulated ? <Chip text="regulated" cls="warn" /> : null}
        {hl.id !== "ok" ? <HealthChip p={p} /> : null}
      </div>
      {p.desc ? <div className="small muted">{p.desc}</div> : null}
      {hl.detail ? <p className="small hm-proj-detail">{hl.detail}</p> : null}
      <div className="row small">
        <span className="num">{String(m.wip)}</span> in flight{m.bays ? ` +${m.bays} in bays` : ""} · <span className="num">{String(m.gates)}</span> at gates{m.gates ? ` · oldest ${fmt.dur(m.oldest)}` : ""}{onb ? ` · ${onb} repo${onb > 1 ? "s" : ""} onboarding` : ""}
      </div>
      {p.budget.monthly ? <Meter value={p.budget.mtd} max={p.budget.monthly} label={`${p.name} spend`} warnAt={p.budget.alertAt} /> : null}
      <div className="small muted">
        <span className={r.spend >= 1 ? "neg" : ""}>{p.budget.monthly ? `${fmt.money0(p.budget.mtd)} of ${fmt.money0(p.budget.monthly)}` : "no budget"}</span>
        {p.owner ? <> · owner <OwnerName id={p.owner} /></> : null}
      </div>
      {p.status === "archived" ? (
        <ProjectActions p={p} ctx="hm-card" />
      ) : (
        <div className="row">
          <Btn small kind="primary" id={`hm-floor-${p.id}`} aria={`Open the floor for ${p.name}`} label="Open Floor" onClick={() => goProject(p.id, "floor")} />
          <Btn small id={`hm-cfg-${p.id}`} aria={`Configure ${p.name}`} label="Config" onClick={() => goProject(p.id, "project-config")} />
          {onb ? <Btn small kind="ghost" id={`hm-onb-${p.id}`} aria={`Onboarding for ${p.name}`} label="Onboarding" onClick={() => goProject(p.id, "onboarding")} /> : null}
        </div>
      )}
    </article>
  );
}

function OwnerName({ id }: { id: string }) {
  const actor = useActors()(id);
  return <>{actor.name}</>;
}

function rowCols(ctx: string, cat: Catalog, withRoles: boolean, myRoles: (id: string) => string[]): Col<Row>[] {
  const cols: Col<Row>[] = [
    {
      key: "name", label: "Project",
      render: ({ p }) => (
        <div className="pf-name">
          <span className="mono hm-key">{p.key}</span>
          <button type="button" className="pf-name-btn" id={`${ctx}-open-${p.id}`} onClick={() => goProject(p.id, p.status === "archived" ? "project-config" : "floor")}>
            {p.name}
          </button>
          {p.regulated ? <span className="tag pf-reg">regulated</span> : null}
        </div>
      ),
    },
    { key: "health", label: "Health", render: ({ p, m }) => (<div><HealthChip p={p} />{m.health.detail ? <div className="small muted pf-detail">{m.health.detail}</div> : null}</div>) },
    { key: "belt", label: "Flow", render: ({ p, m }) => (<div className="pf-belt"><MiniBelt cat={cat} project={p} counts={m.byPosition} onStation={p.status === "archived" ? undefined : () => goProject(p.id, "floor")} /></div>) },
    { key: "wip", label: "WIP", align: "end", render: ({ m }) => (<span className="mono">{String(m.wip)}{m.bays ? <span className="muted small">{` +${m.bays} bays`}</span> : null}</span>) },
    {
      key: "eff", label: "Flow eff.", align: "end",
      render: ({ m }) => (
        <span className={`mono${effLow(m) ? " muted" : ""}`} data-tip={effTip(m)} tabIndex={0}>
          {effText(m)}
        </span>
      ),
    },
    {
      key: "gates", label: "Gates waiting", align: "end",
      render: ({ m }) => (
        <span className={`mono${m.late ? " neg" : m.gates ? " warn-text" : ""}`}>
          {String(m.gates)}
          {m.gates ? <span className="muted small">{`oldest ${fmt.dur(m.oldest)}${m.late ? `, ${m.late} late` : ""}`}</span> : null}
        </span>
      ),
    },
    {
      key: "trust", label: "Trust cover", align: "end",
      render: ({ m }) => (
        <span className={`mono${covLow(m) ? " muted" : ""}`} data-tip={covTip(m)} tabIndex={0}>
          {covText(m)}
        </span>
      ),
    },
    {
      key: "spend", label: "Spend", align: "end",
      render: ({ p }) =>
        p.budget.monthly ? (
          <div className="pf-spend">
            <span className={`mono${p.budget.mtd >= p.budget.monthly ? " neg" : ""}`}>
              {fmt.money0(p.budget.mtd)}
              <span className="muted small">{` / ${fmt.money0(p.budget.monthly)}`}</span>
            </span>
            <Meter value={p.budget.mtd} max={p.budget.monthly} label={`${p.name} spend`} warnAt={p.budget.alertAt} />
          </div>
        ) : (
          <span className="muted small">no budget</span>
        ),
    },
  ];
  if (withRoles) {
    cols.push({
      key: "roles", label: "Your roles", hideSmall: true,
      render: ({ p }) => {
        const r = myRoles(p.id);
        return r.length ? <span className="pf-roles">{r.slice(0, 2).map((x) => <Chip key={x} text={x} />)}{r.length > 2 ? <span className="muted small">{`+${r.length - 2}`}</span> : null}</span> : <span className="muted small">none</span>;
      },
    });
  }
  cols.push({ key: "acts", label: "", render: ({ p }) => <ProjectActions p={p} ctx={ctx} /> });
  return cols;
}

interface PortfolioProps {
  ctx: string;
  projects: PView[];
  /** "cards" or "rows" on first use. */
  defaultLayout: "cards" | "rows";
  roles?: boolean;
}

export function Portfolio({ ctx, projects, defaultLayout, roles }: PortfolioProps) {
  const ui = useUI();
  const me = useMe();
  const who = me?.person.id ?? "anon";
  const cat = useCatalog();
  const teams = useTeams();
  const tpls = useTemplates().data ?? [];
  const saved = useSavedViews().data ?? [];
  const [st, set] = usePfState(who, ctx, defaultLayout);
  const qid = `${ctx}-q`;
  if (!cat || !me) return null;

  const mine: ViewDef[] = saved
    .filter((v) => (v as { screen?: string }).screen === "portfolio" || (v as { screen?: string }).screen === undefined)
    .map((v: SavedView) => ({ id: String(v.id), name: v.name, version: (v as { version?: number }).version, s: ((v as { s?: Partial<ViewKeys> }).s ?? {}) as Partial<ViewKeys> }));
  const views = [...PF_BUILTIN, ...mine];
  const curView = views.find((x) => x.id === st.view);
  const modified = !!curView && VIEW_KEYS.some((k) => curView.s[k] !== st[k]);
  const applyView = (v: ViewDef) => set({ ...(v.s as Partial<PfState>), view: v.id });
  const myRoles = (pid: string): string[] => me.person.roles.filter((g) => g.scope === pid || g.scope === "factory").map((g) => cat.roles.find((r) => r.id === g.role)?.name ?? g.role);

  const archivedN = projects.filter((p) => p.status === "archived").length;
  const q = (st.q || "").trim().toLowerCase();
  const rows: Row[] = projects
    .filter((p) => st.archived || p.status !== "archived")
    .map((p) => ({ p, m: metricsOf(p), spend: p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0, team: p.teams[0] || "none" }));
  const shown = rows.filter((r) => {
    if (st.health !== "all" && r.m.health.id !== st.health) return false;
    if (st.team !== "all" && !r.p.teams.includes(st.team)) return false;
    if (st.tpl !== "all" && r.p.template !== st.tpl) return false;
    return !q || `${r.p.name} ${r.p.key} ${r.p.desc || ""} ${r.p.id}`.toLowerCase().includes(q);
  });
  const sorter = SORTS.find((s) => s.id === st.sort) ?? SORTS[0]!;
  shown.sort((a, b) => {
    const x = sorter.v(a);
    const y = sorter.v(b);
    return (x > y ? 1 : x < y ? -1 : a.p.name < b.p.name ? -1 : 1) * (x === y ? 1 : st.dir);
  });

  let groups: Array<{ key: string; label: string | null; items: Row[] }>;
  if (st.group === "none") groups = [{ key: "all", label: null, items: shown }];
  else {
    const keyOf = (r: Row) => (st.group === "health" ? r.m.health.id : st.group === "team" ? r.team : r.p.template);
    const labelOf = (k: string) => (st.group === "health" ? (HEALTH_LABEL[k] ?? k) : st.group === "team" ? (teams.find((t) => t.id === k)?.name ?? k) : (tpls.find((t) => t.id === k)?.name ?? k));
    const map: Record<string, Row[]> = {};
    const order: string[] = [];
    for (const r of shown) {
      const k = keyOf(r);
      if (!map[k]) {
        map[k] = [];
        order.push(k);
      }
      map[k]!.push(r);
    }
    if (st.group === "health") order.sort((a, b) => (HEALTH_ORDER[a] ?? 9) - (HEALTH_ORDER[b] ?? 9));
    else order.sort((a, b) => (labelOf(a) < labelOf(b) ? -1 : 1));
    groups = order.map((k) => ({ key: k, label: labelOf(k), items: map[k]! }));
  }

  const setFocus = (patch: Partial<PfState>, id: string) => {
    set(patch);
    setTimeout(() => document.getElementById(id)?.focus(), 40);
  };

  const viewDialog = (mode: "new" | "rename") => {
    let value = mode === "rename" && curView ? curView.name : "";
    let errEl: HTMLDivElement | null = null;
    ui.dialog({
      title: mode === "rename" ? "Rename view" : "Save this view",
      kicker: "Portfolio · saved views",
      ...(mode === "rename" ? {} : { sub: "Saves the grouping, sort and filters. Only you see your saved views." }),
      body: (
        <div className="form-grid">
          <Field label="View name" htmlFor="pf-view-name">
            <input id="pf-view-name" className="input" defaultValue={value} placeholder="Payments and partners, by spend" autoComplete="off" onChange={(e) => (value = e.target.value)} />
          </Field>
          <div className="form-err" role="alert" ref={(el) => { errEl = el; }} />
        </div>
      ),
      actions: [
        { label: "Cancel" },
        {
          label: mode === "rename" ? "Rename view" : "Save view", kind: "primary", submit: true, id: "pf-view-ok",
          onClick: async (close) => {
            const n = value.trim();
            const fail = (m: string) => { if (errEl) errEl.textContent = m; };
            if (n.length < 2) return fail("Name the view (2+ characters).");
            if (views.some((x) => x.name.toLowerCase() === n.toLowerCase() && !(mode === "rename" && x.id === st.view))) return fail(`You already have a view called ${n}.`);
            if (mode === "rename" && curView) {
              const r = await ops.updateSavedView(curView.id, { name: n }, { ifMatch: curView.version });
              if (!r.ok) return fail(r.msg);
              ui.toast(`View renamed to ${n}.`, "ok");
            } else {
              const s: Record<string, unknown> = {};
              for (const k of VIEW_KEYS) s[k] = st[k];
              const r = await ops.saveSavedView({ name: n, screen: "portfolio", s });
              if (!r.ok) return fail(r.msg);
              const id = (r as { view?: { id?: string } }).view?.id;
              if (id) set({ view: id });
              ui.toast(`View ${n} saved.`, "ok");
            }
            close();
          },
        },
      ],
    });
  };

    const summary = `${shown.length} of ${projects.length} projects${archivedN && !st.archived ? ` · ${archivedN} archived hidden` : ""}${st.group !== "none" ? ` · ${groups.length} groups` : ""} · sorted by ${sorter.label.toLowerCase()}${st.dir > 0 ? "" : ", descending"}.`;
  const cols = rowCols(ctx, cat, !!roles, myRoles);

  // The count on each view tab: how many projects that view would list, before search.
  const countFor = (v: ViewDef): number =>
    projects.filter((p) => {
      const m = metricsOf(p);
      const f = { ...st, ...(v.s as Partial<PfState>) };
      if (!f.archived && p.status === "archived") return false;
      if (f.health !== "all" && m.health.id !== f.health) return false;
      if (f.team !== "all" && !p.teams.includes(f.team)) return false;
      return f.tpl === "all" || p.template === f.tpl;
    }).length;

  const inner = (g: { key: string; label: string | null; items: Row[] }) =>
    st.layout === "rows" ? (
      <DataTable id={`${ctx}-t-${g.key}`} caption={`${g.label || "Projects"} portfolio`} columns={cols} rows={g.items} rowKey={(r) => r.p.id} empty={{ title: "No projects", text: "" }} />
    ) : (
      <div className="card-grid hm-proj-grid">{g.items.map((r) => <ProjectCard key={r.p.id} r={r} />)}</div>
    );
  const groupHead = (g: { label: string | null; items: Row[] }) => {
    const gates = g.items.reduce((a, r) => a + r.m.gates, 0);
    const wip = g.items.reduce((a, r) => a + r.m.wip, 0);
    return (
      <h3 className="pf-group-h">
        <span>{g.label}</span>
        <span className="small muted">{`${g.items.length} project${g.items.length > 1 ? "s" : ""} · ${wip} WIP · ${gates} gate${gates === 1 ? "" : "s"} waiting`}</span>
      </h3>
    );
  };

  return (
    <div className={`pf pf-${st.layout}`} id={ctx}>
      <p className="small muted pf-sum" aria-live="polite">{summary}</p>
      <div className={`panel pf-card${st.layout === "cards" ? " pf-cardsbar" : ""}`}>
        <Tabs
          idPrefix={`${ctx}-view`}
          items={[...views.map((v) => ({ id: v.id, label: v.name, count: countFor(v) })), ...(curView ? [] : [{ id: "", label: "Custom view" }])]}
          active={curView ? st.view : ""}
          onChange={(id) => {
            const v = views.find((x) => x.id === id);
            if (!v) return;
            applyView(v);
            setTimeout(() => document.getElementById(`${ctx}-view-${id}`)?.focus(), 40);
          }}
        />
        <FilterBar
          label="Filter projects"
          actions={
            <>
              {modified ? <span className="status tone-wait pf-mod">Changed</span> : null}
                {curView && !curView.builtIn && modified ? (
                  <Btn small id={`${ctx}-vupd`} label={`Update ${curView.name}`} onClick={async () => {
                    const s: Record<string, unknown> = {};
                    for (const k of VIEW_KEYS) s[k] = st[k];
                    const r = await ops.updateSavedView(curView.id, { s }, { ifMatch: curView.version });
                    ui.toast(r.ok ? `View ${curView.name} updated.` : r.msg, r.ok ? "ok" : "error");
                  }} />
                ) : null}
                <Btn small kind="ghost" icon="plus" id={`${ctx}-vsave`} label="Save as view" onClick={() => viewDialog("new")} />
                {curView && !curView.builtIn ? (
                  <>
                    <Btn small kind="ghost" id={`${ctx}-vren`} label="Rename" onClick={() => viewDialog("rename")} />
                    <Btn small kind="ghost" icon="x" id={`${ctx}-vdel`} label="Delete" onClick={async () => {
                      const r = await ops.deleteSavedView(curView.id, { ifMatch: curView.version });
                      if (!r.ok) return void ui.toast(r.msg, "error");
                      set({ ...(PF_BUILTIN[0]!.s as Partial<PfState>), view: "v-all" });
                      ui.toast(`View ${curView.name} deleted.`, "ok");
                    }} />
                  </>
                ) : null}
                <Segmented name={`${ctx}-layout`} items={[{ id: "cards", label: "Cards" }, { id: "rows", label: "Rows" }]} value={st.layout} onChange={(v) => setFocus({ layout: v as PfState["layout"] }, `${ctx}-layout-${v}`)} label="Portfolio layout" />
            </>
          }
        >
          <div className="filters">
            <SearchBox id={qid} value={st.q || ""} onChange={(v) => set({ q: v })} placeholder="Name, key or description" label="Search projects" />
            <Field label="Health" htmlFor={`${ctx}-health`}>
              <Select id={`${ctx}-health`} options={[{ value: "all", label: "Any" }, ...Object.keys(HEALTH_LABEL).filter((k) => k !== "archived" || st.archived).map((k) => ({ value: k, label: HEALTH_LABEL[k]! }))]} value={st.health} onChange={(v) => setFocus({ health: v }, `${ctx}-health`)} />
            </Field>
            <Field label="Team" htmlFor={`${ctx}-team`}>
              <Select id={`${ctx}-team`} options={[{ value: "all", label: "Any" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} value={st.team} onChange={(v) => setFocus({ team: v }, `${ctx}-team`)} />
            </Field>
            <Field label="Template" htmlFor={`${ctx}-tpl`}>
              <Select id={`${ctx}-tpl`} options={[{ value: "all", label: "Any" }, ...tpls.map((t) => ({ value: t.id, label: t.name }))]} value={st.tpl} onChange={(v) => setFocus({ tpl: v }, `${ctx}-tpl`)} />
            </Field>
            <Field label="Group" htmlFor={`${ctx}-group`}>
              <Select id={`${ctx}-group`} options={GROUPS.map((g) => ({ value: g.id, label: g.id === "none" ? "None" : g.label }))} value={st.group} onChange={(v) => setFocus({ group: v }, `${ctx}-group`)} />
            </Field>
            <Field label="Sort" htmlFor={`${ctx}-sort`}>
              <Select id={`${ctx}-sort`} options={SORTS.map((s) => ({ value: s.id, label: s.label }))} value={st.sort} onChange={(v) => setFocus({ sort: v }, `${ctx}-sort`)} />
              <IconBtn icon={st.dir > 0 ? "up" : "down"} id={`${ctx}-dir`} className="pf-dir" label={`Sort ${st.dir > 0 ? "ascending" : "descending"}. Select to flip.`} title={st.dir > 0 ? "Ascending" : "Descending"} onClick={() => setFocus({ dir: (st.dir > 0 ? -1 : 1) as 1 | -1 }, `${ctx}-dir`)} />
            </Field>
            {archivedN ? (
              <label className="check field-check" htmlFor={`${ctx}-arch`}>
                <input type="checkbox" id={`${ctx}-arch`} checked={!!st.archived} onChange={(e) => setFocus({ archived: e.target.checked }, `${ctx}-arch`)} />
                {`Show ${archivedN} archived`}
              </label>
            ) : null}
          </div>
        </FilterBar>
        {st.layout === "rows" && shown.length ? (
          <div className="pf-rows pf-card-body">
            {groups.map((g) => (
              <section key={g.key} className="pf-group" aria-label={g.label ?? "Projects"}>
                {g.label ? groupHead(g) : null}
                {inner(g)}
              </section>
            ))}
          </div>
        ) : null}
      </div>
      {!shown.length ? (
        <EmptyState
          id={`${ctx}-empty`} icon="filter" title={projects.length ? "No projects match" : "No projects yet"}
          text={projects.length ? "Clear the search or the filters, or show archived projects." : "Create one from a template."}
          action={projects.length ? <Btn small id={`${ctx}-clear`} label="Clear filters" onClick={() => set({ q: "", health: "all", team: "all", tpl: "all" })} /> : null}
        />
      ) : st.layout === "cards" ? (
        <div className="pf-groups">
          {groups.map((g) =>
            g.label ? (
              <section key={g.key} className="pf-group" aria-label={g.label}>
                {groupHead(g)}
                {inner(g)}
              </section>
            ) : (
              <div key={g.key} style={{ display: "contents" }}>{inner(g)}</div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export type { Row as PortfolioRow };
