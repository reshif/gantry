import { describe, expect, it } from "vitest";
import { isResearchHost } from "../src/core/research-host.js";
import { SIGNING_SECRET_MIN, builtinTypes, validateConfig } from "../src/areas/integrations/connectors.js";

describe("research hosts are DNS names, never IP addresses", () => {
  it("refuses IPv4 literals and numeric forms", () => {
    for (const h of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "*.10.0.0.5", "0x7f.0.0.1", "127.1", "1.2.3.4"]) expect(isResearchHost(h), h).toBe(false);
  });
  it("refuses brackets and bare names", () => {
    for (const h of ["[::1]", "::1", "localhost", "", "a b.com", "-a.com"]) expect(isResearchHost(h), h).toBe(false);
  });
  it("keeps real names and wildcards", () => {
    for (const h of ["docs.nautobot.com", "*.example.org", "a1.b2.co", "xn--bcher-kva.example"]) expect(isResearchHost(h), h).toBe(true);
  });
});

describe("signing secrets need real entropy", () => {
  const types = new Map(builtinTypes().map((t) => [t.id, t]));
  const github = types.get("github")!;
  const webhook = types.get("webhook")!;
  const slack = types.get("slack")!;
  const cfgGithub = { org: "acme" };
  it("refuses a short GitHub webhook secret and accepts a generated one", () => {
    expect(validateConfig(github, cfgGithub, { webhookSecret: "abcdef" }, { needSecret: true })).toMatch(/at least 32/);
    expect(validateConfig(github, cfgGithub, { webhookSecret: "a".repeat(SIGNING_SECRET_MIN - 1) }, { needSecret: true })).toMatch(/at least 32/);
    expect(validateConfig(github, cfgGithub, { webhookSecret: "a".repeat(SIGNING_SECRET_MIN) }, { needSecret: true })).toBeNull();
  });
  it("covers the outbound webhook secret and the Slack signing secret, but not third-party tokens", () => {
    expect(validateConfig(webhook, { url: "https://x.example.org/in", format: "json" }, { secret: "abcdef" }, { needSecret: true })).toMatch(/at least 32/);
    expect(validateConfig(slack, { workspace: "acme" }, { botToken: "xoxb-1", signingSecret: "s".repeat(10) }, { needSecret: true })).toMatch(/at least 32/);
    expect(validateConfig(slack, { workspace: "acme" }, { botToken: "xoxb-1", signingSecret: "s".repeat(32) }, { needSecret: true })).toBeNull();
    expect(validateConfig(slack, { workspace: "acme" }, { botToken: "abcdef", signingSecret: "s".repeat(32) }, { needSecret: true })).toBeNull();
  });
  it("a custom trigger-source type's secret is a signing secret too", () => {
    const custom = { source: true, fields: [{ key: "hookKey", label: "Hook key", type: "secret" as const, required: true }] };
    expect(validateConfig(custom, {}, { hookKey: "abcdef" }, { needSecret: true })).toMatch(/at least 32/);
  });
});
