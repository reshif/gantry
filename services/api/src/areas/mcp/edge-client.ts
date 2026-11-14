/**
 * The API's one call to the edge's MCP admin endpoint (spec 12.4): the edge connects to the server from the egress network and lists its tools.
 * The edge token authenticates the call. Tests replace the transport with `configureMcpEdge`.
 */
import { z } from "zod";

export interface EdgeTarget {
  url: string;
  transport: "http" | "sse";
  auth: { mode: "none" | "bearer" | "header"; header?: string | null; secret?: string | null };
}

export interface DiscoveredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
  /** sha256 of the canonical definition, computed by the edge. */
  hash: string;
  /** The server's own suggestion of read or write. The admin sets the real class. */
  hint: "read" | "write";
}

export type Discovery =
  | { ok: true; protocolRevision: string; serverName: string; tools: DiscoveredTool[]; ms: number }
  | { ok: false; msg: string };

const Answer = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    protocolRevision: z.string().max(40).default(""),
    serverName: z.string().max(200).default(""),
    ms: z.number().default(0),
    tools: z.array(z.object({ name: z.string().min(1).max(300), title: z.string().max(300).optional(), description: z.string().max(20000).default(""), inputSchema: z.unknown(), annotations: z.unknown(), hash: z.string().regex(/^[0-9a-f]{64}$/), hint: z.enum(["read", "write"]) })).max(1000),
  }),
  z.object({ ok: z.literal(false), msg: z.string().max(1000) }),
]);

export interface EdgeTransport {
  baseUrl: string;
  fetch: typeof fetch;
}

let override: Partial<EdgeTransport> | null = null;
export const configureMcpEdge = (o: Partial<EdgeTransport>): void => void (override = o);
export const resetMcpEdge = (): void => void (override = null);

export async function discoverTools(edgeToken: string, t: EdgeTarget): Promise<Discovery> {
  const base = (override?.baseUrl ?? process.env.EDGE_URL ?? "http://gantry-edge:8443").replace(/\/+$/, "");
  const f = override?.fetch ?? fetch;
  try {
    const res = await f(`${base}/mcp-admin/v1/discover`, {
      method: "POST",
      headers: { authorization: `Bearer ${edgeToken}`, "content-type": "application/json" },
      body: JSON.stringify(t),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) return { ok: false, msg: "The edge refused the discovery request." };
    const p = Answer.safeParse(JSON.parse(text));
    if (!p.success) return { ok: false, msg: `The edge answered with something unexpected (${res.status}).` };
    return p.data;
  } catch (e) {
    return { ok: false, msg: `The edge could not be reached to discover tools: ${e instanceof Error ? e.message : String(e)}` };
  }
}
