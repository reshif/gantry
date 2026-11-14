/** Shared pieces of the MCP screen (legacy views/mcp.js helpers): chips, scope text, and the lists the dialogs and panels draw from. */
import { classesOf, flowOf, type Catalog, type McpServer, type Project } from "@gantry/domain";
import type { Decision } from "../../ui/primitives";

export const SENS = [{ value: "public", label: "Public" }, { value: "internal", label: "Internal" }, { value: "confidential", label: "Confidential" }, { value: "restricted", label: "Restricted" }];
export const AUTH_MODES = [{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "header", label: "API key in a header" }];
export const TRANSPORTS = [{ value: "http", label: "Streamable HTTP" }, { value: "sse", label: "SSE" }];

export const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export function Health({ st }: { st: string }) {
  const s = st === "healthy" ? "healthy" : st === "down" || st === "failing" ? "failing" : "degraded";
  return (
    <span className={`health h-${s}`}>
      <span className="health-shape" aria-hidden="true" />
      {st}
    </span>
  );
}

export const Rw = ({ write }: { write: boolean }) => (
  <span className={`mcp-rw ${write ? "is-w" : "is-r"}`} title={write ? "Write tool" : "Read-only tool"}>
    {write ? "W" : "R"}
  </span>
);

export const SensChip = ({ s }: { s: string }) => <span className={`mcp-sens mcp-sens-${s}`}>{s}</span>;

export const scopeText = (v: "all" | string[] | null | undefined, name: string): string => (v === "all" ? `all ${name}` : !v || !v.length ? `no ${name}` : `${v.length} ${name}`);

export type ScopeDraft = { projects: "all" | string[]; repos: "all" | string[]; agents: "all" | string[]; stations: "all" | string[]; classes: "all" | string[] };

export const draftOf = (s: McpServer): ScopeDraft => ({
  projects: s.projects === "all" ? "all" : [...(s.projects ?? [])],
  repos: s.repos === "all" ? "all" : [...(s.repos ?? [])],
  agents: s.agents === "all" ? "all" : [...(s.agents ?? [])],
  stations: s.stations === "all" ? "all" : [...(s.stations ?? [])],
  classes: s.classes == null || s.classes === "all" ? "all" : [...s.classes],
});

export const projectsIn = (all: Project[], v: "all" | string[]): Project[] => all.filter((p) => p.status !== "archived" && (v === "all" || v.includes(p.id)));

/** Stations from the flows of the projects in scope; custom stations go right after the station they follow in their own project's flow and carry their project's name. */
export function stationsFor(cat: Catalog, projects: Project[]): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; no: string; name: string; custom?: boolean | undefined; project?: string | undefined; index: number }> = [];
  for (const p of projects) for (const st of flowOf(cat, p).active) if (!st.custom && !seen.has(st.id)) { seen.add(st.id); out.push(st); }
  out.sort((a, b) => a.index - b.index);
  for (const p of projects) {
    const fl = flowOf(cat, p).active;
    fl.forEach((st, i) => {
      if (!st.custom || seen.has(st.id)) return;
      seen.add(st.id);
      const prev = i ? fl[i - 1]!.id : null;
      const at = out.findIndex((x) => x.id === prev);
      out.splice(at < 0 ? out.length : at + 1, 0, st);
    });
  }
  const pname = (id: string | undefined): string => projects.find((p) => p.id === id)?.name ?? id ?? "";
  return out.map((st) => ({ id: st.id, label: `${st.no} ${st.name}${st.custom ? ` (${pname(st.project)})` : ""}` }));
}

export function classesFor(cat: Catalog, projects: Project[]): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string }> = [];
  for (const p of projects) {
    for (const c of classesOf(cat, p)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const owner = c.project ? projects.find((x) => x.id === c.project)?.name ?? c.project : p.name;
      out.push({ id: c.id, label: c.name + (c.custom ? ` (${owner})` : "") });
    }
  }
  return out;
}

/** The outcome column: the real states of a call (spec 12.4) in the legacy chip style. */
export const OUTCOME: Record<string, { cls: string; text: string }> = {
  ok: { cls: "ok", text: "✓ ok" },
  allowed: { cls: "warn", text: "◆ running" },
  denied: { cls: "denied", text: "⊘ denied" },
  error: { cls: "failed", text: "✕ error" },
};
