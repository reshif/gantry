/**
 * The Matrix tab: "Who hears about what", event by channel switches (prototype). The real model is routes (event, destinations); a cell is on
 * when an enabled route for the event has a destination on that channel. A switch adds or removes that destination on the event's route,
 * or creates the route with the first open connection of that channel. In-app is not a routable channel in the backend, so its column is shown off and locked.
 */
import { NOTIFY_EVENTS, type Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { DataTable } from "../../ui/DataTable";
import { Toggle, type Decision } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { useUI } from "../../ui/overlay-context";
import { ALL_FIELDS, DEF_TPL, accepts, defaultTarget, type Route, type useNtData } from "./kit";

type Nt = ReturnType<typeof useNtData>;
export const MATRIX_CHANNELS = [{ id: "inapp", label: "In-app", type: "" }, { id: "slack", label: "Slack", type: "slack" }, { id: "email", label: "Email", type: "email" }, { id: "pager", label: "Pager", type: "paging" }] as const;
type Ch = (typeof MATRIX_CHANNELS)[number];

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
    <Card title="Who hears about what" hint={`Applies to ${p.name}`} flush id="nt-matrix-card">
      <div className="matrix" id="nt-matrix">
        <DataTable<(typeof NOTIFY_EVENTS)[number]>
          id="nt-matrix-table"
          caption="Who hears about what"
          rows={[...NOTIFY_EVENTS]}
          rowKey={(e) => e.id}
          rowId={(e) => `nt-mx-${e.id}`}
          columns={[
            { key: "event", label: "Event", render: (e) => e.name },
            ...MATRIX_CHANNELS.map((ch) => ({
              key: ch.id, label: ch.label, align: "center" as const,
              render: (e: (typeof NOTIFY_EVENTS)[number]) => {
                const on = isOn(e.id, ch);
                const mandatory = (e.id === "kill" || e.id === "restore") && on;
                const d: Decision | null = !ch.type ? { allowed: false, reason: "In-app delivery is not routable yet: the notification bell lists every event." } : !perm.allowed ? perm : mandatory ? { allowed: false, reason: "Kill and restore notifications cannot be switched off." } : null;
                return <span className="perm-cell"><Toggle id={`nt-mx-${e.id}-${ch.id}`} checked={on} decision={d} label={`${e.name} via ${ch.label}`} onChange={(v) => void flip(e, ch, v)} /></span>;
              },
            })),
          ]}
        />
      </div>
    </Card>
  );
}
