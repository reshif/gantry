/**
 * POST /hooks/slack (spec 8.10, 12.3): Slack's interactive callbacks (button clicks) and slash commands (`/gantry link <code>`).
 * Not behind session auth. The signature is verified over the raw body with each switched-on Slack connection's signing secret (v0 scheme, constant time),
 * a request outside a five-minute window is refused (replay protection), and a request already seen (by Slack's trigger id, else by body hash) creates nothing new.
 *
 * In-chat approval is a command like any other: the chat user must be linked to exactly one active person (a recorded link step), the decision point judges that
 * person at click time, the gate must be named for chat on that connection and never a release, hotfix, security hold or risk-tagged change, and the gate
 * instance on the card must still be the open one (a stale click is refused). The vote is stored with channel, chat user id, person and instance id.
 */
import { bodyHasNul } from "../../core/nul.js";
import { hookDenials } from "../../core/denial-sampler.js";
import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { appendEvent, withTx } from "@gantry/db";
import { riskTagsOf } from "@gantry/domain";
import { command, publishChange, readCatalog, refuse, Refusal, type CommandResult } from "../../core/index.js";
import { actionForGate, approveGate, parseGateId } from "../workorders/gates.js";
import { loadFlow } from "../workorders/model.js";
import { verifySlackSignature } from "../notifications/slack.js";
import { chatApprovalFor } from "./chat-policy.js";
import { completeLink, personForChatUser } from "./links.js";
import { opsEnv } from "./runtime.js";
import { open } from "./secrets.js";
import { readInstanceRows, configOf } from "./store.js";

const MAX_BODY = 512 * 1024;

interface Matched { id: string; name: string; config: Record<string, unknown> }

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** The switched-on Slack connections and their signing secrets. A switched-off connection never accepts a callback. */
async function slackSecrets(app: Parameters<FastifyPluginAsync>[0]): Promise<Array<Matched & { signingSecret: string }>> {
  const g = app.gantry;
  const out: Array<Matched & { signingSecret: string }> = [];
  for (const r of await readInstanceRows(g.pool, g.orgId)) {
    if (r.type_id !== "slack" || !r.enabled || !r.secret_enc) continue;
    try {
      const s = open(g.config.secrets.dataKey, r.id, r.secret_enc, "botToken");
      if (s.signingSecret) out.push({ id: r.id, name: r.name, config: configOf(r.config), signingSecret: s.signingSecret });
    } catch {
      /* an unreadable secret never verifies anything */
    }
  }
  return out;
}

interface BlockAction { type?: string; user?: { id?: string; username?: string; name?: string }; team?: { id?: string }; trigger_id?: string; response_url?: string; actions?: Array<{ action_id?: string; value?: string }> }

