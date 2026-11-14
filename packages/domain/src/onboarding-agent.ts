/**
 * The Onboarding Agent's part in repository onboarding (spec 11.3), and the rules that keep it a helper and not an authority.
 *
 * Gantry observes the repository deterministically (`inspect`, `assess`, `planPr`): those facts are the source of truth (spec 10.3: what the system observed wins over what an
 * agent says). The agent runs on top of them, in a sandbox with the repository's files, and may only
 *   - explain a finding (a `note`), say whether it reads the repository differently, judge the overall risk, and suggest test/lint/build commands for layouts the rules cannot read;
 *   - draft the content of AGENTS.md (commands, conventions, notes) and suggest guideline changes.
 * It can never add or remove a finding, change `ok`, severity or `required`, add a file to the pull request, touch a protected path, exceed the diff cap or merge. Its output is validated here;
 * anything outside the contract rejects the whole output and the caller falls back to the deterministic result, recording why.
 */
import { z } from "zod";
import type { OnboardAssessor } from "./types.js";
import type { AssessedFinding, PlannedFile } from "./onboarding.js";

/** The station name an onboarding agent run is routed and metered under. */
export const ONBOARD_STATION = "onboarding";
export const ONBOARD_AGENT = "ag-onboard";

/** The ids of the checks the deterministic assessment makes: the only finding ids an agent may mention. */
export const FINDING_IDS = ["ci", "test", "protect", "owners", "lint", "secrets", "agents", "repro", "deps", "mcp", "docker"] as const;

/** The one file whose content an agent may draft. Every other file in the plan is written by Gantry from the repository's own files. */
export const AGENT_DRAFTABLE = ["AGENTS.md"] as const;

/* ------------------------------------------------------------------ safety of free text ---- */

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./, /(password|passwd|secret|token|api[_-]?key|access[_-]?key)\w*\s*[:=]\s*["']?[^\s"']{6,}/i, /[A-Za-z0-9+/_-]{48,}={0,2}/,
];
/** Whether a string looks like a credential. Deliberately broad: a false alarm only makes the agent's text unused. */
export const looksSecret = (s: string): boolean => SECRET_PATTERNS.some((r) => r.test(s));

const DANGEROUS_COMMAND = [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, /\brm\s+-[a-z]*r[a-z]*f?\b/i, /\bsudo\b/i, /[`]|\$\(/, /\bgit\s+push\b/i, /\bchmod\s+-R\s+777\b/i];

const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\r\n]/.test(s), "must be one line");
const command = oneLine(160).refine((s) => !DANGEROUS_COMMAND.some((r) => r.test(s)), "is not a safe command to put in a file people run from");
const prose = (max: number) => z.string().trim().max(max);

/* ------------------------------------------------------------------ the result contract ---- */

/**
 * What the Onboarding Agent ends its run with. One object serves both steps (the task says which): the assessment fills `findings`, `commands`, `risk`, `forPeople`;
 * the pull request step fills `plannedFiles`, `agentsMd`, `guidelineSuggestions`. Fields a step does not use are empty. The starter kit's instructions and its eval cases use the same names.
 */
export const AgentResult = z.object({
  findings: z.array(z.object({
    id: z.string().max(40),
    /** The agent's own reading of the check. Recorded; never replaces what Gantry observed. */
    ok: z.boolean(),
    note: prose(500).default(""),
  })).max(40).default([]),
  commands: z.object({ test: command.optional(), lint: command.optional(), build: command.optional(), install: command.optional() }).default({}),
  risk: z.object({ level: z.enum(["low", "medium", "high"]), reason: prose(400) }).optional(),
  plannedFiles: z.array(z.object({ path: z.string().max(300), purpose: prose(300).default(""), closes: z.string().max(40).default("") })).max(20).default([]),
  agentsMd: z.object({
    commands: z.array(z.object({ label: oneLine(40), command })).max(8).default([]),
    conventions: z.array(oneLine(200)).max(12).default([]),
    notes: prose(1200).default(""),
  }).optional(),
  guidelineSuggestions: z.array(oneLine(300)).max(8).default([]),
  forPeople: z.array(oneLine(300)).max(10).default([]),
  summary: prose(800).default(""),
});
export type AgentResult = z.infer<typeof AgentResult>;

/** The result format, restated in the run's input so a version of the agent whose own instructions are older still ends with the object that is validated. */
export const RESULT_FORMAT =
  'End with one JSON object and nothing else. Fields: findings (array of { "id": one of the finding ids you were given, "ok": boolean, "note": string }; empty for draft_pr), commands (object with any of "test","lint","build","install": a single-line command read from the repository), risk ({ "level": "low"|"medium"|"high", "reason": string }; required for assess), plannedFiles (array of { "path", "purpose", "closes" } for the files you drafted; draft_pr only, and only paths in the plan), agentsMd ({ "commands": [{ "label", "command" }], "conventions": [string], "notes": string }; draft_pr only), guidelineSuggestions (array of strings), forPeople (array of strings), summary (two sentences). Never include a secret value.';

/** Every string the agent produced, for the secret scan. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function parseResult(raw: unknown): Checked<AgentResult> {
  const p = AgentResult.safeParse(raw);
  if (!p.success) return bad(`The agent's result does not match the contract: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}.`);
  const hit = strings(p.data).find(looksSecret);
  if (hit) return bad("The agent's result contains something that looks like a credential, so none of it is used.");
  return { ok: true, value: p.data };
}

/** The assessment step's output: only findings that exist, each at most once. */
export function validateAssessment(raw: unknown, findings: readonly { id: string }[]): Checked<AgentResult> {
  const r = parseResult(raw);
  if (!r.ok) return r;
  const known = new Set(findings.map((f) => f.id));
  const seen = new Set<string>();
  for (const f of r.value.findings) {
    if (!known.has(f.id)) return bad(`The agent reported a finding (${f.id}) that the assessment did not make, so its output is not used.`);
    if (seen.has(f.id)) return bad(`The agent reported ${f.id} twice, so its output is not used.`);
    seen.add(f.id);
  }
  if (!r.value.risk) return bad("The agent gave no risk judgement.");
  return r;
}

/** Whether a repository-relative path falls under a protected pattern (`**` crosses directories, `*` does not). */
export function isProtected(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    const body = p
      .replace(/^\//, "")
      .replace(/[.+^${}()|\\]/g, "\\$&")
      .replace(/\/\*\*$/, "\u0001")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, "(?:.*/)?")
      .replace(/\u0001/g, "(?:/.*)?");
    return new RegExp(`^${body}$`).test(path);
  });
}

