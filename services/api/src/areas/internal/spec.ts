import type { Queryable } from "@gantry/db";
import { REPO_CONTEXT_LAYER_NAME, RepoContext, renderRepoContext } from "@gantry/domain";
import { compactPrevious, type StationResultRow } from "./previous.js";
import { agentConfig } from "./metering.js";
import { testCommandRules } from "../onboarding/testcmd.js";
import { dialogueHandoff, latestDocuments } from "../workorders/documents.js";
import { commentsHandoff } from "../workorders/doccollab.js";
import { planOf, researchHosts, sourcesHandoff } from "../workorders/research.js";
import { swarmOf } from "../workorders/swarm.js";
import { readSecurity } from "../../core/read/index.js";
import type { RunCtx } from "./context.js";
import { scopeVerdict, type ScopeRow } from "../mcp/scope.js";
import { assemble, composedParts, composeLayers, loadAgentVersion, resolveSkills, type InstructionPin, type Layer, type SkillOut } from "../agents/compose.js";
import { buildManifest, type PromptManifest } from "../agents/manifest.js";

const HEARTBEAT_SECONDS = 15;
/** The lease a heartbeat grants: six missed heartbeats (spec 4.3 step 5). */
export const LEASE_SECONDS = HEARTBEAT_SECONDS * 6;

const READ_TOOLS = ["Read", "Glob", "Grep"];
/** "May run tests" is a set of test commands, never a bare `Bash`: an unrestricted shell would run whatever injected text asks for. Mirrors runner/wrapper/src/tools.ts. */
export const TEST_COMMANDS = ["Bash(npm test:*)", "Bash(npm run test:*)", "Bash(npx vitest:*)", "Bash(npx jest:*)", "Bash(pnpm test:*)", "Bash(yarn test:*)", "Bash(pytest:*)", "Bash(python -m pytest:*)", "Bash(go test:*)", "Bash(cargo test:*)"];
/** "May write the branch" includes recording the work: the platform publishes the commits in the workspace, so a Build that cannot `git commit` delivers nothing. Local, non-network git only. */
export const GIT_COMMANDS = ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git add:*)", "Bash(git commit:*)"];
const UNRESTRICTED_SHELL = /^Bash(?:\(\s*(?:\*+|:\*+)?\s*\))?$/;
const TOOL_NAMES: Record<string, string[]> = {
  readRepo: READ_TOOLS,
  writeBranch: ["Edit", "Write", "NotebookEdit", ...GIT_COMMANDS],
  runTests: TEST_COMMANDS,
};

/** The tool allow-list: an explicit list on the agent version wins, then the legacy tools flags, then read-only. */
export function toolAllowList(body: Record<string, unknown>, data: Record<string, unknown>): string[] {
  const explicit = body.toolAllowList ?? data.toolAllowList;
  if (Array.isArray(explicit)) {
    const out = new Set<string>();
    for (const t of explicit) {
      if (typeof t !== "string" || !t) continue;
      if (UNRESTRICTED_SHELL.test(t.trim())) for (const c of TEST_COMMANDS) out.add(c);
      else out.add(t);
    }
    return [...out];
  }
  const flags = (body.tools ?? data.tools) as Record<string, unknown> | undefined;
  if (flags && typeof flags === "object") {
    const out = new Set<string>();
    for (const [k, on] of Object.entries(flags)) if (on === true) for (const t of TOOL_NAMES[k] ?? []) out.add(t);
    return [...out];
  }
  return READ_TOOLS;
}

/**
 * "May run tests" also covers the project's own test command, once a person confirmed it (repo_config.data.testCommands, set in the repository's settings; onboarding
 * only proposes it). Each becomes `Bash(<command>:*)`. An agent that holds no test command gets none, and nothing here ever adds a bare `Bash`.
 */
export function withProjectTests(list: string[], confirmed: unknown): string[] {
  if (!list.some((t) => (TEST_COMMANDS as string[]).includes(t))) return list;
  return [...new Set([...list, ...testCommandRules(confirmed)])];
}

export interface ComposedInstructions {
  text: string;
  hash: string;
  layers: { name: string; hash: string; version?: number | null }[];
  /** The layers that were used (non-empty), with their text, for the prompt manifest. */
  used: Layer[];
}

