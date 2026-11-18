/**
 * Prompts tab of the work order: every recorded model call of the work order with what the model was given (the prompt manifest:
 * repository context, agent layers, skills, tools) and the stored trace (system prompt, answer). The list is GET prompt-calls?wo=, the
 * detail GET prompt-traces/{hash}; the server answers only what this person may read (a 403 or 404 shows as "Not visible to you").
 * The open call is URL state (`?call=`).
 */
import { fmt } from "@gantry/domain";
import { usePromptCalls, usePromptTrace } from "../../api/queries";
import type { PromptCall, PromptPart, PromptTrace } from "../../api/types";
import { useRouteState } from "../../lib/queryState";
import { Async } from "../../ui/async";
import { Card } from "../../ui/cr";
import { DataTable, type Col } from "../../ui/DataTable";
import { Btn } from "../../ui/primitives";
import { when } from "./kit";

const KIND: Record<string, string> = { repo_context: "Repository context (AGENTS.md)", layer: "Agent layer", skill: "Skill", system: "System prompt", tools: "Tools", station_tools: "Station tools", result_instruction: "Result instruction", result_schema: "Result shape" };
const dollars = (micros: number): string => `$${(micros / 1e6).toFixed(micros >= 1e5 ? 2 : 4)}`;
const short = (h: string | null): string => (h ? h.slice(0, 8) : "—");
const callKey = (c: PromptCall): string => c.trace ?? c.requestId ?? `${c.at}`;
const pretty = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? ""));
/** The system prompt as the edge stored it: a string, or a list of text blocks. */
const systemText = (req: unknown): string => {
  const s = (req as { system?: unknown } | null)?.system;
  return Array.isArray(s) ? s.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : pretty(b))).join("\n\n") : s === undefined ? "" : pretty(s);
};

const partCols: Col<PromptPart>[] = [
  { key: "kind", label: "Part", render: (p) => <span className="tag">{KIND[p.kind] ?? p.kind}</span> },
  { key: "name", label: "Name", render: (p) => <span>{p.name}</span> },
  { key: "source", label: "Source", hideSmall: true, render: (p) => <span className="dim ell mono">{p.source}</span> },
  { key: "version", label: "Version", render: (p) => <span className="mono">{p.version ?? "—"}</span> },
  { key: "bytes", label: "Size", align: "end", render: (p) => <span className="mono">{`${p.bytes} B`}</span> },
  { key: "sha", label: "Hash", hideSmall: true, render: (p) => <span className="mono dim">{short(p.sha256)}</span> },
];

/** The manifest's parts under the headings a person looks for: what the agent layer was, which repository context it read, which skills (and versions), which station tools. */
const GROUPS: Array<{ id: string; label: string; kinds: string[] }> = [
  { id: "layers", label: "Agent layers", kinds: ["layer"] },
  { id: "repo", label: "Repository context", kinds: ["repo_context"] },
  { id: "skills", label: "Skills", kinds: ["skill"] },
  { id: "tools", label: "Station tools", kinds: ["station_tools", "tools"] },
  { id: "other", label: "Instructions and result shape", kinds: ["system", "result_instruction", "result_schema"] },
];
const knownKinds = GROUPS.flatMap((g) => g.kinds);

