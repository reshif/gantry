/**
 * Shared pieces of the Integrations screen (legacy views/integrations.js helpers): types and instances from the API, the usage of an instance
 * (routes, overrides, triggers, repos), the schema-driven settings form, validation and the project scope picker. Same classes and ids as legacy.
 */
import { useMemo, type ReactNode } from "react";
import { INTEGRATION_CATEGORIES, NOTIFY_EVENTS, type IntegrationField, type IntegrationInstance, type IntegrationType, type Project, type Repo, type Trigger } from "@gantry/domain";
import { useDeliveries, useIntegrationTypes, useIntegrations, useProjects, useTriggers } from "../../api/queries";
import { Icon } from "../../ui/Icon";
import { Select, Status, type Tone } from "../../ui/primitives";
import { useAllRepos } from "../govern/data";

export const AUTHS = [
  { value: "token", label: "API token" }, { value: "oauth", label: "OAuth app" }, { value: "hmac", label: "Signed (HMAC secret)" }, { value: "basic", label: "Basic auth" },
  { value: "app", label: "App with private key" }, { value: "smtp", label: "SMTP login" }, { value: "none", label: "None" },
];
export const PAYLOADS = [
  { value: "json", label: "JSON" }, { value: "cloudevents", label: "CloudEvents JSON" }, { value: "form", label: "Form-encoded" }, { value: "blocks", label: "Chat blocks" },
  { value: "adaptive", label: "Adaptive card" }, { value: "html", label: "HTML email" },
];
export const FTYPES = [
  { value: "text", label: "Text" }, { value: "url", label: "URL (https)" }, { value: "secret", label: "Secret (masked)" }, { value: "select", label: "Choice" }, { value: "bool", label: "Yes / no" }, { value: "number", label: "Number" },
];

/** A type as the API returns it: the legacy shape plus its manifest and availability. */
export type TypeRow = IntegrationType & { manifest?: { version: string; capabilities: string[]; operations: string[]; delivery: { idempotencyKey: string; retryable: string; permanent: string; rateLimit: string } } };

