/**
 * Notification cards (spec 12.2). One `CardSample` (what the card says about a work order or an event) is rendered for each transport:
 * Slack blocks, an Adaptive Card for Teams, email, and a webhook/custom-HTTP body. The same model feeds the preview endpoint, so what the
 * Notifications screen shows is what is sent.
 */
import { CARD_ACTIONS, CARD_DEFAULTS, CARD_TEMPLATES, NOTIFY_EVENTS } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { readCatalog } from "../../core/read/index.js";
import type { EventLike } from "./events.js";

export interface CardFields {
  title?: boolean;
  repo?: boolean;
  class?: boolean;
  priority?: boolean;
  approvers?: boolean;
  link?: boolean;
  actions?: boolean;
}

export const DEFAULT_FIELDS: Required<CardFields> = { title: true, repo: true, class: true, priority: true, approvers: true, link: true, actions: true };

/** A field is on unless a route or card turned it off. */
export const fieldOn = (f: CardFields | null | undefined, k: keyof CardFields): boolean => !f || (f as Record<string, unknown>)[k] !== false;

export interface CardSample {
  event: string;
  template: string;
  tone: string;
  head: string;
  body: string;
  woId: string | null;
  title: string;
  repo: string;
  cls: string;
  clsName: string;
  prio: string;
  approvers: string;
  gate: { id: string; label: string; name: string } | null;
  /** The open gate instance this card is about (card key for in-place updates). */
  instance: string | null;
  link: string;
  project: { id: string; key: string; name: string };
  at: number;
}

export const TONES: Record<string, string> = {
  "gate.waiting": "gate", "gate.escalated": "block", "gate.decided": "done", blocked: "block", "security.hold": "block", andon: "block", kill: "kill", restore: "done",
  released: "done", "eval.regression": "fail", budget: "wait", "trust.changed": "gate", "delivery.failed": "fail",
};
export const toneOf = (event: string): string => TONES[event] ?? "accent";

export const templateFor = (event: string): string => CARD_DEFAULTS[event] ?? "submitted";
export const eventName = (id: string): string => NOTIFY_EVENTS.find((e) => e.id === id)?.name ?? id;
export const actionLabel = (id: string): string => CARD_ACTIONS[id] ?? id;
/** Built-in template ids and their buttons; custom templates are rows in `card_templates`. */
export const builtinTemplate = (id: string): { name: string; actions: string[] } | null => CARD_TEMPLATES[id] ?? null;

export const linkFor = (publicUrl: string, woId: string | null): string => `${publicUrl.replace(/\/+$/, "")}/#${woId ? `record/${encodeURIComponent(woId)}` : "home"}`;

