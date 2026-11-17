/**
 * Known issues, the e2e side of the ratchet. e2e/known-issues.json lists the axe rules and overflows that exist today, per
 * route, persona, width and colour scheme. A test fails on anything NOT listed (a regression) and reports listed entries that
 * no longer occur (stale: delete them). The file is regenerated, never hand-grown: `npm run e2e:known -w @gantry/web`. Additions are reviewed through CODEOWNERS (apps/web/e2e/).
 */
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "known-issues.json");

export interface Known {
  a11y: Record<string, string[]>;
  overflow: string[];
}

export function loadKnown(): Known {
  try {
    const k = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Known>;
    return { a11y: k.a11y ?? {}, overflow: k.overflow ?? [] };
  } catch {
    return { a11y: {}, overflow: [] };
  }
}

export const updating = (): boolean => process.env.E2E_UPDATE_KNOWN === "1";

function save(k: Known): void {
  const sorted = { a11y: Object.fromEntries(Object.entries(k.a11y).sort(([a], [b]) => a.localeCompare(b))), overflow: [...k.overflow].sort() };
  writeFileSync(FILE, JSON.stringify(sorted, null, 2) + "\n");
}

/** Workers share the file in update mode: a directory is the lock (mkdir is atomic). */
function locked(fn: () => void): void {
  const lock = `${FILE}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (i > 5000) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    fn();
  } finally {
    rmdirSync(lock);
  }
}

/** Update mode only: set this key's axe rules, or drop the key when clean. */
export function recordA11y(key: string, rules: string[]): void {
  locked(() => {
    const k = loadKnown();
    if (rules.length) k.a11y[key] = [...new Set(rules)].sort();
    else delete k.a11y[key];
    save(k);
  });
}

export function recordOverflow(key: string, overflowing: boolean): void {
  locked(() => {
    const k = loadKnown();
    k.overflow = k.overflow.filter((x) => x !== key);
    if (overflowing) k.overflow.push(key);
    save(k);
  });
}

/** Rules in `found` that are not known for `key`, and known rules no longer found. */
export function diffRules(known: Known, key: string, found: string[]): { fresh: string[]; stale: string[] } {
  const was = known.a11y[key] ?? [];
  return { fresh: found.filter((r) => !was.includes(r)), stale: was.filter((r) => !found.includes(r)) };
}
