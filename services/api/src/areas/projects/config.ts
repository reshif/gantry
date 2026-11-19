import type { WorkClass } from "@gantry/domain";
import { z } from "zod";
import { invalid } from "../../core/errors.js";
import { ClassSchema, RouteSchema } from "./schemas.js";

/** The `PATCH /projects/{id}/config` paths (legacy `G.ops.setProject`), parsed once into a tagged value. */
export type ConfigEdit =
  | { kind: "desc"; value: string }
  | { kind: "overlay"; value: string }
  | { kind: "owner"; value: string }
  | { kind: "slots"; value: number }
  | { kind: "station-enabled"; id: string; value: boolean }
  | { kind: "station-wip"; id: string; value: number }
  | { kind: "gate-enabled"; id: string; value: boolean }
  | { kind: "classes"; value: WorkClass[] }
  | { kind: "notifications"; value: z.infer<typeof RouteSchema>[] }
  | { kind: "mcp"; value: string[] }
  | { kind: "budget-monthly"; value: number | null }
  | { kind: "budget-alert"; value: number };

const parse = <T extends z.ZodType>(s: T, v: unknown, what: string): z.infer<T> => {
  const r = s.safeParse(v);
  if (!r.success) throw invalid(`${what}: ${r.error.issues[0]?.message ?? "invalid value"}.`);
  return r.data;
};

export function parseConfigEdit(path: string, value: unknown): ConfigEdit {
  const p = path.split(".");
  const [a, b, c, d] = p;
  if (p.length === 1) {
    if (a === "desc") return { kind: "desc", value: parse(z.string().max(2000), value, "Description").trim() };
    if (a === "overlay") return { kind: "overlay", value: parse(z.string().max(20000), value, "Instructions overlay").trim() };
    if (a === "owner") return { kind: "owner", value: parse(z.string().min(1).max(100), value, "Owner") };
    if (a === "notifications") return { kind: "notifications", value: parse(z.array(RouteSchema).max(100), value, "Notification routes") };
    if (a === "mcp") return { kind: "mcp", value: parse(z.array(z.string().min(1).max(100)).max(100), value, "MCP servers") };
  }
  if (a === "flow" && p.length === 2 && b === "slots") return { kind: "slots", value: parse(z.number().int().min(1).max(8), value, "Coding slots") };
  if (a === "flow" && p.length === 2 && b === "classes") return { kind: "classes", value: parse(z.array(ClassSchema).min(1).max(100), value, "Classes") as WorkClass[] };
  if (a === "flow" && b === "stations" && c && p.length === 4) {
    if (d === "enabled") return { kind: "station-enabled", id: c, value: parse(z.boolean(), value, "On or off") };
    if (d === "wip") return { kind: "station-wip", id: c, value: parse(z.number().int().min(1).max(30), value, "WIP limit") };
  }
  if (a === "flow" && b === "gates" && c && p.length === 4 && d === "enabled") return { kind: "gate-enabled", id: c, value: parse(z.boolean(), value, "On or off") };
  if (a === "budget" && p.length === 2 && b === "monthly") return { kind: "budget-monthly", value: parse(z.number().min(0).max(10_000_000).nullable(), value, "Monthly budget") };
  if (a === "budget" && p.length === 2 && b === "alertAt") return { kind: "budget-alert", value: parse(z.number().min(0.05).max(1), value, "Alert line") };
  if (a === "approvers") throw invalid("Approver rules are saved with PUT /projects/{id}/approvers/{gate}.");
  throw invalid(`${path} is not an editable project setting.`);
}

/** The catalogue action a path needs (legacy: approvers.edit, notify.edit, otherwise project.config). */
export const actionFor = (e: ConfigEdit): "notify.edit" | "project.config" => (e.kind === "notifications" ? "notify.edit" : "project.config");
