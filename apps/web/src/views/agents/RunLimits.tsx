/**
 * The agent's "Run limits" panel: max turns, max time (minutes) and max cost per run (optional). A blank field is unset and the default applies, which the field
 * shows as its placeholder. Limits are a safety rail people set, versioned with the agent: Save writes them and cuts a new version, which goes live through the
 * normal promote and eval flow. The server checks the ranges and the agent-edit right; the lock here only says why a control is disabled.
 */
import { useState } from "react";
import { Btn, Field, Input, Panel } from "../../ui/primitives";
import { LIMIT_DEFAULTS, LIMIT_RANGE, inheritedText, limitsLine, parseLimits, textOf, type LimitText } from "../../lib/runLimits";
import type { TabProps } from "./Config";

export function RunLimitsPanel({ a, ro, perm, saveLimits }: Pick<TabProps, "a" | "ro" | "perm" | "saveLimits">) {
  const saved = textOf(a.limits);
  const [t, setT] = useState<LimitText>(saved);
  const [busy, setBusy] = useState(false);
  const { value, errors } = parseLimits(t);
  const bad = Object.keys(errors).length > 0;
  const dirty = JSON.stringify(t) !== JSON.stringify(saved);
  const ph = inheritedText({ budget: a.budget });
  const set = (k: keyof LimitText) => (e: React.ChangeEvent<HTMLInputElement>) => setT((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    if (bad || busy) return;
    setBusy(true);
    await saveLimits(value);
    setBusy(false);
  };
  return (
    <Panel title="Run limits">
      <div className="form-grid" id="ag-limits">
        <Field label="Max turns" htmlFor="ag-lim-turns" error={errors.turns} hint={`Default ${LIMIT_DEFAULTS.turns}. ${LIMIT_RANGE.turns[0]} to ${LIMIT_RANGE.turns[1]}.`}>
          <Input id="ag-lim-turns" type="number" inputMode="numeric" className="mono" min={LIMIT_RANGE.turns[0]} max={LIMIT_RANGE.turns[1]} placeholder={ph.turns} disabled={ro} value={t.turns} onChange={set("turns")} />
        </Field>
        <Field label="Max time (minutes)" htmlFor="ag-lim-min" error={errors.minutes} hint={`Default ${LIMIT_DEFAULTS.minutes}. ${LIMIT_RANGE.minutes[0]} to ${LIMIT_RANGE.minutes[1]}.`}>
          <Input id="ag-lim-min" type="number" inputMode="decimal" className="mono" min={LIMIT_RANGE.minutes[0]} max={LIMIT_RANGE.minutes[1]} placeholder={ph.minutes} disabled={ro} value={t.minutes} onChange={set("minutes")} />
        </Field>
        <Field label="Max cost per run (optional)" htmlFor="ag-lim-cost" error={errors.costUsd} hint={`Dollars. Unset: the agent's per-run budget ($${a.budget}) applies.`}>
          <Input id="ag-lim-cost" type="number" inputMode="decimal" className="mono" min={LIMIT_RANGE.costUsd[0]} step="0.01" placeholder={ph.costUsd} disabled={ro} value={t.costUsd} onChange={set("costUsd")} />
        </Field>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Btn label="Save as new version" kind="primary" id="ag-lim-save" guard={ro ? perm : null} disabled={!dirty || bad || busy} onClick={() => void save()} />
        <Btn label="Revert" id="ag-lim-revert" disabled={!dirty} onClick={() => setT(saved)} />
        <span className="small muted">{`On the floor now: ${limitsLine(a.liveLimits)}. A change ships as a new version and runs the eval suite before going live. A project can override these per station.`}</span>
      </div>
    </Panel>
  );
}
