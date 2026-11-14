/** Slash commands (legacy console.js SLASH and its intent parsing). Each one runs a console tool directly against live data: no model is involved, so they work without one. */
import { DAYS, istTime, istToday, fmt } from "@gantry/domain";

export const SLASH: Array<{ cmd: string; hint: string }> = [
  { cmd: "/help", hint: "What the console understands" },
  { cmd: "/projects", hint: "Your projects with state, WIP and gates" },
  { cmd: "/status ", hint: "One project in detail, e.g. /status payments" },
  { cmd: "/onboarding ", hint: "Repo onboarding pipeline, e.g. /onboarding storefront" },
  { cmd: "/onboard ", hint: "Connect a repo, e.g. /onboard acme/search-api to identity" },
  { cmd: "/new ", hint: "New work order, e.g. /new payments-api: Fix refund rounding" },
  { cmd: "/why ", hint: "Why is a work order stuck, e.g. /why WO-2398" },
  { cmd: "/who-can ", hint: "e.g. /who-can release payments friday 22:00" },
  { cmd: "/approve ", hint: "Approve the gate a work order waits at" },
  { cmd: "/evals", hint: "Latest eval scores and regressions" },
  { cmd: "/triggers ", hint: "GitHub and schedule triggers for a project" },
  { cmd: "/halt ", hint: "Andon: /halt payments-api duplicate refunds" },
  { cmd: "/resume ", hint: "Resume a halted project or repo" },
  { cmd: "/kill ", hint: "Hard stop: /kill WO-2398 | /kill payments | /kill factory, then a reason" },
  { cmd: "/restore ", hint: "Restore after a kill: /restore payments reason" },
  { cmd: "/changes ", hint: "What changed in a project, e.g. /changes payments" },
  { cmd: "/bottlenecks", hint: "Which gates wait longest on people" },
  { cmd: "/summary ", hint: "Plain summary of a work order, e.g. /summary WO-2417" },
  { cmd: "/workload", hint: "Who carries the approvals in your projects" },
  { cmd: "/trust ", hint: "Trust levels and proposals, e.g. /trust payments" },
  { cmd: "/mine", hint: "Approvals and questions waiting on you" },
];

export interface ProjectRef { id: string; name: string; key?: string }

export type Plan =
  | { kind: "help" }
  | { kind: "reply"; text: string }
  | { kind: "tool"; tool: string; input: Record<string, unknown>; intro: string; card: string; action?: boolean; project?: string };

const ACTION_WORDS: Array<[RegExp, string]> = [
  [/kill (the )?factory/, "kill.factory"], [/restore (the )?factory/, "restore.factory"], [/kill (a |the )?(project|line)/, "kill.project"], [/restore (a |the )?project/, "restore.project"],
  [/kill (a |the )?(work ?order|wo)\b/, "kill.workorder"], [/restore (a |the )?(work ?order|wo)\b/, "restore.workorder"], [/\bkill\b/, "kill.project"],
  [/release|ship|deploy/, "release"], [/merge (the )?onboarding|onboarding pr/, "onboarding.merge"], [/onboard|connect (a )?repo/, "repo.onboard"],
  [/approver/, "approvers.edit"], [/approve|gate/, "gate.approve"], [/resume/, "line.resume"], [/halt|andon|stop the line/, "line.halt"],
  [/submit|new work order|create (a )?work order/, "wo.submit"], [/confirm (the )?brief/, "brief.confirm"], [/reclassify|classif/, "wo.classify"], [/decline/, "wo.decline"],
  [/send back|rework/, "wo.sendback"], [/reassign/, "wo.reassign"], [/trigger/, "triggers.edit"], [/api key/, "api.keys"], [/invite|people/, "people.manage"],
  [/polic|permission/, "policy.edit"], [/security|sso|mfa/, "security.manage"], [/agent/, "agent.edit"], [/model|routing/, "model.edit"], [/eval/, "eval.run"],
  [/archive/, "project.archive"], [/member/, "project.members"], [/config|flow/, "project.config"], [/audit|ledger/, "audit.view"],
];
export const parseAction = (t: string): string | null => ACTION_WORDS.find(([re]) => re.test(t.toLowerCase()))?.[1] ?? null;