/**
 * Spec 10.2: factory base, project overlay, agent, repository guidelines (at the pinned commit). Layers with no content are left out.
 * The run's own pin (written when it was dispatched) decides the layer versions and the guidelines text; a run with no pin reads the latest published ones.
 */
export async function composeInstructions(db: Queryable, c: RunCtx): Promise<ComposedInstructions> {
  const agent = await agentConfig(db, c);
  const av = c.agentId ? await loadAgentVersion(db, c.orgId, c.agentId, c.agentVersion) : null;
  const pin = c.runData.instructionPin && typeof c.runData.instructionPin === "object" ? (c.runData.instructionPin as InstructionPin) : null;
  const { layers } = await composeLayers(db, { orgId: c.orgId, agentId: c.agentId, projectId: c.projectId, repoId: c.repoId, pin, fallbackAgentText: agent.instructions, fallbackOverlay: c.overlay }, av);
  const out = assemble(layers);
  return { text: out.text, hash: out.hash, layers: out.layers.map((l) => ({ name: l.name, hash: l.hash, version: l.version })), used: out.layers };
}

/**
 * The repository's convention files as Gantry read them at the pinned commit when it seeded the workspace (recorded on the run by dispatch), framed as repository
 * data with a stated precedence. Appended after the layers: it informs how to work in the repo and ranks below the factory base, overlay and agent text.
 * The harness's own CLAUDE.md loader stays disabled, so this is the only way repository conventions reach the model.
 */
export function repoContextSection(c: Pick<RunCtx, "runData">): string {
  const parsed = RepoContext.safeParse(c.runData.repoContext);
  const body = parsed.success ? renderRepoContext(parsed.data) : "";
  return body ? `## ${REPO_CONTEXT_LAYER_NAME}\n\n${body}` : "";
}

async function skillsFor(db: Queryable, c: RunCtx): Promise<SkillOut[]> {
  if (!c.agentId) return [];
  const av = await loadAgentVersion(db, c.orgId, c.agentId, c.agentVersion);
  return resolveSkills(db, { orgId: c.orgId, agentId: c.agentId, body: av?.body ?? {}, projectId: c.projectId, versions: c.skillVersions });
}

