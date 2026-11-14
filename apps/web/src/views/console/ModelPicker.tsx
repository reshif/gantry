/** The console's model selector (spec 12.6): enabled models the gateway can call, grouped by vendor, defaulting to the routing default. The choice is the person's own and is saved on the server. */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useUI } from "../../ui/overlay-context";
import { ck, setConsoleModel } from "./api";
import type { ConsoleModel, ConsoleStatus } from "./types";

const price = (m: ConsoleModel): string => (m.inPrice || m.outPrice ? ` · USD ${m.inPrice}/${m.outPrice} per M tokens` : "");
export const modelLabel = (m: ConsoleModel, isDefault: boolean): string => `${m.name} · ${m.tier}${price(m)}${isDefault ? " · default" : ""}`;

export function ModelPicker({ st, busy }: { st: ConsoleStatus; busy?: boolean }) {
  const qc = useQueryClient();
  const ui = useUI();
  const [saving, setSaving] = useState(false);
  const byVendor = new Map<string, ConsoleModel[]>();
  for (const m of st.models ?? []) byVendor.set(m.vendorName, [...(byVendor.get(m.vendorName) ?? []), m]);
  const change = async (id: string): Promise<void> => {
    setSaving(true);
    const r = await setConsoleModel(id === st.defaultModel ? null : id);
    setSaving(false);
    if (!r.ok) ui.toast(r.msg ?? "The model could not be changed.", "error");
    await qc.invalidateQueries({ queryKey: ck.status() });
  };
  return (
    <label className="con-model" htmlFor="con-model">
      <span className="small muted">Model</span>
      <select id="con-model" className="input" value={st.effectiveModel ?? ""} disabled={saving || busy} aria-label="Model used to answer" onChange={(e) => void change(e.target.value)}>
        {[...byVendor].map(([vendor, ms]) => (
          <optgroup key={vendor} label={vendor}>
            {ms.map((m) => <option key={m.id} value={m.id}>{modelLabel(m, m.id === st.defaultModel)}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
