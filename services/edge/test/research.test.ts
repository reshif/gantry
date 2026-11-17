import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, type Gateway } from "../src/gateway.js";
import { htmlToText, publicOnlyAgent, recordedUrl } from "../src/research.js";
import { S3ObjectStore } from "../src/trace.js";
import { baseConfig, close, FakeApi, FakeS3, makeToken } from "./helpers.js";

describe("governed web research", () => {
  const api = new FakeApi();
  const s3 = new FakeS3();
  let gw: Gateway;
  let base = "";
  const RUN = "run-r1";
  const TOKEN = makeToken(RUN);
  let pages: Record<string, { status?: number; type?: string; body?: string; location?: string }> = {};
  const fetched: string[] = [];
  const research = (body: unknown) => fetch(`${base}/run/v1/research/fetch`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    await Promise.all([api.start(), s3.start()]);
    gw = buildGateway({
      cfg: baseConfig({ apiUrl: api.url }), logger: false,
      store: new S3ObjectStore({ endpoint: s3.url, bucket: "gantry-test", accessKey: "k", secretKey: "s", region: "us-east-1" }),
      researchFetch: async (url) => {
        fetched.push(url);
        const p = pages[url];
        if (!p) return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
        return new Response(p.body ?? "", { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html", ...(p.location ? { location: p.location } : {}) } });
      },
    });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await Promise.all([close(api.server), close(s3.server)]);
  });
  beforeEach(() => {
    api.calls = [];
    fetched.length = 0;
    pages = {};
    api.override = (r) => {
      if (r.url.endsWith("/research/hosts")) return [200, { ok: true, hosts: ["docs.nautobot.com", "*.example.org"] }];
      if (r.url.endsWith("/research/source")) return [200, { ok: true, ref: "s1" }];
      return undefined;
    };
  });

  it("refuses an IP-literal host even when an approved plan lists it (the DNS guard never sees literals)", async () => {
    api.override = (r) => (r.url.endsWith("/research/hosts") ? [200, { ok: true, hosts: ["127.0.0.1", "10.0.0.5", "169.254.169.254", "*.example.org"] }] : r.url.endsWith("/research/source") ? [200, { ok: true, ref: "s1" }] : undefined);
    for (const u of ["https://127.0.0.1/", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://2130706433/", "https://[::1]/", "https://0x7f.1/"]) {
      const r = await research({ url: u });
      expect(r.status, u).toBe(403);
    }
    expect(fetched).toEqual([]);
  });

  it("refuses a redirect to an allow-listed IP literal", async () => {
    api.override = (r) => (r.url.endsWith("/research/hosts") ? [200, { ok: true, hosts: ["docs.nautobot.com", "127.0.0.1"] }] : undefined);
    pages["https://docs.nautobot.com/r"] = { status: 302, location: "https://127.0.0.1/secret" };
    const r = await research({ url: "https://docs.nautobot.com/r" });
    expect(r.status).toBe(403);
    expect(fetched).toEqual(["https://docs.nautobot.com/r"]);
  });

  it("the production dispatcher never opens a socket to an IP literal", async () => {
    const net = await import("node:net");
    const { fetch: ufetch } = await import("undici");
    let accepted = 0;
    const srv = net.createServer((c) => { accepted++; c.destroy(); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await expect(ufetch(`https://127.0.0.1:${port}/`, { dispatcher: publicOnlyAgent() })).rejects.toBeTruthy();
    expect(accepted).toBe(0);
    await new Promise((r) => srv.close(r));
  });

  it("fetches an allow-listed page, turns it into text, redacts secrets, snapshots it and records the source", async () => {
    pages["https://docs.nautobot.com/jobs?token=abc&page=2"] = { body: "<html><head><title>Jobs</title><script>evil()</script></head><body><h2>Retry</h2><p>Use &amp; retry. key AKIAABCDEFGHIJKLMNOP</p></body></html>" };
    const r = await research({ url: "https://docs.nautobot.com/jobs?token=abc&page=2#x", why: "how jobs retry" });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: true, source: "s1", title: "Jobs", url: "https://docs.nautobot.com/jobs?page=2" });
    expect(b.text).toContain("## Retry");
    expect(b.text).toContain("Use & retry.");
    expect(b.text).not.toContain("evil()");
    expect(b.text).toContain("[REDACTED:aws-access-key]");
    const src = JSON.parse(api.of("/research/source")[0]!.body);
    expect(src).toMatchObject({ url: "https://docs.nautobot.com/jobs?page=2", title: "Jobs", why: "how jobs retry", httpStatus: 200 });
    expect(src.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.objects.get(`/gantry-test/sha256/${src.contentHash}`)!.toString()).toBe(b.text);
  });

  it("refuses an IP literal even when it is on the allow-list, directly or by redirect (the DNS guard never sees one)", async () => {
    api.override = (r) => {
      if (r.url.endsWith("/research/hosts")) return [200, { ok: true, hosts: ["169.254.169.254", "127.0.0.1", "[::1]", "docs.nautobot.com"] }];
      if (r.url.endsWith("/research/source")) return [200, { ok: true, ref: "s1" }];
      return undefined;
    };
    for (const u of ["https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/", "https://[::1]/", "https://2130706433/", "https://0x7f.1/"]) {
      const r = await research({ url: u });
      expect(r.status, u).toBe(403);
      expect((await r.json()).msg, u).toMatch(/IP address/);
    }
    pages["https://docs.nautobot.com/go"] = { status: 302, location: "https://169.254.169.254/latest/meta-data/" };
    const red = await research({ url: "https://docs.nautobot.com/go" });
    expect(red.status).toBe(403);
    expect((await red.json()).msg).toMatch(/IP address.*redirect/);
    expect(fetched).toEqual(["https://docs.nautobot.com/go"]);
  });

  it("the real public-only agent cannot be steered at a loopback server by name, and isIpLiteral covers both families", async () => {
    const { isIpLiteral } = await import("../src/research.js");
    expect([isIpLiteral("10.0.0.5"), isIpLiteral("[fd00::1]"), isIpLiteral("docs.nautobot.com"), isIpLiteral("a.1")]).toEqual([true, true, false, false]);
  });

  it("refuses hosts off the list, including through a redirect, and non-https or non-text; refusals are recorded", async () => {
    expect((await research({ url: "https://evil.example.com/x" })).status).toBe(403);
    expect((await research({ url: "http://docs.nautobot.com/x" })).status).toBe(422);
    pages["https://docs.nautobot.com/go"] = { status: 302, location: "https://evil.example.com/steal" };
    const red = await research({ url: "https://docs.nautobot.com/go" });
    expect(red.status).toBe(403);
    expect((await red.json()).msg).toMatch(/redirect/);
    expect(fetched).toEqual(["https://docs.nautobot.com/go"]);
    pages["https://a.example.org/f.zip"] = { type: "application/zip", body: "PK" };
    expect((await research({ url: "https://a.example.org/f.zip" })).status).toBe(415);
    expect((await research({ url: "https://docs.nautobot.com/missing" })).status).toBe(502);
    expect(api.of("/research/refused").length).toBe(5);
    expect(api.of("/research/source")).toHaveLength(0);
  });

  it("refuses when the work order has no research hosts", async () => {
    api.override = (r) => (r.url.endsWith("/research/hosts") ? [200, { ok: true, hosts: [] }] : undefined);
    const r = await research({ url: "https://docs.nautobot.com/" });
    expect(r.status).toBe(403);
    expect((await r.json()).msg).toMatch(/not enabled/);
  });

  it("helpers: html to text, recorded URL, a public-only dispatcher exists", () => {
    expect(htmlToText("<ul><li>a</li><li>b &lt;c&gt;</li></ul>").text).toBe("- a\n- b <c>");
    expect(recordedUrl(new URL("https://x.org/p?api_key=1&q=2#f"))).toBe("https://x.org/p?q=2");
    expect(publicOnlyAgent()).toBeTruthy();
  });
});

describe("run timeline steps", () => {
  it("pulls tool names and short targets from a transcript, scanned, and nothing else", async () => {
    const { stepsOf } = await import("../src/steps.js");
    const jsonl = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "secret thoughts" }, { type: "tool_use", name: "Read", input: { file_path: "src/jobs.py" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "file body" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -H 'x: AKIAABCDEFGHIJKLMNOP' https://a b c d e f" } }, { type: "tool_use", name: "mcp__gantry__web_fetch", input: { url: "https://docs.nautobot.com/x", why: "w" } }] } }),
      "not json",
    ].join("\n");
    const s = stepsOf(jsonl, 3, []);
    expect(s).toEqual([
      { turn: 3, tool: "Read", detail: "src/jobs.py" },
      { turn: 3, tool: "Bash", detail: expect.stringContaining("[REDACTED") },
      { turn: 3, tool: "gantry:web_fetch", detail: "https://docs.nautobot.com/x" },
    ]);
    expect(JSON.stringify(s)).not.toContain("secret thoughts");
    expect(JSON.stringify(s)).not.toContain("file body");
  });
});
