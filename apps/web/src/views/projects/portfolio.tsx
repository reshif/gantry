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
import { Btn, Field, Meter, Segmented, Select } from "../../ui/primitives";
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

const effText = (m: Row["m"]) => (m.effN < MIN_EFF || m.eff === null ? "insufficient data" : fmt.pct(m.eff));
const covText = (m: Row["m"]) => (m.cov.total < MIN_COV ? "insufficient data" : fmt.pct(m.cov.share));

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

/** The project card (legacy projectCard in home.js). */
export function ProjectCard({ cat, r }: { cat: Catalog; r: Row }) {
  const { p, m } = r;
  const hl = m.health;
  const onb = m.onboarding;
  return (
    <article className={`hm-proj hk-card-${hl.id}`} aria-label={p.name}>
      <div className="hm-proj-head">
        <div className="hm-proj-name">
          <span className="mono hm-key">{p.key}</span>
          <h3>{p.name}</h3>
        </div>
        <HealthChip p={p} />
      </div>
      <MiniBelt cat={cat} project={p} counts={m.byPosition} onStation={() => goProject(p.id, "floor")} />
      {hl.detail ? <p className="small hm-proj-detail">{hl.detail}</p> : null}
      <dl className="hm-proj-facts">
        <div>
          <dt>WIP</dt>
          <dd>
            {String(m.wip)}
            <span className="muted">{m.bays ? ` +${m.bays} in bays` : ""}</span>
          </dd>
        </div>
        <div>
          <dt>Slots</dt>
          <dd>{`${m.slotsUsed} of ${p.flow.slots}`}</dd>
        </div>
        <div className={m.gates ? "is-wait" : ""}>
          <dt>Approvals</dt>
          <dd>
            {String(m.gates)}
            {m.gates ? <span className="muted">{` · oldest ${fmt.dur(m.oldest)}`}</span> : null}
          </dd>
        </div>
        <div className={onb ? "is-onb" : ""}>
          <dt>Onboarding</dt>
          <dd>{onb ? `${onb} repo${onb > 1 ? "s" : ""}` : "all ready"}</dd>
        </div>
      </dl>
      <p className="hm-proj-ins small">
        <span data-tip={`Agent working time over lead time, ${m.effN} shipped in 7 days`} tabIndex={0}>
          <span className="kv-k">Flow eff. </span>
          <span className="mono">{effText(m)}</span>
        </span>
        <span data-tip={`${m.cov.auto} of ${m.cov.total} gate decisions passed under trust in 7 days`} tabIndex={0}>
          <span className="kv-k">Trust </span>
          <span className="mono">{covText(m)}</span>
        </span>
        <span>
          <span className="kv-k">Spend </span>
          <span className={`mono${r.spend >= 1 ? " neg" : ""}`}>{p.budget.monthly ? fmt.pct(r.spend) : "no budget"}</span>
        </span>
      </p>
      {p.status === "archived" ? (
        <ProjectActions p={p} ctx="hm-card" />
      ) : (
        <div className="hm-proj-actions">
          <Btn small icon="belt" id={`hm-floor-${p.id}`} aria={`Open the floor for ${p.name}`} label="Floor" onClick={() => goProject(p.id, "floor")} />
          <Btn small kind="ghost" id={`hm-cfg-${p.id}`} aria={`Configure ${p.name}`} label="Config" onClick={() => goProject(p.id, "project-config")} />
          {onb ? <Btn small kind="ghost" id={`hm-onb-${p.id}`} aria={`Onboarding for ${p.name}`} label="Onboarding" onClick={() => goProject(p.id, "onboarding")} /> : null}
        </div>
      )}
    </article>
  );
}

