/**
 * Shared pieces of the Notifications screen (legacy views/notifications.js): the routing data of one project, destination checks, and the card previews
 * (Slack, Teams, email, webhook). Previews are drawn from the server's rendering (`POST /card-templates/preview`), which uses the same builders the producer
 * uses, so what shows here is what goes out. Nothing is sent by a preview.
 */
import { useQuery } from "@tanstack/react-query";
import { CARD_ACTIONS, CARD_DEFAULTS, CARD_TEMPLATES, NOTIFY_EVENTS, fmt, type CardTemplate, type IntegrationInstance, type NotificationRoute, type Project } from "@gantry/domain";
import { api } from "../../api/client";
import { ops } from "../../api/ops";
import { useCardTemplates, useIntegrations, useIntegrationTypes, useMe, useProjects, useRoutes } from "../../api/queries";
import { usePrefs } from "../../lib/prefs";
import { Btn, useCopy } from "../../ui/primitives";
import { Icon, Logo } from "../../ui/Icon";
import type { TypeRow } from "../integrations/kit";

export const FIELDS: Array<[string, string]> = [["title", "Work order title"], ["repo", "Repo"], ["class", "Class"], ["priority", "Priority"], ["approvers", "Approvers"], ["link", "Link"], ["actions", "Action buttons"]];
export const KIND_EVENT: Record<string, string> = { gate: "gate.waiting", question: "question", incident: "blocked", kill: "kill", release: "released", onboarding: "onboarding.pr", submitted: "submitted", budget: "budget", eval: "eval.regression" };
export const TPL = CARD_TEMPLATES;
export const ACTION_LABEL = CARD_ACTIONS;
export const DEF_TPL = CARD_DEFAULTS;
export const ALL_FIELDS = { title: true, repo: true, class: true, priority: true, approvers: true, link: true, actions: true };
export type Fields = typeof ALL_FIELDS;
export const fieldOn = (f: Partial<Fields> | null | undefined, k: string): boolean => !f || (f as Record<string, boolean | undefined>)[k] !== false;
export const events = (): Array<{ value: string; label: string }> => NOTIFY_EVENTS.map((e) => ({ value: e.id, label: e.name }));
export const evName = (id: string): string => NOTIFY_EVENTS.find((e) => e.id === id)?.name ?? id;

export type Route = NotificationRoute & { version?: number };
export type Dest = NotificationRoute["dest"][number];
export type Draft = Omit<Route, "id" | "fields"> & { id: string | null; fields: Fields };

export const chanIcon = (typeId: string): string => ({ slack: "slack", teams: "teams", email: "mail", webhook: "webhook", paging: "page", github: "github" } as Record<string, string>)[typeId] ?? "plug";

export interface Conn extends IntegrationInstance { t: TypeRow }
export const instState = (i: IntegrationInstance | null | undefined): string => (!i ? "missing" : !i.connected ? "disabled" : i.status === "failing" ? "failing" : i.status === "offline" ? "offline" : "healthy");

/** A type that lists Gantry events takes only those; the built-in chat, email and webhook types take any (legacy G.integrationAccepts). */
export function accepts(t: TypeRow, ev: string): boolean {
  const gantry = (t.events ?? []).filter((e) => NOTIFY_EVENTS.some((n) => n.id === e));
  return !gantry.length || gantry.includes(ev);
}

export function defaultTarget(type: string, p: Pick<Project, "key">, inst: IntegrationInstance | null): string {
  if (type === "email") return "submitter";
  if (type === "slack") return (typeof inst?.config.defaultChannel === "string" && inst.config.defaultChannel) || `#${p.key.toLowerCase()}-factory`;
  if (type === "teams") return "General";
  if (type === "webhook") return inst ? inst.targetId || inst.id : "";
  return "";
}

