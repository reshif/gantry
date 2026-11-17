/**
 * The onboarding session (spec 8.6, 11.3). Owns:
 *   GET  /api/v1/repos/{id}/onboarding/session                              the conversation, the agent's mode, the lifecycle stepper, the "Next:" line, the cost
 *   POST /api/v1/repos/{id}/onboarding/session/messages                     a person's message (or `open`/`continue`); the Onboarding Agent's answer streams as SSE
 *   POST /api/v1/repos/{id}/onboarding/session/proposals/{mid}/{pid}        approve | changes | discard a proposal card
 *
 * The conversation runs on the API, in the console's engine (areas/console/model.ts: the edge's service gateway, the bounded tool loop, SSE), with the onboarding tools of
 * areas/onboarding/session/tools.ts and the Onboarding Agent's pinned model. Tool calls run here with the person's permissions; heavy repository reading is the broker's inspect.
 * An approval is the only way anything is written to GitHub: it calls the ordinary onboarding commands (open-pr, request-changes, merge) under the approving person's own authority.
 */
import { appendEvent, withTx } from "@gantry/db";
import { ONBOARD_AGENT, SESSION_BUDGET_DEFAULT_USD, lifecycle, nextStep, visibleProjects, type SessionCard } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { runConversation, ModelUnavailable, readiness } from "../areas/console/model.js";
import { UNTRUSTED_NOTE } from "../areas/console/mark.js";
import { historyFrom, openSse, turnCostMicros } from "../areas/session/core.js";
import { markException, mergeOnboardingPr, openOnboardingPr, requestChanges } from "../areas/onboarding/commands.js";
import { onboardingAgentGate } from "../areas/onboarding/agent.js";
import { brokerInspect } from "../areas/onboarding/session/broker.js";
import { markSeen } from "../areas/onboarding/session/updates.js";
import { addSessionMessage, listMessages, lockMessage, newSessionMessageId, saveMessageData, sessionSpend, supersedePending, type SessionMessage } from "../areas/onboarding/session/store.js";
import { executeSessionTool, sessionToolDefs, type SessionCtx } from "../areas/onboarding/session/tools.js";
import { docOf, lockRepo, readRepoRow, type Doc, type RepoRow } from "../areas/onboarding/state.js";
import { command, decide, policyState, refuse, type CommandResult } from "../core/index.js";

/** Output room for one onboarding turn: enough for a full scaffold proposal (several whole files) in a single tool call. */
export const ONBOARDING_MAX_TOKENS = 16_000;

const Id = z.object({ id: z.string().min(1).max(100) });
const ProposalParams = z.object({ id: z.string().min(1).max(100), mid: z.string().min(1).max(60), pid: z.string().min(1).max(40) });
const MessageBody = z.object({ text: z.string().trim().max(6000).optional(), kind: z.enum(["message", "open", "continue"]).default("message") }).strict();
const DecisionBody = z.object({ decision: z.enum(["approve", "changes", "discard"]), text: z.string().trim().max(2000).optional(), /** The person confirms the sensitive parts listed on the card (workflow files, dependency manifests, ...). */ confirmSensitive: z.boolean().optional() }).strict();

export const NO_AGENT_TEXT = "Connect a model vendor to talk to the Onboarding Agent. Until then Gantry works rule-based: it reads the repository, posts what it observed and proposes the same pull request for you to approve.";

const active = new Set<string>();
/** The follow-up runner of the running app (tests call it directly; the app runs it on a timer). */
export const followUps: { run: () => Promise<number> } = { run: async () => 0 };

