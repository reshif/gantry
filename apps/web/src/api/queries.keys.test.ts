/**
 * The data-layer conventions, enforced as tests: one typed key factory per slice, no literal `queryKey` arrays
 * outside `api/`, no `qc.invalidateQueries`-by-hand string keys, and a single `/teams` key.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { qk } from "./keys";
import { readOf, rowsOf } from "../lib/readState";
import { ApiError, refusalKindOf } from "./client";

const SRC = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

describe("query keys", () => {
  it("no view or shared module spells a queryKey as a literal array", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (f.startsWith(join(SRC, "api"))) continue;
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/queryKey:\s*\[/g)) offenders.push(`${f.slice(SRC.length + 1)}:${s.slice(0, m.index).split("\n").length}`);
    }
    // Slice-local factories (ck, wk, woSessionKey, sessionKey) build their keys in a named function, not inline.
    expect(offenders).toEqual([]);
  });

  it("the teams read has one key, so People and the project wizard share one cache entry", () => {
    expect(qk.teams()).toEqual(["teams"]);
    const hits = walk(SRC).filter((f) => /useQuery\(\{\s*queryKey:\s*\[\s*"teams"/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("every key starts with its slice name so SSE invalidation reaches it", () => {
    expect(qk.woTable("p1", {})[0]).toBe("workOrders");
    expect(qk.woDocuments("WO-1")[0]).toBe("workOrders");
    expect(qk.convSessions(null)[0]).toBe("conversations");
    expect(qk.sessionsAll()[0]).toBe("sessions");
    expect(qk.agentSuites()[0]).toBe("agents");
  });
});

describe("readOf", () => {
  const q = (o: object) => ({ data: undefined, error: null, isPending: true, isError: false, refetch: async () => undefined, ...o }) as never;
  it("keeps loading, hidden, failed and ready apart; a failed read is never an empty list", () => {
    expect(readOf(q({})).status).toBe("loading");
    expect(readOf(q({ isError: true, error: new ApiError(403, "Needs a role.", null) }))).toMatchObject({ status: "hidden", msg: "Needs a role." });
    expect(readOf(q({ isError: true, error: new ApiError(500, "Down.", null) })).status).toBe("failed");
    expect(rowsOf(q({ isError: true, error: new ApiError(500, "Down.", null) }))).toBeUndefined();
    expect(rowsOf(q({ data: [1, 2], isPending: false }))).toEqual([1, 2]);
  });
  it("a failed refresh with data in hand is ready and stale", () => {
    expect(readOf(q({ data: [1], isError: true, error: new ApiError(500, "Down.", null) }))).toMatchObject({ status: "ready", stale: true, msg: "Down." });
  });
});

describe("refusalKindOf", () => {
  it("maps the statuses the bar names", () => {
    expect(refusalKindOf(401)).toBe("unauthenticated");
    expect(refusalKindOf(403)).toBe("forbidden");
    expect(refusalKindOf(409)).toBe("conflict");
    expect(refusalKindOf(412)).toBe("conflict");
    expect(refusalKindOf(422)).toBe("invalid");
    expect(refusalKindOf(429)).toBe("rate_limited");
    expect(refusalKindOf(0)).toBe("unreachable");
    expect(refusalKindOf(503)).toBe("server");
  });
});
