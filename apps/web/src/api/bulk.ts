/** Bulk writes on a selection of work orders (the Work orders list). One command per person action; each work order is its own server call. */
import { ops } from "./ops";
import { useCommand } from "../lib/useCommand";

/** Parks every given work order in a bay with one reason. Succeeds when at least one moved; the message says how many did not. */
export async function parkMany(ids: string[], bay: string, reason: string): Promise<{ ok: boolean; msg: string }> {
  const results = await Promise.all(ids.map((id) => ops.park(id, bay, reason)));
  const failed = results.filter((r) => !r.ok);
  const moved = results.length - failed.length;
  if (!moved) return { ok: false, msg: failed[0]?.msg || "None of the work orders could be parked." };
  return { ok: true, msg: failed.length ? `Parked ${moved}; ${failed.length} could not be parked: ${failed[0]?.msg ?? ""}` : `Parked ${moved}` };
}

export const useParkMany = () => useCommand(parkMany, { toastFail: false });