export const slackHookRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const raw = (_req: FastifyRequest, body: Buffer, done: (e: Error | null, b?: Buffer) => void): void => done(null, body);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_BODY }, raw);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer", bodyLimit: MAX_BODY }, raw);

  const audit = (type: string, outcome: "denied" | "failed", rule: string, reason: string, req: FastifyRequest, extra: Record<string, unknown> = {}) =>
    withTx(g.pool, (tx) => appendEvent(tx, { orgId: g.orgId, type, category: "integrations", actor: "slack-hook", channel: "slack", subject: { type: "hook", id: "slack" }, outcome, rule, after: { reason, ...extra }, requestId: req.id, sourceIp: req.ip || null }))
      .catch((err: unknown) => req.log.error({ err }, "could not audit slack hook denial"));

  /** An ephemeral reply through Slack's `response_url`, only to Slack's own host (or the configured API base in tests). */
  const reply = async (url: string | undefined, text: string): Promise<void> => {
    if (!url) return;
    try {
      const env = opsEnv(app);
      const u = new URL(url);
      const base = new URL(env.slackBase);
      if (u.protocol !== "https:" && u.origin !== base.origin) return;
      if (u.hostname !== "hooks.slack.com" && u.origin !== base.origin) return;
      await env.http.request({ method: "POST", url, headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }), timeoutMs: 8000 });
    } catch (err) {
      app.log.warn({ err }, "could not answer a Slack response_url");
    }
  };

  app.post("/hooks/slack", { bodyLimit: MAX_BODY }, async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ts = typeof req.headers["x-slack-request-timestamp"] === "string" ? req.headers["x-slack-request-timestamp"] : undefined;
    const sig = typeof req.headers["x-slack-signature"] === "string" ? req.headers["x-slack-signature"] : undefined;
    const secrets = await slackSecrets(app);
    if (!secrets.length) return res.code(503).send({ ok: false, msg: "No Slack connection is switched on." });
    let matched: Matched | null = null;
    let worst: "missing" | "stale" | "mismatch" = "mismatch";
    for (const s of secrets) {
      const c = verifySlackSignature(body, ts, sig, s.signingSecret);
      if (c.ok) {
        matched = s;
        break;
      }
      if (c.reason === "stale") worst = "stale";
      else if (c.reason === "missing" && worst !== "stale") worst = "missing";
    }
    if (!matched) {
      const smp = hookDenials.sample("slack", req.ip);
      if (smp.audit) await audit("slack.hook.denied", "denied", worst === "stale" ? "HOOK-STALE" : "HOOK-SIG", worst === "stale" ? "The request is outside the five-minute window." : worst === "missing" ? "The signature header is missing." : "The signature does not match.", req, smp.suppressed ? { suppressed: smp.suppressed } : {});
      return res.code(401).send({ ok: false, msg: worst === "stale" ? "Stale request." : "Invalid signature." });
    }

    const ctype = String(req.headers["content-type"] ?? "");
    const text = body.toString("utf8");
    let form: URLSearchParams | null = null;
    let json: Record<string, unknown> | null = null;
    if (ctype.startsWith("application/x-www-form-urlencoded")) form = new URLSearchParams(text);
    else {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return res.code(400).send({ ok: false, msg: "The body is not valid JSON." });
      }
    }
    // G-A4: a NUL in a signed body is a 400, not a database error.
    if (bodyHasNul(json) || (form && [...form].some(([k, v]) => k.includes("\u0000") || v.includes("\u0000")))) return res.code(400).send({ ok: false, msg: "Text cannot contain a NUL character." });
    if (json?.type === "url_verification" && typeof json.challenge === "string") return res.send({ challenge: json.challenge });

    // Replay: the same signed request again creates nothing new. Slack's trigger id when it has one, else the body hash.
    const interactive = form?.get("payload") ? (JSON.parse(form.get("payload")!) as BlockAction) : null;
    const trigger = interactive?.trigger_id ?? form?.get("trigger_id") ?? undefined;
    const hash = sha256(body);
    const deliveryId = (trigger ?? hash).slice(0, 120);
    const fresh = await withTx(g.pool, async (tx) => {
      const ins = await tx.query(`insert into inbound_deliveries (org_id, id, source, delivery_id, event_type, payload_hash) values ($1,$2,'slack',$3,$4,$5) on conflict (org_id, source, delivery_id) do nothing`, [g.orgId, `sl-${deliveryId}`.slice(0, 160), deliveryId, interactive ? "interaction" : form?.get("command") ? "command" : "event", hash]);
      if (ins.rowCount) return true;
      await appendEvent(tx, { orgId: g.orgId, type: "slack.hook.denied", category: "integrations", actor: "slack-hook", channel: "slack", subject: { type: "hook", id: "slack" }, outcome: "denied", rule: "HOOK-REPLAY", after: { reason: "A request already received is not processed again.", delivery: deliveryId }, requestId: req.id, sourceIp: req.ip || null });
      return false;
    });
    if (!fresh) return res.send({});

    if (form?.get("command")) return handleCommand(req, res, matched, form);
    if (interactive) return handleInteraction(req, res, matched, interactive);
    return res.send({});
  });

  /** `/gantry link <code>`: the chat side of the recorded link step. */
  async function handleCommand(req: FastifyRequest, res: FastifyReply, inst: Matched, form: URLSearchParams): Promise<unknown> {
    const user = form.get("user_id") ?? "";
    const words = (form.get("text") ?? "").trim().split(/\s+/);
    const ephemeral = (text: string) => res.send({ response_type: "ephemeral", text });
    if (!user) return ephemeral("Slack did not say who you are.");
    if (words[0]?.toLowerCase() !== "link" || !words[1]) return ephemeral("Use `/gantry link <code>`. Get the code in Gantry: Integrations, then link your chat account.");
    try {
      const done = await withTx(g.pool, async (tx) => {
        const r = await completeLink(tx, g.orgId, "slack", user, words[1]!, new Date());
        await publishChange(tx, { org: g.orgId, keys: ["chatLinks", "audit"] });
        await appendEvent(tx, { orgId: g.orgId, type: "chat.link.completed", category: "integrations", actor: r.personId, onBehalfOf: r.personId, channel: "slack", subject: { type: "person", id: r.personId }, after: { channel: "slack", chatUser: user, integration: inst.id }, requestId: req.id, sourceIp: req.ip || null });
        return r;
      });
      return ephemeral(`Linked: this Slack account is now ${done.name}. Approvals you click here count as yours, and only where Gantry allows approving from chat.`);
    } catch (e) {
      if (e instanceof Refusal) {
        await audit("chat.link.denied", "denied", "CHAT-LINK", e.error.msg, req, { chatUser: user });
        return ephemeral(e.error.msg);
      }
      throw e;
    }
  }

  async function handleInteraction(req: FastifyRequest, res: FastifyReply, inst: Matched, p: BlockAction): Promise<unknown> {
    const act = p.actions?.[0];
    const user = p.user?.id ?? "";
    const respond = async (text: string) => {
      await reply(p.response_url, text);
      return res.send({});
    };
    if (!act?.action_id?.startsWith("gantry.") || !user) return res.send({});
    const kind = act.action_id.slice("gantry.".length);
    if (kind !== "approve") return respond("Open this in Gantry to continue.");
    let v: { instance?: string | null; wo?: string | null; gate?: string | null } = {};
    try {
      v = JSON.parse(act.value ?? "{}") as typeof v;
    } catch {
      return respond("That button is malformed.");
    }
    if (!v.instance || !v.wo) return respond("This card is not tied to a gate instance, so it cannot be approved here.");
    const who = await personForChatUser(g.pool, g.orgId, "slack", user);
    if (!who.ok) {
      await audit("chat.approve.denied", "denied", "CHAT-LINK", who.reason === "inactive" ? "The linked person is not active." : "The chat user is not linked to a Gantry person.", req, { chatUser: user, instance: v.instance, integration: inst.id });
      return respond(who.reason === "inactive" ? "Your linked Gantry account is not active, so this click does not count." : "Your Slack account is not linked to a Gantry person yet. In Gantry, open Integrations, link your chat account, then send `/gantry link <code>` here. Until then, open the request in Gantry.");
    }
    const gi = parseGateId(v.instance);
    const wo = (await g.pool.query<{ project_id: string }>(`select project_id from work_orders where org_id = $1 and id = $2`, [g.orgId, gi.woId])).rows[0];
    if (!wo) return respond("That work order no longer exists.");
    if (gi.n === null) return respond("This card does not name the exact request, so it cannot be approved here. Open it in Gantry.");
    // The chat policy first, so the reason a person reads is the real one (a release or a hotfix is never approved from chat), then again under the lock inside the command.
    const chatPolicy = async (db: import("@gantry/db").Queryable): Promise<ReturnType<typeof chatApprovalFor> | null> => {
      const w = (await loadFlow(db, g.orgId, { ids: [gi.woId] })).workOrders[0];
      if (!w) return null;
      return chatApprovalFor(inst.config, gi.gateId, { cls: w.cls, risk: w.risk ?? null, position: String(w.bay ?? ""), riskTags: riskTagsOf({ files: w.files, paths: w.paths, risk: w.risk }) });
    };
    const pre = await chatPolicy(g.pool);
    if (pre && !pre.ok) {
      await audit("chat.approve.denied", "denied", "CHAT-APPROVAL", pre.reason, req, { chatUser: user, person: who.personId, instance: v.instance, integration: inst.id });
      return respond(`${pre.reason} Open it in Gantry.`);
    }
    // The click is a command by the linked person, through the same pipeline: decision point at click time, audited denials, one transaction.
    (req.gx as { principal: unknown }).principal = { kind: "person", id: who.personId, name: who.name, sessionId: `slack:${p.team?.id ?? "-"}:${user}` };
    (req.gx as { channel: string }).channel = "slack"; // set by the signature-checked hook; trustedVia() honours only this
    (req as { body: unknown }).body = { via: "slack" };
    const catalog = await readCatalog(g.pool, g.orgId);
    try {
      const out = await command(req, { action: actionForGate(catalog, gi.gateId), scope: { project: wo.project_id, wo: gi.woId } }, async (tx, a): Promise<CommandResult<Record<string, unknown>>> => {
        const policy = (await chatPolicy(tx)) ?? { ok: false as const, reason: "That work order no longer exists." };
        if (!policy.ok) throw refuse("denied", policy.reason, { rule: { kind: "chat", id: "CHAT-APPROVAL", name: "Approving from chat" }, needs: "Approve in Gantry" });
        const r = await approveGate(tx, a, gi.woId, gi.gateId, gi.n, { via: "slack" });
        await tx.query(`update gate_votes set chat = $4::jsonb where org_id = $1 and gate_instance_id = $2 and voter = $3`, [g.orgId, v.instance, who.personId, JSON.stringify({ channel: "slack", chatUser: user, team: p.team?.id ?? null, person: who.personId, instance: v.instance, integration: inst.id })]);
        r.events.push({ type: "chat.approve", category: "approvals", subject: { type: "gate", id: v.instance! }, projectId: wo.project_id, woId: gi.woId, after: { channel: "slack", chatUser: user, person: who.personId, instance: v.instance, integration: inst.id } });
        return r;
      });
      return respond(String(out.msg ?? "Approved."));
    } catch (e) {
      if (e instanceof Refusal) return respond(e.error.kind === "stale" ? `This request is no longer current: ${e.error.msg}` : e.error.msg);
      throw e;
    }
  }
};
