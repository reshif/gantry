/** The Endpoints tab (legacy refTab): the public API with copyable curl requests and sample responses, and how to verify outbound webhook signatures. */
import { Panel } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { BASE, CodeBlock, type ApiData } from "./kit";

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
  if (e.body) s += ` \\\n  -d '${JSON.stringify(e.body, null, 2).replace(/\n/g, "\n  ")}'`;
  return s;
};

const SIG = `// Node.js: Gantry signs each outbound webhook delivery.
// X-Gantry-Signature: t=<unix seconds>,v1=<hex>, where v1 = HMAC-SHA256(secret, \`\${t}.\${rawBody}\`)
const [t, v1] = req.get("X-Gantry-Signature").split(",").map((p) => p.split("=")[1]);
const mac = crypto.createHmac("sha256", process.env.GANTRY_WEBHOOK_SECRET).update(\`\${t}.\${rawBody}\`).digest("hex");
const ok = mac.length === v1.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(v1)) && Math.abs(Date.now() / 1000 - Number(t)) < 300;`;

export function RefTab({ d }: { d: ApiData }) {
  const cfg = d.cfg;
  return (
    <div className="form-grid">
      <div className="callout">
        <Icon name="api" />
        <span>
          Base URL <span className="mono">{BASE}</span>. Bearer keys from the Keys tab. Rate limit <strong className="mono">{(cfg?.rateLimit ?? 60) + "/min"}</strong> per key with a burst of <span className="mono">{String(cfg?.burst ?? 20)}</span> (429 with Retry-After
          over it); idempotency keys are remembered for <span className="mono">{(cfg?.idempotencyHours ?? 24) + "h"}</span>. Every request is recorded on the Request log tab.
        </span>
      </div>
      {ENDPOINTS.map((e, i) => (
        <section key={e.p + e.m} className="panel api-ep" aria-label={`${e.m} ${e.p}`}>
          <div className="api-ep-head">
            <span className={`api-m api-m-${e.m.toLowerCase()}`}>{e.m}</span>
            <span className="mono api-path">{e.p}</span>
            <span className="tag">{e.scope}</span>
          </div>
          <p className="api-ep-d">{e.d}</p>
          <div className="api-ep-code">
            <CodeBlock id={`api-ref-copy-${i}`} text={curl(e)} label="Request" />
            <CodeBlock id={`api-ref-res-${i}`} text={JSON.stringify(e.res, null, 2)} label="Response (abridged)" />
          </div>
        </section>
      ))}
      <Panel title="Verifying webhook signatures"><CodeBlock id="api-ref-sig" text={SIG} label={`Signature check (${cfg?.webhookSigning ?? "HMAC-SHA256"})`} /></Panel>
    </div>
  );
}