/** Everything the screen needs about the current project. */
export function useNtData() {
  const me = useMe();
  const prefs = usePrefs();
  const projects = useProjects().data ?? [];
  const types = (useIntegrationTypes().data ?? []) as TypeRow[];
  const insts = useIntegrations().data ?? [];
  const customCards = useCardTemplates().data ?? [];
  const visible = me ? projects.filter((p) => me.projects.some((x) => x.id === p.id)) : projects;
  const project = visible.find((p) => p.id === prefs.project) ?? visible[0] ?? null;
  const routesQ = useRoutes(project?.id);
  const versions = new Map((routesQ.data ?? []).map((r) => [r.id, r.version]));
  const typeOf = (typeId: string): TypeRow => types.find((t) => t.id === typeId) ?? ({ id: typeId, name: typeId, category: "custom", icon: "plug", fields: [], events: [], actions: [] } as unknown as TypeRow);
  const opensTo = (i: IntegrationInstance): boolean => !project || i.projects === "all" || i.projects.includes(project.id);
  /** Connections that can receive notifications and are open to the project. */
  const destInsts = project ? insts.filter((i) => typeOf(i.type).destination && typeOf(i.type).available !== false && opensTo(i)) : [];
  const instOf = (d: Pick<Dest, "channel" | "target" | "integration">): IntegrationInstance | null => {
    if (d.integration) return insts.find((i) => i.id === d.integration) ?? null;
    if (d.channel === "webhook") {
      const w = insts.find((i) => i.type === "webhook" && i.targetId === d.target);
      if (w) return w;
    }
    const mine = destInsts.filter((i) => i.type === d.channel);
    return mine.find((i) => i.connected && i.status !== "failing") ?? mine[0] ?? null;
  };
  const tplInfo = (id: string): { id: string; name: string; kind: string; actions: string[]; fields?: string[] | undefined; custom: boolean; integration?: string | null | undefined } => {
    const b = TPL[id];
    if (b) return { id, name: b.name, kind: id, actions: [...b.actions], custom: false };
    const c = customCards.find((t) => t.id === id);
    if (c) return { id: c.id, name: c.name, kind: c.kind ?? "submitted", actions: [...(c.actions ?? [])], fields: c.fields, custom: true, integration: c.integration };
    return { id, name: id, kind: "submitted", actions: [...TPL.submitted!.actions], custom: false };
  };
  const tplOptions = (include?: string): Array<{ value: string; label: string }> => [
    ...Object.keys(TPL).map((k) => ({ value: k, label: TPL[k]!.name })),
    ...customCards.map((t) => ({ value: t.id, label: `${t.name} (custom)` })),
    ...(include && !TPL[include] && !customCards.some((t) => t.id === include) ? [{ value: include, label: tplInfo(include).name }] : []),
  ];
  const routesUsingTpl = (id: string): string[] => {
    const out: string[] = [];
    for (const p of projects) for (const r of p.notifications ?? []) if (r.template === id) out.push(`${p.key} ${r.id}`);
    return out;
  };
  return { me, project, visible, projects, types, insts, destInsts, instOf, typeOf, tplInfo, tplOptions, customCards, routesUsingTpl, versions, routes: project?.notifications ?? [] };
}

