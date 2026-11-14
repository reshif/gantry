// TEST/SANDBOX ONLY: fake Slack Web API and a fake MCP server (streamable HTTP, JSON-RPC over POST) for the compose end-to-end run.
// Never part of deploy/compose.yml. Listens on :80 (network aliases fake-slack and fake-mcp in test/e2e/compose.doubles.yml).
//   Slack:   POST /api/<method> (auth.test, chat.postMessage, chat.update, conversations.info ...) -> {ok:true,...}; every call is logged.
//   MCP:     POST /mcp  initialize | notifications/initialized | tools/list | tools/call
//   Control: GET /_fake/log, POST /_fake/tools {tools:[...]} replaces the advertised tool definitions, POST /_fake/reset
import { createServer } from "node:http";
const PORT = Number(process.env.PORT ?? 80);
const log = [];
let tools = [
  { name: "search_docs", description: "Search the documentation wiki.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, annotations: { readOnlyHint: true } },
  { name: "create_page", description: "Create a page in the wiki.", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, annotations: { readOnlyHint: false } },
];
let ts = 1700000000;
const body = async (req) => { const c = []; for await (const x of req) c.push(x); const s = Buffer.concat(c).toString("utf8"); try { return JSON.parse(s); } catch { return s; } };
const send = (res, code, obj, h = {}) => { res.statusCode = code; res.setHeader("content-type", "application/json"); for (const [k, v] of Object.entries(h)) res.setHeader(k, v); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") return void res.end("ok");
  if (url.pathname === "/_fake/log") return send(res, 200, log);
  if (url.pathname === "/_fake/reset") { log.length = 0; return send(res, 200, { ok: true }); }
  const b = await body(req);
  if (url.pathname === "/_fake/tools") { tools = b.tools; return send(res, 200, { ok: true, count: tools.length }); }
  if (url.pathname === "/v1/messages") { // fake Anthropic Messages API: the text "BIG" in the last user message reports a large output token count
    const last = JSON.stringify(b?.messages?.at(-1) ?? "");
    const out = last.includes("BIG") ? 400000 : 12, inp = 1000;
    log.push({ kind: "vendor", model: b?.model, key: String(req.headers["x-api-key"] ?? req.headers.authorization ?? "").slice(0, 6), stream: !!b?.stream, out });
    if (!b?.stream) return send(res, 200, { id: "msg_fake", type: "message", role: "assistant", model: b?.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify({ type: n, ...d })}\n\n`);
    ev("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: b?.model, content: [], usage: { input_tokens: inp, output_tokens: 1 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: out } });
    ev("message_stop", {});
    return void res.end();
  }
  if (url.pathname.startsWith("/api/")) { // Slack
    const method = url.pathname.slice(5);
    log.push({ kind: "slack", method, auth: String(req.headers.authorization ?? "").slice(0, 12), body: b });
    if (method === "auth.test") return send(res, 200, { ok: true, url: "https://fake.slack.com/", team: "Fake", user: "gantry", team_id: "T1", user_id: "U1", bot_id: "B1" });
    if (method === "chat.postMessage") return send(res, 200, { ok: true, channel: b.channel ?? "C1", ts: `${++ts}.000100`, message: { text: b.text } });
    if (method === "chat.update") return send(res, 200, { ok: true, channel: b.channel ?? "C1", ts: b.ts, text: b.text });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/mcp") {
    const m = b?.method; const id = b?.id;
    log.push({ kind: "mcp", method: m, params: b?.params });
    const ok = (result) => send(res, 200, { jsonrpc: "2.0", id, result }, { "mcp-session-id": "fake-session" });
    if (m === "initialize") return ok({ protocolVersion: b.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-docs", version: "1.0.0" } });
    if (m === "notifications/initialized") { res.statusCode = 202; return void res.end(); }
    if (m === "tools/list") return ok({ tools });
    if (m === "tools/call") return ok({ content: [{ type: "text", text: `ran ${b.params?.name}` }], isError: false });
    return send(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } });
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, "0.0.0.0", () => console.log(`fake slack + mcp on :${PORT}`));