function TraceDetail({ call }: { call: PromptCall }) {
  const q = usePromptTrace(call.trace);
  return (
    <Async<PromptTrace> query={q} what="this prompt record" id="dz-prompt-trace">
      {(t) => {
        const manifest = t.manifest?.parts?.length ? t.manifest : (t.runPrompt?.manifest ?? t.manifest);
        const parts = manifest?.parts ?? [];
        const groups = [...GROUPS, { id: "more", label: "Other parts", kinds: [] as string[] }]
          .map((g) => ({ ...g, rows: parts.filter((p) => (g.id === "more" ? !knownKinds.includes(p.kind) : g.kinds.includes(p.kind))) }))
          .filter((g) => g.rows.length);
        const system = systemText(t.request);
        return (
          <div className="stack" id="dz-prompt-detail" style={{ gap: 12 }}>
            <div className="label">Manifest</div>
            {groups.length ? groups.map((g) => (
              <section key={g.id} id={`dz-prompt-${g.id}`} aria-label={g.label} className="stack" style={{ gap: 4 }}>
                <div className="small strong">{`${g.label} (${g.rows.length})`}</div>
                <DataTable id={`dz-prompt-parts-${g.id}`} caption={`${g.label} this call was given`} columns={partCols} rows={g.rows} rowKey={(p) => `${p.kind}:${p.name}:${p.sha256}`} />
              </section>
            )) : <p className="muted small" id="dz-prompt-nomanifest">This call recorded no manifest.</p>}
            {manifest?.hash ? <p className="dim small">{`Instruction hash `}<span className="mono">{manifest.hash}</span>{manifest.compact ? " (some parts left out of the header; the hash covers them all)" : ""}</p> : null}
            {system ? <><div className="label">System prompt</div><pre className="code" id="dz-prompt-system" style={{ fontSize: 12, maxHeight: 320, overflow: "auto" }}>{system}</pre></> : null}
            {t.response !== undefined ? <><div className="label">Answer</div><pre className="code" id="dz-prompt-answer" style={{ fontSize: 12, maxHeight: 320, overflow: "auto" }}>{pretty(t.response)}</pre></> : null}
          </div>
        );
      }}
    </Async>
  );
}

export function PromptsTab({ wo }: { wo: string }) {
  const q = usePromptCalls(wo);
  const [open, setOpen] = useRouteState("call", "");
  const cols: Col<PromptCall>[] = [
    { key: "call", label: "Call", render: (c) => <span className="stack" style={{ gap: 0 }}><span>{c.station ?? c.surface ?? "call"}</span><span className="dim small mono">{c.run ?? c.turn ?? ""}</span></span> },
    { key: "model", label: "Model", render: (c) => <span className="mono">{c.model}</span> },
    { key: "tokens", label: "Tokens", align: "end", render: (c) => <span className="mono">{`${fmt.k(c.inputTokens)} in · ${fmt.k(c.outputTokens)} out`}</span> },
    { key: "cost", label: "Cost", align: "end", render: (c) => <span className="mono">{dollars(c.costMicros)}</span> },
    { key: "hash", label: "Manifest", hideSmall: true, render: (c) => <span className="mono dim">{short(c.promptHash)}</span> },
    { key: "at", label: "When", hideSmall: true, render: (c) => <span className="dim">{when(Date.parse(c.at))}</span> },
  ];
  return (
    <Card title="Prompts" hint="What each model call was given, and what it answered" id="dz-prompts">
      <Async<PromptCall[]> query={q} what="the prompt records" id="dz-prompts-read" empty={<p className="muted small" id="dz-prompts-empty">No model calls are recorded for this work order yet.</p>}>
        {(calls) => {
          const sel = calls.find((c) => callKey(c) === open) ?? null;
          return (
            <div className="stack" style={{ gap: 16 }}>
              <DataTable id="dz-prompts-table" caption={`Model calls of ${wo}`} columns={cols} rows={calls} rowKey={callKey} rowId={(c) => `dz-prompt-${callKey(c).slice(0, 12)}`}
                onRow={(c) => setOpen(callKey(c) === open ? "" : callKey(c))} rowLabel={(c) => `Show what ${c.station ?? c.surface ?? "this call"} was given`} />
              {sel ? (
                <section id="dz-prompt-open" aria-label="Prompt record">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <h3>{`${sel.station ?? sel.surface ?? "Call"} · ${sel.model}`}</h3>
                    <Btn small kind="ghost" label="Close" id="dz-prompt-close" onClick={() => setOpen("")} />
                  </div>
                  <TraceDetail call={sel} />
                </section>
              ) : <p className="dim small">Pick a call to see its manifest and trace.</p>}
            </div>
          );
        }}
      </Async>
    </Card>
  );
}
