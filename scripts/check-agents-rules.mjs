#!/usr/bin/env node
// Fails when a rule in AGENTS.md has no enforcement. Every rule line is `- **ID** text. Enforced by: `check`, `check`.`
// and every check id must exist in scripts/enforcement.json and still be real (its lint tag, script, file or PR template item).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

export function parseRules(text) {
  const rules = [];
  // A rule starts at "- **X-NN**" and runs to the next rule or a blank line.
  const re = /^- \*\*([A-Z]-\d+)\*\*([\s\S]*?)(?=^- \*\*[A-Z]-\d+\*\*|^\s*$|^#)/gm;
  for (const m of text.matchAll(re)) {
    const body = m[2].replace(/\s+/g, " ").trim();
    const by = /Enforced by:\s*(.+?)\.?$/.exec(body);
    const checks = by ? [...by[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : [];
    rules.push({ id: m[1], checks });
  }
  return rules;
}

/** Why a registry entry is not real, or null when it is. `ctx` reads the repository (injectable for tests). */
export function verifyCheck(id, entry, ctx) {
  switch (entry.kind) {
    case "lint-tags": {
      const src = ctx.read("eslint.config.web.js");
      const missing = entry.tags.filter((t) => !src.includes(`"${t}"`) && !src.includes(`[${t}]`));
      return missing.length ? `lint tag(s) ${missing.join(", ")} not in eslint.config.web.js` : null;
    }
    case "count-tag":
      return ctx.read("scripts/lib/frontend-counts.mjs").includes(`"${entry.tag}"`) ? null : `tag ${entry.tag} not counted in scripts/lib/frontend-counts.mjs`;
    case "lint-plugin":
      return ctx.read("eslint.config.web.js").includes(`from "${entry.plugin}"`) ? null : `${entry.plugin} not imported in eslint.config.web.js`;
    case "script": {
      const scripts = JSON.parse(ctx.read("package.json")).scripts ?? {};
      if (!scripts[entry.script]) return `root package.json has no script "${entry.script}"`;
      const re = new RegExp(`npm (run )?${entry.script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
      return ctx.workflows().some((w) => re.test(w)) ? null : `no workflow runs "npm run ${entry.script}"`;
    }
    case "file": {
      if (!ctx.exists(entry.path)) return `${entry.path} does not exist`;
      const missing = [entry.contains ?? []].flat().filter((c) => !ctx.read(entry.path).includes(c));
      return missing.length ? `${entry.path} does not contain ${missing.map((m) => `"${m}"`).join(", ")}` : null;
    }
    case "test": {
      // a test (node:test or Playwright) with this exact name exists in the file; renaming or deleting it breaks the rule
      if (!ctx.exists(entry.path)) return `${entry.path} does not exist`;
      return ctx.read(entry.path).includes(`test("${entry.name}"`) || ctx.read(entry.path).includes(`test(\`${entry.name}`) ? null : `${entry.path} has no test named "${entry.name}"`;
    }
    case "review":
      return ctx.exists(".github/pull_request_template.md") && ctx.read(".github/pull_request_template.md").includes(entry.item) ? null : `PR template has no checklist item containing "${entry.item}"`;
    default:
      return `unknown check kind "${entry.kind}"`;
  }
}

export function verify(agentsText, registry, ctx) {
  const problems = [];
  const rules = parseRules(agentsText);
  if (!rules.length) problems.push("AGENTS.md has no rules (lines starting with - **X-NN**)");
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.id)) problems.push(`${r.id}: duplicate rule id`);
    seen.add(r.id);
    if (!r.checks.length) problems.push(`${r.id}: names no enforcing check ("Enforced by: \`check\`")`);
    for (const c of r.checks) {
      const entry = registry.checks[c];
      if (!entry) problems.push(`${r.id}: check \`${c}\` is not in scripts/enforcement.json`);
      else {
        const why = verifyCheck(c, entry, ctx);
        if (why) problems.push(`${r.id}: check \`${c}\` is not enforcing: ${why}`);
      }
    }
  }
  const used = new Set(rules.flatMap((r) => r.checks));
  for (const c of Object.keys(registry.checks)) if (!used.has(c)) problems.push(`check \`${c}\` in enforcement.json enforces no rule in AGENTS.md`);
  return { rules, problems };
}

export const repoContext = () => ({
  read: read,
  exists: (p) => existsSync(join(ROOT, p)),
  workflows: () => readdirSync(join(ROOT, ".github", "workflows")).filter((n) => /\.ya?ml$/.test(n)).map((n) => read(`.github/workflows/${n}`)),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(join(ROOT, "AGENTS.md"))) {
    console.error("AGENTS.md is missing");
    process.exit(1);
  }
  const { rules, problems } = verify(read("AGENTS.md"), JSON.parse(read("scripts/enforcement.json")), repoContext());
  if (problems.length) {
    console.error("AGENTS.md rules without enforcement:\n" + problems.map((p) => `  ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`AGENTS.md: ${rules.length} rules, each with a real enforcing check`);
}
