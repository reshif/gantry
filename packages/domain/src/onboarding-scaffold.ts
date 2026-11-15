/**
 * The onboarding pull request, authored by the agent and checked by rails (spec 11.3).
 *
 * The Onboarding Agent proposes the whole file set (any paths, new or edited) from what Gantry observed and what the person said. Nothing here decides WHAT the agent may
 * propose; this module only (1) reviews the proposal against a small set of safety rails and (2) marks the parts a person must confirm explicitly. The deterministic
 * planner (`planPr`) is a suggestion and the fallback when no agent runs; it is never a cap.
 *
 * Hard blocks (the whole proposal is rejected, with every reason, so the agent can fix it and propose again):
 *   unsafe or colliding paths (absolute, `..`, `.git`), binaries, secrets and credential files, lockfiles (a tool generates those; authored hashes would be invented),
 *   edits to existing application code, branch-protection files (rules are GitHub settings and Gantry never sets them), unsafe shell (pipe to a shell, secrets echoed,
 *   removing the filesystem root), more than the diff cap.
 * Sensitive (allowed, but the card says so and a person confirms): workflow files, dependency manifests, protected paths, ownership files, new source code in a repo that has
 *   some, edits to files onboarding does not normally change, privileged shell (sudo, pull_request_target, write-all).
 * Blockers (nothing is wrong with the files; something outside them must change first): the App lacks the `workflows` permission.
 */
import type { RepoFacts, PlannedFile, PlanContext, AssessedFinding } from "./onboarding.js";
import { agentsMd as renderAgentsMd, lineDelta } from "./onboarding.js";
import { AgentResult, isProtected, validateDraft, type Authorship, type Checked } from "./onboarding-agent.js";

export const SCAFFOLD_MAX_DIFF = 1500;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 100_000;

export type SensitiveId = "workflow" | "dependencies" | "protected" | "existing_file" | "code" | "codeowners" | "shell" | "guideline";
export interface SensitiveFlag { id: SensitiveId; label: string; paths: string[]; reason: string }
export interface Blocker { id: "workflow_permission"; message: string; fix: string }

const BINARY_EXT = /\.(png|jpe?g|gif|ico|bmp|webp|pdf|zip|gz|tgz|tar|7z|rar|exe|dll|so|dylib|bin|class|jar|war|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|pyc|o|a|sqlite3?|db)$/i;
const LOCKFILES = /(^|\/)(uv\.lock|poetry\.lock|Pipfile\.lock|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|gradle\.lockfile)$/;
const CREDENTIAL_FILES = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|jks|keystore)|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$/i;
const BRANCH_RULE_FILES = /^\.github\/(settings\.ya?ml|rulesets?\/.*|branch[-_]protection.*|branch-rules.*)$/i;
const CODE_EXT = /\.(py|js|jsx|mjs|cjs|ts|tsx|go|rs|java|kt|kts|scala|rb|php|c|cc|cpp|h|hpp|cs|swift|m|sh|bash|lua|ex|exs|clj|dart|vue|svelte)$/i;
const MANIFEST = /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|package\.json|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|Pipfile|setup\.py|setup\.cfg|composer\.json|mix\.exs)$/;
const SCAFFOLD_EXISTING = /^(AGENTS\.md|CLAUDE\.md|README(\.md)?|CODEOWNERS|\.github\/CODEOWNERS|docs\/CODEOWNERS|\.gantry\/.*|\.github\/workflows\/.*|ruff\.toml|\.golangci\.ya?ml|\.tool-versions|\.python-version|\.nvmrc|\.node-version|\.gitignore|\.editorconfig|Makefile|justfile|\.pre-commit-config\.ya?ml|\.prettierrc.*|\.eslintrc.*|eslint\.config\.[cm]?js|\.github\/dependabot\.ya?ml)$/;
const SHELLISH = /(^|\/)(Makefile|justfile|Dockerfile|[^/]*\.sh|\.github\/workflows\/[^/]*)$|^\.github\/workflows\//;

