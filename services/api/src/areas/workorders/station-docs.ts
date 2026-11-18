/**
 * Every station leaves a document a person can read.
 *
 * The agent writes its own document with `write_document` (G-01: agents author). When a run succeeds without writing its primary document
 * (`<station>.md`), or a stage has no agent run at all (the brief), Gantry records the agent's own structured result as a plain markdown
 * rendering: its fields verbatim, plus facts Gantry observed (files, checks, head commit). Nothing is composed beyond headings and layout,
 * and the document says it was recorded from the result, so nobody mistakes it for the agent's prose.
 */
import type { Tx } from "@gantry/db";
import { recordDocument } from "./documents.js";
import type { StationResult } from "./station.js";

const hash = async (s: string): Promise<string> => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");
const MAX_DOC = 150_000;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const label = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

/** A value as markdown lines: strings as text, lists as bullets, objects as `key: value` bullets (nested by indentation). */
function render(v: unknown, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (v === null || v === undefined || v === "") return [];
  if (typeof v === "string") return v.includes("\n") && depth === 0 ? [v] : [`${pad}${depth ? "- " : ""}${oneLine(v)}`];
  if (typeof v === "number" || typeof v === "boolean") return [`${pad}${depth ? "- " : ""}${String(v)}`];
  if (Array.isArray(v)) {
    return v.flatMap((x) => {
      if (isObj(x)) {
        const parts = Object.entries(x).filter(([, y]) => typeof y !== "object" && y !== null && y !== "").map(([k, y]) => `${k}: ${oneLine(String(y))}`);
        const nested = Object.entries(x).filter(([, y]) => typeof y === "object" && y !== null);
        return [`${pad}- ${parts.join(" · ") || "item"}`, ...nested.flatMap(([k, y]) => [`${pad}  - ${k}:`, ...render(y, depth + 2)])];
      }
      return render(x, depth + 1);
    });
  }
  if (isObj(v)) return Object.entries(v).flatMap(([k, y]) => (typeof y === "object" && y !== null ? [`${pad}- ${k}:`, ...render(y, depth + 1)] : y === "" || y === undefined || y === null ? [] : [`${pad}- ${k}: ${oneLine(String(y))}`]));
  return [];
}

/** The markdown for a station result that came with no document of its own. */
export function documentFromResult(stationName: string, result: StationResult): string {
  const out = isObj(result.output) ? result.output : {};
  const lines: string[] = [`# ${stationName}`, "", "_Recorded by Gantry from this run's structured result: the agent wrote no document of its own. The fields below are the agent's, unchanged._", ""];
  if (result.summary) lines.push("## Summary", "", result.summary, "");
  for (const [k, v] of Object.entries(out)) {
    if (k === "summary" || k === "documents" || k === "dialogue") continue;
    const body = render(v);
    if (body.length) lines.push(`## ${label(k)}`, "", ...body, "");
  }
  const o = result.observed;
  if (o) {
    const facts: string[] = [];
    if (o.headSha) facts.push(`- Head commit: ${o.headSha}`);
    for (const f of o.files ?? []) facts.push(`- File: ${f.path} (+${f.additions ?? 0} −${f.deletions ?? 0})`);
    for (const c of o.checks ?? []) facts.push(`- Check ${c.name}: ${c.ok ? "passed" : "failed"}${c.note ? ` (${oneLine(c.note)})` : ""}`);
    if (o.tests) facts.push(`- Tests: ${o.tests.passed} passed, ${o.tests.failed} failed, ${o.tests.added} added`);
    if (facts.length) lines.push("## Observed by Gantry", "", ...facts, "");
  }
  return lines.join("\n").trimEnd().slice(0, MAX_DOC) + "\n";
}

/** After a succeeded run: when the agent left no `<station>.md`, record its result as that document. Returns the document id, or null when one exists. */
export async function ensureStationDocument(tx: Tx, d: { orgId: string; woId: string; attemptId: string; station: string; stationName: string; result: StationResult }): Promise<string | null> {
  const name = `${d.station}.md`;
  const have = await tx.query(`select 1 from artefacts where org_id = $1 and wo_id = $2 and attempt_id = $3 and doc = $4`, [d.orgId, d.woId, d.attemptId, name]);
  if (have.rowCount) return null;
  const body = documentFromResult(d.stationName, d.result);
  const id = `art-${d.attemptId}-${d.station}-result`;
  await recordDocument(tx, { orgId: d.orgId, id, woId: d.woId, attemptId: d.attemptId, station: d.station, name, hash: await hash(body), mediaType: "text/markdown; charset=utf-8", size: body.length, body, author: null, authorKind: "system" });
  return id;
}

interface BriefLike { goal?: unknown; scopeIn?: unknown; scopeOut?: unknown; ac?: unknown; risks?: unknown; open?: unknown; decisions?: unknown; estimate?: unknown; note?: unknown }
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** The confirmed brief as brief.md (the Intake station's document). */
export function briefMarkdown(brief: BriefLike, o: { version: number; cls: string; route: string[]; by: string }): string {
  const sec = (title: string, items: string[]): string[] => (items.length ? [`## ${title}`, "", ...items.map((i) => `- ${oneLine(i)}`), ""] : []);
  return [
    `# Brief (version ${o.version})`, "",
    `Class: ${o.cls} · Route: ${o.route.join(" → ") || "none"} · Confirmed by: ${o.by}${typeof brief.estimate === "string" && brief.estimate ? ` · Estimate: ${brief.estimate}` : ""}`, "",
    ...(typeof brief.goal === "string" && brief.goal ? ["## Goal", "", brief.goal, ""] : []),
    ...sec("In scope", list(brief.scopeIn)), ...sec("Out of scope", list(brief.scopeOut)), ...sec("Acceptance criteria", list(brief.ac)),
    ...sec("Risks", list(brief.risks)), ...sec("Open questions", list(brief.open)), ...sec("Decisions", list(brief.decisions)),
    ...(typeof brief.note === "string" && brief.note ? ["## Note", "", brief.note, ""] : []),
  ].join("\n").trimEnd() + "\n";
}

export async function recordBriefDocument(tx: Tx, d: { orgId: string; woId: string; version: number; brief: BriefLike; cls: string; route: string[]; by: string; byName: string }): Promise<void> {
  const body = briefMarkdown(d.brief, { version: d.version, cls: d.cls, route: d.route, by: d.byName });
  await recordDocument(tx, { orgId: d.orgId, id: `art-brief-${d.woId}-v${d.version}`, woId: d.woId, attemptId: null, station: "intake", name: "brief.md", hash: await hash(body), mediaType: "text/markdown; charset=utf-8", size: body.length, body, author: null, authorKind: "system" });
}
