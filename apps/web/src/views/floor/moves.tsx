/**
 * Moving work on the board (legacy performMove / moveMenu): every move is checked by the server first (POST .../move with
 * dry_run) so a refused move says why before anything changes, then performed through the same endpoint.
 */
import { useCallback, useRef } from "react";
import { bayDef, flowOf, route as routeOf } from "@gantry/domain";
import { api, get } from "../../api/client";
import { ops } from "../../api/ops";
import type { WorkOrder } from "../../api/types";
import { useUI, type MenuItem } from "../../ui/overlay-context";
import { useFloorCtx, bayName, stationId, type FWo } from "./kit";

export interface MoveCheckResult {
  allowed: boolean;
  reason: string;
  kind?: "approve" | "back" | "park" | "unpark";
}

const HINT: Record<string, string> = { approve: "approve gate", back: "send back", park: "park", unpark: "return" };

/** The dry run of a move. The result is not cached: the answer depends on what everyone else is doing right now. */
export async function checkMove(woId: string, target: string): Promise<MoveCheckResult> {
  const r = await ops.moveCheck(woId, target);
  const x = r as unknown as { allowed?: boolean; reason?: string; kind?: MoveCheckResult["kind"]; msg: string };
  if (!r.ok) return { allowed: false, reason: r.msg };
  return { allowed: x.allowed === true, reason: x.reason ?? x.msg, ...(x.kind ? { kind: x.kind } : {}) };
}

interface TravelerMoves {
  wo: WorkOrder;
  allowed: { moves: Record<string, MoveCheckResult> };
}

export function useMoves() {
  const ui = useUI();
  const ctx = useFloorCtx();
  const busy = useRef(false);
  const toast = useCallback((r: { ok: boolean; msg: string }) => {
    ui.toast(r.msg, r.ok ? "ok" : "error");
    return r.ok;
  }, [ui]);

  const perform = useCallback(
    async (woId: string, target: string, known?: MoveCheckResult) => {
      const w = ctx.wos.find((x) => x.id === woId);
      if (!w || busy.current) return;
      const c = known ?? (await checkMove(woId, target));
      if (!c.allowed) {
        ui.toast(`Cannot move ${w.id}: ${c.reason}`, "error");
        return;
      }
      const here = ctx.cat.stations[w.station]?.name ?? "its station";
      if (c.kind === "park") {
        const bay = bayDef(ctx.cat, target);
        const declined = target === "declined";
        ui.reasonDialog({
          title: declined ? `Decline ${w.id}` : `Move ${w.id} to ${bay?.name ?? target}`,
          kicker: "Board move",
          ok: declined ? "Decline" : `Move to ${bay?.name ?? target}`,
          kind: declined ? "danger" : "primary",
          min: declined ? 5 : 3,
          sub: `${bay?.desc ?? ""}. It returns to ${here} when someone releases it.`,
          placeholder: "Why?",
          onOk: async (v) => {
            const r = await ops.moveTo(w.id, target, v);
            if (r.ok) ui.toast(r.msg, "ok");
            return r;
          },
        });
        return;
      }
      if (c.kind === "back") {
        ui.reasonDialog({
          title: `Send ${w.id} back to ${ctx.cat.stations.find((s) => s.id === target)?.name ?? target}`,
          kicker: "Board move",
          ok: "Send back",
          min: 3,
          label: "Note for the agent",
          sub: "The station's agent picks it up again with your note. Gates after that station reset.",
          placeholder: "What needs to change?",
          onOk: async (v) => {
            const r = await ops.moveTo(w.id, target, v);
            if (r.ok) ui.toast(r.msg, "ok");
            return r;
          },
        });
        return;
      }
      busy.current = true;
      try {
        toast(await ops.moveTo(w.id, target));
      } finally {
        busy.current = false;
      }
    },
    [ctx.wos, ctx.cat, ui, toast],
  );

  /** The keyboard-friendly "Move to" menu: every station and bay of the project, with what the server says about each. */
  const menu = useCallback(
    async (anchor: HTMLElement, w: FWo) => {
      let moves: Record<string, MoveCheckResult> = {};
      try {
        moves = (await get<TravelerMoves>(api(`work-orders/${encodeURIComponent(w.id)}`))).allowed.moves;
      } catch {
        moves = {};
      }
      const fl = flowOf(ctx.cat, ctx.project);
      const onRoute = routeOf(ctx.cat, ctx.project, w.cls);
      const cur = w.bay ?? stationId(ctx.cat, w);
      const items: MenuItem[] = [];
      for (const s of fl.stations) {
        const m = moves[s.id];
        const allowed = !!m?.allowed && s.id !== cur;
        const reason = s.id === cur ? `${w.id} is already here.` : (m?.reason ?? (onRoute.includes(s.id) ? "Not available right now." : `${s.name} is not on the ${w.cls} route.`));
        items.push({ label: `${s.no} ${s.name}`, icon: "move", hint: allowed && m?.kind ? HINT[m.kind] : undefined, guard: allowed ? null : { allowed: false, reason, needs: "" }, onClick: () => void perform(w.id, s.id, m) });
      }
      fl.bays.forEach((b, i) => {
        if (i === 0) items.push({ sep: true });
        const m = moves[b.id];
        const allowed = !!m?.allowed && b.id !== cur;
        items.push({ label: bayName(ctx.cat, b.id), icon: "st-park", hint: allowed && m?.kind ? HINT[m.kind] : undefined, guard: allowed ? null : { allowed: false, reason: b.id === cur ? `${w.id} is already here.` : (m?.reason ?? "Not available right now."), needs: "" }, onClick: () => void perform(w.id, b.id, m) });
      });
      ui.menu(anchor, `Move ${w.id} to`, items);
    },
    [ctx.cat, ctx.project, perform, ui],
  );

  return { perform, menu };
}