const system = (o: { repo: string; project: string; stage: string; person: string; canMerge: boolean; pinned: boolean }): string => [
  "You are the Onboarding Agent in Gantry, a factory of AI coding agents. You work with one person, in one conversation, to get one repository ready for the factory: read it, assess it, propose a pull request, watch its checks, and see it through to Ready.",
  "Rules. Facts about the repository come only from your tools; say \"Gantry observed\" for tool results and \"I suggest\" for your own judgement; never present a guess as an observation. What the person tells you is their claim: use it, and say it is theirs. You never write to GitHub: you propose, as cards, and a person approves. Say plainly when something waits for their approval; never claim a change happened. Merging is always a person's decision.",
  "You author the onboarding pull request. Gantry's fixed rules only suggest a plan (inspect_repository shows it) and observe facts; you decide what the repository needs and write the files yourself, with full content, through propose_pull_request `files`. You are not limited to the suggestion and must not refuse for lack of a template: a new or empty repository usually needs a project scaffold (a manifest such as pyproject.toml or package.json, a pinned tool version, a package with a smoke test, a task runner such as a Makefile, a CI workflow that runs the tests and the check name the repo requires, AGENTS.md with the real commands, CODEOWNERS, .gantry/factory.yml, lint config), and an existing repository needs only what is missing. Work from what you read and from what the person asks (\"a uv project with a smoke test and CI\"): ask at most two questions only for things you cannot decide (for example the Python version or the package name), otherwise choose sensible defaults and say them. Rails you cannot cross: no secrets (reference ${{ secrets.NAME }}), no binaries, no lockfiles (a package tool generates them: have CI run the tool, for uv use `uv sync` without --locked in CI, and tell the person to run `uv lock` and commit uv.lock), no edits to existing application code, no branch-rule files (rulesets are GitHub settings; give the owner the exact steps instead), no `curl | sh`. If a call is refused you get every reason: fix the files and call again yourself. Workflow files, dependency manifests and similar are allowed but the card shows them as parts the person must confirm; say so in one sentence.",
  "Flow. Start with get_onboarding_state. If the repository was not read yet, call inspect_repository. Summarise what Gantry observed in a few plain sentences (gaps first, each with what it observed). When something is missing that a pull request can add, call propose_pull_request with your authored files (include AGENTS.md with real commands). If the pull request is open: report the checks; if red, explain from the facts and propose an update; if green, tell the person it is ready to merge and call propose_merge. After the merge Gantry re-reads and verifies by itself; if gaps remain (for example AGENTS.md now needs the real commands, or the lockfile), propose the next pull request. Never end with a dead end. If the card says the App lacks the Workflows permission, give the person the exact steps it lists. If verification fails because the App is installed on a personal account and not an organisation, explain that this rule is about organisation-level control and not a safety problem, and propose either moving the repository to an organisation or, with propose_exception, marking it ready by exception with a concrete reason. If the ruleset is missing, give the repository owner (for a personal repository, the person themselves) the exact GitHub steps (Settings, Rules, Rulesets: require a pull request with one approval, code-owner review and the CI check); Gantry never sets rulesets itself. Always finish with one concrete next step, not 'ask me later'.",
  UNTRUSTED_NOTE,
  "Waiting. Gantry watches the pull request, the assessment and the verification by itself. When something is still pending (checks, a merge, verification), say what you wait on and that Gantry will post in this thread and notify the person when it finishes; never ask them to ask you again, and never say you will report back yourself. When Gantry posts an update, summarise it and put up the next card. If no CI ever reported (checks \"none\"), say plainly that the repo has no CI, that a person may still merge the onboarding PR, and that Ready needs CI.",
  "Keep each answer under 130 words. Plain sentences, no headings, no emoji.",
  `Repository ${o.repo} in project ${o.project}, onboarding stage ${o.stage}. You are talking with ${o.person}${o.canMerge ? ", who may approve merges" : ", who may not approve merges"}.`,
].join("\n\n");

