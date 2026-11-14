import { describe, expect, it } from "vitest";
import { VendorLimiter } from "../src/limiter.js";
import { scanJson, scanText } from "../src/secrets-scan.js";
import { SseUsage, usageFromJson } from "../src/usage.js";
import { TraceIncrements } from "../src/trace.js";
import { parseVendorKeys } from "../src/config.js";

describe("secret scanning", () => {
  const samples: Array<[string, string]> = [
    ["anthropic-key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
    ["openai-key", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github-token", "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github-token", "github" + "_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop"],
    ["aws-access-key", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["slack-token", ["xoxb", "1234567890", "abcdefghij"].join("-")],
    ["slack-webhook", ["https://hooks.slack.com/services", "T00000000", "B00000000", "X".repeat(24)].join("/")],
    ["google-api-key", "AIza" + "SyA1234567890abcdefghijklmnopqrstuv"],
    ["stripe-key", ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_")],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"],
    ["credential-url", "postgres://admin:hunter2pass@db.internal:5432/app"],
    ["bearer-token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["gantry-run-token", `grt.${Buffer.from("run-1").toString("base64url")}.${"a".repeat(43)}`],
  ];
  for (const [kind, s] of samples) {
    it(`redacts ${kind}`, () => {
      const r = scanText(`before ${s} after`);
      expect(r.text).not.toContain(s.slice(4));
      expect(r.text).toContain(`[REDACTED:`);
      expect(r.findings.map((f) => f.kind)).toContain(kind);
    });
  }
  it("redacts a private key block", () => {
    const r = scanText("x\n-----BEGIN RSA " + "PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA " + "PRIVATE KEY-----\ny");
    expect(r.text).toBe("x\n[REDACTED:private-key]\ny");
  });
  it("matches known vendor keys exactly, ignoring very short values", () => {
    const r = scanText("key=vendor-secret-value-1 and word", ["vendor-secret-value-1", "and"]);
    expect(r.text).toBe("key=[REDACTED:known-key] and word");
  });
  it("leaves ordinary text alone", () => {
    const t = "The quick brown fox, sk-learn is a library, ghp is short, AKIA too.";
    expect(scanText(t)).toEqual({ text: t, findings: [] });
  });
  it("walks JSON values and counts findings", () => {
    const r = scanJson({ a: ["ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789", 3], b: { c: "ok" } });
    expect(r.value).toEqual({ a: ["[REDACTED:github-token]", 3], b: { c: "ok" } });
    expect(r.findings).toEqual([{ kind: "github-token", count: 1 }]);
  });
});

describe("usage extraction", () => {
  it("reads stream usage across arbitrary chunk boundaries, last output count wins", () => {
    const s = new SseUsage();
    const full =
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 9, cache_creation_input_tokens: 2 } } })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "x", input: {} } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 77 } })}\n\n`;
    for (let i = 0; i < full.length; i += 7) s.push(full.slice(i, i + 7));
    s.end();
    expect(s.usage).toEqual({ inputTokens: 5, outputTokens: 77, cacheReadTokens: 9, cacheWriteTokens: 2, seen: true });
    expect(s.message.content[0]).toMatchObject({ type: "tool_use", input: { a: 1 } });
    expect(s.message.stop_reason).toBe("tool_use");
  });
  it("reads JSON usage and tolerates junk", () => {
    expect(usageFromJson({ usage: { input_tokens: 3, output_tokens: 4 } })).toMatchObject({ inputTokens: 3, outputTokens: 4, seen: true });
    expect(usageFromJson("x").seen).toBe(false);
    const s = new SseUsage();
    s.push("data: not json\n\ndata: [DONE]\n\n");
    expect(s.usage.seen).toBe(false);
  });
});

describe("vendor limiter", () => {
  it("queues beyond the cap and releases in order", async () => {
    const l = new VendorLimiter(1, 1000);
    const a = await l.acquire("v");
    expect(a.ok).toBe(true);
    let got = false;
    const bP = l.acquire("v").then((b) => { got = true; return b; });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toBe(false);
    if (a.ok) a.release();
    const b = await bP;
    expect(b.ok).toBe(true);
    expect(l.inflight("v")).toBe(1);
  });
  it("gives up with busy after the wait budget", async () => {
    const l = new VendorLimiter(1, 40);
    await l.acquire("v");
    expect(await l.acquire("v")).toMatchObject({ ok: false, reason: "busy" });
  });
  it("waits out a short cooldown and refuses a long one with the remaining time", async () => {
    const l = new VendorLimiter(2, 300);
    l.pause("v", 0.05);
    const t = Date.now();
    expect((await l.acquire("v")).ok).toBe(true);
    expect(Date.now() - t).toBeGreaterThanOrEqual(40);
    l.pause("w", 10);
    expect(await l.acquire("w")).toMatchObject({ ok: false, reason: "cooldown", retryAfterSeconds: 10 });
  });
  it("release is idempotent", async () => {
    const l = new VendorLimiter(1, 100);
    const a = await l.acquire("v");
    if (a.ok) { a.release(); a.release(); }
    expect(l.inflight("v")).toBe(0);
  });
});

describe("trace increments and config", () => {
  it("resets when a conversation restarts", () => {
    const t = new TraceIncrements();
    t.build("r", { messages: [1, 2, 3] });
    expect(t.build("r", { messages: [1] }).delta.messagesFrom).toBe(0);
  });
  it("parses vendor_keys.json in both shapes and drops empty entries", () => {
    expect(parseVendorKeys('{"a":"k1","b":{"apiKey":"k2"},"c":""}')).toEqual({ a: "k1", b: "k2" });
    expect(() => parseVendorKeys("[1]")).toThrow();
  });
});
