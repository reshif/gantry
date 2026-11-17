/**
 * The Agent Workspace (agent workspace, Phase 4): one inbox over every conversation, side threads with a chosen agent, sharing, archive,
 * full-text search, export and the operator view.
 *   GET    /api/v1/workspace/inbox[?all=1]                       every conversation the caller can read (`all`: also work orders closed long ago)
 *   GET    /api/v1/workspace/agents?wo=                          the agents a side thread can talk to (the stations' agents)
 *   POST   /api/v1/workspace/threads                             a new chat about a work order, repository or project, optionally with a chosen agent
 *   PATCH  /api/v1/workspace/threads/{key}                       pin, archive (own chat: for everyone; anything else: for me), rename, share with the project
 *   POST   /api/v1/workspace/threads/{id}/members                invite a person to a chat (the owner)
 *   DELETE /api/v1/workspace/threads/{id}/members/{person}       remove an invitation (the owner) or leave (the person)
 *   GET    /api/v1/workspace/threads/{key}/export?format=md|json  the conversation as markdown or JSON
 *   GET    /api/v1/workspace/search?q=&kinds=&project=           full text over messages, documents, sources and questions the caller can read
 *   GET    /api/v1/workspace/operator                            stuck, waiting and over-budget work, and chat spend per person
 * Every write goes through command() and is audited (titles and message text never are).
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { chatAccess, createScopedThread, listMessages, readChat, type ScopeKind } from "../areas/console/threads.js";
import { inbox } from "../areas/workspace/inbox.js";
import { operatorView } from "../areas/workspace/operator.js";
import { search, type HitKind } from "../areas/workspace/search.js";
import { listWoMessages, legacyMessages } from "../areas/workorders/session/store.js";
import { listMessages as listOnboardingMessages } from "../areas/onboarding/session/store.js";
import { command, decide, policyState, refuse } from "../core/index.js";
import { readSecurity } from "../core/read/index.js";

const Key = z.object({ key: z.string().min(1).max(120) });
const ChatId = z.object({ id: z.string().min(1).max(60) });
const CreateBody = z.object({
  scope: z.object({ kind: z.enum(["factory", "project", "work_order", "repo"]), id: z.string().min(1).max(100).nullish() }),
  agent: z.string().min(1).max(100).nullish(),
  title: z.string().trim().max(120).optional(),
  visibility: z.enum(["private", "project"]).optional(),
}).strict();
const PatchBody = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  title: z.string().trim().min(1, "Give the conversation a name.").max(120).optional(),
  visibility: z.enum(["private", "project"]).optional(),
}).strict();
const MemberBody = z.object({ person: z.string().min(1).max(100) }).strict();
const SearchQ = z.object({ q: z.string().trim().min(2, "Search for at least two characters.").max(200), kinds: z.string().max(60).optional(), project: z.string().max(100).optional() });
const ExportQ = z.object({ format: z.enum(["md", "json"]).default("md") });

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const person = (req: FastifyRequest): { id: string; name: string } => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "The workspace is for signed-in people.");
    return { id: p.id, name: p.name };
  };
  const seen = async (req: FastifyRequest, me: string) => {
    const st = await policyState(req);
    const projects = visibleProjects(st, me).map((p) => p.id);
    return { st, projects, sees: (p: string) => projects.includes(p) };
  };

  app.get("/api/v1/workspace/inbox", async (req) => {
    const me = person(req);
    const all = (req.query as Record<string, unknown>)?.all === "1";
    const st = await policyState(req);
    const items = await inbox(g.pool, g.orgId, req, st, me.id, { all });
    return { items, total: items.length };
  });

  /** The agents a side thread can talk to: each station's agent (project stations included), active ones only. */
  app.get("/api/v1/workspace/agents", async (req) => {
    const me = person(req);
    const wo = z.object({ wo: z.string().max(100).optional() }).parse(req.query).wo;
    const { st, sees, projects } = await seen(req, me.id);
    // Default deny: the agent roster is only offered to someone who holds a role on at least one project.
    if (projects.length === 0) return { items: [] };
    let project: string | null = null;
    if (wo) {
      project = (await g.pool.query<{ project_id: string }>(`select project_id from work_orders where org_id = $1 and id = $2`, [g.orgId, wo])).rows[0]?.project_id ?? null;
      if (!project || !sees(project)) throw refuse("not_found", "No such work order.");
    }
    const { rows } = await g.pool.query<{ id: string; name: string; status: string }>(`select id, name, status from agents where org_id = $1`, [g.orgId]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: Array<{ id: string; name: string; station: string; stationName: string }> = [];
    for (const s of st.catalog.stations) {
      if (s.project && s.project !== project) continue;
      const a = byId.get(s.agent);
      if (!a || a.status !== "active" || out.some((o) => o.id === a.id)) continue;
      out.push({ id: a.id, name: a.name, station: s.id, stationName: s.name });
    }
    return { items: out };
  });

  app.post("/api/v1/workspace/threads", async (req) => {
    const me = person(req);
    const b = CreateBody.parse(req.body);
    const { st, sees } = await seen(req, me.id);
    const kind = b.scope.kind as ScopeKind;
    const id = kind === "factory" ? null : (b.scope.id ?? null);
    if (kind !== "factory" && !id) throw refuse("invalid", "Say what the conversation is about.");
    let project: string | null = null;
    let label = "the factory";
    if (kind === "work_order") {
      const w = (await g.pool.query<{ project_id: string; title: string }>(`select project_id, title from work_orders where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
      if (!w || !sees(w.project_id)) throw refuse("not_found", "No such work order.");
      project = w.project_id;
      label = id!;
    } else if (kind === "repo") {
      const r = (await g.pool.query<{ project_id: string; name: string }>(`select project_id, name from repos where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
      if (!r || !sees(r.project_id)) throw refuse("not_found", "No such repository.");
      project = r.project_id;
      label = r.name;
    } else if (kind === "project") {
      if (!sees(id!)) throw refuse("not_found", "No such project.");
      project = id;
      label = st.projects.find((p) => p.id === id)?.name ?? id!;
    }
    let agentName: string | null = null;
    if (b.agent) {
      const a = (await g.pool.query<{ name: string; status: string }>(`select name, status from agents where org_id = $1 and id = $2`, [g.orgId, b.agent])).rows[0];
      if (!a || a.status !== "active") throw refuse("invalid", `${b.agent} is not an active agent.`);
      agentName = a.name;
    }
    // Threads about a work order are read by its project, as its primary thread is (owner decision 1); a chat about the factory stays private.
    const visibility = project ? (b.visibility ?? (kind === "work_order" ? "project" : "private")) : "private";
    if (b.visibility === "project" && !project) throw refuse("invalid", "A chat about the whole factory cannot be shared with a project. Invite people instead.");
    const title = b.title || (agentName ? `${agentName} about ${label}` : `About ${label}`);
    return command(req, { action: null }, async (tx, a) => {
      const tid = await createScopedThread(tx, a.orgId, { person: me.id, title, scope: { kind, id }, projectId: project, agentId: b.agent ?? null, visibility, now: a.now });
      return {
        msg: agentName ? `New thread with ${agentName}.` : "New thread.",
        events: [{ type: "thread.created", category: "access", subject: { type: "thread", id: tid }, projectId: project, after: { scope: kind, about: id, agent: b.agent ?? null, visibility } }],
        changes: ["console", "workspace"], project, extra: { id: tid, key: tid, title, visibility },
      };
    });
  });

  app.patch("/api/v1/workspace/threads/:key", async (req) => {
    const me = person(req);
    const { key } = Key.parse(req.params);
    const b = PatchBody.parse(req.body);
    const { sees } = await seen(req, me.id);
    const isChat = key.startsWith("ct-");
    const chat = isChat ? await readChat(g.pool, g.orgId, key) : null;
    const can = chat ? chatAccess(chat, me.id, sees) : null;
    if (isChat && (!chat || !can?.read)) throw refuse("not_found", "No such conversation.");
    if (!isChat) {
      const m = /^(wo|repo):(.+)$/.exec(key);
      if (!m) throw refuse("not_found", "No such conversation.");
      const project = m[1] === "wo"
        ? (await g.pool.query<{ project_id: string }>(`select project_id from work_orders where org_id = $1 and id = $2`, [g.orgId, m[2]])).rows[0]?.project_id
        : (await g.pool.query<{ project_id: string }>(`select project_id from repos where org_id = $1 and id = $2`, [g.orgId, m[2]])).rows[0]?.project_id;
      if (!project || !sees(project)) throw refuse("not_found", "No such conversation.");
      if (b.title !== undefined || b.visibility !== undefined) throw refuse("invalid", "A work order's or repository's own thread keeps its name and is always read by its project.");
    }
    if (chat && !can!.owner && (b.title !== undefined || b.visibility !== undefined)) throw refuse("denied", "Only the person who started this conversation can rename or share it.");
    if (chat && b.visibility === "project" && !chat.projectId) throw refuse("invalid", "A chat about the whole factory cannot be shared with a project. Invite people instead.");
    return command(req, { action: null }, async (tx, a) => {
      const events: Array<Record<string, unknown>> = [];
      // Pins are always the person's own; so is archive, except that the owner of a chat archives it for everyone (it becomes read-only).
      const ownArchive = chat && can!.owner && b.archived !== undefined;
      if (b.pinned !== undefined || (b.archived !== undefined && !ownArchive)) {
        await tx.query(
          `insert into thread_prefs (org_id, person_id, thread_key, pinned, archived) values ($1,$2,$3, coalesce($4, false), coalesce($5, false))
           on conflict (org_id, person_id, thread_key) do update set pinned = coalesce($4, thread_prefs.pinned), archived = coalesce($5, thread_prefs.archived), updated_at = clock_timestamp()`,
          [a.orgId, me.id, key, b.pinned ?? null, ownArchive ? null : (b.archived ?? null)],
        );
      }
      if (chat && can!.owner) {
        if (b.archived !== undefined) {
          await tx.query(`update console_threads set status = $3, archived_at = $4, archived_by = $5, updated_at = clock_timestamp() where org_id = $1 and id = $2`, [a.orgId, key, b.archived ? "archived" : "active", b.archived ? a.now : null, b.archived ? me.id : null]);
          events.push({ type: b.archived ? "thread.archived" : "thread.unarchived", category: "access", subject: { type: "thread", id: key }, projectId: chat.projectId });
        }
        if (b.title !== undefined) await tx.query(`update console_threads set title = $3, updated_at = clock_timestamp() where org_id = $1 and id = $2`, [a.orgId, key, b.title]);
        if (b.visibility !== undefined && b.visibility !== chat.visibility) {
          await tx.query(`update console_threads set visibility = $3, updated_at = clock_timestamp() where org_id = $1 and id = $2`, [a.orgId, key, b.visibility]);
          events.push({ type: "thread.shared", category: "access", subject: { type: "thread", id: key }, projectId: chat.projectId, before: { visibility: chat.visibility }, after: { visibility: b.visibility } });
        }
      }
      const msg = b.archived === true ? (ownArchive ? "Archived. The conversation is read-only until you unarchive it." : "Moved to your Archived list.") : b.archived === false ? "Back in your inbox." : b.pinned !== undefined ? (b.pinned ? "Pinned." : "Unpinned.") : b.visibility ? (b.visibility === "project" ? "Shared with the project." : "Now private to you and the people you invited.") : "Saved.";
      return { msg, events: events as never, changes: ["console", "workspace"], project: chat?.projectId ?? null };
    });
  });

  app.post("/api/v1/workspace/threads/:id/members", async (req) => {
    const me = person(req);
    const { id } = ChatId.parse(req.params);
    const b = MemberBody.parse(req.body);
    const { st, sees } = await seen(req, me.id);
    const chat = await readChat(g.pool, g.orgId, id);
    const can = chat ? chatAccess(chat, me.id, sees) : null;
    if (!chat || !can?.read) throw refuse("not_found", "No such conversation.");
    if (!can.owner) throw refuse("denied", "Only the person who started this conversation can invite people.");
    const who = st.people.find((p) => p.id === b.person);
    if (!who) throw refuse("not_found", "No such person.");
    if (who.id === me.id) throw refuse("invalid", "You are already in this conversation.");
    // Sharing never widens what someone can see: a person who cannot see the project cannot be invited to a thread about it.
    if (chat.projectId && !visibleProjects(st, who.id).some((p) => p.id === chat.projectId)) throw refuse("invalid", `${who.name} cannot see project ${chat.projectId}, so they cannot read a thread about it.`);
    return command(req, { action: null }, async (tx, a) => {
      await tx.query(`insert into thread_members (org_id, thread_id, person_id, added_by) values ($1,$2,$3,$4) on conflict do nothing`, [a.orgId, id, who.id, me.id]);
      return { msg: `${who.name} can now read and post in this conversation.`, events: [{ type: "thread.member.added", category: "access", subject: { type: "thread", id }, projectId: chat.projectId, after: { person: who.id } }], changes: ["console", "workspace"], project: chat.projectId };
    });
  });

  app.delete("/api/v1/workspace/threads/:id/members/:person", async (req) => {
    const me = person(req);
    const { id, person: pid } = z.object({ id: z.string().min(1).max(60), person: z.string().min(1).max(100) }).parse(req.params);
    const { sees } = await seen(req, me.id);
    const chat = await readChat(g.pool, g.orgId, id);
    const can = chat ? chatAccess(chat, me.id, sees) : null;
    if (!chat || !can?.read) throw refuse("not_found", "No such conversation.");
    if (!can.owner && pid !== me.id) throw refuse("denied", "Only the person who started this conversation can remove people. You can leave it yourself.");
    return command(req, { action: null }, async (tx, a) => {
      const r = await tx.query(`delete from thread_members where org_id = $1 and thread_id = $2 and person_id = $3`, [a.orgId, id, pid]);
      if (!r.rowCount) throw refuse("not_found", "That person is not in this conversation.");
      return { msg: pid === me.id ? "You left the conversation." : "Removed.", events: [{ type: "thread.member.removed", category: "access", subject: { type: "thread", id }, projectId: chat.projectId, after: { person: pid } }], changes: ["console", "workspace"], project: chat.projectId };
    });
  });

  /** A conversation as markdown or JSON, for whoever may read it. Every export is audited (key, project, format, count; never the text). Card data stays in the JSON; the markdown is the readable transcript. */
  app.get("/api/v1/workspace/threads/:key/export", async (req, reply) => {
    const me = person(req);
    const { key } = Key.parse(req.params);
    const { format } = ExportQ.parse(req.query);
    const { sees } = await seen(req, me.id);
    let title = key;
    let rows: Array<{ id: string; role: string; author: string | null; text: string; at: number; data?: unknown }> = [];
    let project: string | null = null;
    if (key.startsWith("ct-")) {
      const chat = await readChat(g.pool, g.orgId, key);
      if (!chat || !chatAccess(chat, me.id, sees).read) throw refuse("not_found", "No such conversation.");
      title = chat.title || "Chat";
      project = chat.projectId;
      rows = (await listMessages(g.pool, g.orgId, key)).map((m) => ({ id: m.id, role: m.role, author: m.author ?? (m.role === "user" ? chat.owner : m.role === "assistant" ? (chat.agentId ?? "gantry") : "gantry"), text: m.text, at: m.at, data: m.data }));
    } else if (key.startsWith("wo:")) {
      const id = key.slice(3);
      const w = (await g.pool.query<{ project_id: string; title: string }>(`select project_id, title from work_orders where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
      if (!w || !sees(w.project_id)) throw refuse("not_found", "No such conversation.");
      title = `${id} · ${w.title}`;
      project = w.project_id;
      const [legacy, msgs] = await Promise.all([legacyMessages(g.pool, g.orgId, id), listWoMessages(g.pool, g.orgId, id, 2000)]);
      rows = [...legacy, ...msgs].map((m) => ({ id: m.id, role: m.role, author: m.author, text: m.text, at: m.at, data: m.data }));
    } else if (key.startsWith("repo:")) {
      const id = key.slice(5);
      const r = (await g.pool.query<{ project_id: string; name: string }>(`select project_id, name from repos where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
      if (!r || !sees(r.project_id)) throw refuse("not_found", "No such conversation.");
      title = `Onboarding ${r.name}`;
      project = r.project_id;
      rows = (await listOnboardingMessages(g.pool, g.orgId, id, 2000)).map((m) => ({ id: m.id, role: m.role, author: m.author, text: m.text, at: m.at, data: m.data }));
    } else throw refuse("not_found", "No such conversation.");
    const file = `${key.replace(/[^A-Za-z0-9_-]+/g, "-")}.${format}`;
    // A transcript download is an access event: it joins the hash chain with who, what and how much, never the text.
    await command(req, { action: null }, async () => ({
      msg: "Exported.",
      events: [{ type: "thread.exported", category: "access", subject: { type: "thread", id: key }, projectId: project, after: { format, messages: rows.length } }] as never,
      changes: [], project,
    }));
    void reply.header("content-disposition", `attachment; filename="${file}"`);
    if (format === "json") return { key, title, exportedAt: new Date().toISOString(), exportedBy: me.id, messages: rows };
    void reply.type("text/markdown; charset=utf-8");
    const iso = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16);
    return [`# ${title}`, "", `Exported ${iso(Date.now())} UTC by ${me.name}. ${rows.length} messages.`, "", ...rows.flatMap((m) => [`## ${m.author ?? m.role} · ${iso(m.at)} UTC`, "", m.text || "_(no text)_", ""])].join("\n");
  });

  app.get("/api/v1/workspace/search", async (req) => {
    const me = person(req);
    const q = SearchQ.parse(req.query);
    const { projects } = await seen(req, me.id);
    const kinds = (q.kinds ?? "").split(",").filter((k): k is HitKind => ["message", "document", "source", "question"].includes(k));
    const items = await search(g.pool, g.orgId, { q: q.q, me: me.id, projects, kinds, project: q.project ?? null });
    return { items, q: q.q };
  });

  /** Lists the projects where the caller may park work (who can act on stuck work); chat spend per person needs people.view. */
  app.get("/api/v1/workspace/operator", async (req) => {
    const me = person(req);
    const { st, projects } = await seen(req, me.id);
    const mayAct: string[] = [];
    for (const p of projects) if ((await decide(req, "wo.park", { project: p })).allowed) mayAct.push(p);
    const [people, sec] = await Promise.all([decide(req, "people.view", {}), readSecurity(g.pool, g.orgId)]);
    const view = await operatorView(g.pool, g.orgId, { projects: mayAct, bays: st.catalog.bays.map((b) => b.id), canSeePeople: people.allowed, capUsd: sec.value.chatCapUsdPerDay ?? null });
    const canEditCap = (await decide(req, "security.manage", {})).allowed;
    return { ...view, projects: mayAct, capUsd: sec.value.chatCapUsdPerDay ?? null, canEditCap, canSeePeople: people.allowed, quietMinutes: 15 };
  });
};