export const evName = (id: string): string => NOTIFY_EVENTS.find((e) => e.id === id)?.name ?? id;
export const catName = (id: string): string => INTEGRATION_CATEGORIES.find((c) => c.id === id)?.name ?? id;
export const slug = (s: string): string => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
export const keyOf = (s: string): string => {
  const w = String(s || "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  return w.map((x, i) => (i ? x.charAt(0).toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join("").slice(0, 24);
};

export const statusOf = (i: IntegrationInstance): "disabled" | "failing" | "offline" | "healthy" => (!i.connected ? "disabled" : i.status === "failing" ? "failing" : i.status === "offline" ? "offline" : "healthy");

const STATUS_WORD: Record<string, string> = { healthy: "Healthy", failing: "Failing", degraded: "Degraded", offline: "Offline", disabled: "Disabled" };

const STATUS_TONE: Record<string, Tone> = { healthy: "done", failing: "block", degraded: "wait", offline: "neutral", disabled: "neutral" };

export function Health({ st }: { st: string }) {
  return <Status tone={STATUS_TONE[st] ?? "neutral"}>{STATUS_WORD[st] ?? st}</Status>;
}

export const Mark = ({ icon, small }: { icon?: string; small?: boolean }) => (
  <span className={`int-mark${small ? " int-mark-sm" : ""}`}>
    <Icon name={icon || "plug"} />
  </span>
);

export function DirTags({ t }: { t: Pick<IntegrationType, "source" | "destination" | "custom"> }) {
  return (
    <>
      {t.source ? <span className="tag int-dir">source</span> : null}
      {t.destination ? <span className="tag int-dir">destination</span> : null}
      {t.custom ? <span className="tag int-custom">custom</span> : null}
    </>
  );
}

export const scopeText = (i: Pick<IntegrationInstance, "projects">, name: (id: string) => string): string =>
  i.projects === "all" ? "All projects" : i.projects.length === 1 ? name(i.projects[0]!) : `${i.projects.length} projects`;

export interface Usage {
  routes: Array<{ project: Project; route: Project["notifications"][number]; target: string }>;
  implicit: Array<{ project: Project; route: Project["notifications"][number]; target: string }>;
  overrides: Array<{ repo: Repo; o: Repo["notifyOverrides"][number] }>;
  triggers: Trigger[];
  repos: Repo[];
}

/** Everything the data screens already read: a connection's type, who may use it, and what depends on it. */
export function useIntegrationData() {
  const typesQ = useIntegrationTypes();
  const instsQ = useIntegrations();
  const types = (typesQ.data ?? []) as TypeRow[];
  const insts = instsQ.data ?? [];
  const projects = useProjects().data ?? [];
  const triggers = useTriggers().data ?? [];
  const { repos } = useAllRepos();
  const live = projects.filter((p) => p.status !== "archived");
  const typeOf = (i: Pick<IntegrationInstance, "type">): TypeRow => types.find((t) => t.id === i.type) ?? ({ id: i.type, name: i.type, category: "custom", icon: "plug", auth: "token", payload: "json", builtIn: false, fields: [], events: [], actions: [] } as TypeRow);
  const pname = (id: string): string => projects.find((p) => p.id === id)?.name ?? id;
  const opensTo = (i: IntegrationInstance, pid: string): boolean => i.projects === "all" || i.projects.includes(pid);
  const integrationFor = (d: { channel: string; target: string; integration?: string | null | undefined }, pid: string): IntegrationInstance | null => {
    if (d.integration) return insts.find((i) => i.id === d.integration) ?? null;
    if (d.channel === "webhook") {
      const w = insts.find((i) => i.type === "webhook" && i.targetId === d.target);
      if (w) return w;
    }
    const mine = insts.filter((i) => i.type === d.channel && opensTo(i, pid));
    return mine.find((i) => i.connected && i.status !== "failing") ?? mine[0] ?? null;
  };
  const usage = (inst: IntegrationInstance): Usage => {
    const routes: Usage["routes"] = [];
    const implicit: Usage["implicit"] = [];
    for (const p of projects) for (const r of p.notifications ?? []) for (const d of r.dest) {
      if (d.integration === inst.id) routes.push({ project: p, route: r, target: d.target });
      else if (!d.integration && integrationFor(d, p.id)?.id === inst.id) implicit.push({ project: p, route: r, target: d.target });
    }
    const overrides: Usage["overrides"] = [];
    for (const r of repos) for (const o of r.notifyOverrides ?? []) for (const d of o.dest ?? []) if (d.integration === inst.id) overrides.push({ repo: r, o });
    const trig = (Array.isArray(triggers) ? triggers : []).filter((t) => (t as unknown as { source?: string }).source === inst.id);
    const rp = typeOf(inst).category === "source" ? repos.filter((r) => (r as unknown as { source?: string }).source === inst.id) : [];
    return { routes, implicit, overrides, triggers: trig, repos: rp };
  };
  return { types, insts, typesQ, instsQ, projects, live, repos, typeOf, pname, usage, integrationFor };
}

export const usageCount = (u: Usage): number => u.routes.length + u.implicit.length + u.overrides.length + u.triggers.length + u.repos.length;

export function usageLine(u: Usage): string {
  const parts: string[] = [];
  const n = u.routes.length + u.implicit.length;
  if (n) parts.push(`${n} route${n === 1 ? "" : "s"}`);
  if (u.triggers.length) parts.push(`${u.triggers.length} trigger${u.triggers.length === 1 ? "" : "s"}`);
  if (u.repos.length) parts.push(`${u.repos.length} repo${u.repos.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "nothing yet";
}

/** The deliveries of one connection in the last day, for the drawer and the header count. */
export function useInstanceDeliveries(id: string) {
  const q = useDeliveries({ integration: id, limit: 40 });
  const items = Array.isArray(q.data) ? q.data : q.data?.items ?? [];
  return items;
}

/* ---------- schema-driven form ---------- */

export interface FormVals {
  config: Record<string, string | boolean>;
  secrets: Record<string, string>;
}
export const emptyVals = (t: Pick<IntegrationType, "fields">): FormVals => {
  const config: FormVals["config"] = {};
  for (const f of t.fields) {
    if (f.type === "select") config[f.key] = f.options?.[0] ?? "";
    if (f.type === "bool") config[f.key] = false;
  }
  return { config, secrets: {} };
};

export function control(prefix: string, f: IntegrationField, vals: FormVals, set: (v: FormVals) => void, ro: boolean): ReactNode {
  const id = prefix + f.key;
  if (f.type === "select") return <Select id={id} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} value={String(vals.config[f.key] ?? f.options?.[0] ?? "")} disabled={ro} onChange={(v) => set({ ...vals, config: { ...vals.config, [f.key]: v } })} />;
  if (f.type === "bool") {
    return (
      <label className="check int-bool" htmlFor={id}>
        <input type="checkbox" id={id} checked={!!vals.config[f.key]} disabled={ro} onChange={(e) => set({ ...vals, config: { ...vals.config, [f.key]: e.target.checked } })} />
        <span>{f.label}</span>
      </label>
    );
  }
  const secret = f.type === "secret";
  const v = secret ? vals.secrets[f.key] ?? "" : String(vals.config[f.key] ?? "");
  return (
    <input
      id={id}
      className={`input${secret || f.type === "url" || f.type === "number" ? " mono" : ""}`}
      type={secret ? "password" : f.type === "number" ? "number" : "text"}
      autoComplete="off"
      value={v}
      placeholder={f.placeholder || (f.type === "url" ? "https://" : "")}
      disabled={ro}
      onChange={(e) => set(secret ? { ...vals, secrets: { ...vals.secrets, [f.key]: e.target.value } } : { ...vals, config: { ...vals.config, [f.key]: e.target.value } })}
    />
  );
}

/** The first problem with the settings, as a sentence (the server checks the same rules). */
export function validate(t: Pick<IntegrationType, "fields">, vals: FormVals, needSecret: boolean): string | null {
  for (const f of t.fields) {
    if (f.type === "bool") continue;
    if (f.type === "secret") {
      const s = (vals.secrets[f.key] ?? "").trim();
      if (needSecret && f.required !== false && !s) return `Add the ${f.label.toLowerCase()}.`;
      if (s && s.length < 6) return `${f.label} looks too short.`;
      continue;
    }
    const raw = vals.config[f.key];
    const s = raw == null ? "" : String(raw).trim();
    if (f.required !== false && !s) return `Fill in ${f.label}.`;
    if (f.type === "url" && s && !/^https:\/\/[^\s/]+\.[^\s]+/.test(s) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(s)) return `${f.label} must be an https URL.`;
    if (f.type === "number" && s && Number.isNaN(Number(s))) return `${f.label} must be a number.`;
  }
  return null;
}

export const configOf = (t: Pick<IntegrationType, "fields">, vals: FormVals): Record<string, string | number | boolean> => {
  const c: Record<string, string | number | boolean> = {};
  for (const f of t.fields) {
    if (f.type === "secret") continue;
    const v = vals.config[f.key];
    if (v != null && v !== "") c[f.key] = f.type === "number" ? Number(v) : v;
  }
  return c;
};
export const secretsOf = (vals: FormVals): Record<string, string> => Object.fromEntries(Object.entries(vals.secrets).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));

export function hostOf(t: Pick<IntegrationType, "fields" | "name">, vals: FormVals): string {
  const u = t.fields.find((f) => f.type === "url" && vals.config[f.key]);
  if (u) return String(vals.config[u.key]).replace(/^https?:\/\//, "").split("/")[0]!;
  const first = t.fields.find((f) => f.type === "text" && vals.config[f.key]);
  return first ? String(vals.config[first.key]) : t.name;
}

/** Scope picker: all projects, or a checked set. */
export function ScopePicker({ prefix, projects, value, onChange, ro, live }: { prefix: string; projects: Project[]; value: "all" | string[]; onChange: (v: "all" | string[]) => void; ro: boolean; live: Project[] }) {
  const all = value === "all";
  const set = useMemo(() => new Set(all ? [] : value), [all, value]);
  void projects;
  return (
    <fieldset className="int-scope">
      <legend className="field-label">Projects that may use it</legend>
      <label className="check int-scope-all" htmlFor={`${prefix}all`}>
        <input type="checkbox" id={`${prefix}all`} checked={all} disabled={ro} onChange={(e) => onChange(e.target.checked ? "all" : [])} />
        All projects, including new ones
      </label>
      <div className="check-grid">
        {live.map((p) => (
          <label className="check" htmlFor={`${prefix}${p.id}`} key={p.id}>
            <input
              type="checkbox" id={`${prefix}${p.id}`} checked={all || set.has(p.id)} disabled={ro || all}
              onChange={(e) => onChange(e.target.checked ? [...set, p.id] : [...set].filter((x) => x !== p.id))}
            />
            <span>{p.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