interface WoRow {
  id: string; title: string; cls: string; priority: string; repo: string | null; submitter: string | null; position: string; state: string; data: Record<string, unknown>; project_id: string;
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Approver text for a gate: the roles and people on the project's rule, and how many are needed. */
async function approversText(db: Queryable, orgId: string, projectId: string, gateId: string): Promise<string> {
  const r = (
    await db.query<{ rule: { roles?: string[]; people?: string[]; required?: number } }>(
      `select v.rule from approver_rules a join approver_rule_versions v on v.org_id = a.org_id and v.project_id = a.project_id and v.gate_id = a.gate_id and v.version = a.current_version
       where a.org_id = $1 and a.project_id = $2 and a.gate_id = $3`, [orgId, projectId, gateId],
    )
  ).rows[0]?.rule;
  if (!r) return "Submitter";
  const names: string[] = [];
  if (r.roles?.length) for (const x of (await db.query<{ id: string; name: string }>(`select id, name from roles where org_id = $1 and id = any($2)`, [orgId, r.roles])).rows) names.push(x.name);
  if (r.people?.length) for (const x of (await db.query<{ name: string }>(`select name from people where org_id = $1 and id = any($2)`, [orgId, r.people])).rows) names.push(x.name);
  return `${names.join(", ") || "Anyone with the right"} · ${r.required ?? 1} needed`;
}

export interface SampleInput {
  orgId: string;
  publicUrl: string;
  event: string;
  template?: string;
  projectId: string | null;
  woId?: string | null;
  /** The committed event this card is for (absent for previews and tests). */
  source?: EventLike | null;
  at?: Date;
}

/** Builds the card model for an event, from the work order, project and gate it refers to. Previews pass no source event and get a sample from the project's latest work order. */
export async function loadSample(db: Queryable, i: SampleInput): Promise<CardSample> {
  const project = i.projectId ? (await db.query<{ id: string; key: string; name: string; regulated: boolean }>(`select id, key, name, regulated from projects where org_id = $1 and id = $2`, [i.orgId, i.projectId])).rows[0] : null;
  const p = project ?? { id: i.projectId ?? "", key: "", name: i.projectId ?? "Gantry" };
  const a = obj(i.source?.after);
  let wo: WoRow | null = null;
  const woId = i.woId ?? i.source?.woId ?? null;
  if (woId) wo = (await db.query<WoRow>(`select id, title, class as cls, priority, repo_id as repo, submitter, position, state, data, project_id from work_orders where org_id = $1 and id = $2`, [i.orgId, woId])).rows[0] ?? null;
  else if (!i.source && i.projectId) {
    const pick = i.event.startsWith("gate") ? `state = 'waiting' desc,` : "";
    wo = (await db.query<WoRow>(`select id, title, class as cls, priority, repo_id as repo, submitter, position, state, data, project_id from work_orders where org_id = $1 and project_id = $2 and state <> 'killed' order by ${pick} created_at desc limit 1`, [i.orgId, i.projectId])).rows[0] ?? null;
  }
  const catalog = await readCatalog(db, i.orgId);
  const gateId = str(a.gate) || (wo && i.event.startsWith("gate") ? wo.position : "");
  const gateDef = catalog.gates.find((g) => g.id === gateId) ?? (!i.source ? catalog.gates.find((g) => g.id === "G2") : undefined) ?? null;
  const gate = gateDef ? { id: gateDef.id, label: gateDef.label, name: gateDef.name } : null;
  let instance = str(a.instance) || null;
  if (!instance && wo && gate && i.event === "gate.waiting") {
    instance = (await db.query<{ id: string }>(`select id from gate_instances where org_id = $1 and wo_id = $2 and gate_id = $3 and status = 'open' order by opened_at desc limit 1`, [i.orgId, wo.id, gate.id])).rows[0]?.id ?? null;
  }
  const clsName = wo ? catalog.classes.find((c) => c.id === wo!.cls)?.name ?? wo.cls : "Feature";
  const id = wo?.id ?? woId ?? (i.source ? null : "WO-2417");
  const title = wo?.title ?? (i.source ? "" : "Sample work order");
  const text = str(a.text);
  const approvers = gate && wo ? await approversText(db, i.orgId, p.id, gate.id) : "Submitter";
  const gl = gate ? `${gate.label} ${gate.name}` : "A gate";
  const who = (v: unknown): string => str(v);
  const H: Record<string, [string, string]> = {
    submitted: [`${id} submitted to ${p.name}`, text || "Intake classified it and opened the intake conversation."],
    question: [`Intake has a question on ${id}`, text || "What is in scope?"],
    "gate.waiting": [`${gl} is waiting on ${id}`, "This gate needs a person. Approving moves the work order to the next station."],
    "gate.escalated": [`${gl} on ${id} has waited too long`, text || "Waited past the escalation limit."],
    "gate.decided": [`${gate ? gate.label : "Gate"} ${/rejected/.test(text) ? "rejected" : "approved"} on ${id}`, text && /rejected/.test(text) ? text : `${who(a.mode) === "auto" ? "Passed automatically" : "Approved"}${a.by ? ` by ${who(a.by)}` : ""}. The work order moved on.`],
    blocked: [`${id} is blocked`, text || "The agent stopped and needs a decision."],
    "security.hold": [`${id} moved to Security hold`, text || "A security check flagged a finding."],
    andon: [`Andon halt on ${p.name}`, text || "A person halted the line. Agents finish their current step and wait."],
    kill: [`Kill switch pulled on ${p.name || "the factory"}`, text || "Hard stop. In-flight work is held in place until restored."],
    restore: [`${p.name || "The factory"} restored after kill`, text || "Work resumes from where it was held."],
    "onboarding.pr": [`Onboarding PR ${a.number ? `#${String(a.number)}` : ""} for ${str(a.repo) || "a repo"}`.replace("  ", " "), text || "The Onboarding agent proposes the changes this repo needs before work orders can run."],
    released: [`Released ${id}`, text || "Tagged and closed."],
    "eval.regression": ["Eval regression", text || "A suite score fell. Promotion is blocked."],
    budget: [`${p.name} budget threshold`, text || "Spend crossed the alert threshold."],
    "trust.changed": ["Trust level changed", text || "A trust cell moved on the ladder."],
    "learning.proposed": ["Learning proposal drafted", text || "Gantry grouped recent signals into a proposed improvement."],
    "outcome.recorded": [`Post-release outcome on ${id}`, text || "An outcome was recorded."],
    mention: [`${who(a.byName) || "Someone"} mentioned ${who(a.personName) || "you"}${id ? ` on ${id}` : " in a conversation"}`, text || "Open the conversation to read it."],
    "delivery.failed": [`A notification could not be delivered`, text || "A delivery ran out of attempts."],
  };
  const [head, body] = H[i.event] ?? [eventName(i.event), text];
  return {
    event: i.event, template: i.template ?? templateFor(i.event), tone: toneOf(i.event), head, body, woId: id, title, repo: wo?.repo ?? str(a.repo) ?? "", cls: wo?.cls ?? "feature", clsName, prio: wo?.priority ?? "P2",
    approvers, gate, instance, link: linkFor(i.publicUrl, id), project: { id: p.id, key: p.key, name: p.name }, at: (i.at ?? new Date()).getTime(),
  };
}

/** The labelled facts a card shows, in field order. */
export function factRows(f: CardFields | null | undefined, event: string, template: string, s: CardSample): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (fieldOn(f, "title") && s.woId) rows.push(["Work order", `${s.woId} · ${s.title}`]);
  if (fieldOn(f, "repo") && s.repo) rows.push(["Repo", s.repo]);
  if (fieldOn(f, "class") && s.woId) rows.push(["Class", s.clsName]);
  if (fieldOn(f, "priority") && s.woId) rows.push(["Priority", s.prio]);
  if (fieldOn(f, "approvers") && (template === "gate" || event.startsWith("gate"))) rows.push(["Approvers", s.approvers]);
  return rows;
}

export interface CardAction { id: string; label: string; primary?: boolean; style?: "primary" | "danger"; url?: string }

/**
 * The buttons on a card. Approve and reject appear only when the destination allows in-chat approval for this gate (spec 12.3). Email never approves.
 * `fields.actions === false` removes all buttons; `fields.link === false` removes "Open in Gantry".
 */
export function actionsFor(f: CardFields | null | undefined, template: string, o: { canApprove: boolean; actions?: string[]; channel: string }, link: string): CardAction[] {
  if (!fieldOn(f, "actions")) return [];
  let list = (o.actions ?? builtinTemplate(template)?.actions ?? ["open"]).slice();
  if (!o.canApprove || o.channel === "email") list = list.filter((a) => a !== "approve" && a !== "reject");
  // Rejecting needs a written reason, so it is done in Gantry: a chat card offers Approve and Open only.
  if (o.channel === "slack") list = list.filter((a) => a !== "reject");
  if (!fieldOn(f, "link")) list = list.filter((a) => a !== "open");
  return list.map((id, n) => ({ id, label: actionLabel(id), ...(n === 0 ? { primary: true } : {}), ...(id === "approve" ? { style: "primary" as const } : id === "reject" ? { style: "danger" as const } : {}), ...(id !== "approve" && id !== "reject" ? { url: link } : {}) }));
}

/** Slack Block Kit for a card. Approve and reject carry the gate instance id, so a click on an instance that is no longer open is refused (spec 12.3). */
export function slackBlocks(s: CardSample, rows: Array<[string, string]>, actions: CardAction[], o: { closed?: string } = {}): unknown[] {
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${esc(s.head)}*${s.body ? `\n${esc(s.body)}` : ""}` } }];
  if (rows.length) blocks.push({ type: "section", fields: rows.slice(0, 10).map(([k, v]) => ({ type: "mrkdwn", text: `*${esc(k)}*\n${esc(v)}` })) });
  if (o.closed) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: esc(o.closed) }] });
  else if (actions.length) {
    blocks.push({
      type: "actions",
      elements: actions.slice(0, 5).map((a) => ({
        type: "button", text: { type: "plain_text", text: a.label }, action_id: `gantry.${a.id}`, ...(a.style ? { style: a.style } : {}),
        ...(a.url ? { url: a.url } : { value: JSON.stringify({ instance: s.instance, wo: s.woId, gate: s.gate?.id ?? null }) }),
      })),
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${esc(s.project.name)} · ${esc(s.link)}` }] });
  return blocks;
}

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escHtml = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function teamsCard(s: CardSample, rows: Array<[string, string]>, actions: CardAction[]): unknown {
  return {
    type: "AdaptiveCard", version: "1.4", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [{ type: "TextBlock", size: "Medium", weight: "Bolder", text: s.head, wrap: true }, ...(s.body ? [{ type: "TextBlock", text: s.body, wrap: true }] : []), ...(rows.length ? [{ type: "FactSet", facts: rows.map(([title, value]) => ({ title, value })) }] : [])],
    actions: actions.filter((a) => a.url).map((a) => ({ type: "Action.OpenUrl", title: a.label, url: a.url })),
  };
}