/** "friday 22:00", "tonight", "tomorrow 9am": an IST moment (epoch ms) and its label; now when nothing is named. */
export function parseWhen(t: string, now: number): { t: number; label: string } {
  const low = t.toLowerCase();
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const todayIst = new Date(now + 330 * 60000);
  let offset = 0;
  let named = false;
  const di = names.findIndex((d) => low.includes(d) || new RegExp(`\\b${d.slice(0, 3)}\\b`).test(low));
  if (di >= 0) { offset = (di - todayIst.getUTCDay() + 7) % 7; named = true; } else if (/tomorrow/.test(low)) { offset = 1; named = true; } else if (/today|tonight/.test(low)) named = true;
  let time: string | null = null;
  const m = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? low.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    let hh = +m[1]!;
    if (m[3] === "pm" && hh < 12) hh += 12;
    if (m[3] === "am" && hh === 12) hh = 0;
    time = `${String(hh).padStart(2, "0")}:${m[2] ?? "00"}`;
  } else if (/night|tonight/.test(low)) time = "22:00"; else if (/evening/.test(low)) time = "19:00"; else if (/afternoon/.test(low)) time = "15:00"; else if (/morning/.test(low)) time = "10:00";
  if (!named && !time) return { t: now, label: `now (${fmt.stamp(now)})` };
  const tt = istTime(istToday(now, offset), time ?? "12:00");
  return { t: tt, label: fmt.stamp(tt) };
}

const esc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reason text left after the command word and the target are removed. */
const rest = (t: string, words: Array<string | null | undefined>): string => {
  let out = t;
  for (const w of words) if (w) out = out.replace(new RegExp(esc(w), "i"), "");
  return out.replace(/^\s*(because|:|-|,)\s*/i, "").replace(/\s+/g, " ").trim();
};

export function findProject(t: string, projects: ProjectRef[]): ProjectRef | null {
  const low = ` ${t.toLowerCase()} `;
  return projects.find((p) => new RegExp(`[\\s/:,]${esc(p.id)}[\\s.,:?!]`).test(low) || low.includes(` ${p.name.toLowerCase()}`) || (p.key ? new RegExp(`\\s${esc(p.key.toLowerCase())}[\\s.,:?!]`).test(low) : false)) ?? null;
}
export const findWO = (t: string): string | null => {
  const m = t.match(/wo-?\s?(\d{3,6})/i);
  return m ? `WO-${m[1]}` : null;
};

const pick = (p: ProjectRef | null, cur: ProjectRef | null): ProjectRef | null => p ?? cur;

/**
 * Turns "/command rest" into a plan. `projects` are the ones the person can see; `current` is the project they are looking at.
 * Anything that changes state is a propose tool: the answer is a confirm card, and nothing runs until it is confirmed.
 */