function rowCols(ctx: string, cat: Catalog, withRoles: boolean, myRoles: (id: string) => string[]): Col<Row>[] {
  const cols: Col<Row>[] = [
    {
      key: "name", label: "Project",
      render: ({ p }) => (
        <div className="pf-name">
          <span className="mono hm-key">{p.key}</span>
          <button type="button" className="linkish pf-name-btn" id={`${ctx}-open-${p.id}`} onClick={() => goProject(p.id, p.status === "archived" ? "project-config" : "floor")}>
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
        <span className={`mono${m.effN < MIN_EFF ? " muted small" : ""}`} data-tip={`Agent working time over lead time for ${m.effN} work order${m.effN === 1 ? "" : "s"} shipped in 7 days`} tabIndex={0}>
          {effText(m)}
          <span className="muted small">{` n=${m.effN}`}</span>
        </span>
      ),
    },
    {
      key: "gates", label: "Gates waiting", align: "end",
      render: ({ m }) => (
        <span className={`mono${m.late ? " neg" : m.gates ? " warn-text" : ""}`}>
          {String(m.gates)}
          {m.gates ? <span className="muted small">{` · ${fmt.dur(m.oldest)}${m.late ? ` · ${m.late} late` : ""}`}</span> : null}
        </span>
      ),
    },
    {
      key: "trust", label: "Trust cover", align: "end",
      render: ({ m }) => (
        <span className={`mono${m.cov.total < MIN_COV ? " muted small" : ""}`} data-tip={`${m.cov.auto} of ${m.cov.total} gate decisions in 7 days passed under trust`} tabIndex={0}>
          {covText(m)}
          <span className="muted small">{` ${m.cov.auto}/${m.cov.total}`}</span>
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
        return r.length ? <span className="small">{r.join(", ")}</span> : <span className="muted small">none</span>;
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

  const builtInReason = curView?.builtIn ? "Built-in views can't be renamed or deleted. Save a copy first." : null;
  const pickReason = builtInReason || (!curView ? "Pick a saved view first." : null);
  const summary = `${shown.length} of ${projects.length} projects${archivedN && !st.archived ? ` · ${archivedN} archived hidden` : ""}${st.group !== "none" ? ` · ${groups.length} groups` : ""} · sorted by ${sorter.label.toLowerCase()}${st.dir > 0 ? "" : ", descending"}.`;
  const cols = rowCols(ctx, cat, !!roles, myRoles);

  return (
    <div className={`pf pf-${st.layout}`} id={ctx}>
      <div className="pf-toolbar">
        <div className="pf-views">
          <div className="field pf-layout">
            <span className="field-label">Layout</span>
            <Segmented name={`${ctx}-layout`} items={[{ id: "cards", label: "Cards" }, { id: "rows", label: "Rows" }]} value={st.layout} onChange={(v) => setFocus({ layout: v as PfState["layout"] }, `${ctx}-layout-${v}`)} label="Portfolio layout" />
          </div>
          <Field label="View" htmlFor={`${ctx}-view`}>
            <Select
              id={`${ctx}-view`}
              aria-label="Saved view"
              options={[...views.map((v) => ({ value: v.id, label: v.name + (v.builtIn ? "" : " (saved)") })), ...(curView ? [] : [{ value: "", label: "Custom" }])]}
              value={curView ? st.view : ""}
              onChange={(id) => {
                const v = views.find((x) => x.id === id);
                if (!v) return;
                applyView(v);
                setTimeout(() => document.getElementById(`${ctx}-view`)?.focus(), 40);
              }}
            />
          </Field>
          {modified ? <span className="chip chip-warn pf-mod">changed</span> : null}
          <Btn small icon="plus" id={`${ctx}-vsave`} label="Save as view" onClick={() => viewDialog("new")} />
          {curView && !curView.builtIn && modified ? (
            <Btn small id={`${ctx}-vupd`} label={`Update ${curView.name}`} onClick={async () => {
              const s: Record<string, unknown> = {};
              for (const k of VIEW_KEYS) s[k] = st[k];
              const r = await ops.updateSavedView(curView.id, { s }, { ifMatch: curView.version });
              ui.toast(r.ok ? `View ${curView.name} updated.` : r.msg, r.ok ? "ok" : "error");
            }} />
          ) : null}
          <Btn small kind="ghost" id={`${ctx}-vren`} label="Rename" disabledReason={pickReason} onClick={() => viewDialog("rename")} />
          <Btn small kind="ghost" icon="x" id={`${ctx}-vdel`} label="Delete" disabledReason={pickReason} onClick={async () => {
            if (!curView) return;
            const r = await ops.deleteSavedView(curView.id, { ifMatch: curView.version });
            if (!r.ok) return void ui.toast(r.msg, "error");
            set({ ...(PF_BUILTIN[0]!.s as Partial<PfState>), view: "v-all" });
            ui.toast(`View ${curView.name} deleted.`, "ok");
          }} />
        </div>
        <div className="pf-filters">
          <Field label="Search" htmlFor={qid}>
            <input id={qid} className="input" type="search" placeholder="Name, key or description" value={st.q || ""} aria-label="Search projects" onChange={(e) => set({ q: e.target.value })} />
          </Field>
          <Field label="Group by" htmlFor={`${ctx}-group`}>
            <Select id={`${ctx}-group`} options={GROUPS.map((g) => ({ value: g.id, label: g.label }))} value={st.group} onChange={(v) => setFocus({ group: v }, `${ctx}-group`)} />
          </Field>
          <div className="field pf-sort">
            <label className="field-label" htmlFor={`${ctx}-sort`}>Sort</label>
            <div className="pf-sort-row">
              <Select id={`${ctx}-sort`} options={SORTS.map((s) => ({ value: s.id, label: s.label }))} value={st.sort} onChange={(v) => setFocus({ sort: v }, `${ctx}-sort`)} />
              <Btn small kind="ghost" icon={st.dir > 0 ? "up" : "down"} id={`${ctx}-dir`} label={st.dir > 0 ? "Ascending" : "Descending"} aria={`Sort direction: ${st.dir > 0 ? "ascending" : "descending"}. Select to flip.`} onClick={() => setFocus({ dir: (st.dir > 0 ? -1 : 1) as 1 | -1 }, `${ctx}-dir`)} />
            </div>
          </div>
          <Field label="Health" htmlFor={`${ctx}-health`}>
            <Select id={`${ctx}-health`} options={[{ value: "all", label: "Any health" }, ...Object.keys(HEALTH_LABEL).filter((k) => k !== "archived" || st.archived).map((k) => ({ value: k, label: HEALTH_LABEL[k]! }))]} value={st.health} onChange={(v) => setFocus({ health: v }, `${ctx}-health`)} />
          </Field>
          <Field label="Team" htmlFor={`${ctx}-team`}>
            <Select id={`${ctx}-team`} options={[{ value: "all", label: "Any team" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} value={st.team} onChange={(v) => setFocus({ team: v }, `${ctx}-team`)} />
          </Field>
          <Field label="Template" htmlFor={`${ctx}-tpl`}>
            <Select id={`${ctx}-tpl`} options={[{ value: "all", label: "Any template" }, ...tpls.map((t) => ({ value: t.id, label: t.name }))]} value={st.tpl} onChange={(v) => setFocus({ tpl: v }, `${ctx}-tpl`)} />
          </Field>
          {archivedN ? (
            <div className="field pf-arch">
              <span className="field-label">Archived</span>
              <label className="check" htmlFor={`${ctx}-arch`}>
                <input type="checkbox" id={`${ctx}-arch`} checked={!!st.archived} onChange={(e) => setFocus({ archived: e.target.checked }, `${ctx}-arch`)} />
                {`Show ${archivedN} archived`}
              </label>
            </div>
          ) : null}
        </div>
      </div>
      <p className="small muted pf-sum" aria-live="polite">{summary}</p>
      {!shown.length ? (
        <EmptyState
          id={`${ctx}-empty`} icon="filter" title={projects.length ? "No projects match" : "No projects yet"}
          text={projects.length ? "Clear the search or the filters, or show archived projects." : "Create one from a template."}
          action={projects.length ? <Btn small id={`${ctx}-clear`} label="Clear filters" onClick={() => set({ q: "", health: "all", team: "all", tpl: "all" })} /> : null}
        />
      ) : (
        <div className={`pf-groups${st.layout === "rows" ? " pf-rows" : ""}`}>
          {groups.map((g) => {
            const inner =
              st.layout === "rows" ? (
                <DataTable id={`${ctx}-t-${g.key}`} caption={`${g.label || "Projects"} portfolio`} columns={cols} rows={g.items} rowKey={(r) => r.p.id} empty={{ title: "No projects", text: "" }} />
              ) : (
                <div className="hm-proj-grid">{g.items.map((r) => <ProjectCard key={r.p.id} cat={cat} r={r} />)}</div>
              );
            if (!g.label) return <div key={g.key} style={{ display: "contents" }}>{inner}</div>;
            const gates = g.items.reduce((a, r) => a + r.m.gates, 0);
            const wip = g.items.reduce((a, r) => a + r.m.wip, 0);
            return (
              <section key={g.key} className="pf-group" aria-label={g.label}>
                <h3 className="pf-group-h">
                  <span>{g.label}</span>
                  <span className="mono small muted">{`${g.items.length} project${g.items.length > 1 ? "s" : ""} · ${wip} WIP · ${gates} gate${gates === 1 ? "" : "s"} waiting`}</span>
                </h3>
                {inner}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type { Row as PortfolioRow };
