import { describe, expect, it } from "vitest";
import { healthWord, instLabel } from "./onboarding/kit";
import { splitAskedOf } from "./home/data";
import { mcpState } from "./mcp/kit";

describe("server states with a UI word", () => {
  it("integration health unknown reads Not tested yet in pickers, never (unknown)", () => {
    expect(healthWord("unknown")).toBe("not tested yet");
    expect(healthWord("failing")).toBe("failing");
    expect(instLabel({ name: "Slack", status: "unknown" } as never)).toBe("Slack (not tested yet)");
    expect(instLabel({ name: "Slack", status: "healthy" } as never)).toBe("Slack");
  });
  it("a question asked of a deactivated person splits into the Asked-of label and the question", () => {
    expect(splitAskedOf("Asked of Sam Lee (deactivated): Which currency?")).toEqual({ askedOf: "Asked of Sam Lee (deactivated)", text: "Which currency?" });
    expect(splitAskedOf("Which currency?")).toEqual({ askedOf: null, text: "Which currency?" });
    expect(splitAskedOf(null)).toEqual({ askedOf: null, text: "" });
  });
  it("a server that needs re-approval is named so before disabled or its health", () => {
    expect(mcpState({ enabled: false, needsReapproval: true, health: "healthy" })).toBe("needs re-approval");
    expect(mcpState({ enabled: false, health: "healthy" })).toBe("disabled");
    expect(mcpState({ enabled: true, health: "degraded" })).toBe("degraded");
  });
});
