/** Signals tab: every signal the loop reads, from the work order records and eval runs. */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Empty, Panel, Segmented } from "../../ui/primitives";
import { BarList } from "../../ui/charts";
import { useEvalsFactory } from "../../api/queries";
import { Icon } from "../../ui/Icon";
import { SortTable } from "../../ui/SortTable";
import { useCatalog } from "../projects/kit";
import type { LearningSignalRow } from "../../api/types";
import type { LearningFinding } from "@gantry/domain";
import { SIGNALS, WoChip, useLn } from "./kit";

/** The prototype's Signals: two charts side by side (signals by count, gate rejection reasons); the individual signal events are the real feed underneath. */
export function SignalsTab({ signals, findings }: { signals: LearningSignalRow[]; findings: LearningFinding[] }) {
  const by: Record<string, number> = {};
  findings.forEach((f) => { by[f.signal] = (by[f.signal] ?? 0) + f.count; });
  const gr = (useEvalsFactory().data?.gateRejections ?? []).map((r) => ({ label: r[0], value: r[1], tone: "warn" as const }));
  const bars = Object.entries(by).map(([k, v]) => ({ label: SIGNALS[k]?.[0] ?? k, value: v }));
  return (
    <div className="stack">
      <div className="cols">
        <Panel title="Signals by count">{bars.length ? <BarList items={bars} label="Signals by count" labelWidth={110} /> : <Empty title="No signals yet" text="Signals appear as work orders are rejected, sent back or overridden." />}</Panel>
        <Panel title="Gate rejection reasons">{gr.length ? <BarList items={gr} label="Gate rejection reasons" labelWidth={170} /> : <Empty title="No rejections" text="Nothing was rejected at a gate in the last 30 days." />}</Panel>
      </div>
      <Panel title="Signal events"><EventTable signals={signals} /></Panel>
    </div>
  );
}

function EventTable({ signals }: { signals: LearningSignalRow[] }) {
  const { projName, agName } = useLn();
  const cat = useCatalog();
  const [type, setType] = useState("all");
  const counts: Record<string, number> = {};
  for (const x of signals) counts[x.signal] = (counts[x.signal] ?? 0) + 1;
  const rows = signals.filter((x) => type === "all" || x.signal === type);
  const since = Date.now() - 7 * 86_400_000;
  const week = signals.filter((x) => x.at >= since).length;
  const gateLabel = (id: string): string => cat?.gates.find((g) => g.id === id)?.label ?? id;
  return (
    <div className="ln-signals">
      <div className="toolbar">
        <Segmented name="ln-sig" label="Signal type" value={type} onChange={setType} items={[{ id: "all", label: `All ${signals.length}` }, ...Object.keys(SIGNALS).map((k) => ({ id: k, label: `${SIGNALS[k]![0]} ${counts[k] ?? 0}` }))]} />
        <span className="small muted">{`${week} in the last 7 days. Signals come from the work order records and eval runs.`}</span>
      </div>
      <SortTable<LearningSignalRow> id="ln-sig-table" caption="Learning signals" rows={rows} pageSize={25} sort={{ key: "at", dir: -1 }} rowKey={(x) => `${x.wo || x.ref}${x.signal}${x.at}${x.text}`}
        empty={{ title: "No signals", text: "Nothing of this type has been recorded." }}
        columns={[
          { key: "at", label: "When", sort: true, render: (x) => <span className="mono small">{fmt.istDate(x.at)}</span> },
          { key: "signal", label: "Signal", sort: true, render: (x) => { const sg = SIGNALS[x.signal] ?? [x.signal, "alert"]; return <span className={`chip ln-sig ln-sig-${x.signal}`}><Icon name={sg[1]} />{sg[0]}</span>; } },
          { key: "wo", label: "Record", sort: (x) => x.wo || x.ref || "", render: (x) => <WoChip id={x.wo || x.ref || ""} project={x.project} /> },
          { key: "project", label: "Project", sort: (x) => projName(x.project), hideSmall: true, render: (x) => projName(x.project) },
          { key: "agent", label: "Agent", sort: (x) => x.agent ?? "", render: (x) => (x.agent ? agName(x.agent) : "–") },
          { key: "text", label: "What happened", render: (x) => <span className="small">{x.text + (x.gate ? ` (${gateLabel(x.gate)})` : "")}</span> },
        ]} />
    </div>
  );
}
