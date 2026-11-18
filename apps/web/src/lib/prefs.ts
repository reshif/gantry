/**
 * Local preferences (theme, nav collapsed/rail, current project, ...) in localStorage under the
 * legacy key, wrapped in try/catch like legacy persist(): storage can be missing or blocked, and
 * the app must work without it. View-only state (open conversation, record, replay) lives in
 * memory beside them, as in legacy G.store prefs, and is not persisted.
 */
import { useSyncExternalStore } from "react";

export const PREFS_KEY = "gantry.prefs";

export type Theme = "system" | "light" | "dark";

export interface Prefs {
  theme: Theme;
  project: string | null;
  /** Factory pages show every project (the prototype's "All projects" scope) until a project is picked in the switcher. */
  scopeAll: boolean;
  /** Projects the person starred in the switcher, and the last few entered (most recent first). */
  pinnedProjects: string[];
  recentProjects: string[];
  floorView: string;
  boardSwim: string;
  navCollapsed: Record<string, boolean>;
  navRail: boolean;
  palettePinned: string[];
  paletteRecent: string[];
  portfolio?: unknown;
  /* in-memory view state, not persisted */
  openConversation: string | null;
  record: string | null;
  replay: { at?: number; [k: string]: unknown } | null;
  agent: string | null;
  boardFilters: { cls: string; repo: string; assignee: string; prio: string };
  collapsedBays: boolean;
  activeClass: string | null;
}

const PERSISTED = ["theme", "project", "scopeAll", "pinnedProjects", "recentProjects", "floorView", "boardSwim", "navCollapsed", "navRail", "palettePinned", "paletteRecent", "portfolio"] as const;

export function defaultPrefs(): Prefs {
  return {
    theme: "system",
    project: null,
    scopeAll: true,
    pinnedProjects: [],
    recentProjects: [],
    floorView: "belt",
    boardSwim: "none",
    navCollapsed: {},
    navRail: false,
    palettePinned: ["floor", "work-orders"],
    paletteRecent: [],
    openConversation: null,
    record: null,
    replay: null,
    agent: null,
    boardFilters: { cls: "all", repo: "all", assignee: "all", prio: "all" },
    collapsedBays: false,
    activeClass: null,
  };
}

const isTheme = (v: unknown): v is Theme => v === "system" || v === "light" || v === "dark";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isRecordOfBool = (v: unknown): v is Record<string, boolean> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === "boolean");

/** Parse what storage holds; anything malformed falls back to the default for that key. */
export function parsePrefs(raw: string | null): Prefs {
  const out = defaultPrefs();
  if (!raw) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!v || typeof v !== "object") return out;
  const s = v as Record<string, unknown>;
  if (isTheme(s.theme)) out.theme = s.theme;
  if (typeof s.project === "string" && s.project) out.project = s.project;
  if (typeof s.scopeAll === "boolean") out.scopeAll = s.scopeAll;
  if (isStrArray(s.pinnedProjects)) out.pinnedProjects = s.pinnedProjects;
  if (isStrArray(s.recentProjects)) out.recentProjects = s.recentProjects;
  if (typeof s.floorView === "string") out.floorView = s.floorView;
  if (typeof s.boardSwim === "string") out.boardSwim = s.boardSwim;
  if (isRecordOfBool(s.navCollapsed)) out.navCollapsed = s.navCollapsed;
  if (typeof s.navRail === "boolean") out.navRail = s.navRail;
  if (isStrArray(s.palettePinned)) out.palettePinned = s.palettePinned;
  if (isStrArray(s.paletteRecent)) out.paletteRecent = s.paletteRecent;
  if (s.portfolio !== undefined) out.portfolio = s.portfolio;
  return out;
}

function load(): Prefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return defaultPrefs();
  }
}

function persist(p: Prefs): void {
  try {
    const o: Record<string, unknown> = {};
    for (const k of PERSISTED) o[k] = p[k];
    localStorage.setItem(PREFS_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable: preferences last for this tab only */
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

export const getPrefs = (): Prefs => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function updatePrefs(change: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)): void {
  const patch = typeof change === "function" ? change(state) : change;
  state = { ...state, ...patch };
  persist(state);
  for (const fn of [...listeners]) fn();
}

/** Back to defaults in memory only (a session reset wipes storage itself); keeps memory and storage consistent after sign-out. */
export function resetPrefsInMemory(): void {
  state = defaultPrefs();
  for (const fn of [...listeners]) fn();
}

/** Test hook: reload from storage. */
export function reloadPrefs(): void {
  state = load();
  for (const fn of [...listeners]) fn();
}

export const usePrefs = (): Prefs => useSyncExternalStore(subscribe, getPrefs);

/* view state helpers (legacy ops.openRecord / ops.setReplay) */
export const openRecord = (woId: string | null): void => updatePrefs({ record: woId });
export const setReplay = (o: Prefs["replay"]): void => updatePrefs((p) => ({ replay: o ? { ...(p.replay ?? {}), ...o } : null }));
export const setProject = (id: string): void => updatePrefs((p) => ({ project: id, recentProjects: [id, ...p.recentProjects.filter((x) => x !== id)].slice(0, 6) }));
export const togglePinnedProject = (id: string): void =>
  updatePrefs((p) => ({ pinnedProjects: p.pinnedProjects.includes(id) ? p.pinnedProjects.filter((x) => x !== id) : [id, ...p.pinnedProjects].slice(0, 12) }));

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
