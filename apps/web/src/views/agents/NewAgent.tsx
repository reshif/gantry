/**
 * New agent (prototype dialog): Name, Station, Model. The server creates it at the lowest autonomy with safe defaults (read-only tools, no skills,
 * 800-line diff cap, paused until a version passes its suite), so this dialog proposes nothing beyond the three choices a person makes.
 */
import { useState } from "react";
import { ops } from "../../api/ops";
import { Field, Select, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { useModels, useStations, type AgentRow } from "./kit";

export function NewAgentDialog({ perm, close }: { agents?: AgentRow[]; perm: Decision; close: () => void }) {
  const ui = useUI();
  const m = useModels();
  const st = useStations();
  const [name, setName] = useState("");
  const [station, setStation] = useState("");
  const [model, setModel] = useState("");
  const [err, setErr] = useState("");
  const stationId = station || st.all[0]?.id || "";
  const modelId = model || m.overrides[stationId] || m.defaultModel || m.list[0]?.id || "";
  const submit = (done: () => void): void => {
    const n = name.trim();
    if (!n) { setErr("Name is required."); document.getElementById("na-name")?.focus(); return; }
    if (n.length < 3) { setErr("Name needs at least 3 characters."); document.getElementById("na-name")?.focus(); return; }
    setErr("");
    void ops.createAgent({ name: n, station: stationId, model: modelId, fallbacks: [], autonomy: "suggest", tools: { readRepo: true }, stations: [stationId], projects: "all", budget: 5, guardrails: { paths: [], maxDiff: 800 }, instructions: "", skills: [] }).then((r) => {
      if (!r.ok) { setErr(r.msg); return; }
      ui.toast(`Created ${n}`, "ok");
      const created = (r as unknown as { agent?: AgentRow }).agent;
      done();
      if (created) navigate("agents", created.id);
    });
  };
  return (
    <Dialog title="New agent" sub="Agents start at autonomy L0: every output goes to a person." dirty={!!name.trim()} onClose={close}
      body={(
        <div className="form-grid">
          <Field label="Name (required)" htmlFor="na-name" error={err || undefined}>
            <input id="na-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={err ? true : undefined} />
          </Field>
          <Field label="Station" htmlFor="na-station">
            <Select id="na-station" value={stationId} options={st.all.map((s) => ({ value: s.id, label: s.name }))} onChange={setStation} />
          </Field>
          <Field label="Model" htmlFor="na-model">
            <Select id="na-model" value={modelId} options={m.list.map((x) => ({ value: x.id, label: x.id }))} onChange={setModel} />
          </Field>
        </div>
      )}
      actions={[{ label: "Cancel", id: "na-cancel" }, { label: "Create agent", kind: "primary", submit: true, id: "na-ok", guard: perm, onClick: submit }]} />
  );
}
