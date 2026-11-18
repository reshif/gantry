/** The console's model selector (spec 12.6): enabled models the gateway can call, grouped by vendor, defaulting to the routing default. The choice is the person's own and is saved on the server. */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field, Select } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { ck, setConsoleModel } from "./api";
import type { ConsoleModel, ConsoleStatus } from "./types";

const price = (m: ConsoleModel): string => (m.inPrice || m.outPrice ? ` · USD ${m.inPrice}/${m.outPrice}` : "");
export const modelLabel = (m: ConsoleModel, isDefault: boolean): string => `${m.name} · ${m.tier}${price(m)}${isDefault ? " · default" : ""}`;

export function ModelPicker({ st, busy }: { st: ConsoleStatus; busy?: boolean }) {
  const qc = useQueryClient();
  const ui = useUI();
  const [saving, setSaving] = useState(false);
  const change = async (id: string): Promise<void> => {
    setSaving(true);
    const r = await setConsoleModel(id === st.defaultModel ? null : id);
    setSaving(false);
    if (!r.ok) ui.toast(r.msg ?? "The model could not be changed.", "error");
    await qc.invalidateQueries({ queryKey: ck.status() });
  };
  const options = (st.models ?? []).map((m) => ({ value: m.id, label: modelLabel(m, m.id === st.defaultModel) }));
  return (
    <div className="con-model">
      <Field label="Model" description="Price is USD per million tokens, input / output.">
        <Select id="con-model" aria-label="Model used to answer" value={st.effectiveModel ?? ""} options={options} disabled={saving || busy} onChange={(v) => void change(v)} />
      </Field>
    </div>
  );
}
