import { describe, expect, it } from "vitest";
import { DenialSampler } from "../src/core/denial-sampler.js";
import { trustProxyFrom } from "../src/core/config.js";

describe("webhook denial sampling", () => {
  it("audits the first few per source each minute, counts the rest, and reports the count on the next row", () => {
    const s = new DenialSampler(2, 10, 60_000);
    const t0 = 1_000_000;
    expect(s.sample("github", "1.2.3.4", t0)).toEqual({ audit: true, suppressed: 0 });
    expect(s.sample("github", "1.2.3.4", t0 + 1)).toEqual({ audit: true, suppressed: 0 });
    for (let i = 0; i < 50; i++) expect(s.sample("github", "1.2.3.4", t0 + 2 + i).audit).toBe(false);
    // another source still gets its rows, and carries the count left out so far
    expect(s.sample("github", "5.6.7.8", t0 + 100)).toEqual({ audit: true, suppressed: 50 });
    // next minute: the noisy source is audited again, nothing lost
    expect(s.sample("github", "1.2.3.4", t0 + 60_001)).toEqual({ audit: true, suppressed: 0 });
  });

  it("caps each hook overall, so rotating addresses can't flood the ledger", () => {
    const s = new DenialSampler(5, 3, 60_000);
    const audited = Array.from({ length: 100 }, (_, i) => s.sample("trigger:x", `10.0.0.${i}`, 1).audit).filter(Boolean).length;
    expect(audited).toBe(3);
    // a different hook has its own cap
    expect(s.sample("github", "10.0.0.1", 1).audit).toBe(true);
  });
});

describe("trusted proxy", () => {
  it("defaults to private networks, honours a pinned list, and refuses trusting everyone", () => {
    expect(trustProxyFrom(undefined)).toBe("loopback, uniquelocal");
    expect(trustProxyFrom("false")).toBe(false);
    expect(trustProxyFrom("172.20.0.0/16")).toBe("172.20.0.0/16");
    expect(() => trustProxyFrom("true")).toThrow(/any client/);
  });
});