export function emailParts(s: CardSample, rows: Array<[string, string]>, actions: CardAction[], o: { route?: string; showLink: boolean }): { subject: string; text: string; html: string } {
  const subject = `[${s.project.key || s.project.name}] ${s.head}`;
  const text = [s.head, s.body, ...rows.map(([k, v]) => `${k}: ${v}`), ...actions.filter((a) => a.url).map((a) => `${a.label}: ${a.url}`), o.showLink ? `Link: ${s.link}` : ""].filter(Boolean).join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a1d21"><h3 style="margin:0 0 8px">${escHtml(s.head)}</h3>${s.body ? `<p>${escHtml(s.body)}</p>` : ""}${rows.length ? `<table cellpadding="4">${rows.map(([k, v]) => `<tr><th align="left">${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join("")}</table>` : ""}${actions.filter((a) => a.url).map((a) => `<p><a href="${escHtml(a.url!)}">${escHtml(a.label)}</a></p>`).join("")}<p style="color:#666;font-size:12px">${o.route ? `You get this because route ${escHtml(o.route)} on ${escHtml(s.project.name)} sends ${escHtml(eventName(s.event).toLowerCase())} events here. ` : ""}Manage notifications in Gantry.</p></body></html>`;
  return { subject, text, html };
}

/** The JSON a signed webhook or a custom HTTP type receives for a card: the same facts, machine readable (CloudEvents style when the type says so). */
export function webhookData(s: CardSample, f: CardFields | null | undefined): Record<string, unknown> {
  const wo: Record<string, unknown> = {};
  if (s.woId) wo.id = s.woId;
  if (fieldOn(f, "title") && s.title) wo.title = s.title;
  if (fieldOn(f, "repo") && s.repo) wo.repo = s.repo;
  if (fieldOn(f, "class") && s.woId) wo.class = s.cls;
  if (fieldOn(f, "priority") && s.woId) wo.priority = s.prio;
  return { event: s.event, head: s.head, body: s.body, project: s.project.id, workOrder: wo, ...(s.gate ? { gate: s.gate.id } : {}), ...(fieldOn(f, "link") ? { link: s.link } : {}) };
}

/** `{{path}}` placeholders of a custom type's request template. Only values of the card model are reachable; there is no code, no expression language. */
export function renderTemplate(tpl: string, s: CardSample, o: { json?: boolean; extra?: Record<string, unknown> } = {}): string {
  const extra = o.extra ?? {};
  const ctx: Record<string, unknown> = { event: s.event, head: s.head, body: s.body, woId: s.woId, title: s.title, repo: s.repo, class: s.cls, priority: s.prio, link: s.link, project: s.project.id, projectName: s.project.name, gate: s.gate?.id ?? "", at: new Date(s.at).toISOString(), ...extra };
  return tpl.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_m, k: string) => {
    const v = ctx[k];
    if (v == null) return "";
    if (o.json === false) return typeof v === "string" ? v : JSON.stringify(v);
    return typeof v === "string" ? JSON.stringify(v).slice(1, -1) : JSON.stringify(v);
  });
}
