import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { setAppPassword } from "../src/migrate.js";
import { TEST_URL } from "./helpers.js";

// Roles are cluster-wide, so parallel test databases (and parallel migrate runs) set the same role's password at once.
// Postgres can refuse one of those with "tuple concurrently updated"; setAppPassword must ride that out.
describe.skipIf(!TEST_URL)("setAppPassword under concurrency", () => {
  it("many connections setting one role's password at the same moment all succeed", async () => {
    const role = `gantry_race_t_${randomBytes(4).toString("hex")}`;
    const root = new pg.Client({ connectionString: TEST_URL });
    await root.connect();
    await root.query(`create role ${role} nologin`);
    const clients = await Promise.all(
      Array.from({ length: 16 }, async () => {
        const c = new pg.Client({ connectionString: TEST_URL });
        await c.connect();
        return c;
      }),
    );
    try {
      for (let round = 0; round < 5; round++) {
        const results = await Promise.allSettled(clients.map((c) => setAppPassword(c, `pw-${round}`, role)));
        expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      }
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
      await root.query(`drop role if exists ${role}`);
      await root.end();
    }
  }, 60_000);
});
