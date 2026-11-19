/**
 * Operator recovery for a Factory Admin locked out by the IP allow-list. Runs on the server host only (never through the web or the API):
 *
 *   docker compose exec gantry-api node dist/cli/allowlist-recovery.js --person <id> --minutes 30
 *
 * It opens a one-time window (30 minutes by default, 60 at most) for that admin's next sign-in from any address. It does not change the
 * allow-list, and MFA and step-up still apply. Audited as an event with actor "operator".
 */
import { createPool, withTx } from "@gantry/db";
import { openRecoveryWindow, RECOVERY_DEFAULT_MIN, RECOVERY_MAX_MIN } from "../core/auth/ip-recovery-open.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const person = arg("person");
if (!person) {
  console.error(`Usage: node dist/cli/allowlist-recovery.js --person <person id> [--minutes ${RECOVERY_DEFAULT_MIN}]   (1 to ${RECOVERY_MAX_MIN} minutes)`);
  process.exit(2);
}
const minutes = arg("minutes") === undefined ? RECOVERY_DEFAULT_MIN : Number(arg("minutes"));
const pool = createPool("app", { applicationName: "gantry-allowlist-recovery", max: 2 });
try {
  const orgs = (await pool.query<{ id: string }>(`select id from orgs order by created_at limit 2`)).rows;
  if (orgs.length !== 1) throw new Error("Expected exactly one organisation.");
  const r = await withTx(pool, (tx) => openRecoveryWindow(tx, orgs[0]!.id, person, minutes));
  console.log(`Recovery window ${r.id} open for ${person} until ${r.expiresAt.toISOString()}. Their next sign-in from any address is let in once; MFA and step-up still apply.`);
} catch (e) {
  console.error(`Not opened: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
