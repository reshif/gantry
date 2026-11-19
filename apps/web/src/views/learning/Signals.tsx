/** Signals tab: the prototype's two charts side by side, signals by count and gate rejection reasons. The individual signal events are listed on each finding's evidence. */
import type { LearningFinding } from "@gantry/domain";
import { Empty, Panel } from "../../ui/primitives";
import { useEvalsFactory } from "../../api/queries";
import { BarChart } from "../evals/protoCharts";

export function SignalsTab({ findings }: { findings: LearningFinding[] }) {
  const by: Record<string, number> = {};
  findings.forEach((f) => { by[f.signal] = (by[f.signal] ?? 0) + f.count; });
  const gr = (useEvalsFactory().data?.gateRejections ?? []).map((r) => ({ l: r[0], v: r[1], tone: "warn" }));
  const bars = Object.entries(by).map(([l, v]) => ({ l, v }));
  return (
    <div className="stack">
      <div className="cols">
        <Panel title="Signals by count">{bars.length ? <BarChart items={bars} label="Signals by count" lw={90} /> : <Empty title="No signals yet" text="Signals appear as work orders are rejected, sent back or overridden." />}</Panel>
        <Panel title="Gate rejection reasons">{gr.length ? <BarChart items={gr} label="Gate rejection reasons" lw={170} /> : <Empty title="No rejections" text="Nothing was rejected at a gate in the last 30 days." />}</Panel>
      </div>
    </div>
  );
}
