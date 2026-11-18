/**
 * Prompt records of a work order (Runs tab): every recorded model call with its model, tokens and cost, and for each the manifest of what the model
 * was given (repo context, agent layer, skills, tools) and its trace reference. Read from GET /prompt-calls and /prompt-traces/:ref; the server answers
 * 404 for a call the person may not read, so a refusal reads as "no record" and never as an empty list.
 */
import { fmt } from "@gantry/domain";
import { usePromptCalls, usePromptTrace, type PromptCall } from "../../api/queries";
import { Async } from "../../ui/async";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { Btn, Chip, Empty, Panel } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/SortTable";
import { fmtDate } from "./time";

const KIND: Record<string, string> = { repo_context: "Repo context", layer: "Agent layer", skill: "Skill", station_tools: "Station tools", result_instruction: "Result instruction", result_schema: "Result schema", system: "System", tools: "Tools" };

function TraceBody({ call }: { call: PromptCall }) {
  const q = usePromptTrace(call.trace);
  return (
    <Async query={q} what="the prompt record" id="pt-trace" rows={4}>
      {(t) => {
        const parts = t.manifest?.parts ?? [];
        return (
          <div className="stack" id="pt-manifest">
            <dl className="kv">
              <dt>Model</dt><dd className="mono">{t.model ?? call.model}</dd>
              <dt>Tokens</dt><dd>{`${fmt.k(call.inputTokens)} in · ${fmt.k(call.outputTokens)} out`}</dd>
              <dt>Cost</dt><dd>{fmt.money(call.costMicros / 1e6)}</dd>
              <dt>Manifest</dt><dd className="mono small">{t.manifest?.hash ?? call.promptHash ?? "none recorded"}</dd>
              <dt>Trace</dt><dd className="mono small">{call.trace}</dd>
            </dl>
            {parts.length ? (
              <ol className="list" id="pt-parts" aria-label="What the model was given">
                {parts.map((p, i) => (
                  <li key={i}>
                    <Chip text={KIND[p.kind] ?? p.kind} cls={p.kind === "repo_context" ? "info" : "plain"} />
                    <span className="grow">{p.name}<span className="small muted mono">{` ${p.source ?? ""}`}</span></span>
                    <span className="small muted">{`${p.version != null ? `v${p.version} · ` : ""}${fmt.k(p.bytes)} bytes`}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="small muted">This record holds no manifest parts.</p>}
          </div>
        );
      }}
    </Async>
  );
}

export function PromptsPanel({ woId }: { woId: string }) {
  const q = usePromptCalls(woId);
  const ui = useUI();
  const open = (c: PromptCall) => void ui.open((close) => <Dialog wide title="What the model was given" sub={`${c.station ?? c.surface ?? "call"} · ${fmtDate(Date.parse(c.at))}`} onClose={close} body={<TraceBody call={c} />} />);
  const cols: Col<PromptCall>[] = [
    { key: "at", label: "When", render: (c) => fmtDate(Date.parse(c.at)) },
    { key: "st", label: "Station", render: (c) => c.station ?? c.surface ?? "—" },
    { key: "m", label: "Model", render: (c) => <span className="mono small">{c.model}</span> },
    { key: "tok", label: "Tokens", align: "end", render: (c) => <span className="num">{fmt.k(c.inputTokens + c.outputTokens)}</span> },
    { key: "cost", label: "Cost", align: "end", render: (c) => <span className="num">{fmt.money(c.costMicros / 1e6)}</span> },
    { key: "o", label: "Outcome", render: (c) => <Chip text={c.outcome} cls={c.outcome === "ok" || c.outcome === "passed" ? "ok" : "plain"} /> },
    { key: "a", label: "", align: "end", render: (c) => (c.trace ? <Btn label="Manifest and trace" small id={`pt-open-${c.trace.slice(0, 8)}`} aria={`Manifest and trace of the call at ${fmtDate(Date.parse(c.at))}`} onClick={() => open(c)} /> : <span className="muted small">no trace</span>) },
  ];
  return (
    <Panel title="Prompts" id="dz-prompts" flush>
      <Async query={q} what="the prompt records" id="pt-list" rows={3} empty={<Empty title="No prompt records" text="Model calls appear here with what the model was given once an agent has run." />}>
        {(calls) => <DataTable id="dz-prompt-calls" caption="Model calls of this work order" columns={cols} rows={calls} rowKey={(c) => `${c.requestId ?? c.trace}-${c.at}`} pageSize={10} range />}
      </Async>
    </Panel>
  );
}
