#!/usr/bin/env node
// Per-view definition-of-done report (docs/ui/design-system.md section 6, AGENTS.md). For every view it counts the
// violations the bar can check mechanically and says which views pass. Exit 1 on a regression against the lint
// baseline (the same check as lint-ratchet.mjs); the pass/fail table itself is informational and shrinks to all-pass.
//   node scripts/frontend-dod.mjs [--json]
import { collectCounts, compare, readBaseline, viewsOnDisk } from "./lib/frontend-counts.mjs";

/** The bar items a script can verify, in the order of the production bar (2a). */
export const CHECKS = [
  { id: "raw-table", bar: "1" },
  { id: "raw-button", bar: "1" },
  { id: "raw-input", bar: "1" },
  { id: "view-import-react-query", bar: "2" },
  { id: "view-import-api-client", bar: "2" },
  { id: "view-import-ops", bar: "2" },
  { id: "literal-query-key", bar: "3" },
  { id: "data-nullish-empty", bar: "3" },
  { id: "role-literal", bar: "6" },
  { id: "polling-interval", bar: "live" },
  { id: "dangerous-html", bar: "security" },
  { id: "as-unknown-as", bar: "types" },
];

export function report(counts, views) {
  const a11y = (g) => Object.entries(counts).reduce((n, [r, byGroup]) => n + (r.startsWith("jsx-a11y/") ? (byGroup[g] ?? 0) : 0), 0);
  return views.map((view) => {
    const violations = {};
    for (const c of CHECKS) {
      const n = counts[c.id]?.[view] ?? 0;
      if (n) violations[c.id] = n;
    }
    const a = a11y(view);
    if (a) violations["jsx-a11y"] = a;
    return { view, pass: Object.keys(violations).length === 0, violations };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = collectCounts();
  const rows = report(counts, viewsOnDisk());
  const passing = rows.filter((r) => r.pass).length;
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ passing, total: rows.length, views: rows }, null, 2));
  } else {
    const w = Math.max(...rows.map((r) => r.view.length));
    for (const r of rows) {
      const why = Object.entries(r.violations).map(([k, n]) => `${k}:${n}`).join(" ");
      console.log(`${r.pass ? "PASS" : "todo"}  ${r.view.padEnd(w)}  ${why}`);
    }
    console.log(`\n${passing}/${rows.length} views pass the mechanical bar (static checks only; axe, overflow and screenshots run in Playwright).`);
  }
  const base = readBaseline();
  if (!base) {
    console.error("apps/web/lint-baseline.json is missing");
    process.exit(1);
  }
  const { grown } = compare(counts, base);
  if (grown.length) {
    console.error("Regression against the baseline:\n" + grown.map((d) => `  ${d.rule} in ${d.group}: ${d.was} -> ${d.now}`).join("\n"));
    process.exit(1);
  }
}
