/**
 * Grading an eval case's result (spec 13.2). Deterministic checks decide, over what the run reported. A model-graded check is advisory only: it is stored
 * and shown, and never changes pass or fail. An agent never sees these (they are never part of its input), and never grades its own output.
 */
import { z } from "zod";

const path = z.string().max(200).optional();
export const CheckSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("output_equals"), path: z.string().min(1).max(200), value: z.union([z.string().max(2000), z.number(), z.boolean()]) }),
  z.object({ kind: z.literal("output_contains"), path, value: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("output_not_contains"), path, value: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("output_matches"), path, pattern: z.string().min(1).max(500) }),
  /** Files the run reports it changed: none may fall under these path prefixes. */
  z.object({ kind: z.literal("path_not_touched"), paths: z.array(z.string().min(1).max(300)).min(1).max(50) }),
  z.object({ kind: z.literal("max_files"), n: z.number().int().min(0).max(100000) }),
  z.object({ kind: z.literal("max_seconds"), n: z.number().int().min(1).max(86400) }),
  /** Advisory only. Kept with the case; no grader model is called by the platform in this version. */
  z.object({ kind: z.literal("model_graded"), rubric: z.string().min(1).max(2000), grader: z.string().max(100).optional() }),
]);
export type CheckSpec = z.infer<typeof CheckSpec>;

export interface CheckResult {
  kind: string;
  label: string;
  /** null for an advisory check: it does not count. */
  pass: boolean | null;
  advisory?: boolean;
  detail?: string;
}

const get = (o: unknown, p: string | undefined): unknown => {
  if (!p) return o;
  let cur: unknown = o;
  for (const k of p.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
};
const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

/** The files a result reports changed: strings or `{path}` entries under filesChanged, files or changedFiles. */
export function reportedFiles(output: unknown): string[] {
  const o = (output ?? {}) as Record<string, unknown>;
  for (const k of ["filesChanged", "files", "changedFiles"]) {
    const v = o[k];
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { path?: unknown }).path === "string" ? (x as { path: string }).path : "")).filter(Boolean);
  }
  return [];
}

export interface GradeInput { status: "succeeded" | "failed" | "interrupted"; output: unknown; error?: { code: string; msg: string } | null; seconds: number }
export interface Graded { pass: boolean; reason: string; checks: CheckResult[] }

/** Runs every check. The case passes when the run completed and every deterministic check holds. */
export function grade(checks: readonly CheckSpec[], r: GradeInput): Graded {
  const out: CheckResult[] = [{ kind: "completed", label: "The run finished with a result", pass: r.status === "succeeded", ...(r.status === "succeeded" ? {} : { detail: r.error?.msg ?? `The run ${r.status}.` }) }];
  for (const c of checks) {
    switch (c.kind) {
      case "output_equals": {
        const v = get(r.output, c.path);
        out.push({ kind: c.kind, label: `${c.path} is ${JSON.stringify(c.value)}`, pass: v === c.value, ...(v === c.value ? {} : { detail: `Got ${JSON.stringify(v ?? null)}.` }) });
        break;
      }
      case "output_contains": {
        const ok = text(get(r.output, c.path)).toLowerCase().includes(c.value.toLowerCase());
        out.push({ kind: c.kind, label: `${c.path ?? "output"} mentions "${c.value}"`, pass: ok, ...(ok ? {} : { detail: `Missed "${c.value}".` }) });
        break;
      }
      case "output_not_contains": {
        const bad = text(get(r.output, c.path)).toLowerCase().includes(c.value.toLowerCase());
        out.push({ kind: c.kind, label: `${c.path ?? "output"} does not mention "${c.value}"`, pass: !bad, ...(bad ? { detail: `Mentioned "${c.value}".` } : {}) });
        break;
      }
      case "output_matches": {
        let ok = false;
        try {
          ok = new RegExp(c.pattern, "i").test(text(get(r.output, c.path)));
        } catch {
          ok = false;
        }
        out.push({ kind: c.kind, label: `${c.path ?? "output"} matches /${c.pattern}/`, pass: ok, ...(ok ? {} : { detail: "No match." }) });
        break;
      }
      case "path_not_touched": {
        const hit = reportedFiles(r.output).filter((f) => c.paths.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : `${p}/`) || f.startsWith(p)));
        out.push({ kind: c.kind, label: `Does not touch ${c.paths.join(", ")}`, pass: hit.length === 0, ...(hit.length ? { detail: `Touched ${hit.slice(0, 3).join(", ")}.` } : {}) });
        break;
      }
      case "max_files": {
        const n = reportedFiles(r.output).length;
        out.push({ kind: c.kind, label: `At most ${c.n} files changed`, pass: n <= c.n, ...(n <= c.n ? {} : { detail: `${n} files changed.` }) });
        break;
      }
      case "max_seconds":
        out.push({ kind: c.kind, label: `Finishes within ${c.n} seconds`, pass: r.seconds <= c.n, ...(r.seconds <= c.n ? {} : { detail: `Took ${Math.round(r.seconds)} seconds.` }) });
        break;
      case "model_graded":
        out.push({ kind: c.kind, label: c.rubric.slice(0, 120), pass: null, advisory: true, detail: "Advisory only: a model grader's opinion never decides." });
        break;
    }
  }
  const failed = out.filter((c) => c.pass === false);
  return { pass: failed.length === 0, reason: failed.length ? failed.map((c) => c.detail ?? c.label).slice(0, 2).join(" ") : "", checks: out };
}

/** The 95% Wilson interval of a pass share over n tasks: the range reported beside a score (spec 13.2). */
export function wilson(pass: number, n: number): [number, number] {
  if (n <= 0) return [0, 0];
  const z = 1.96;
  const p = pass / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, Math.round(((c - m) / d) * 1000) / 1000), Math.min(1, Math.round(((c + m) / d) * 1000) / 1000)];
}