export function targetError(d: Dest, ctx: { project: Project; instOf: (d: Dest) => IntegrationInstance | null; typeOf: (id: string) => TypeRow }): string | null {
  const t = (d.target || "").trim();
  const inst = ctx.instOf(d);
  if (!inst) return "Pick a connection for each destination. Add one in Integrations if the list is empty.";
  if (!(inst.projects === "all" || inst.projects.includes(ctx.project.id))) return `${inst.name} is not open to ${ctx.project.name}. Change its scope in Integrations.`;
  const ty = ctx.typeOf(inst.type);
  if (!t && inst.type !== "webhook") return `${inst.name} needs a ${(ty.targetLabel || "target").toLowerCase()}.`;
  if (inst.type === "slack" && !/^[#@][a-z0-9._-]+$/i.test(t)) return "Slack targets start with # (channel) or @ (person or role).";
  if (inst.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && !["submitter", "approvers", "project admins"].includes(t)) return "Email targets are an address or one of: submitter, approvers, project admins.";
  return null;
}

export const draftError = (r: { dest: Dest[] }, ctx: Parameters<typeof targetError>[1]): string | null => {
  if (!r.dest.length) return "Add at least one destination.";
  for (const d of r.dest) {
    const e = targetError(d, ctx);
    if (e) return e;
  }
  return null;
};

/* ---------- server-rendered preview ---------- */

export interface PreviewSample {
  event: string; template: string; tone: string; head: string; body: string; woId: string | null; title: string; repo: string; cls: string; clsName: string; prio: string; approvers: string;
  gate: { id: string; label: string; name: string } | null; instance: string | null; link: string; project: { id: string; key: string; name: string }; at: number;
}
export interface Preview { sample: PreviewSample; rows: Array<[string, string]>; actions: string[]; webhook: Record<string, unknown>; email: { subject: string; text: string; html: string } }

export function usePreview(project: string | null | undefined, o: { event: string; template: string; fields: Partial<Fields>; actions?: string[] | undefined }) {
  return useQuery({
    queryKey: ["cardPreview", project, o.event, o.template, o.fields, o.actions ?? null],
    enabled: !!project,
    queryFn: async () => {
      const r = await ops.previewCardTemplate({ project, event: o.event, template: o.template, fields: o.fields, ...(o.actions ? { actions: o.actions } : {}) });
      if (!r.ok) throw new Error(r.msg);
      return r as unknown as Preview;
    },
    staleTime: 15_000,
  });
}

/** The buttons a card shows for one destination: approve only where that connection allows approving from chat, and never on email. */
export function actionsFor(pv: Preview, fields: Partial<Fields>, channel: string, inst: IntegrationInstance | null): { list: string[]; note: string | null } {
  if (!fieldOn(fields, "actions")) return { list: [], note: "Action buttons are off for this route." };
  let list = pv.actions.slice();
  let note: string | null = null;
  const can = inst?.config.approve === true;
  if (list.includes("approve") && !can) {
    list = list.filter((a) => a !== "approve" && a !== "reject");
    note = channel === "email" ? "Email cards never approve; the button opens Gantry where approver rules run." : `Approve from card is off for ${inst ? inst.name : channel}. Turn it on in that connection's settings in Integrations.`;
  }
  if (channel === "slack") list = list.filter((a) => a !== "reject");
  if (!fieldOn(fields, "link")) list = list.filter((a) => a !== "open");
  return { list, note };
}

const Note = ({ text }: { text: string | null }) => (text ? <div className="np-note small"><Icon name="lock" />{text}</div> : null);
const Btns = ({ acts, cls }: { acts: string[]; cls: string }) => (acts.length ? <div className={cls}>{acts.map((a) => <span key={a} className={`np-act np-act-${a}`} role="presentation">{ACTION_LABEL[a]}</span>)}</div> : null);

export function SlackCard({ pv, fields, target, inst }: { pv: Preview; fields: Partial<Fields>; target: string; inst: IntegrationInstance | null }) {
  const s = pv.sample;
  const acts = actionsFor(pv, fields, "slack", inst);
  return (
    <div className="np-frame np-slack">
      <div className="np-chanbar"><span className="mono">{target || "#channel"}</span><span className="muted small">{inst ? inst.name : "Slack"} · preview</span></div>
      <div className="np-msg">
        <span className="np-appav"><Logo /></span>
        <div className="np-msg-main">
          <div className="np-msg-meta"><strong>Gantry</strong><span className="np-appbadge">APP</span><span className="muted small mono">{fmt.ist(s.at)}</span></div>
          <div className="np-msg-text"><strong>{s.head}</strong></div>
          <div className={`np-attach np-tone-${s.tone}`}>
            <div className="np-attach-body">
              {s.body ? <p>{s.body}</p> : null}
              <dl className="np-fields">{pv.rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
              <Btns acts={acts.list} cls="np-btns" />
              <div className="np-ctx small">{s.project.name}{fieldOn(fields, "link") ? <> · <span className="np-link">{s.link.replace(/^https?:\/\//, "")}</span></> : null}</div>
            </div>
          </div>
          <Note text={acts.note} />
        </div>
      </div>
    </div>
  );
}

export function TeamsCard({ pv, fields, target, inst }: { pv: Preview; fields: Partial<Fields>; target: string; inst: IntegrationInstance | null }) {
  const s = pv.sample;
  const acts = actionsFor(pv, fields, "teams", inst);
  return (
    <div className="np-frame np-teams">
      <div className="np-chanbar"><span><Icon name="teams" /> {target || "General"}</span><span className="muted small">{inst ? inst.name : "Teams"} · preview</span></div>
      <div className={`np-tcard np-tone-${s.tone}`}>
        <div className="np-tcard-band" />
        <div className="np-tcard-head"><span className="np-appav np-appav-sm"><Logo /></span><strong>Gantry</strong><span className="muted small mono">{fmt.ist(s.at)}</span></div>
        <div className="np-tcard-title">{s.head}</div>
        {s.body ? <p className="np-tcard-sub">{s.body}</p> : null}
        <table className="np-facts"><tbody>{pv.rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
        <Btns acts={acts.list} cls="np-tbtns" />
      </div>
      <Note text={acts.note} />
    </div>
  );
}

export function EmailCard({ pv, fields, target, inst, route }: { pv: Preview; fields: Partial<Fields>; target: string; inst: IntegrationInstance | null; route: string | null }) {
  const s = pv.sample;
  const acts = actionsFor(pv, fields, "email", inst);
  return (
    <div className="np-frame np-email">
      <dl className="np-mailhead">
        <div><dt>From</dt><dd>Gantry &lt;{typeof inst?.config.from === "string" ? inst.config.from : "gantry@localhost"}&gt;</dd></div>
        <div><dt>To</dt><dd>{target || "recipient"}</dd></div>
        <div><dt>Subject</dt><dd><strong>{pv.email.subject}</strong></dd></div>
      </dl>
      <div className="np-mailbody">
        <div className={`np-mailbrand np-tone-${s.tone}`}><Logo /><span>GANTRY</span></div>
        <h3 className="np-mail-h">{s.head}</h3>
        {s.body ? <p>{s.body}</p> : null}
        <table className="np-mailtable"><tbody>{pv.rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
        {acts.list.length ? <div className="np-btns">{acts.list.map((a, i) => <span key={a} className={`np-act${i === 0 ? " np-act-primary" : ""}`}>{ACTION_LABEL[a]}</span>)}</div> : null}
        {fieldOn(fields, "link") ? <p className="small muted">Or paste this link: <span className="np-link mono">{s.link}</span></p> : null}
        <p className="np-mailfoot small">You get this because route {route || "(new)"} on {s.project.name} sends {evName(s.event).toLowerCase()} events here. Manage notifications in Gantry.</p>
      </div>
      <Note text={acts.note} />
    </div>
  );
}

export function WebhookCard({ pv, target, inst, typeName }: { pv: Preview; target: string; inst: IntegrationInstance | null; typeName?: string }) {
  const copy = useCopy();
  const json = JSON.stringify({ id: `evt_${(pv.sample.at % 1e8).toString(36)}`, type: pv.sample.event, created_at: new Date(pv.sample.at).toISOString(), summary: pv.sample.head, ...pv.webhook }, null, 2);
  const url = typeof inst?.config.url === "string" ? inst.config.url : "https://receiver.example/hook";
  return (
    <div className="np-frame np-hook">
      <div className="np-chanbar"><span className="mono">{(inst ? `${inst.name} · ` : "") + (target || "endpoint")}</span><Btn label="Copy JSON" small icon="copy" id="nt-copy-json" onClick={() => copy(json)} /></div>
      <pre className="np-pre np-pre-head mono">{`POST ${url}\nContent-Type: application/json\nX-Gantry-Event: ${pv.sample.event}\nX-Gantry-Signature: t=<unix>,v1=<hmac-sha256 of "<t>.<body>">`}</pre>
      <pre className="np-pre mono" tabIndex={0} aria-label="Webhook JSON payload">{json}</pre>
      {typeName ? <span className="sr-only">{typeName}</span> : null}
    </div>
  );
}

/** One preview card for a destination, picked by the connection's type. */
export function DestCard({ pv, fields, dest, inst, route }: { pv: Preview; fields: Partial<Fields>; dest: Dest; inst: IntegrationInstance | null; route: string | null }) {
  const type = inst?.type ?? dest.channel;
  if (type === "teams") return <TeamsCard pv={pv} fields={fields} target={dest.target} inst={inst} />;
  if (type === "email") return <EmailCard pv={pv} fields={fields} target={dest.target} inst={inst} route={route} />;
  if (type === "slack") return <SlackCard pv={pv} fields={fields} target={dest.target} inst={inst} />;
  return <WebhookCard pv={pv} target={dest.target} inst={inst} />;
}

export type { CardTemplate };
