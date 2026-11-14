/** Signals tab: every signal the loop reads, from the work order records and eval runs. */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Segmented } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { SortTable } from "../../ui/SortTable";
import { useCatalog } from "../projects/kit";
import type { LearningSignalRow } from "../../api/types";
import { SIGNALS, WoChip, useLn } from "./kit";

export function SignalsTab({ signals }: { signals: LearningSignalRow[] }) {
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
