/**
 * The Matrix tab: "Who hears about what", event by channel switches (prototype). The real model is routes (event, destinations); a cell is on
 * when an enabled route for the event has a destination on that channel. A switch adds or removes that destination on the event's route,
 * or creates the route with the first open connection of that channel. In-app is not a routable channel in the backend: its switches stay on and say why when pressed.
 */
import { type Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Table, Toggle, type Decision } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { useUI } from "../../ui/overlay-context";
import { ALL_FIELDS, DEF_TPL, accepts, defaultTarget, type Route, type useNtData } from "./kit";

type Nt = ReturnType<typeof useNtData>;
export const MATRIX_CHANNELS = [{ id: "inapp", label: "In-app", type: "" }, { id: "slack", label: "Slack", type: "slack" }, { id: "email", label: "Email", type: "email" }, { id: "pager", label: "Pager", type: "paging" }] as const;
type Ch = (typeof MATRIX_CHANNELS)[number];
/** The prototype's nine events, each mapped to the backend event that carries it (`route`). "MCP definition changed" has no backend event yet: its switches are shown locked. */
export const MATRIX_EVENTS: ReadonlyArray<{ id: string; label: string; route: string }> = [
  { id: "submitted", label: "Work order submitted", route: "submitted" },
  { id: "question", label: "Question for a person", route: "question" },
  { id: "gate.waiting", label: "Gate waiting", route: "gate.waiting" },
  { id: "gate.decided", label: "Gate decided", route: "gate.decided" },
  { id: "stuck", label: "Work order stuck", route: "blocked" },
  { id: "done", label: "Work order released", route: "released" },
  { id: "kill", label: "Emergency stop", route: "kill" },
  { id: "trust", label: "Trust proposal", route: "trust.changed" },
  { id: "mcp", label: "MCP definition changed", route: "" },
];

export function MatrixTab({ p, nt, perm }: { p: Project; nt: Nt; perm: Decision }) {
  const ui = useUI();
  const routes = nt.routes as Route[];
  const typeOfDest = (d: Route["dest"][number]): string => nt.instOf(d)?.type ?? d.channel;
  const forEvent = (ev: string): Route[] => routes.filter((r) => r.event === ev);
  const isOn = (ev: string, ch: Ch): boolean => !!ch.type && forEvent(ev).some((r) => r.enabled && r.dest.some((d) => typeOfDest(d) === ch.type));

  const flip = async (ev: { id: string; name: string }, ch: Ch, on: boolean): Promise<void> => {
    const list = forEvent(ev.id);
    const ver = (r: Route) => (nt.versions.get(r.id) !== undefined ? { ifMatch: nt.versions.get(r.id)! } : undefined);
    let res: { ok: boolean; msg: string };
    if (on) {
      const inst = nt.destInsts.find((i) => i.type === ch.type && i.connected && accepts(nt.typeOf(i.type), ev.id));
      const have = list.find((r) => r.dest.some((d) => typeOfDest(d) === ch.type));
      if (have) res = await ops.saveRoute(p.id, have.id, { enabled: true }, ver(have));
      else if (!inst) { ui.toast(`No ${ch.label} connection that accepts this event is open to ${p.name}. Add one in Integrations.`, "error"); return; }
      else {
        const dest = { channel: inst.type, target: defaultTarget(inst.type, p, inst), integration: inst.id };
        const r0 = list[0];
        res = r0
          ? await ops.saveRoute(p.id, r0.id, { dest: [...r0.dest, dest], enabled: true }, ver(r0))
          : await ops.saveRoute(p.id, null, { event: ev.id, dest: [dest], template: DEF_TPL[ev.id] ?? "submitted", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: { ...ALL_FIELDS } });
      }
    } else {
      res = { ok: true, msg: "" };
      for (const r of list.filter((x) => x.dest.some((d) => typeOfDest(d) === ch.type))) {
        const rest = r.dest.filter((d) => typeOfDest(d) !== ch.type);
        // a route must keep a destination: removing the last one switches the route off instead
        res = await ops.saveRoute(p.id, r.id, rest.length ? { dest: rest } : { enabled: false }, ver(r));
        if (!res.ok) break;
      }
    }
    ui.toast(res.ok ? `${on ? "Enabled" : "Disabled"} ${ev.name} via ${ch.label}` : res.msg, res.ok ? "ok" : "error");
  };

  return (
    <Card title="Who hears about what" hint={`Applies to ${p.name}`} id="nt-matrix-card">
      <div className="matrix" id="nt-matrix">
        <Table bare>
          <thead><tr><th>Event</th>{MATRIX_CHANNELS.map((ch) => <th key={ch.id}>{ch.label}</th>)}</tr></thead>
          <tbody>
            {MATRIX_EVENTS.map((e) => (
              <tr key={e.id} id={`nt-mx-${e.id}`}>
                <td>{e.label}</td>
                {MATRIX_CHANNELS.map((ch) => {
                  const on = ch.id === "inapp" ? true : isOn(e.route, ch);
                  const mandatory = e.route === "kill" && on;
                  // In-app and the emergency stop cannot be changed, but they are not drawn dimmed: the switch answers with the reason
                  const d: Decision | null = !e.route && ch.id !== "inapp" ? { allowed: false, reason: "Gantry has no notification event for this yet." } : !perm.allowed ? perm : null;
                  const refuse = (v: boolean): void => {
                    if (ch.id === "inapp") ui.toast("In-app notifications are always on: the notification bell lists every event.", "info");
                    else if (mandatory && !v) ui.toast("Kill and restore notifications cannot be switched off.", "info");
                    else void flip({ id: e.route, name: e.label }, ch, v);
                  };
                  return <td key={ch.id}><span className="perm-cell"><Toggle id={`nt-mx-${e.id}-${ch.id}`} checked={(on && !!e.route) || ch.id === "inapp"} decision={d} label={`${e.label} via ${ch.label}`} onChange={refuse} /></span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <div className="swipe">Swipe sideways for more →</div>
    </Card>
  );
}
