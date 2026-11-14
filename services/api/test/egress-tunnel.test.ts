import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxiedHttp } from "../src/areas/notifications/http.js";

// Regression: with a proxy, an https request must be carried by the CONNECT tunnel. A host name that does not resolve proves the client never dials it itself.
const HOST = "vendor.invalid";
describe("proxiedHttp through a CONNECT proxy", () => {
  let tls: https.Server;
  let proxy: http.Server;
  const connects: string[] = [];
  let cert = "";
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "ignore" });
    cert = readFileSync(join(dir, "c.pem"), "utf8");
    tls = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert }, (req, res) => res.end(JSON.stringify({ path: req.url, host: req.headers.host })));
    await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
    proxy = http.createServer();
    proxy.on("connect", (req, client) => {
      connects.push(req.url ?? "");
      const up = net.connect((tls.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        up.pipe(client);
        client.pipe(up);
      });
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    tls.close();
    proxy.close();
  });

  it("reaches an https host that only the proxy can resolve", async () => {
    const c = proxiedHttp({ proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, ca: cert });
    const r = await c.request({ method: "GET", url: `https://${HOST}/v1/models?limit=5`, headers: {} });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ path: "/v1/models?limit=5", host: HOST });
    expect(connects).toEqual([`${HOST}:443`]);
  });

  it("without a proxy the unresolvable host is a clean NetworkError", async () => {
    await expect(proxiedHttp({ proxy: null, ca: cert }).request({ method: "GET", url: `https://${HOST}/`, headers: {}, timeoutMs: 3000 })).rejects.toMatchObject({ code: "unreachable" });
  });
});
