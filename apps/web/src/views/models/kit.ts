/** Shared helpers of the Models screen (legacy views/models.js top-level functions). */
import type { Agent, Project, Repo, Vendor, Model } from "@gantry/domain";
import type { Decision } from "../../ui/primitives";

export const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
export const no = (reason: string): Decision => ({ allowed: false, reason, needs: "" });

export const RETENTION = [
  { value: "standard", label: "Standard (the vendor's default retention)" },
  { value: "30d", label: "30 days" },
  { value: "zero", label: "Zero retention" },
];

/** A vendor that is called at an endpoint we hold, not a hosted API with a fixed address. */
export const hasEndpoint = (v: Vendor): boolean => v.id === "local" || !!v.custom;

export const usedBy = (agents: Agent[], modelId: string): Agent[] => agents.filter((a) => a.model === modelId || a.fallbacks.includes(modelId));

export const enabledModels = (vendors: Vendor[]): Array<{ value: string; label: string }> =>
  vendors.flatMap((v) => (v.connected ? v.models.filter((m) => m.enabled).map((m) => ({ value: m.id, label: `${m.name} · ${v.name}` })) : []));

export const allModels = (vendors: Vendor[]): Array<Model & { vendorName: string }> => vendors.flatMap((v) => v.models.map((m) => ({ ...m, vendorName: v.name })));

/** The repo's own tags, plus "regulated" for a regulated project (legacy repoTags). */
export function repoTags(r: Repo, projects: Project[]): string[] {
  const t = [...(r.tags ?? [])];
  const p = projects.find((x) => x.id === r.project);
  if (p?.regulated && !t.includes("regulated")) t.push("regulated");
  return t;
}