/** The specific credential shapes plus a key/value rule that ignores references (`${{ secrets.X }}`, `$VAR`, `<placeholder>`). */
const FILE_SECRETS: RegExp[] = [/AKIA[0-9A-Z]{16}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./];
const KEY_VALUE = /(password|passwd|secret|token|api[_-]?key|access[_-]?key)\w*\s*[:=]\s*["']?([^\s"']{6,})/gi;
export function fileLooksSecret(content: string): boolean {
  if (FILE_SECRETS.some((r) => r.test(content))) return true;
  for (const m of content.matchAll(KEY_VALUE)) {
    const v = m[2] ?? "";
    if (/^[$<{%]/.test(v) || /^(secrets|env|vars|inputs|github|os\.|process\.|getenv|environ|none|null|true|false|changeme|example|your|xxx|\*+)/i.test(v)) continue;
    return true;
  }
  return false;
}

const SHELL_BLOCK: [RegExp, string][] = [
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?)\b/i, "pipes a download into a shell"],
  [/\b(echo|printf|cat)\b[^\n]*\$\{\{\s*secrets\./i, "prints a secret"],
  [/\bprintenv\b|\benv\s*\|\s*(sort|grep|cat)/i, "dumps the environment (secrets included) into the log"],
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, "removes the filesystem root or home"],
];
const SHELL_FLAG: [RegExp, string][] = [
  [/\bsudo\b/, "runs commands with sudo"], [/\bpull_request_target\b/, "uses pull_request_target, which runs with write access on code from forks"],
  [/permissions:\s*write-all/i, "grants write-all to the workflow token"], [/\bchmod\s+(-R\s+)?777\b/, "makes files world-writable"],
];

const isWorkflow = (p: string): boolean => /^\.github\/workflows\//.test(p);
const normalize = (p: string): string | null => {
  const s = p.trim();
  if (!s || s.length > 300 || /[\u0000-\u001f\\]/.test(s) || s.startsWith("/") || s.endsWith("/") || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split("/");
  if (parts.some((x) => x === "" || x === "." || x === ".." || x.toLowerCase() === ".git")) return null;
  return s;
};

export interface AuthoredFile { path: string; content: string; purpose?: string; closes?: string }
export interface ReviewEnv { facts: RepoFacts; ctx: PlanContext; maxDiff: number }
export interface Review { files: PlannedFile[]; sensitive: SensitiveFlag[]; blockers: Blocker[]; plus: number; minus: number; maxDiff: number; mayNot: string }

/** The exact steps for the one permission an authored workflow needs. */
export const WORKFLOW_PERMISSION_FIX =
  "Open the Gantry GitHub App in GitHub (Settings, Developer settings, GitHub Apps, your Gantry App, Permissions & events), set Repository permissions > Workflows to Read and write, save, then accept the new permission on the installation (Settings, Applications, Installed GitHub Apps, Configure: GitHub shows a review-request banner). Then ask for the proposal again.";
export const workflowPermissionMessage = "The Gantry GitHub App is not allowed to write workflow files (.github/workflows), so a pull request that adds a CI workflow would be rejected by GitHub.";

/** Whether the installation, as read from GitHub, lacks `workflows: write`. Unknown permissions are not a lack: the broker's own error then explains it. */
export function lacksWorkflowPermission(f: Pick<RepoFacts, "protection">): boolean {
  const inst = f.protection?.installation;
  return !!inst && inst.permissions.workflows !== "write";
}

/** Reviews an authored file set. Every hard-block reason is returned together. */
export function reviewFiles(authored: readonly AuthoredFile[], env: ReviewEnv): Checked<Review> {
  const { facts, ctx } = env;
  const why: string[] = [];
  if (!authored.length) return { ok: false, reason: "The proposal has no files." };
  if (authored.length > MAX_FILES) return { ok: false, reason: `The proposal has ${authored.length} files; the most one pull request may carry is ${MAX_FILES}.` };
  const seen = new Set<string>();
  const out: PlannedFile[] = [];
  const flags = new Map<SensitiveId, SensitiveFlag>();
  const flag = (id: SensitiveId, label: string, path: string, reason: string): void => {
    const f = flags.get(id);
    if (f) { if (!f.paths.includes(path)) f.paths.push(path); } else flags.set(id, { id, label, paths: [path], reason });
  };
  const hasSource = facts.files.some((p) => CODE_EXT.test(p));
  for (const a of authored) {
    const path = normalize(a.path);
    if (!path) { why.push(`"${a.path.slice(0, 80)}" is not a safe repository path (absolute, "..", ".git" and empty parts are refused).`); continue; }
    if (seen.has(path.toLowerCase())) { why.push(`${path} appears twice.`); continue; }
    seen.add(path.toLowerCase());
    const bad = (m: string): void => { why.push(`${path}: ${m}`); };
    if (!a.content.length) { bad("is empty."); continue; }
    if (a.content.includes("\u0000") || BINARY_EXT.test(path)) { bad("is a binary file; a pull request from Gantry carries text only."); continue; }
    if (a.content.length > MAX_FILE_BYTES) { bad(`is larger than ${MAX_FILE_BYTES / 1000} KB.`); continue; }
    if (CREDENTIAL_FILES.test(path)) { bad("is a credential file (environment file, key, token file); never commit those. Commit an .env.example without values instead."); continue; }
    if (fileLooksSecret(a.content)) { bad("contains something that looks like a credential. Reference a secret by name instead (for example ${{ secrets.NAME }})."); continue; }
    if (LOCKFILES.test(path)) { bad("is a lockfile. A package tool generates it (its hashes cannot be authored); leave it out and let CI or a person run the tool."); continue; }
    if (BRANCH_RULE_FILES.test(path)) { bad("would set branch rules. Branch protection and rulesets are GitHub settings that Gantry never sets."); continue; }
    const exists = facts.files.includes(path);
    if (exists && CODE_EXT.test(path)) { bad("is existing application code. An onboarding pull request does not rewrite it."); continue; }
    if (SHELLISH.test(path) || CODE_EXT.test(path)) {
      const hit = SHELL_BLOCK.find(([r]) => r.test(a.content));
      if (hit) { bad(`${hit[1]}. Not allowed in a file that runs in CI or a shell.`); continue; }
      for (const [r, m] of SHELL_FLAG) if (r.test(a.content)) flag("shell", "Privileged shell or workflow settings", path, `${path} ${m}.`);
    }
    // Sensitive: allowed, but a person confirms.
    if (isWorkflow(path)) flag("workflow", "CI workflow", path, "A workflow runs code on GitHub's runners with the repository's permissions. Read it before you approve.");
    else if (isProtected(path, ctx.protectedPaths)) flag("protected", "Protected path", path, "This repo marks these paths as protected (they need an extra approval to change).");
    if (MANIFEST.test(path)) flag("dependencies", "Dependency manifest", path, exists ? "Edits an existing dependency manifest: package versions may change." : "Adds a dependency manifest: it decides which packages the project installs.");
    if (/(^|\/)CODEOWNERS$/.test(path)) flag("codeowners", "Code owners", path, "Changes who must review changes to the repository.");
    if (!exists && CODE_EXT.test(path) && hasSource) flag("code", "New source code", path, "Adds source code to a repository that already has some.");
    if (exists && !SCAFFOLD_EXISTING.test(path) && !MANIFEST.test(path)) flag("existing_file", "Edits an existing file", path, "Onboarding does not normally change this file.");
    const before = facts.contents[path];
    if (exists && before === undefined && !flags.get("existing_file")?.paths.includes(path)) flag("existing_file", "Edits an existing file", path, "Replaces a file whose current content Gantry did not read, so the change cannot be compared.");
    const d = lineDelta(before ?? "", a.content);
    out.push({ path, finding: a.closes?.trim() || "scaffold", mode: exists ? "update" : "create", content: a.content, source: "agent", plus: d.plus, minus: d.minus, added: d.added, ...(a.purpose ? { purpose: a.purpose.slice(0, 300) } : {}) });
  }
  const plus = out.reduce((n, f) => n + f.plus, 0);
  const minus = out.reduce((n, f) => n + f.minus, 0);
  if (plus + minus > env.maxDiff) why.push(`The proposal changes ${plus + minus} lines; the diff cap is ${env.maxDiff}. Split it: propose the essential files first and the rest in a follow-up pull request.`);
  if (why.length) return { ok: false, reason: `The proposal was not accepted: ${why.join(" ")}`.slice(0, 1800) };
  const sensitive = [...flags.values()];
  if (sensitive.length && ctx.org_guidelines.mayNot) sensitive.push({ id: "guideline", label: "Organisation guideline", paths: [], reason: `The organisation's guidelines say: ${ctx.org_guidelines.mayNot}` });
  const blockers: Blocker[] = out.some((f) => isWorkflow(f.path)) && lacksWorkflowPermission(facts) ? [{ id: "workflow_permission", message: workflowPermissionMessage, fix: WORKFLOW_PERMISSION_FIX }] : [];
  return { ok: true, value: { files: out, sensitive, blockers, plus, minus, maxDiff: env.maxDiff, mayNot: ctx.org_guidelines.mayNot } };
}

export interface ResolvedDraft { value: AgentResult; /** The authored file set, or null when the agent drafted only AGENTS.md content (the rule-based plan then carries it). */ files: PlannedFile[] | null; sensitive: SensitiveFlag[]; blockers: Blocker[]; maxDiff: number }

/**
 * An agent's draft, validated as a whole: the contract and secret scan, then (when it authored files) the rails. A draft with sensitive parts is refused unless
 * `confirmed` (a person confirmed them on the card); the worker passes that from the approved session.
 */
export function resolveDraft(raw: unknown, env: { facts: RepoFacts; findings: AssessedFinding[]; ctx: PlanContext; plan: readonly Pick<PlannedFile, "path">[]; maxDiff: number; by: Authorship; confirmed: boolean }): Checked<ResolvedDraft> {
  const v = validateDraft(raw, env.plan, { protectedPaths: env.ctx.protectedPaths, maxDiff: env.maxDiff });
  if (!v.ok) return v;
  const authored: AuthoredFile[] = v.value.files.map((f) => ({ path: f.path, content: f.content, purpose: f.purpose, closes: f.closes }));
  if (!authored.length) return { ok: true, value: { value: v.value, files: null, sensitive: [], blockers: [], maxDiff: env.maxDiff } };
  if (v.value.agentsMd && !authored.some((f) => f.path === "AGENTS.md")) authored.push({ path: "AGENTS.md", content: renderAgentsMd(env.facts, env.ctx, { by: env.by, body: v.value.agentsMd }), purpose: "repository-specific commands and conventions", closes: "agents" });
  const r = reviewFiles(authored, { facts: env.facts, ctx: env.ctx, maxDiff: env.maxDiff });
  if (!r.ok) return r;
  if (r.value.sensitive.some((s) => s.id !== "guideline") && !env.confirmed) return { ok: false, reason: `The proposal has parts a person must confirm (${r.value.sensitive.filter((s) => s.id !== "guideline").map((s) => s.label.toLowerCase()).join(", ")}); that happens on the card in the onboarding session.` };
  return { ok: true, value: { value: v.value, files: r.value.files, sensitive: r.value.sensitive, blockers: r.value.blockers, maxDiff: env.maxDiff } };
}
