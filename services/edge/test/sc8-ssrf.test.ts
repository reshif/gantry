import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { buildGateway, type Gateway } from "../src/gateway.js";
import { S3ObjectStore } from "../src/trace.js";
import { baseConfig, close, FakeApi, FakeS3, makeToken } from "./helpers.js";
describe("S-68: vendor endpoint SSRF", () => {
  const api = new FakeApi(); const s3 = new FakeS3(); let gw: Gateway; let base = ""; let hits: string[] = [];
  const internal = http.createServer((req, res) => { hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "-"} xkey=${req.headers["x-api-key"] ?? "-"}`); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "x", type: "message", role: "assistant", content: [{ type: "text", text: "INTERNAL-ONLY-DATA" }], usage: { input_tokens: 1, output_tokens: 1 } })); });
  beforeAll(async () => {
    await Promise.all([api.start(), s3.start()]); await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    api.route.baseUrl = `http://127.0.0.1:${(internal.address() as any).port}`; // what the API hands the edge once a vendor endpoint is set to a private address
    gw = buildGateway({ cfg: baseConfig({ apiUrl: api.url, blockPrivateAddresses: true }), store: new S3ObjectStore({ endpoint: s3.url, bucket: "gantry-test", accessKey: "k", secretKey: "s", region: "us-east-1" }), logger: false });
    await gw.app.listen({ host: "127.0.0.1", port: 0 }); base = `http://127.0.0.1:${(gw.app.server.address() as any).port}`;
  });
  afterAll(async () => { await gw.app.close(); await Promise.all([close(api.server), close(s3.server), close(internal)]); });
  it("a run's model call is refused when the vendor endpoint is loopback, link-local or private, and the vendor key is never sent there", async () => {
    const res = await fetch(`${base}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${makeToken("run-w3-1")}` }, body: JSON.stringify({ model: "claude-test-1", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(hits, "the internal service was never contacted").toEqual([]);
    expect(text, "a private upstream is refused by the edge").not.toContain("INTERNAL-ONLY-DATA");
  });
  it("a listed LAN range never opens loopback", async () => {
    (api.route as { lan?: string[] }).lan = ["192.168.0.0/16", "10.0.0.0/8"];
    hits = [];
    const res = await fetch(`${base}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${makeToken("run-w3-2")}` }, body: JSON.stringify({ model: "claude-test-1", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
    expect(await res.text()).not.toContain("INTERNAL-ONLY-DATA");
    expect(hits).toEqual([]);
  });
});