export interface DraftLimits { protectedPaths: readonly string[]; maxDiff: number }

/** The pull-request step's output: it may draft only AGENTS.md, only if the plan has it, and never beyond the plan, the protected paths or the diff cap. */
export function validateDraft(raw: unknown, plan: readonly Pick<PlannedFile, "path">[], lim: DraftLimits): Checked<AgentResult> {
  const r = parseResult(raw);
  if (!r.ok) return r;
  const planned = new Set(plan.map((f) => f.path));
  for (const f of r.value.plannedFiles) {
    if (isProtected(f.path, lim.protectedPaths)) return bad(`The agent named a protected path (${f.path}), so its output is not used.`);
    if (!planned.has(f.path)) return bad(`The agent named a file (${f.path}) that is not in the plan, so its output is not used.`);
    if (!AGENT_DRAFTABLE.includes(f.path as (typeof AGENT_DRAFTABLE)[number])) return bad(`The agent may draft only ${AGENT_DRAFTABLE.join(", ")}; it named ${f.path}, so its output is not used.`);
  }
  if (r.value.agentsMd && !planned.has("AGENTS.md")) return bad("The agent drafted AGENTS.md, but the plan does not include it, so its output is not used.");
  if (!r.value.agentsMd && !r.value.guidelineSuggestions.length) return bad("The agent drafted nothing.");
  const added = (r.value.agentsMd?.commands.length ?? 0) + (r.value.agentsMd?.conventions.length ?? 0) + (r.value.agentsMd?.notes ? r.value.agentsMd.notes.split("\n").length : 0) + 8;
  if (added > lim.maxDiff) return bad(`The agent's draft adds more than the diff cap of ${lim.maxDiff} lines, so its output is not used.`);
  return r;
}

/* ------------------------------------------------------------------ merging what was observed with what the agent said ---- */

/** The agent's notes and the observed findings in one list. Observed fields are never touched; a disagreement is stated in the note, not applied. */
export function mergeAssessment(findings: AssessedFinding[], r: AgentResult): AssessedFinding[] {
  const by = new Map(r.findings.map((f) => [f.id, f]));
  return findings.map((f) => {
    const a = by.get(f.id);
    if (!a) return { ...f, source: "observed" as const };
    const note = [a.ok !== f.ok ? `The agent reads this differently (it would mark it ${a.ok ? "met" : "not met"}); the observed result stands.` : "", a.note].filter(Boolean).join(" ").trim();
    return { ...f, source: "observed" as const, ...(note ? { note } : {}) };
  });
}

/** The record kept with the repo of what the agent contributed to the assessment. */
export function assessorOf(r: AgentResult, run: Omit<OnboardAssessor, "mode" | "risk" | "summary" | "commands" | "forPeople" | "guidelineSuggestions">): OnboardAssessor {
  return {
    mode: "agent", ...run,
    ...(r.risk ? { risk: r.risk } : {}), ...(r.summary ? { summary: r.summary } : {}), ...(Object.keys(r.commands).length ? { commands: r.commands } : {}),
    ...(r.forPeople.length ? { forPeople: r.forPeople } : {}), ...(r.guidelineSuggestions.length ? { guidelineSuggestions: r.guidelineSuggestions } : {}),
  };
}

/** What AGENTS.md needs from a draft. */
export type AgentsDraft = NonNullable<AgentResult["agentsMd"]>;

/** The authorship a file or pull request states about itself. */
export interface Authorship { mode: "rule-based" | "agent"; agent?: string; version?: number; model?: string }

export function authorshipOf(a: OnboardAssessor | null | undefined): Authorship {
  return a && a.mode === "agent" ? { mode: "agent", ...(a.agent ? { agent: a.agent } : {}), ...(a.version !== undefined ? { version: a.version } : {}), ...(a.model ? { model: a.model } : {}) } : { mode: "rule-based" };
}

/** The sentence a file or pull request carries about who wrote it. */
export function authorLine(a: Authorship | undefined, what: "file" | "pr"): string {
  if (a?.mode === "agent") return `Drafted by Gantry's Onboarding Agent${a.version !== undefined ? ` v${a.version}` : ""}${a.model ? ` (model ${a.model})` : ""}; reviewed facts observed by Gantry.`;
  return what === "file"
    ? "Written by Gantry from this repository's own files (rule-based, no AI agent involved); edit it like any other file."
    : "Opened by Gantry. The files were written by rule-based logic from the repository's own files; no AI agent was involved.";
}

/** The short label the UI and the pull request show for an assessor. */
export function assessorLabel(a: OnboardAssessor | null | undefined): string {
  if (!a || a.mode !== "agent") return "rule-based (no agent)";
  return `Onboarding Agent${a.version !== undefined ? ` v${a.version}` : ""}${a.model ? ` · model ${a.model}` : ""}`;
}
