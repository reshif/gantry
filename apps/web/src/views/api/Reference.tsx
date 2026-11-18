/** The Endpoints tab (legacy refTab): the public API with copyable curl requests and sample responses, and how to verify outbound webhook signatures. */
import { Btn, Panel, useCopy } from "../../ui/primitives";
import { DataTable } from "../../ui/DataTable";
import { BASE, type ApiData } from "./kit";

interface Endpoint { m: string; p: string; d: string; scope: string; body?: unknown; res: unknown; idem?: boolean }

export const ENDPOINTS: Endpoint[] = [
  { m: "POST", p: "/api/v1/projects/{project}/work-orders", d: "Submit a work order. It goes through the same handler as the web form: Intake classifies it and opens the intake conversation. Needs an Idempotency-Key header, so a retry cannot create twice.", scope: "wo.submit",
    body: { repo: "payments-api", title: "Add idempotency keys to refund endpoint", description: "Keep behaviour backwards compatible.", class: "feature", priority: "P2" },
    res: { ok: true, msg: "WO-2431 submitted to Payments Platform as Feature.", id: "WO-2431", classification: { cls: "feature", confidence: 0.91 }, route: ["intake", "research", "spec"], gates: ["G0G1", "G2", "G5"], version: 1 }, idem: true },
  { m: "GET", p: "/api/v1/work-orders/{id}", d: "Read a work order: station, state, gates, brief and links.", scope: "wo.read", res: { id: "WO-2431", title: "Add idempotency keys to refund endpoint", position: "intake", state: "waiting", cls: "feature", priority: "P2" } },
  { m: "GET", p: "/api/v1/work-orders/{id}/record", d: "The full work order record: request, clarification, agreed brief, station by station, files changed and commits, verification per acceptance criterion, merge and release, approvals with the trust level in force, after-release outcomes and the timeline. The evidence record for a release; use /record.md for the same Markdown the record page copies.", scope: "wo.read",
    res: { id: "WO-2406", summary: "Bump Go toolchain to 1.25 ...", completeness: { done: 11, total: 11 }, request: { source: "slack", by: "p-tomas" }, criteria: [{ id: "AC-1", status: "met" }], pr: { number: 1836, state: "merged", tag: "v1.12.1" } } },
  { m: "POST", p: "/api/v1/work-orders/{id}/messages", d: "Answer the open intake question. The brief updates as answers arrive.", scope: "wo.answer", body: { text: "Only payments-api" }, res: { ok: true, msg: "Answer recorded.", version: 3, conv: { done: false, qi: 2 } } },
  { m: "POST", p: "/api/v1/triggers/{id}/fire", d: "Fire a trigger from your own system, with the same dedupe, limits and author rules. Needs an Idempotency-Key header: it is the event's identity.", scope: "triggers.run", body: { title: "Nightly dependency updates" }, res: { ok: true, outcome: "created", wo: "WO-2432" }, idem: true },
];

export const curl = (e: Endpoint): string => {
  const url = BASE + e.p.replace("{project}", "payments").replace("{id}", e.p.includes("triggers") ? "TR-3" : "WO-2431");
  let s = `curl -X ${e.m} ${url} \\\n  -H "Authorization: Bearer $GANTRY_KEY"`;
  if (e.body) s += ` \\\n  -H "Content-Type: application/json"`;
  if (e.idem) s += ` \\\n  -H "Idempotency-Key: 6f1c-refund-42"`;
  if (e.body) s += ` \\\n  -d '${JSON.stringify(e.body)}'`;
  return s;
};

const purpose = (e: Endpoint): string => e.d.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "").split(": ")[0]!.replace(/^The full work order record.*$/, "Read the full work order record");

export function RefTab({ d: _d }: { d: ApiData }) {
  const copy = useCopy();
  const example = curl(ENDPOINTS[0]!);
  return (
    <div className="stack">
      <Panel title="Endpoints" flush id="api-ref-endpoints">
        <DataTable id="api-ref-table" caption="Endpoints" rows={ENDPOINTS} rowKey={(e) => e.m + e.p} sortSelect={false} columns={[
          { key: "m", label: "Method", render: (e) => <span className="mono">{e.m}</span> },
          { key: "p", label: "Path", render: (e) => <span className="mono">{e.p}</span> },
          { key: "d", label: "Purpose", render: purpose },
        ]} />
      </Panel>
      <Panel title="Example" id="api-ref-example">
        <div className="stack">
          <pre className="pre" aria-label="Example request">{example}</pre>
          <Btn label="Copy" small id="api-ref-example-copy" onClick={() => copy(example)} />
        </div>
      </Panel>
    </div>
  );
}