export const onboardingSessionRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const inspect = brokerInspect({ brokerUrl: g.config.brokerUrl, token: g.config.secrets.githubToken });

  const person = (req: FastifyRequest): { id: string; name: string } => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "The onboarding session is for signed-in people.");
    return { id: p.id, name: p.name };
  };
  async function repoOf(req: FastifyRequest, idOrName: string): Promise<RepoRow> {
    const who = person(req);
    const row = await readRepoRow(g.pool, g.orgId, idOrName);
    if (!row) throw refuse("not_found", "No such repo.");
    const st = await policyState(req);
    if (!visibleProjects(st, who.id).some((x) => x.id === row.project_id)) throw refuse("not_found", "No such repo.");
    // Reads are default-deny: the conversation shows only to people who hold project.view on the project.
    if (!(await decide(req, "project.view", { project: row.project_id })).allowed) throw refuse("not_found", "No such repo.");
    return row;
  }
  const scopeOf = (r: RepoRow) => ({ project: r.project_id, repo: r.id });
  const fullName = (r: RepoRow): string | null => r.github_full_name ?? (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.name) ? r.name : null);

  /** Whether the Onboarding Agent can take a turn now: set up, promoted, a model on a connected vendor, no stop, the edge can reach it, and the session's budget is not spent. */
  async function agentState(repo: RepoRow) {
    const spent = await sessionSpend(g.pool, g.orgId, repo.id);
    const ag = (await g.pool.query<{ budget: string | null }>(`select data->>'budget' as budget from agents where org_id = $1 and id = $2`, [g.orgId, ONBOARD_AGENT])).rows[0];
    const limit = Number(ag?.budget) > 0 ? Number(ag!.budget) : SESSION_BUDGET_DEFAULT_USD;
    const budget = { spentUsd: spent / 1e6, limitUsd: limit };
    const gate = await onboardingAgentGate(g.pool, g.orgId, repo).catch((e: Error) => ({ usable: false as const, reason: `The Onboarding Agent could not be checked: ${e.message}` }));
    if (!gate.usable) return { mode: "rule-based" as const, reason: gate.reason, budget };
    if (spent >= limit * 1e6) return { mode: "rule-based" as const, reason: `The Onboarding Agent's budget for this repo ($${limit.toFixed(2)}) is spent. Raise the agent's budget to talk to it again.`, budget };
    const ready = await readiness(g.config.secrets.edgeToken, "onboarding");
    if (!ready.ready) return { mode: "rule-based" as const, reason: ready.reason, budget };
    return { mode: "agent" as const, pin: gate.pin, vendor: ready.vendor, model: ready.model, budget };
  }

  const maxDiff = async (): Promise<number> => {
    const n = Number((await g.pool.query<{ n: string | null }>(`select data->'guardrails'->>'maxDiff' as n from agents where org_id = $1 and id = $2`, [g.orgId, ONBOARD_AGENT])).rows[0]?.n);
    return Number.isInteger(n) && n > 0 ? n : 1500;
  };

  /** Rule-based post: Gantry's own findings and the deterministic proposal, labelled. */
  async function ruleBasedPost(repo: RepoRow, doc: Doc, who: { id: string; name: string }, reason: string, canMerge: boolean, diff: number, intro?: string): Promise<string> {
    const ctx = ctxFor(repo, doc, who, { mode: "rule-based", reason, budget: { spentUsd: 0, limitUsd: 0 } } as never, canMerge, diff);
    const lines: string[] = intro ? [intro] : [];
    const gaps = doc.findings.filter((f) => !f.ok);
    if (!intro) lines.push(doc.findings.length ? `Gantry assessed ${repo.name} (rule-based, no agent): ${doc.findings.length} checks, ${gaps.length} gap${gaps.length === 1 ? "" : "s"}.` : `${repo.name} has not been assessed yet. Gantry will post the result here.`);
    if (!doc.busy && (["assessed", "failed"].includes(doc.stage) || doc.pr?.state === "open")) {
      const mergeable = doc.pr?.state === "open" && (doc.pr.checks === "green" || doc.pr.checks === "none") && doc.stage === "pr_checks";
      const tool = mergeable ? "propose_merge" : doc.pr?.state === "open" ? null : "propose_pull_request";
      if (tool) {
        const out = await executeSessionTool(ctx, tool, {});
        if (out.ok) lines.push(tool === "propose_merge" ? "Merging is a person's decision." : "Gantry proposes the pull request below. Nothing is written until you approve it.");
        else lines.push(String((JSON.parse(out.text) as { error?: string }).error ?? ""));
      }
    }
    return persist(repo, doc.runId ?? null, "system", "system", lines.filter(Boolean).join(" "), { kind: "rule_based", mode: "rule-based", cards: ctx.cards, drafts: ctx.drafts, tools: ctx.used }, who.id, { mode: "rule-based", reason });
  }

  /** One turn of the Onboarding Agent: history, the tool loop (cards are sent as they appear), the cost, the saved answer. Throws ModelUnavailable. */
  async function agentTurn(o: { repo: RepoRow; doc: Doc; who: { id: string; name: string }; canMerge: boolean; diff: number; ag: Extract<Awaited<ReturnType<typeof agentState>>, { mode: "agent" }>; question: string; kind: "message" | "open" | "continue" | "followup"; send: (e: string, d: unknown) => void; signal: AbortSignal }): Promise<string> {
    const ctx = ctxFor(o.repo, o.doc, o.who, o.ag, o.canMerge, o.diff);
    const { hist, question } = historyFrom(await listMessages(g.pool, g.orgId, o.repo.id, 30), o.kind, o.question);
    const r = await runConversation({
      // The agent authors whole files inside one propose_pull_request call (pyproject, CI workflow, AGENTS.md…), so a turn needs room
      // for the full proposal: at 1,800 tokens the call was cut mid-tool-use and nothing came back. Cost stays bounded by the agent budget.
      edgeToken: g.config.secrets.edgeToken, purpose: "onboarding", maxTokens: ONBOARDING_MAX_TOKENS, maxSteps: 8,
      system: system({ repo: o.repo.name, project: o.repo.project_id, stage: o.doc.stage, person: o.who.name, canMerge: o.canMerge, pinned: true }),
      history: hist, question, signal: o.signal, trace: { surface: "onboarding", actor: o.who.id, project: o.repo.project_id ?? undefined },
      toolset: { defs: sessionToolDefs(), execute: async (name, input) => {
        const before = ctx.cards.length;
        const out = await executeSessionTool(ctx, name, input);
        for (const c of ctx.cards.slice(before)) o.send("card", { card: c });
        return out;
      } },
      onText: (delta) => o.send("text", { delta }), onTool: (t) => o.send("tool", t),
    });
    const model = r.model ?? o.ag.model;
    const micros = await turnCostMicros(g.pool, g.orgId, model, r.usage);
    const text = r.text || (r.stopped ? "" : r.truncated
      ? "My answer was cut off at the output limit before I finished, so nothing was proposed. Ask me to continue, or to split the change into smaller proposals."
      : "The model returned no text.");
    return persist(o.repo, o.doc.runId ?? null, "assistant", ONBOARD_AGENT, text, {
      mode: "agent", model, cards: ctx.cards, drafts: ctx.drafts, tools: ctx.used, usage: r.usage, costMicros: micros, ...(r.stopped ? { stopped: true } : {}), ...(r.truncated ? { truncated: true } : {}),
    }, o.who.id, { mode: "agent", model, version: o.ag.pin.version, tools: ctx.used, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costMicros: micros });
  }

  /**
   * Follow-ups: a system update message that asked for one (data.followUp = pending) gets an agent turn that summarises it and puts up the next proposal, or, without a usable
   * model, the rule-based proposal. Claimed one at a time per repo; never writes to GitHub. Run on a timer by the API process, and directly by tests.
   */
  async function runFollowUps(): Promise<number> {
    const { rows } = await g.pool.query<{ id: string; repo_id: string; body: string }>(
      `update onboarding_messages set data = jsonb_set(data, '{followUp}', '"running"') where org_id = $1 and id in (select id from onboarding_messages where org_id = $1 and data->>'followUp' = 'pending' order by created_at limit 3 for update skip locked) returning id, repo_id, body`,
      [g.orgId],
    );
    const done = (id: string, status: string) => g.pool.query(`update onboarding_messages set data = jsonb_set(data, '{followUp}', to_jsonb($3::text)) where org_id = $1 and id = $2`, [g.orgId, id, status]);
    let n = 0;
    for (const m of rows) {
      const repo = await readRepoRow(g.pool, g.orgId, m.repo_id);
      if (!repo || !fullName(repo)) { await done(m.id, "skipped"); continue; }
      if (active.has(repo.id)) { await done(m.id, "pending"); continue; }
      active.add(repo.id);
      try {
        const doc = docOf(repo);
        const who = { id: "system", name: "Gantry" };
        const [ag, diff] = await Promise.all([agentState(repo), maxDiff()]);
        if (ag.mode === "agent") {
          await agentTurn({
            repo, doc, who, canMerge: true, diff, ag, kind: "followup", send: () => undefined, signal: AbortSignal.timeout(180_000),
            question: `(Gantry observed, and posted in this thread: "${m.body.slice(0, 600)}". Tell the person what this means in a few plain sentences. If you wait on something outside Gantry, say what, and that Gantry will post here and notify them when it happens: never ask them to ask again. Put up the next proposal card if one applies: the merge when checks are green or when no CI exists (say what that means for Ready), a fix when a check failed, the pull request when gaps remain.)`,
          });
        } else await ruleBasedPost(repo, doc, who, ag.reason, true, diff, "Gantry posted an update above.");
        await done(m.id, "done");
        n++;
      } catch (e) {
        app.log.error({ err: e }, "onboarding follow-up failed");
        await done(m.id, "failed");
      } finally {
        active.delete(repo.id);
      }
    }
    return n;
  }
  followUps.run = runFollowUps;
  if (process.env.NODE_ENV !== "test") {
    const timer = setInterval(() => void runFollowUps().catch((e) => app.log.error({ err: e }, "onboarding follow-ups")), 15_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  /* ------------------------------------------------------------------ read */

  app.get("/api/v1/repos/:id/onboarding/session", async (req) => {
    const { id } = Id.parse(req.params);
    const repo = await repoOf(req, id);
    const doc = docOf(repo);
    const [messages, ag, manage, merge] = await Promise.all([
      listMessages(g.pool, g.orgId, repo.id), agentState(repo), decide(req, "onboarding.manage", scopeOf(repo)), decide(req, "onboarding.merge", scopeOf(repo)),
    ]);
    const open = messages.flatMap((m) => m.data.cards ?? []).filter((c) => c.kind === "proposal" && c.status === "pending");
    const pending: boolean | "merge" = open.some((c) => c.kind === "proposal" && c.what === "merge") ? "merge" : open.length > 0;
    const checked = doc.pr ? (await g.pool.query<{ t: Date }>(`select updated_at as t from onboarding_prs where org_id = $1 and repo_id = $2 and number = $3`, [g.orgId, repo.id, doc.pr.number])).rows[0]?.t.getTime() ?? null : null;
    // What the thread is waiting on outside the conversation: shown as a chip, so nobody has to ask again (Gantry posts here and notifies when it happens).
    const waiting = doc.busy === "assessing" ? { text: "Waiting for the assessment to finish", since: doc.timeline.at(-1)?.at ?? null, checkedAt: null }
      : doc.busy === "verifying" || doc.stage === "pr_merged" ? { text: "Waiting for the live verification", since: null, checkedAt: null }
      : doc.busy === "merging" ? { text: "Waiting for GitHub to apply its merge rules", since: null, checkedAt: null }
      : doc.pr?.state === "open" && (doc.pr.checks === "pending" || doc.pr.checks === "running") ? { text: `Waiting for CI on PR #${doc.pr.number}${doc.pr.checks === "running" ? " (running)" : ""}`, since: doc.pr.headAt ?? null, checkedAt: checked }
      : null;
    const agentCost = (doc.assessor?.costUsd ?? 0) + (doc.drafter?.costUsd ?? 0);
    return {
      repoId: repo.id, repo: repo.name, project: repo.project_id, messages,
      agent: ag.mode === "agent" ? { mode: "agent", model: ag.model, vendor: ag.vendor, version: ag.pin.version } : { mode: "rule-based", reason: ag.reason },
      budget: ag.budget, costUsd: ag.budget.spentUsd + agentCost,
      can: { talk: manage.allowed, merge: merge.allowed, talkWhy: manage.allowed ? "" : manage.reason },
      steps: lifecycle(doc), next: nextStep(doc, { agent: ag.mode === "agent", pendingProposal: pending, canMerge: merge.allowed }),
      stage: doc.stage, busy: doc.busy ?? null, prNeedsUpdate: doc.prNeedsUpdate === true, waiting, prChecks: doc.pr?.checks ?? null,
    };
  });

  /* ------------------------------------------------------------------ a turn */

  function ctxFor(repo: RepoRow, doc: Doc, who: { id: string; name: string }, ag: Awaited<ReturnType<typeof agentState>>, canMerge: boolean, diff: number): SessionCtx {
    return {
      db: g.pool, orgId: g.orgId, repo, doc, full: fullName(repo)!, inspect, person: who, agent: ag.mode === "agent" ? { version: ag.pin.version, model: ag.pin.model } : null,
      maxDiff: diff, canMerge, cards: [], drafts: {}, used: [], next: 1,
    };
  }

  /** Saves one assistant (or system) message with its cards, replaces older pending proposals, and records who said it in the audit. */
  async function persist(repo: RepoRow, runId: string | null, role: "assistant" | "system", author: string, text: string, data: SessionMessage["data"], onBehalfOf: string, ev: Record<string, unknown>): Promise<string> {
    const id = newSessionMessageId();
    await withTx(g.pool, async (tx) => {
      const hasProposal = (data.cards ?? []).some((c) => c.kind === "proposal");
      if (hasProposal) await supersedePending(tx, g.orgId, repo.id, id);
      const now = new Date();
      await addSessionMessage(tx, g.orgId, repo.id, runId, role, author, text, data, now, id);
      await appendEvent(tx, {
        orgId: g.orgId, type: "onboarding.session.answer", category: "onboarding", actor: author === ONBOARD_AGENT ? ONBOARD_AGENT : "system", channel: "system", onBehalfOf,
        subject: { type: "repo", id: repo.id }, projectId: repo.project_id, outcome: "ok", occurredAt: now, after: { message: id, chars: text.length, cards: (data.cards ?? []).map((c) => c.kind), ...ev },
      });
    });
    return id;
  }

  app.post("/api/v1/repos/:id/onboarding/session/messages", async (req, reply: FastifyReply) => {
    const { id } = Id.parse(req.params);
    const b = MessageBody.parse(req.body ?? {});
    const who = person(req);
    const repo = await repoOf(req, id);
    if (!fullName(repo)) throw refuse("conflict", `${repo.name} has no GitHub identity, so there is nothing to onboard.`);
    if (b.kind === "message" && !b.text) throw refuse("invalid", "Write a message.");
    if (b.kind === "open" && (await listMessages(g.pool, g.orgId, repo.id, 400)).some((m) => m.data.kind !== "update")) return { ok: true, msg: "The conversation already started.", already: true };
    if (active.has(repo.id)) throw refuse("conflict", "The Onboarding Agent is already answering. Wait for it to finish.");
    // 1. The person's words are saved first (state and event in one transaction, idempotent on Idempotency-Key). Opening needs the same right as talking.
    const saved = await command(req, { action: "onboarding.manage", scope: scopeOf(repo), idempotent: true }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
      const row = await lockRepo(tx, a.orgId, repo.id);
      const runId = docOf(row).runId ?? null;
      const mid = b.text && b.kind !== "open" ? await addSessionMessage(tx, a.orgId, repo.id, runId, "user", who.id, b.text, {}, a.now) : null;
      return {
        msg: "Saved.",
        // The ledger records that something was said, never its text.
        events: [{ type: "onboarding.session.message", category: "onboarding", subject: { type: "repo", id: repo.id }, projectId: repo.project_id, after: { message: mid, kind: b.kind, chars: b.text?.length ?? 0 } }],
        extra: { messageId: mid, runId }, changes: ["repos"], project: repo.project_id,
      };
    });
    if (reply.getHeader("idempotent-replayed")) return { ...saved, replayed: true };

    const fresh = (await readRepoRow(g.pool, g.orgId, repo.id))!;
    const doc = docOf(fresh);
    const [ag, merge, diff] = await Promise.all([agentState(fresh), decide(req, "onboarding.merge", scopeOf(fresh)), maxDiff()]);

    /* Rule-based: the same page, Gantry posts what it observed and the deterministic proposal. */
    if (ag.mode !== "agent") {
      if (b.kind === "message") {
        const mid = await persist(fresh, doc.runId ?? null, "system", "system", NO_AGENT_TEXT, { kind: "no_agent", mode: "rule-based", cards: [] }, who.id, { mode: "rule-based", reason: ag.reason });
        return { ok: true, msg: NO_AGENT_TEXT, mode: "rule-based", reason: ag.reason, messageId: mid };
      }
      const mid = await ruleBasedPost(fresh, doc, who, ag.reason, merge.allowed, diff);
      return { ok: true, msg: "Posted.", mode: "rule-based", reason: ag.reason, messageId: mid };
    }

    /* The Onboarding Agent's turn: streamed. */
    const { send, ac, end } = openSse(reply);
    active.add(repo.id);
    try {
      const question = b.kind === "open" ? "(The person opened the onboarding session. Begin.)" : b.kind === "continue" ? "(The person asked for changes to your proposal; see their last message. Revise and propose again.)" : (b.text ?? "");
      const mid = await agentTurn({ repo: fresh, doc, who, canMerge: merge.allowed, diff, ag, question, kind: b.kind, send, signal: ac.signal });
      send("done", { messageId: mid });
    } catch (e) {
      const unavailable = e instanceof ModelUnavailable;
      if (!unavailable) req.log.error({ err: e }, "onboarding session turn failed");
      const text = unavailable ? `The Onboarding Agent did not answer: ${e.message}. Nothing was changed; Gantry's rule-based path still works.` : "Something went wrong while answering. Nothing was changed.";
      try {
        const mid = await persist(fresh, doc.runId ?? null, "system", "system", text, { kind: unavailable ? e.code : "error", cards: [] }, who.id, { mode: "none", code: unavailable ? e.code : "error" });
        send("error", { code: unavailable ? e.code : "error", msg: text, messageId: mid });
      } catch (e2) {
        req.log.error({ err: e2 }, "onboarding session could not save the failure notice");
        send("error", { code: "error", msg: text });
      }
    } finally {
      active.delete(repo.id);
      end();
    }
    return reply;
  });

  /** The person has seen the session's updates: the bell stops listing them. */
  app.post("/api/v1/repos/:id/onboarding/session/seen", async (req) => {
    const { id } = Id.parse(req.params);
    const who = person(req);
    const repo = await repoOf(req, id);
    return command(req, { action: null }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
      await markSeen(tx, a.orgId, repo.id, who.id);
      return { msg: "Seen.", events: [], changes: ["home"], project: repo.project_id };
    });
  });

  /* ------------------------------------------------------------------ a decision on a proposal */

  app.post("/api/v1/repos/:id/onboarding/session/proposals/:mid/:pid", async (req) => {
    const { id, mid, pid } = ProposalParams.parse(req.params);
    const b = DecisionBody.parse(req.body ?? {});
    const who = person(req);
    const repo = await repoOf(req, id);
    const m0 = (await listMessages(g.pool, g.orgId, repo.id)).find((m) => m.id === mid);
    const c0 = m0?.data.cards?.find((c): c is Extract<SessionCard, { kind: "proposal" }> => c.kind === "proposal" && c.id === pid);
    if (!m0 || !c0) throw refuse("not_found", "No such proposal.");
    // Merging needs the right to merge onboarding pull requests; everything else the right to manage onboarding.
    const action = c0.what === "merge" && b.decision === "approve" ? "onboarding.merge" : c0.what === "exception" && b.decision === "approve" ? "onboarding.exception" : "onboarding.manage";
    return command(req, { action, scope: scopeOf(repo) }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
      const row = await lockRepo(tx, a.orgId, repo.id);
      const doc = docOf(row);
      const m = await lockMessage(tx, a.orgId, repo.id, mid);
      const card = m?.data.cards?.find((c): c is Extract<SessionCard, { kind: "proposal" }> => c.kind === "proposal" && c.id === pid);
      if (!m || !card) throw refuse("not_found", "No such proposal.");
      if ((card.status as string) !== "pending") throw refuse("conflict", `This proposal is already ${card.status}. Ask the agent for a new one if you need it.`);
      const ev = (type: string, after: Record<string, unknown>) => ({ type, category: "onboarding" as const, subject: { type: "repo", id: repo.id }, projectId: repo.project_id, after: { proposal: pid, message: mid, what: card.what, ...after } });
      const finish = async (status: Extract<SessionCard, { kind: "proposal" }>["status"], note?: string): Promise<void> => {
        card.status = status;
        card.decidedBy = who.id;
        if (note) card.note = note.slice(0, 500);
        await saveMessageData(tx, a.orgId, mid, m.data);
      };

      if (b.decision === "discard" || b.decision === "changes") {
        const changes = b.decision === "changes";
        if (changes && !b.text) throw refuse("invalid", "Say what to change.");
        await finish(changes ? "changes" : "discarded", b.text);
        if (changes) await addSessionMessage(tx, a.orgId, repo.id, doc.runId ?? null, "user", who.id, `Changes requested: ${b.text}`, {}, a.now);
        return { msg: changes ? "Change requested. The agent will revise the proposal." : "Proposal discarded.", events: [ev(changes ? "onboarding.session.changes" : "onboarding.session.discarded", {})], changes: ["repos", "audit"], project: repo.project_id };
      }

      // Approve: the proposal must still describe the repository.
      if (card.runId && doc.runId && card.runId !== doc.runId) throw refuse("conflict", "A newer assessment replaced the run this proposal was made for. Ask the agent for a new proposal.");
      let out: CommandResult<Record<string, unknown>>;
      if (card.what === "merge") {
        if (!doc.pr || doc.pr.number !== card.prNumber || doc.pr.headSha !== card.headSha) throw refuse("conflict", "The pull request changed after this was proposed. Ask the agent for a new proposal.");
        out = await mergeOnboardingPr(tx, a, repo.id);
      } else if (card.what === "exception") {
        out = await markException(tx, a, repo.id, card.reason ?? "Accepted in the onboarding session.");
      } else {
        const needs = (card.sensitive ?? []).filter((x) => x.id !== "guideline");
        if (needs.length && !b.confirmSensitive) throw refuse("invalid", `Confirm the parts this pull request marks as sensitive (${needs.map((x) => x.label.toLowerCase()).join(", ")}) before approving.`);
        if (card.what === "update_pr" && doc.pr?.number !== card.prNumber) throw refuse("conflict", "The open pull request changed. Ask the agent for a new proposal.");
        // What the worker opens is exactly what was proposed: the validated draft (or the rule-based plan) is attached to the run; the client supplies nothing.
        const draft = m.data.drafts?.[pid];
        const approved = { by: who.id, at: a.now.toISOString(), message: mid, proposal: pid, mode: card.mode, confirmedSensitive: needs.length > 0 };
        if (doc.runId) await tx.query(`update onboarding_runs set data = ((data - 'agentDraft') || $3::jsonb) where org_id = $1 and id = $2`, [a.orgId, doc.runId, JSON.stringify({ sessionApproved: approved, ...(draft ? { agentDraft: draft } : {}) })]);
        out = card.what === "update_pr"
          ? await requestChanges(tx, a, repo.id, "Approved in the onboarding session: update the pull request as proposed.")
          : await openOnboardingPr(tx, a, repo.id, { authored: !!draft });
      }
      await finish("approved");
      return { ...out, events: [...out.events, ev("onboarding.session.approved", { files: card.files.map((f) => f.path), mode: card.mode })], changes: [...new Set([...(out.changes ?? []), "repos", "audit"])] };
    });
  });
};