/** Enabled MCP servers whose scope covers this run: project (and the project's own enable list), repo, agent, station and work class (spec 12.4). */
export async function mcpServersInScope(db: Queryable, c: RunCtx): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<ScopeRow & { server_id: string; name: string }>(
    `select s.id as server_id, s.name, sc.projects, sc.repos, sc.agents, sc.stations, sc.classes from mcp_servers s join mcp_scopes sc on sc.org_id = s.org_id and sc.server_id = s.id
      where s.org_id = $1 and s.enabled order by s.id`,
    [c.orgId],
  );
  const enabled = Array.isArray(c.projectConfig.mcp) ? (c.projectConfig.mcp as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const seen = new Map<string, string>();
  for (const r of rows) {
    const v = scopeVerdict(r, { project: c.projectId, projectEnabled: enabled, serverId: r.server_id, repo: c.repoId, agent: c.agentId, station: c.station, cls: c.woClass }, { server: r.name });
    if (!v) seen.set(r.server_id, r.name);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** The name a harness knows a server by. Tool names are `mcp__<name>__<tool>` and may hold only letters, digits, `_` and `-`, so a registry name like "Docs wiki" becomes `docs-wiki`; a clash falls back to the id. */
export function mcpKey(s: { id: string; name: string }, all: Array<{ id: string; name: string }>): string {
  const key = s.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || s.id;
  return all.some((o) => o.id !== s.id && o.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) === key) ? s.id : key;
}

export interface RunSpecOut {
  runId: string;
  adapter: "claude" | "stub";
  station: string;
  model?: string;
  instructions: string;
  instructionsHash: string;
  /** Everything the system prompt is made of, in order, with versions and hashes; `promptManifest.hash` covers all of it. */
  promptManifest: PromptManifest;
  skills: { name: string; content: string }[];
  mcpServers: Record<string, { type: "http"; url: string }>;
  toolAllowList: string[];
  limits: { turns: number; costUsd?: number; wallClockSeconds: number };
  heartbeatSeconds: number;
  leaseSeconds: number;
  input?: unknown;
  stub?: unknown;
}

/** What the runner wrapper's `RunSpec` expects (runner/wrapper/src/spec.ts). Returns null when a claude run has no model. */
export async function composeRunSpec(db: Queryable, c: RunCtx, edgeUrl: string): Promise<RunSpecOut | { error: string }> {
  const agent = await agentConfig(db, c);
  const model = c.runModel ?? c.tupleModel ?? undefined;
  // No model is never a silent stub: the stub adapter runs only when the run was explicitly marked as one (tests and local development).
  const adapter = c.runData.adapter === "stub" ? "stub" : "claude";
  if (adapter === "claude" && !model) return { error: "This agent has no model, so the run cannot start. Choose a model for the agent and run it again." };
  const inst = await composeInstructions(db, c);
  // An onboarding agent step (a hidden carrier) reads the seeded repository and answers: read-only tools, no MCP servers, whatever the agent version's own settings say.
  const carrier = typeof c.woData.onboarding === "object" && c.woData.onboarding !== null;
  const mcp = carrier ? [] : await mcpServersInScope(db, c);
  // A run's rails come from the agent version it was pinned to. The agent's working copy (a draft) is only read for a run with no version at all, so an unpromoted edit never widens a live run.
  const draft = Object.keys(agent.body).length ? {} : agent.data;
  const lim = (agent.body.limits ?? draft.limits ?? {}) as { turns?: unknown; wallClockSeconds?: unknown };
  const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  const agentBudget = typeof agent.budgetUsd === "number" && agent.budgetUsd > 0 ? agent.budgetUsd : undefined;
  // An approved research plan's budget caps the run too (the lower of the two wins).
  const planBudget = planOf(c.woData)?.status === "approved" ? (planOf(c.woData)?.budgetUsd ?? undefined) : undefined;
  const costUsd = agentBudget !== undefined && planBudget ? Math.min(agentBudget, planBudget) : (planBudget ?? agentBudget);
  const input = c.runData.input ?? c.attemptData.input ?? (await handoff(db, c));
  const skills = await skillsFor(db, c);
  const confirmedTests = carrier || !c.repoId ? null : (await db.query<{ t: unknown }>(`select data->'testCommands' as t from repo_config where org_id = $1 and repo_id = $2`, [c.orgId, c.repoId])).rows[0]?.t;
  // The repository's own convention files follow the layers; they are a manifest part of their own, so the hash covers them.
  const repoSection = repoContextSection(c);
  const instructionsText = [inst.text, repoSection].filter((x) => x !== "").join("\n\n");
  const promptManifest = buildManifest("run", composedParts(inst.used, skills, repoSection), { handoff: input ?? "" });
  return {
    runId: c.runId,
    adapter,
    station: c.station,
    ...(model ? { model } : {}),
    instructions: instructionsText,
    instructionsHash: promptManifest.hash,
    promptManifest,
    skills: skills.map((s) => ({ name: s.name, content: s.content })),
    mcpServers: Object.fromEntries(mcp.map((s) => [mcpKey(s, mcp), { type: "http" as const, url: `${edgeUrl.replace(/\/+$/, "")}/mcp/v1/${encodeURIComponent(s.id)}` }])),
    toolAllowList: carrier ? READ_TOOLS : withProjectTests(toolAllowList(agent.body, draft), confirmedTests),
    limits: { turns: pos(lim.turns) ?? 40, ...(costUsd ? { costUsd } : {}), wallClockSeconds: pos(lim.wallClockSeconds) ?? 3600 },
    heartbeatSeconds: HEARTBEAT_SECONDS,
    leaseSeconds: LEASE_SECONDS,
    ...(input !== undefined ? { input } : {}),
    ...(c.runData.stub !== undefined ? { stub: c.runData.stub } : {}),
  };
}

/**
 * What the platform observed Build deliver (the `run.published` event), stated as a fact for the stations after it. When Build published no commit it says so plainly:
 * the agent judges what that means for each criterion (an unchanged repository cannot show a requested change); code only supplies the fact.
 */
export async function changeFact(db: Queryable, c: RunCtx, prior: StationResultRow[]): Promise<Record<string, unknown> | null> {
  if (c.station === "build" || !prior.some((r) => r.station === "build")) return null;
  const ev = (await db.query<{ after: { commits?: number; noop?: boolean; headSha?: string | null; pr?: number | null; branch?: string } | null }>(
    `select after from events where org_id = $1 and wo_id = $2 and type = 'run.published' order by seq desc limit 1`, [c.orgId, c.woId],
  )).rows[0]?.after;
  const commits = Number(ev?.commits ?? 0);
  const seed = (c.runData?.seed ?? {}) as { base?: unknown; baseBranch?: unknown };
  const baseSha = typeof seed.base === "string" && /^[0-9a-f]{40}$/.test(seed.base) ? seed.base : null;
  // The workspace holds the base commit (the target branch head) next to the head, so the change is read offline: no network git, no token.
  const base = baseSha
    ? { baseSha, baseBranch: typeof seed.baseBranch === "string" ? seed.baseBranch : null, diffCommand: `git diff ${baseSha}...${ev?.headSha ?? "HEAD"}`, baseNote: "Your workspace holds the target branch head (baseSha) as well as the work branch head, so the diff above works offline. A checkout with no parent for the head is normal here: the base is baseSha." }
    : !c.repoId ? {} : { baseSha: null, baseNote: "No base commit could be placed in your workspace, so the change against the target branch cannot be diffed there. Say so rather than judging the head commit alone as if it added every file." };
  if (ev && commits > 0) return { observedBy: "platform", commits, headSha: ev.headSha ?? null, branch: ev.branch ?? null, pullRequest: ev.pr ?? null, diff: "present", ...base };
  return {
    observedBy: "platform", commits: 0, headSha: null, diff: "none", ...base,
    note: ev ? "The platform published no commit from Build: the work branch has no change against the base branch. Whatever Build reported, the repository is unchanged, so a criterion about the change cannot pass on this; say so in your result." : "The platform has no record that Build published a commit. Check the repository itself before you pass a criterion about the change.",
  };
}

/** Station handoff (spec 10.2): the latest confirmed brief and the previous stations' structured results, not a transcript. */
async function handoff(db: Queryable, c: RunCtx): Promise<unknown> {
  const brief = (await db.query(`select body from brief_versions where org_id = $1 and wo_id = $2 order by version desc limit 1`, [c.orgId, c.woId])).rows[0]?.body;
  const prior = (
    await db.query(
      `select station, outcome, summary, body from station_results where org_id = $1 and wo_id = $2 and attempt_id <> $3 order by created_at`,
      [c.orgId, c.woId, c.attemptId],
    )
  ).rows;
  const title = (await db.query(`select title from work_orders where org_id = $1 and id = $2`, [c.orgId, c.woId])).rows[0]?.title;
  // Phase 1: the documents the earlier stations (and earlier runs of this one) wrote, and what was asked, answered and assumed, so the
  // agent starts from what was settled and does not ask again.
  const documents = await latestDocuments(db, c.orgId, c.woId, { exceptAttempt: c.attemptId });
  const dialogue = { ...(await dialogueHandoff(db, c.orgId, c.woId)), documentComments: await commentsHandoff(db, c.orgId, c.woId) };
  const sources = await sourcesHandoff(db, c.orgId, c.woId);
  const plan = planOf(c.woData);
  const research = {
    plan: plan ? { status: plan.status, questions: plan.questions, hosts: plan.hosts, web: plan.web, budgetUsd: plan.budgetUsd, ...(plan.note ? { note: plan.note } : {}) } : null,
    readableHosts: await researchHosts(db, c.orgId, c.woData),
    factoryAllowList: (await readSecurity(db, c.orgId)).value.researchHosts ?? [],
  };
  // Phase 3: a scout gets its own question; the run after a swarm gets what each scout did (their documents are in `documents`).
  const sc = c.attemptData.scout as { id: string; question: string; focus: string } | undefined;
  const sw = swarmOf(c.woData);
  const scouts = !sc && sw?.endedAt && sw.station === c.station ? sw.scouts.map((x) => ({ id: x.id, question: x.question, focus: x.focus, state: x.state, summary: x.summary ?? "" })) : undefined;
  const change = await changeFact(db, c, prior as StationResultRow[]);
  return {
    workOrder: { id: c.woId, title, class: c.woClass }, brief: brief ?? null, ...(change ? { change } : {}), previous: compactPrevious(prior as StationResultRow[], c.woId), documents, dialogue, sources, research,
    ...(sc ? { scout: { id: sc.id, question: sc.question, focus: sc.focus, note: `You are scout ${sc.id}. Answer only this question, write your findings to research/scout-${sc.id.toLowerCase()}.md with write_document, cite web sources, and end. You cannot send scouts or propose a plan.` } } : {}),
    ...(scouts ? { scouts } : {}),
  };
}