export function plan(text: string, projects: ProjectRef[], current: ProjectRef | null, now: number): Plan {
  const t = text.trim();
  const m = /^\/([a-z-]+)\b\s*(.*)$/i.exec(t);
  if (!m) return { kind: "reply", text: "Slash commands start with /. Type / to see them." };
  const cmd = m[1]!.toLowerCase();
  const args = m[2] ?? "";
  const proj = findProject(args, projects);
  const p = pick(proj, current);
  const wo = findWO(args);
  const needProject = (what: string): Plan => ({ kind: "reply", text: `Which project? You can ask about ${projects.slice(0, 4).map((x) => x.name).join(", ") || "none yet"}${what ? ` ${what}` : ""}.` });
  switch (cmd) {
    case "help": return { kind: "help" };
    case "projects": case "project": return { kind: "tool", tool: "list_projects", input: {}, intro: "Your projects", card: "projects" };
    case "status":
      return p ? { kind: "tool", tool: "project_status", input: { project: p.id }, intro: `${p.name}${proj ? "." : " (your current project)."}`, card: "status" } : { kind: "reply", text: "Which project?" };
    case "onboarding": return { kind: "tool", tool: "onboarding_state", input: p ? { project: p.id } : {}, intro: `Onboarding${p ? ` for ${p.name}` : ""}. Work orders can only go to Ready repos.`, card: "onboarding" };
    case "onboard": {
      const repo = args.match(/([a-z0-9-]+\/[a-z0-9._-]+)/i)?.[1];
      if (!repo) return { kind: "reply", text: "Which repo? For example: /onboard acme/search-api to identity" };
      const pp = findProject(args.replace(repo, ""), projects) ?? current;
      return pp ? { kind: "tool", tool: "propose_onboard_repo", input: { project: pp.id, repo }, intro: "Here is the plan. Nothing changes until you confirm it.", card: "proposal", action: true } : needProject("");
    }
    case "new": {
      const body = args.replace(/^work order\b/i, "").trim();
      const repoTok = body.split(/[:\s]/)[0] ?? "";
      const title = (body.split(/:\s*/).slice(1).join(": ") || (body.match(/\bto (.+)$/i)?.[1] ?? "")).trim();
      if (!repoTok) return { kind: "reply", text: "Which repo? For example: /new payments-api: Fix refund rounding" };
      if (!title) return { kind: "reply", text: `What should the work order say? For example: /new ${repoTok}: Fix refund rounding` };
      const prio = body.match(/\b(P[0-3])\b/i)?.[1]?.toUpperCase();
      const clean = title.replace(/\bP[0-3]\b/i, "").trim();
      return p ? { kind: "tool", tool: "propose_submit_work_order", input: { project: p.id, repo: repoTok, title: clean.charAt(0).toUpperCase() + clean.slice(1), ...(prio ? { priority: prio } : {}) }, intro: "Here is the plan. Nothing changes until you confirm it.", card: "proposal", action: true } : needProject("");
    }
    case "why": case "explain": return wo ? { kind: "tool", tool: "get_work_order", input: { id: wo }, intro: `Here is what the record says about ${wo}.`, card: "explain" } : { kind: "reply", text: "Which work order? For example: /why WO-2398" };
    case "summary": return wo ? { kind: "tool", tool: "get_work_order", input: { id: wo }, intro: "", card: "summary" } : { kind: "reply", text: "Which work order? For example: /summary WO-2417" };
    case "who-can": case "whocan": {
      const action = parseAction(args);
      if (!action) return { kind: "reply", text: "Which action? For example: who can release payments on Friday at 22:00?" };
      const when = parseWhen(args, now);
      return { kind: "tool", tool: "who_can", input: { action, ...(p ? { project: p.id } : {}), at: when.t }, intro: `Asked the policy engine, ${when.label}.`, card: "whocan" };
    }
    case "approve": return wo ? { kind: "tool", tool: "propose_approve_gate", input: { wo }, intro: "Here is the plan. Nothing changes until you confirm it.", card: "proposal", action: true } : { kind: "reply", text: "Which work order? For example: /approve WO-2398" };
    case "evals": return { kind: "tool", tool: "evals", input: {}, intro: "Latest run per agent against its promotion threshold.", card: "evals" };
    case "triggers": return { kind: "tool", tool: "triggers", input: p ? { project: p.id } : {}, intro: `Triggers${p ? ` of ${p.name}` : ""}. Triggers are off in a new install.`, card: "triggers" };
    case "halt": {
      if (wo || /\bfactory\b/i.test(args)) return { kind: "reply", text: `Halt a project or a repo, for example: /halt payments-api duplicate refunds. To stop one work order, use /kill ${wo ?? "WO-…"}.` };
      const target = proj ? { scope: "project", id: proj.id, word: proj.name } : (args.split(/\s+/)[0] ? { scope: "repo", id: args.split(/\s+/)[0]!, word: args.split(/\s+/)[0]! } : null);
      if (!target) return { kind: "reply", text: "Halt a project or a repo, for example: /halt payments-api duplicate refunds." };
      const reasonText = rest(args, [target.word, proj?.id, proj?.key]);
      return { kind: "tool", tool: "propose_halt", input: { scope: target.scope, id: target.id, reason: reasonText }, intro: "Here is the plan. Nothing changes until you confirm it.", card: "proposal", action: true };
    }
    case "resume": {
      const first = args.split(/\s+/)[0] ?? "";
      const target = proj ? { scope: "project", id: proj.id } : first ? { scope: "repo", id: first } : null;
      return target ? { kind: "tool", tool: "propose_resume", input: target, intro: "Here is the plan. Nothing changes until you confirm it.", card: "proposal", action: true } : { kind: "reply", text: "Resume a project or a repo, for example: /resume payments-api." };
    }
    case "kill": case "restore": {
      const verb = cmd === "kill" ? "propose_kill" : "propose_restore";
      const target = /\bfactory\b/i.test(args) && !wo && !proj ? { scope: "factory" } : wo ? { scope: "workorder", id: wo } : proj ? { scope: "project", id: proj.id } : null;
      if (!target) return { kind: "reply", text: cmd === "kill" ? "What should I kill? /kill WO-2398 reason, /kill payments reason, or /kill factory reason. Kills are hard stops; for a pause use /halt." : "What should I restore? /restore WO-2398 reason, /restore payments reason, or /restore factory reason." };
      const reasonText = rest(args, [wo, proj?.name, proj?.id, proj?.key, target.scope === "factory" ? "the factory" : null, target.scope === "factory" ? "factory" : null]);
      return { kind: "tool", tool: verb, input: { ...target, reason: reasonText }, intro: "Here is the plan. Nothing changes until you confirm it.", card: "proposal", action: true };
    }
    case "changes": {
      const low = args.toLowerCase();
      const hrs = /today|24 ?h|last day/.test(low) ? 24 : Math.min(168, (low.match(/(\d+)\s*(day|d\b)/) ? +low.match(/(\d+)\s*(day|d\b)/)![1]! * 24 : 0) || (low.match(/(\d+)\s*(hour|h\b)/) ? +low.match(/(\d+)\s*(hour|h\b)/)![1]! : 168));
      return p ? { kind: "tool", tool: "events", input: { project: p.id, since_hours: hrs, ...(/kill|halt/.test(low) ? { types: ["kill", "restore", "halt", "resume"] } : {}) }, intro: `What changed in ${p.name} in the last ${hrs >= 48 ? `${Math.round(hrs / 24)} days` : `${hrs} hours`}.`, card: "changes" } : needProject("");
    }
    case "bottlenecks": return { kind: "tool", tool: "workload", input: proj ? { project: proj.id } : {}, intro: `Gates where work waited longest for a person${proj ? ` in ${proj.name}` : ""}.`, card: "bottlenecks" };
    case "workload": return { kind: "tool", tool: "workload", input: proj ? { project: proj.id } : {}, intro: `Who carried the human work${proj ? ` in ${proj.name}` : ""} over 7 days, by estimated minutes.`, card: "workload" };
    case "trust": return p ? { kind: "tool", tool: "trust", input: { project: p.id }, intro: `Trust in ${p.name}.`, card: "trust" } : needProject("");
    case "mine": return { kind: "tool", tool: "waiting_on_me", input: {}, intro: "Waiting on you.", card: "mine" };
    default: return { kind: "reply", text: `I do not know /${cmd}. Type /help to see what the console understands.` };
  }
}

export { DAYS };
