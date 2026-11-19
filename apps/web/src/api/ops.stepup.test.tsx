import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrfToken, setStepUpHandler } from "./client";
import { ops } from "./ops";
import { OverlayProvider } from "../ui/Overlay";
import { STEP_UP_MESSAGE, useInstallStepUp } from "../ui/stepup";

// S-66: vendor, integration, MCP and API-config changes now ask for a fresh sign-in. The dialogs call these ops; the central step-up prompt
// must send the same request again (same body, same Idempotency-Key) after the popup signs in, so the dialog just completes.
const refusal = { status: 403, body: { ok: false, msg: "Sign in again to confirm this change.", needs: "step_up", rule: { kind: "step-up", id: "STEP-UP", windowSec: 900, signedInSecAgo: 36000 } } };
const okBody = { status: 200, body: { ok: true, msg: "Saved." } };

function Host() {
  useInstallStepUp();
  return null;
}

interface Req { url: string; method: string; headers: Record<string, string>; body: unknown }
let reqs: Req[];
let answers: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  reqs = [];
  answers = [];
  setCsrfToken("c");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      reqs.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = answers.shift() ?? okBody;
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
  vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
  render(
    <OverlayProvider>
      <Host />
    </OverlayProvider>,
  );
});
afterEach(() => {
  cleanup();
  setStepUpHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const signInAgain = async () => {
  await screen.findByText(/recent sign-in/);
  fireEvent.click(document.getElementById("stepup-go-popup")!);
  await act(async () => void window.dispatchEvent(new MessageEvent("message", { data: { type: STEP_UP_MESSAGE, ok: true }, origin: window.location.origin })));
};

describe("a change that redirects data or credentials retries after the step-up sign-in", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean }>, string, string, boolean]> = [
    ["add a vendor", () => ops.addVendor({ name: "Evil", endpoint: "https://llm.example.com/v1", key: "sk-abcdefgh" }), "POST", "/api/v1/vendors", true],
    ["edit a vendor", () => ops.setVendor("local", { endpoint: "http://192.168.1.5:11434" }, "vendor.update"), "PATCH", "/api/v1/vendors/local", false],
    ["add a vendor from a template", () => ops.addVendorFromTemplate({ template: "openai-compatible", fields: { endpoint: "https://x.example.com/v1" } }), "POST", "/api/v1/vendors/from-template", true],
    ["add an integration", () => ops.addIntegration({ type: "webhook", name: "Lake", config: { url: "https://hook.example.com/in" }, secrets: {}, projects: "all", enable: false, targetId: "lake" }), "POST", "/api/v1/integrations", true],
    ["edit an integration", () => ops.updateIntegration("int-1", { config: { url: "https://hook2.example.com/in" } }), "PATCH", "/api/v1/integrations/int-1", false],
    ["add an MCP server", () => ops.addMCP({ name: "Docs", transport: "http", url: "https://mcp.example.com/mcp" }), "POST", "/api/v1/mcp/servers", true],
    ["edit an MCP server", () => ops.updateMCP("m-1", { url: "https://mcp2.example.com/mcp" }), "PATCH", "/api/v1/mcp/servers/m-1", false],
    ["change the API limits", () => ops.setApiConfig({ rateLimit: 5000 }), "PATCH", "/api/v1/api-config", false],
  ];
  for (const [name, call, method, path, creates] of cases) {
    it(`${name}: one prompt, then the same request again`, async () => {
      answers = [refusal, okBody];
      const p = call();
      await signInAgain();
      expect((await p).ok).toBe(true);
      expect(reqs).toHaveLength(2);
      expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([`${method} ${path}`, `${method} ${path}`]);
      expect(reqs[1]!.body).toEqual(reqs[0]!.body);
      if (creates) expect(reqs[1]!.headers["Idempotency-Key"]).toBe(reqs[0]!.headers["Idempotency-Key"]);
    });
  }
});
