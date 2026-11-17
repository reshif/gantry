/**
 * Repo onboarding logic that needs no IO (spec 11.3): what the broker reads from a repository (`RepoFacts`), how those facts become findings and the files an
 * onboarding pull request adds (the rule-based path, which is also the source of truth the Onboarding Agent works on top of: see onboarding-agent.ts), how a CODEOWNERS
 * file is judged, and how the live checks of "Verified means" are put together.
 * The broker reads, the worker calls these functions, the API stores the outcome. Nothing here guesses: a finding is a fact about the repository.
 */
import { z } from "zod";
import type { GuidelineItem, OnboardFinding, Severity } from "./types.js";
import { authorLine, type AgentsDraft, type Authorship } from "./onboarding-agent.js";
import type { SensitiveFlag } from "./onboarding-scaffold.js";

/* ------------------------------------------------------------------ facts ---- */

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);

export const ProtectionFacts = z.object({
  defaultBranch: z.string(),
  branchProtection: z.object({ requiresPullRequest: z.boolean(), approvals: z.number(), codeOwners: z.boolean(), requiredChecks: z.array(z.string()), enforceAdmins: z.boolean() }).nullable(),
  rulesets: z.array(z.object({
    id: z.number(), name: z.string(), target: z.string(), enforcement: z.string(), ruleTypes: z.array(z.string()), requiredChecks: z.array(z.string()),
    approvals: z.number(), codeOwners: z.boolean(), bypassActors: z.array(z.object({ actorType: z.string(), actorId: z.number().nullable() })),
  })),
  appOnBypassList: z.boolean(),
  requiresGantryCheck: z.boolean(),
  /** The Gantry check is required by an active ruleset and pinned to the Gantry App (spec 11.3). */
  gantryCheckPinned: z.boolean().default(false),
  installation: z.object({ id: z.number(), permissions: z.record(z.string(), z.string()), repositorySelection: z.string().nullable(), targetType: z.string().nullable() }).nullable(),
});
export type ProtectionFacts = z.infer<typeof ProtectionFacts>;

export const SecretHit = z.object({ path: z.string(), line: z.number().int().positive(), rule: z.string() });
export type SecretHit = z.infer<typeof SecretHit>;

/** Everything the assessment reads from a repository. Produced by the GitHub broker from the default branch's tree. */
export const RepoFacts = z.object({
  repo: z.string(),
  defaultBranch: z.string(),
  headSha: sha40,
  archived: z.boolean().default(false),
  /** GitHub's primary language for the repository, or null. */
  language: z.string().nullable(),
  languages: z.record(z.string(), z.number()).default({}),
  /** Paths in the default branch's tree (blobs only). */
  files: z.array(z.string()).max(50_000),
  /** True when GitHub truncated the tree: absence of a file is then not proof. */
  truncated: z.boolean().default(false),
  /** Text content of the files the assessment reads (see `wantsContent`). */
  contents: z.record(z.string(), z.string()).default({}),
  secrets: z.object({ scanned: z.number().int(), complete: z.boolean(), hits: z.array(SecretHit), /** A light read (the scheduled re-check) does not scan; the finding then does not judge it. */ skipped: z.boolean().default(false) }),
  protection: ProtectionFacts.nullable(),
});
export type RepoFacts = z.infer<typeof RepoFacts>;

/** The files whose content the assessment needs. The broker fetches exactly these. */
export const CONTENT_FILES: readonly RegExp[] = [
  /^(\.github\/|docs\/)?CODEOWNERS$/, /^AGENTS\.md$/, /^\.gantry\/factory\.ya?ml$/, /^package\.json$/, /^Makefile$/, /^go\.mod$/, /^pyproject\.toml$/, /^pytest\.ini$/, /^tox\.ini$/, /^setup\.cfg$/,
  /^Cargo\.toml$/, /^pom\.xml$/, /^build\.gradle(\.kts)?$/, /^\.tool-versions$/, /^\.nvmrc$/, /^\.node-version$/, /^\.python-version$/, /^rust-toolchain(\.toml)?$/, /^requirements[^/]*\.txt$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/, /^docker-compose[^/]*\.ya?ml$/, /^compose[^/]*\.ya?ml$/,
  // What a person would read first to understand the repository. Read only; the Intake agent reads them (read_file) to write a brief that fits the code.
  /^(docs\/)?README(\.(md|markdown|rst|txt))?$/i, /^CONTRIBUTING(\.(md|markdown|rst|txt))?$/i,
];
export const wantsContent = (path: string): boolean => CONTENT_FILES.some((r) => r.test(path));

/* ------------------------------------------------------------------ small readers ---- */

const has = (f: RepoFacts, re: RegExp): boolean => f.files.some((p) => re.test(p));
const find = (f: RepoFacts, re: RegExp): string | null => f.files.find((p) => re.test(p)) ?? null;
const text = (f: RepoFacts, path: string): string => f.contents[path] ?? "";
const json = (s: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export type Ecosystem = "node" | "go" | "python" | "rust" | "maven" | "gradle" | "terraform" | "unknown";

/** The build ecosystem from the manifests that are really there. A repo can have several; the first match in this order is the primary one. */
export function ecosystems(f: RepoFacts): Ecosystem[] {
  const out: Ecosystem[] = [];
  if (has(f, /^package\.json$/)) out.push("node");
  if (has(f, /^go\.mod$/)) out.push("go");
  if (has(f, /^(pyproject\.toml|setup\.py|requirements[^/]*\.txt|Pipfile)$/)) out.push("python");
  if (has(f, /^Cargo\.toml$/)) out.push("rust");
  if (has(f, /^pom\.xml$/)) out.push("maven");
  if (has(f, /^build\.gradle(\.kts)?$/)) out.push("gradle");
  if (has(f, /\.tf$/)) out.push("terraform");
  return out.length ? out : ["unknown"];
}

/** How the repo's tests are run, read from its own files. Null when nothing says so. */
export function detectTestCommand(f: RepoFacts): { command: string; source: string } | null {
  const pkg = json(text(f, "package.json"));
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? (pkg.scripts as Record<string, unknown>) : {};
  const t = typeof scripts.test === "string" ? scripts.test : "";
  if (t && !/no test specified/i.test(t)) return { command: "npm test", source: "package.json scripts.test" };
  if (/^test:/m.test(text(f, "Makefile"))) return { command: "make test", source: "Makefile test target" };
  if (has(f, /^go\.mod$/)) return { command: "go test ./...", source: "go.mod" };
  if (has(f, /^(pytest\.ini|tox\.ini)$/) || /\[tool\.pytest|\bpytest\b/.test(text(f, "pyproject.toml") + text(f, "setup.cfg"))) return { command: "pytest -q", source: "pytest configuration" };
  if (has(f, /^Cargo\.toml$/)) return { command: "cargo test", source: "Cargo.toml" };
  if (has(f, /^pom\.xml$/)) return { command: "mvn -q test", source: "pom.xml" };
  if (has(f, /^build\.gradle(\.kts)?$/)) return { command: "./gradlew test", source: "build.gradle" };
  if (has(f, /\.tf$/)) return { command: "terraform validate", source: "Terraform files" };
  return null;
}

/** Whether building or testing needs Docker (spec 16, D7): compose files used by tests, testcontainers, or a test script that calls docker. */
export function needsDocker(f: RepoFacts): string | null {
  const compose = f.files.find((p) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(p) && /test|ci|integration/i.test(p));
  if (compose) return `${compose} is used for tests`;
  const pkg = json(text(f, "package.json"));
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? (pkg.scripts as Record<string, unknown>) : {};
  const dockerScript = Object.entries(scripts).find(([k, v]) => /test/.test(k) && typeof v === "string" && /\bdocker(-compose)?\b/.test(v));
  if (dockerScript) return `package.json script "${dockerScript[0]}" calls docker`;
  const mk = text(f, "Makefile");
  if (/^test[^\n]*:[^\n]*\n(\t[^\n]*\n?)*?\t[^\n]*\bdocker(-compose)?\b/m.test(mk)) return "the Makefile test target calls docker";
  const manifests = text(f, "package.json") + text(f, "go.mod") + text(f, "pyproject.toml") + text(f, "pom.xml") + text(f, "build.gradle") + text(f, "build.gradle.kts") + text(f, "Cargo.toml");
  if (/testcontainers/i.test(manifests)) return "the build depends on testcontainers";
  return null;
}

const LOCKFILES: Record<Ecosystem, RegExp | null> = {
  node: /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/, go: /^go\.sum$/, python: /^(poetry\.lock|uv\.lock|Pipfile\.lock|requirements[^/]*\.txt|pdm\.lock)$/,
  rust: /^Cargo\.lock$/, maven: null, gradle: null, terraform: /^\.terraform\.lock\.hcl$/, unknown: null,
};

/* ------------------------------------------------------------------ CODEOWNERS ---- */

export interface OwnerRule { pattern: string; owners: string[]; line: number }

/** Parses a CODEOWNERS file: rules in order, plus the lines that are not valid rules. */
export function parseCodeowners(src: string): { rules: OwnerRule[]; invalid: { line: number; text: string; why: string }[] } {
  const rules: OwnerRule[] = [];
  const invalid: { line: number; text: string; why: string }[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    const pattern = parts[0]!;
    const owners = parts.slice(1);
    if (pattern.startsWith("!") || /[[\]]/.test(pattern)) return void invalid.push({ line: i + 1, text: raw.trim(), why: "GitHub does not support this pattern syntax in CODEOWNERS" });
    const bad = owners.find((o) => !/^@[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(o) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o));
    if (bad) return void invalid.push({ line: i + 1, text: raw.trim(), why: `"${bad}" is not a user, team or email` });
    rules.push({ pattern, owners, line: i + 1 });
  });
  return { rules, invalid };
}

/** A CODEOWNERS pattern as a regular expression over a repo-relative path (gitignore-like: leading slash anchors, trailing slash is a directory, ** crosses directories). */
function patternRe(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  const dir = p.endsWith("/");
  p = p.replace(/^\//, "").replace(/\/$/, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${re}${dir ? "/.*" : "(?:/.*)?"}$`);
}

/** The owners of a path: the last matching rule wins, as on GitHub. Empty when no rule matches or the last match names nobody. */
export function ownersOf(rules: OwnerRule[], path: string): string[] {
  let hit: OwnerRule | null = null;
  for (const r of rules) if (patternRe(r.pattern).test(path)) hit = r;
  return hit ? hit.owners : [];
}

export const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"] as const;

export interface OwnersJudgement { path: string | null; valid: boolean; problems: string[]; missing: string[] }

/** Spec 11.3: the code-owner file is valid and covers the CI configuration, the code-owner file itself and the Gantry config. */
export function judgeCodeowners(f: RepoFacts): OwnersJudgement {
  const path = CODEOWNERS_PATHS.find((p) => f.files.includes(p)) ?? null;
  if (!path) return { path: null, valid: false, problems: ["There is no CODEOWNERS file."], missing: [] };
  const { rules, invalid } = parseCodeowners(text(f, path));
  const problems = invalid.map((x) => `line ${x.line}: ${x.why}`);
  if (!rules.length) problems.push("It has no rules.");
  const ci = f.files.find((p) => p.startsWith(".github/workflows/")) ?? ".github/workflows/ci.yml";
  const targets = [ci, path, ".gantry/factory.yml"];
  const missing = targets.filter((t) => ownersOf(rules, t).length === 0);
  return { path, valid: problems.length === 0, problems, missing };
}

/* ------------------------------------------------------------------ findings ---- */

/** Which guideline item makes a check required for Ready. The factory list is edited by people; an item removed from it leaves its check advisory. */
export const CHECK_GUIDELINE: Record<string, string> = {
  ci: "gl-1", test: "gl-2", protect: "gl-3", owners: "gl-4", lint: "gl-5", secrets: "gl-6", repro: "gl-7", deps: "gl-8", mcp: "gl-9",
};
/** Checks that are always required: the agent instructions file is what lets agents work, and a repo that needs Docker cannot run in the sandbox (spec 16, D7). */
export const ALWAYS_REQUIRED = ["agents", "docker"] as const;

export interface AssessedFinding extends OnboardFinding {
  /** A gap in a required check blocks Ready; an advisory one is listed only. */
  required: boolean;
  /** What was read to decide: the file, the rule or the count. Never a secret value. */
  detail: string;
}

export interface AssessContext {
  /** The factory guidelines plus the project's additions. Items with `required: false` leave their check advisory. */
  guidelines: GuidelineItem[];
  /** MCP server names the repo is configured to need (declared in .gantry/factory.yml). */
  mcp: string[];
  /** Required status checks from the repo's settings (the CI job name the workflow must report). */
  requiredChecks: string[];
}

const SEV: Record<string, Severity> = { ci: "high", test: "high", protect: "high", owners: "medium", lint: "low", secrets: "high", agents: "medium", repro: "medium", deps: "high", mcp: "low", docker: "high" };

/** Version a toolchain can be pinned to, when the repo itself says which one it uses. */
export function inferToolVersions(f: RepoFacts): string[] {
  const out: string[] = [];
  const gomod = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text(f, "go.mod"));
  if (gomod) out.push(`golang ${gomod[1]}`);
  const pkg = json(text(f, "package.json"));
  const eng = pkg && typeof pkg.engines === "object" && pkg.engines ? (pkg.engines as Record<string, unknown>) : null;
  const node = typeof eng?.node === "string" ? /(\d+)(?:\.\d+)*/.exec(eng.node)?.[1] : null;
  if (node) out.push(`nodejs ${node}`);
  const py = /(\d+\.\d+)/.exec(text(f, "pyproject.toml").match(/requires-python\s*=\s*"([^"]+)"/)?.[1] ?? "");
  if (py) out.push(`python ${py[1]}`);
  return out;
}

const LINT_FILES = /^(\.eslintrc(\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|\.golangci\.ya?ml|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|\.rubocop\.yml|checkstyle\.xml|\.clippy\.toml|clippy\.toml|\.prettierrc(\.[a-z]+)?|biome\.jsonc?|\.tflint\.hcl)$/;
const hasLint = (f: RepoFacts): string | null => find(f, LINT_FILES) ?? (/\[tool\.(ruff|flake8|pylint|black)\]/.test(text(f, "pyproject.toml")) ? "pyproject.toml" : null);
const hasToolPin = (f: RepoFacts): string | null => find(f, /^(\.tool-versions|\.nvmrc|\.node-version|\.python-version|rust-toolchain(\.toml)?|Dockerfile\.build)$/) ?? (/^go\s+\d/m.test(text(f, "go.mod")) ? "go.mod" : null);

/** The assessment (spec 11.3 "Assessed"): one finding per check, each from what the repository holds. */
export function assess(f: RepoFacts, ctx: AssessContext): AssessedFinding[] {
  const eco = ecosystems(f);
  const primary = eco[0]!;
  const test = detectTestCommand(f);
  const owners = judgeCodeowners(f);
  const lintFile = hasLint(f);
  const pin = hasToolPin(f);
  const lock = LOCKFILES[primary];
  const manifest = primary === "unknown" ? null : find(f, /^(package\.json|go\.mod|pyproject\.toml|setup\.py|requirements[^/]*\.txt|Pipfile|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?)$/) ?? (primary === "terraform" ? find(f, /\.tf$/) : null);
  const lockOk = !lock || has(f, lock) || !manifest;
  const workflows = f.files.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  const docker = needsDocker(f);
  const prot = f.protection;
  const protOk = !!prot && ((prot.rulesets.some((r) => r.enforcement === "active" && r.ruleTypes.includes("pull_request") && r.approvals >= 1)) || (!!prot.branchProtection?.requiresPullRequest && prot.branchProtection.approvals >= 1))
    && (prot.requiresGantryCheck || (prot.branchProtection?.requiredChecks.length ?? 0) > 0 || prot.rulesets.some((r) => r.enforcement === "active" && r.requiredChecks.length > 0));
  const factory = text(f, ".gantry/factory.yml");
  const declared = new Set([...factory.matchAll(/^\s*-\s*["']?([A-Za-z0-9_.:-]+)["']?\s*$/gm)].map((m) => m[1]!));
  const mcpMissing = ctx.mcp.filter((m) => !declared.has(m));
  const secretHits = f.secrets.hits;
  const reqItems = new Map(ctx.guidelines.map((g) => [g.id, g.required]));
  const isRequired = (id: string): boolean => (ALWAYS_REQUIRED as readonly string[]).includes(id) || reqItems.get(CHECK_GUIDELINE[id] ?? "") === true;
  const fixableCi = !workflows.length && ciTemplate(primary, "ci/test", f) !== null;
  const lintFix = !lintFile ? lintTemplate(primary) : null;

  const out: Omit<AssessedFinding, "required">[] = [
    workflows.length
      ? { id: "ci", check: "CI present", ok: true, sev: SEV.ci!, fix: "", file: null, detail: `${workflows.length} workflow file${workflows.length > 1 ? "s" : ""}: ${workflows.slice(0, 3).join(", ")}` }
      : fixableCi
        ? { id: "ci", check: "CI present", ok: false, sev: SEV.ci!, fix: "Add .github/workflows/gantry-ci.yml", file: ".github/workflows/gantry-ci.yml", detail: "No file under .github/workflows" }
        : { id: "ci", check: "CI present", ok: false, sev: SEV.ci!, fix: "Add a CI workflow that builds and tests the repo. The Onboarding Agent can propose one in the onboarding PR (it needs your confirmation)", file: null, manual: true, detail: "No file under .github/workflows and no known template for this stack" },
    test
      ? { id: "test", check: "Test command", ok: true, sev: SEV.test!, fix: "", file: null, detail: `${test.command} (${test.source})` }
      : { id: "test", check: "Test command", ok: false, sev: SEV.test!, fix: "Add a test command (a test script or Makefile target). The Onboarding Agent can propose one with a smoke test", file: null, manual: true, detail: "No test command found in the repo's manifests" },
    prot && protOk
      ? { id: "protect", check: "Branch protection", ok: true, sev: SEV.protect!, fix: "", file: null, detail: `${prot.rulesets.filter((r) => r.enforcement === "active").length} active ruleset(s) on ${prot.defaultBranch}` }
      : { id: "protect", check: "Branch protection", ok: false, sev: SEV.protect!, fix: "Org owner must apply the Gantry ruleset on the default branch: pull request, 1 approval, code-owner review, CI checks and the Gantry check", file: null, manual: true, detail: prot ? "No active ruleset or branch protection requires a pull request, an approval and status checks" : "Protections could not be read" },
    owners.valid && !owners.missing.length
      ? { id: "owners", check: "CODEOWNERS", ok: true, sev: SEV.owners!, fix: "", file: null, detail: `${owners.path} covers CI config, itself and .gantry/` }
      : { id: "owners", check: "CODEOWNERS", ok: false, sev: SEV.owners!, fix: owners.path ? "Cover the CI configuration, CODEOWNERS and .gantry/ in CODEOWNERS" : "Add CODEOWNERS for top-level directories", file: owners.path ?? "CODEOWNERS", detail: owners.path ? [...owners.problems, ...owners.missing.map((m) => `${m} has no owner`)].join("; ") : "No CODEOWNERS file" },
    lintFile
      ? { id: "lint", check: "Lint config", ok: true, sev: SEV.lint!, fix: "", file: null, detail: lintFile }
      : lintFix
        ? { id: "lint", check: "Lint config", ok: false, sev: SEV.lint!, fix: "Commit lint config", file: lintFix.path, detail: "No lint configuration found" }
        : { id: "lint", check: "Lint config", ok: false, sev: SEV.lint!, fix: "Commit a lint configuration; a safe default needs the linter installed, which a pull request may not add", file: null, manual: true, detail: "No lint configuration found" },
    f.secrets.skipped
      ? { id: "secrets", check: "Secrets scan", ok: true, sev: SEV.secrets!, fix: "", file: null, detail: "Not scanned in this check" }
      : secretHits.length
      ? { id: "secrets", check: "Secrets scan", ok: false, sev: SEV.secrets!, fix: `Rotate and remove ${secretHits.length} secret${secretHits.length > 1 ? "s" : ""}: ${secretHits.slice(0, 3).map((h) => `${h.path}:${h.line} (${h.rule})`).join(", ")}`, file: null, manual: true, detail: `${secretHits.length} match(es) in ${f.secrets.scanned} files` }
      : { id: "secrets", check: "Secrets scan", ok: f.secrets.complete, sev: SEV.secrets!, fix: f.secrets.complete ? "" : "The scan stopped at its size limit; scan the rest of the repository", file: null, ...(f.secrets.complete ? {} : { manual: true }), detail: `${f.secrets.scanned} files scanned${f.secrets.complete ? "" : " (limit reached)"}` },
    text(f, "AGENTS.md").trim()
      ? { id: "agents", check: "Agent instructions file", ok: true, sev: SEV.agents!, fix: "", file: null, detail: "AGENTS.md" }
      : { id: "agents", check: "Agent instructions file", ok: false, sev: SEV.agents!, fix: "Add AGENTS.md with conventions and test command", file: "AGENTS.md", detail: "No AGENTS.md" },
    pin
      ? { id: "repro", check: "Build reproducibility", ok: true, sev: SEV.repro!, fix: "", file: null, detail: `Toolchain pinned in ${pin}` }
      : inferToolVersions(f).length
        ? { id: "repro", check: "Build reproducibility", ok: false, sev: SEV.repro!, fix: "Pin toolchain version", file: ".tool-versions", detail: "No toolchain pin; versions inferred from the manifests" }
        : { id: "repro", check: "Build reproducibility", ok: false, sev: SEV.repro!, fix: "Pin the toolchain version (.tool-versions or .python-version / .nvmrc). Tell the Onboarding Agent the version and it can propose the pin", file: null, manual: true, detail: "No toolchain pin and no version in the manifests" },
    manifest && lockOk
      ? { id: "deps", check: "Dependency manifest", ok: true, sev: SEV.deps!, fix: "", file: null, detail: `${manifest}${lock ? " with a lockfile" : ""}` }
      : { id: "deps", check: "Dependency manifest", ok: false, sev: SEV.deps!, fix: manifest ? "Commit the lockfile: a package tool generates it (for example `uv lock`, `npm install`), so a person or CI runs it and commits the result" : "Add a dependency manifest. For a new project the onboarding agent can propose one (it needs your confirmation)", file: null, manual: true, detail: manifest ? `${manifest} has no lockfile` : "No manifest for any supported ecosystem" },
    factory && !mcpMissing.length && /^repo:/m.test(factory)
      ? { id: "mcp", check: "MCP needs declared", ok: true, sev: SEV.mcp!, fix: "", file: null, detail: ctx.mcp.length ? `${ctx.mcp.length} server(s) declared in .gantry/factory.yml` : ".gantry/factory.yml present" }
      : { id: "mcp", check: "MCP needs declared", ok: false, sev: SEV.mcp!, fix: "Declare MCP servers in .gantry/factory.yml", file: ".gantry/factory.yml", detail: factory ? `Missing: ${mcpMissing.join(", ") || "repo entry"}` : "No .gantry/factory.yml" },
    docker
      ? { id: "docker", check: "Builds and tests without Docker", ok: false, sev: SEV.docker!, fix: "Tests that need Docker cannot run in the runner sandbox. Remove the Docker dependency from the test path, or ask for an exception", file: null, manual: true, detail: docker }
      : { id: "docker", check: "Builds and tests without Docker", ok: true, sev: SEV.docker!, fix: "", file: null, detail: "No Docker use found on the test path" },
  ];
  return out.map((x) => ({ ...x, required: isRequired(x.id) }));
}

/* ------------------------------------------------------------------ the pull request ---- */

export interface PlannedFile {
  path: string;
  /** The finding this file fixes. */
  finding: string;
  mode: "create" | "update";
  /** Full new content of the file. */
  content: string;
  /** Lines added and removed against the file on the default branch (a new file adds all of its lines). */
  plus: number;
  minus: number;
  /** The added lines, for the preview in the pull request tab (at most 400). */
  added: string[];
  /** `agent` when the Onboarding Agent drafted this content, otherwise `observed` (written by rule from the repository's own files). */
  source?: "observed" | "agent";
  /** Why the agent included this file (agent-authored files only). */
  purpose?: string;
}

export interface PlanContext {
  project: string;
  repoId: string;
  /** Owner of the repository on GitHub (the org) and the owning team's GitHub slug. */
  org: string;
  team: string;
  defaultBranch: string;
  branchPrefix: string;
  merge: string;
  requiredChecks: string[];
  protectedPaths: string[];
  mcp: string[];
  org_guidelines: { items: GuidelineItem[]; may: string; mayNot: string; version: number };
  project_guidelines: { items: GuidelineItem[]; notes: string; version: number };
}

export function lintTemplate(eco: Ecosystem): { path: string; content: string } | null {
  if (eco === "go") return { path: ".golangci.yml", content: ["version: \"2\"", "linters:", "  default: standard", ""].join("\n") };
  if (eco === "python") return { path: "ruff.toml", content: ["line-length = 100", "", "[lint]", "select = [\"E\", \"F\", \"I\"]", ""].join("\n") };
  return null;
}

/** A CI workflow for the repo's ecosystem, or null when Gantry has no template for it. The job is named after the required check so the check name matches the ruleset. */
export function ciTemplate(eco: Ecosystem, check: string, f: RepoFacts): string | null {
  const head = (extra: string[]): string =>
    ["name: gantry-ci", "on:", "  pull_request:", "  push:", `    branches: [${yamlScalar(f.defaultBranch)}]`, "permissions:", "  contents: read", "jobs:", "  test:", `    name: ${yamlScalar(check)}`, "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", ...extra, ""].join("\n");
  const test = detectTestCommand(f);
  const run = (cmd: string): string[] => ["      - name: Test", `        run: ${cmd}`];
  switch (eco) {
    case "node": return head(["      - uses: actions/setup-node@v4", "        with:", `          node-version: ${yamlScalar(inferToolVersions(f).find((v) => v.startsWith("nodejs "))?.slice(7) ?? "lts/*")}`, `      - run: ${has(f, /^package-lock\.json$/) ? "npm ci" : "npm install"}`, ...run(test?.command ?? "npm test")]);
    case "go": return head(["      - uses: actions/setup-go@v5", "        with:", "          go-version-file: go.mod", ...run("go test ./...")]);
    case "python": return head(["      - uses: actions/setup-python@v5", "        with:", "          python-version: \"3.x\"", `      - run: ${has(f, /^requirements\.txt$/) ? "pip install -r requirements.txt pytest" : "pip install -e . pytest"}`, ...run(test?.command ?? "pytest -q")]);
    case "rust": return head(["      - uses: dtolnay/rust-toolchain@stable", ...run("cargo test")]);
    case "maven": return head(["      - uses: actions/setup-java@v4", "        with:", "          distribution: temurin", "          java-version: \"21\"", ...run("mvn -q test")]);
    case "gradle": return head(["      - uses: actions/setup-java@v4", "        with:", "          distribution: temurin", "          java-version: \"21\"", ...run("./gradlew test")]);
    default: return null;
  }
}

/** A YAML scalar that is safe unquoted or double-quoted (the files Gantry writes use only strings, numbers and lists of strings). */
export function yamlScalar(v: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(v) && !/^(true|false|null|yes|no|on|off|~|\d+)$/i.test(v) ? v : JSON.stringify(v);
}

export function agentsMd(f: RepoFacts, c: PlanContext, draft?: { by: Authorship; body: AgentsDraft }): string {
  const test = detectTestCommand(f);
  const a = draft?.body;
  const org = c.org_guidelines.items.filter((i) => i.required);
  const adv = c.org_guidelines.items.filter((i) => !i.required);
  const proj = c.project_guidelines.items;
  const lines = [
    "# AGENTS.md", "", `Instructions for coding agents that work in this repository for Gantry. ${authorLine(draft?.by, "file")}`, "",
    "## Test command", "", test ? `Run \`${test.command}\` before opening a PR.` : "No test command has been detected. A person must add one here.", "",
    ...(a?.commands.length ? ["## Commands", "", "Drafted by the onboarding agent from the repository's files and not run by Gantry; check them before relying on them.", "", ...a.commands.map((x) => `- ${x.label}: \`${x.command}\``), ""] : []),
    "## Conventions", "", `- Branches start with ${c.branchPrefix}. The default branch is ${c.defaultBranch}; merges use the ${c.merge} method.`, `- Never push to ${c.defaultBranch}. Every change goes through a pull request and the project's gates.`,
    ...(c.requiredChecks.length ? [`- Required checks: ${c.requiredChecks.join(", ")}.`] : []),
    ...(c.protectedPaths.length ? [`- Protected paths need an extra approval: ${c.protectedPaths.join(", ")}.`] : []), "",
    ...(a?.conventions.length ? ["## Repository conventions", "", ...a.conventions.map((x) => `- ${x}`), ""] : []),
    ...(a?.notes ? ["## Notes", "", a.notes, ""] : []),
    ...(org.length ? ["## Guidelines", "", ...org.map((i) => `- ${i.text}`), ""] : []),
    ...(adv.length ? ["## Advisory guidelines", "", ...adv.map((i) => `- ${i.text}`), ""] : []),
    ...(proj.length || c.project_guidelines.notes ? ["## Project rules", "", ...proj.map((i) => `- ${i.text}${i.required ? "" : " (advisory)"}`), ...(c.project_guidelines.notes ? ["", c.project_guidelines.notes] : []), ""] : []),
    ...(c.org_guidelines.mayNot ? ["## Never change", "", c.org_guidelines.mayNot, ""] : []),
  ];
  return lines.join("\n");
}

export function factoryYml(c: PlanContext, f: RepoFacts): string {
  const list = (xs: string[]): string[] => (xs.length ? xs.map((x) => `  - ${yamlScalar(x)}`) : []);
  return [
    "# Gantry configuration for this repository. Written by the onboarding pull request.",
    `project: ${yamlScalar(c.project)}`, `repo: ${yamlScalar(f.repo)}`, `default_branch: ${yamlScalar(c.defaultBranch)}`, `branch_prefix: ${yamlScalar(c.branchPrefix)}`, `merge: ${yamlScalar(c.merge)}`,
    c.requiredChecks.length ? "required_checks:" : "required_checks: []", ...list(c.requiredChecks),
    c.mcp.length ? "mcp:" : "mcp: []", ...list(c.mcp),
    c.protectedPaths.length ? "protected_paths:" : "protected_paths: []", ...list(c.protectedPaths),
    `guidelines: ${c.org_guidelines.version}${c.project_guidelines.version ? `.${c.project_guidelines.version}` : ""}`, "",
  ].join("\n");
}

const linesOf = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/** Lines added and removed between two versions of a file, comparing lines as a multiset (what a person reads as "+N -M" for a file that only gains entries). */
export function lineDelta(before: string, after: string): { plus: number; minus: number; added: string[] } {
  const left = new Map<string, number>();
  for (const l of linesOf(before)) left.set(l, (left.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of linesOf(after)) {
    const c = left.get(l) ?? 0;
    if (c > 0) left.set(l, c - 1);
    else added.push(l);
  }
  let minus = 0;
  for (const c of left.values()) minus += c;
  return { plus: added.length, minus, added: added.slice(0, 400) };
}

/** What the onboarding pull request adds (spec 11.3): only files, never application code, dependencies or branch rules. */
export function planPr(f: RepoFacts, findings: AssessedFinding[], c: PlanContext, draft?: { by: Authorship; agentsMd?: AgentsDraft }): PlannedFile[] {
  const gap = (id: string): AssessedFinding | undefined => findings.find((x) => x.id === id && !x.ok && x.file);
  const out: PlannedFile[] = [];
  const add = (path: string, finding: string, content: string, source: "observed" | "agent" = "observed"): void => {
    const before = f.contents[path];
    out.push({ path, finding, mode: before === undefined && !f.files.includes(path) ? "create" : "update", content, source, ...lineDelta(before ?? "", content) });
  };
  const eco = ecosystems(f)[0]!;
  if (gap("agents")) {
    const drafted = draft?.agentsMd ? { by: draft.by, body: draft.agentsMd } : undefined;
    add("AGENTS.md", "agents", agentsMd(f, c, drafted), drafted ? "agent" : "observed");
  }
  if (gap("owners")) {
    const o = judgeCodeowners(f);
    const handle = `@${c.org}/${c.team}`;
    const wanted = [`* ${handle}`, `/.github/ ${handle}`, `/.gantry/ ${handle}`, `/CODEOWNERS ${handle}`];
    if (!o.path) add("CODEOWNERS", "owners", ["# Owners for agent work. Written by the onboarding pull request.", ...wanted, ""].join("\n"));
    else {
      const cur = text(f, o.path).replace(/\n*$/, "\n");
      const { rules } = parseCodeowners(cur);
      const extra = wanted.filter((w) => !rules.some((r) => r.pattern === w.split(" ")[0]));
      const stripped = cur.split("\n").filter((l, i) => !parseCodeowners(cur).invalid.some((x) => x.line === i + 1)).join("\n");
      add(o.path, "owners", `${stripped.replace(/\n*$/, "\n")}${extra.length ? `\n# Added by Gantry so that CI config, this file and .gantry/ have an owner\n${extra.join("\n")}\n` : ""}`);
    }
  }
  if (gap("mcp")) add(".gantry/factory.yml", "mcp", factoryYml(c, f));
  else if (!f.files.includes(".gantry/factory.yml")) add(".gantry/factory.yml", "mcp", factoryYml(c, f));
  if (gap("ci")) {
    const wf = ciTemplate(eco, c.requiredChecks[0] ?? "ci/test", f);
    if (wf) add(".github/workflows/gantry-ci.yml", "ci", wf);
  }
  if (gap("lint")) {
    const l = lintTemplate(eco);
    if (l) add(l.path, "lint", l.content);
  }
  if (gap("repro")) {
    const v = inferToolVersions(f);
    if (v.length) add(".tool-versions", "repro", `${v.join("\n")}\n`);
  }
  return out;
}

export const PR_TITLE = (repo: string): string => `Prepare ${repo} for Gantry`;

export function prBody(files: PlannedFile[], findings: AssessedFinding[], by: Authorship, extra: { guidelineSuggestions?: string[]; forPeople?: string[]; sensitive?: SensitiveFlag[] } = {}): string {
  const why = (id: string): string => findings.find((x) => x.id === id)?.check ?? id;
  const gaps = findings.filter((x) => !x.ok && (x.manual || !x.file));
  const mine = (extra.forPeople ?? []).filter((x) => !gaps.some((g) => x.includes(g.check)));
  const authored = files.some((p) => p.purpose !== undefined || (p.source === "agent" && p.finding === "scaffold")) || (extra.sensitive?.length ?? 0) > 0;
  const sens = extra.sensitive ?? [];
  return [
    authorLine(by, "pr"),
    authored
      ? "The agent chose these files from what Gantry observed and what the person asked for. Gantry checked them (no secrets, no binaries or lockfiles, no existing application code changed, no branch rules) and a person confirmed the sensitive parts listed below. A person reviews and merges it; Gantry never merges it on its own."
      : "It adds only what a pull request can add: no application code, no dependency changes and no branch rules. A person reviews and merges it; Gantry never merges it on its own.", "",
    "## Files", "", ...files.map((p) => `- \`${p.path}\` (${p.mode === "create" ? "new" : "edited"}, +${p.plus} -${p.minus}, ${p.source === "agent" ? "drafted by the agent" : "written by rule from the repository's files"}): ${p.purpose || why(p.finding)}`), "",
    ...(sens.length ? ["## Confirmed by a person before this was opened", "", ...sens.map((x) => `- ${x.label}${x.paths.length ? ` (${x.paths.map((q) => `\`${q}\``).join(", ")})` : ""}: ${x.reason}`), ""] : []),
    ...(gaps.length ? ["## Still open", "", "These cannot be fixed by a pull request and need a person with access:", "", ...gaps.map((x) => `- ${x.check}: ${x.fix || x.detail}`), ...mine.map((x) => `- ${x} (suggested by the agent)`), ""] : mine.length ? ["## Still open", "", ...mine.map((x) => `- ${x} (suggested by the agent)`), ""] : []),
    ...(extra.guidelineSuggestions?.length ? ["## Suggestions for the guidelines", "", "Not applied by this pull request; for a person to consider.", "", ...extra.guidelineSuggestions.map((x) => `- ${x}`), ""] : []),
    `Assessment: ${by.mode === "agent" ? "Onboarding Agent on top of rule-based facts" : "rule-based"}.`, "",
  ].join("\n");
}

/* ------------------------------------------------------------------ verified means ---- */

export const READINESS_CHECKS = [
  { id: "installation", label: "App installed on the repo with the expected permissions, at organisation level" },
  { id: "ruleset", label: "Default-branch ruleset active with a pull request, a human approval, code-owner review and the repo's CI checks" },
  { id: "gantry_check", label: "The Gantry check is required and pinned to the Gantry App" },
  { id: "bypass", label: "The App is not on any bypass list" },
  { id: "codeowners", label: "The code-owner file is valid and covers the CI configuration, itself and the Gantry config" },
  { id: "canary", label: "A canary branch can be published, and a draft pull request opened and closed" },
  { id: "canary_ci", label: "CI reports a check on the canary" },
  { id: "direct_push", label: "A direct push to the default branch by Gantry is rejected" },
  { id: "runner", label: "A runner image variant exists that can build and test the repo without Docker" },
  { id: "guidelines", label: "Every required guideline of the onboarding list is met" },
] as const;
export type ReadinessId = (typeof READINESS_CHECKS)[number]["id"];

export interface ReadinessResult {
  id: ReadinessId;
  label: string;
  ok: boolean;
  /** True when the check could not be made (GitHub or the broker did not answer). Such a result is neither a pass nor a loss of readiness. */
  unknown?: boolean;
  detail: string;
}

/** The permissions the App must hold on the repo (spec 11.1). Workflows write is judged separately, only when the repo has workflow files Gantry added. */
export const EXPECTED_PERMISSIONS: Record<string, "read" | "write"> = {
  metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "write", actions: "read", statuses: "read", administration: "read",
};
const rank = (p: string | undefined): number => (p === "write" ? 2 : p === "read" ? 1 : 0);

/** Spec 11.3 checks that come from the protections report and the repository's files (the canary and the runner are judged by the caller). */
export function judgeProtections(f: RepoFacts, requiredChecks: string[]): ReadinessResult[] {
  const L = (id: ReadinessId): string => READINESS_CHECKS.find((c) => c.id === id)!.label;
  const p = f.protection;
  if (!p) {
    return (["installation", "ruleset", "gantry_check", "bypass"] as const).map((id) => ({ id, label: L(id), ok: false, unknown: true, detail: "Protections could not be read." }));
  }
  const inst = p.installation;
  const lacking = inst ? Object.entries(EXPECTED_PERMISSIONS).filter(([k, v]) => rank(inst.permissions[k]) < rank(v)).map(([k, v]) => `${k}:${v}`) : [];
  const active = p.rulesets.filter((r) => r.enforcement === "active" && (r.target === "branch" || r.target === ""));
  const pr = active.find((r) => r.ruleTypes.includes("pull_request") && r.approvals >= 1 && r.codeOwners);
  const required = new Set([...active.flatMap((r) => r.requiredChecks), ...(p.branchProtection?.requiredChecks ?? [])]);
  const missingCi = requiredChecks.filter((c) => !required.has(c));
  const ruleOk = !!pr && !missingCi.length;
  const ruleWhy = !active.length ? "No active ruleset on the default branch." : !pr ? "No active ruleset requires a pull request with at least one approval and code-owner review." : `Required checks missing from the ruleset: ${missingCi.join(", ")}.`;
  return [
    { id: "installation", label: L("installation"), ok: !!inst && inst.targetType === "Organization" && !lacking.length, detail: !inst ? "The installation could not be read." : inst.targetType !== "Organization" ? `The App is installed on a ${inst.targetType ?? "unknown"} account, not an organisation. Gantry expects an organisation-level install, so that org owners control the App and the branch ruleset. For a personal repository this is not a safety problem: move the repository to an organisation and install the App there, or have a person with authority record "Ready by exception" with the reason (the Onboarding Agent can propose it).` : lacking.length ? `Missing permissions: ${lacking.join(", ")}.` : "Installed at organisation level with the expected permissions." },
    { id: "ruleset", label: L("ruleset"), ok: ruleOk, detail: ruleOk ? `Ruleset "${pr!.name}" is active.` : ruleWhy },
    { id: "gantry_check", label: L("gantry_check"), ok: p.requiresGantryCheck && p.gantryCheckPinned, detail: !p.requiresGantryCheck ? "No active ruleset requires the Gantry check." : !p.gantryCheckPinned ? "The Gantry check is required but not pinned to the Gantry App." : "The Gantry check is required and pinned." },
    { id: "bypass", label: L("bypass"), ok: !p.appOnBypassList, detail: p.appOnBypassList ? "The Gantry App is on a bypass list. Remove it: Gantry must never be able to bypass the rules." : "The App is on no bypass list." },
  ];
}

export function judgeOwners(f: RepoFacts): ReadinessResult {
  const o = judgeCodeowners(f);
  return {
    id: "codeowners", label: READINESS_CHECKS.find((c) => c.id === "codeowners")!.label, ok: o.valid && !o.missing.length,
    detail: !o.path ? "There is no CODEOWNERS file." : o.valid && !o.missing.length ? `${o.path} is valid and covers CI config, itself and .gantry/.` : [...o.problems, ...o.missing.map((m) => `${m} has no owner`)].join("; "),
  };
}

/** Whether any configured runner variant has the toolchain for the repo and the repo does not need Docker. `toolchains` maps a variant name to the ecosystems it carries. */
export function judgeRunner(f: RepoFacts, toolchains: Record<string, string[]>): ReadinessResult {
  const label = READINESS_CHECKS.find((c) => c.id === "runner")!.label;
  const docker = needsDocker(f);
  if (docker) return { id: "runner", label, ok: false, detail: `The repo needs Docker (${docker}); the runner sandbox has none.` };
  const eco = ecosystems(f).filter((e) => e !== "unknown");
  const wanted = eco.length ? eco : ["unknown"];
  const hit = Object.entries(toolchains).find(([, have]) => wanted.every((e) => have.includes(e) || (e === "unknown")));
  return hit
    ? { id: "runner", label, ok: true, detail: `Variant ${hit[0]} carries ${wanted.join(", ")}.` }
    : { id: "runner", label, ok: false, detail: `No runner variant carries ${wanted.join(", ")}. Variants: ${Object.entries(toolchains).map(([k, v]) => `${k} (${v.join(", ")})`).join("; ") || "none"}.` };
}

/** Ready is lost only by a definite failure. A check that could not be made is not a failure, so a GitHub outage never halts a repo. */
export const readinessLost = (r: ReadinessResult[]): boolean => r.some((x) => !x.ok && !x.unknown);
export const readinessUnknown = (r: ReadinessResult[]): boolean => !readinessLost(r) && r.some((x) => x.unknown);

/* ------------------------------------------------------------------ canary results ---- */

/** What the broker's canary run reports (see the GitHub broker's `runCanary`). */
export interface CanaryFacts {
  published: boolean;
  draftOpened: boolean;
  closed: boolean;
  cleaned: boolean;
  checks: { name: string; status: string; conclusion: string | null; app: string | null }[];
  directPush: "rejected" | "accepted" | "unknown";
  directPushDetail: string;
  error: string | null;
}

/** The three live checks the canary answers (spec 11.3). A canary that could not run at all leaves them unknown, not failed. */
export function judgeCanary(c: CanaryFacts | null, why = "The canary could not run."): ReadinessResult[] {
  const L = (id: ReadinessId): string => READINESS_CHECKS.find((x) => x.id === id)!.label;
  if (!c) return (["canary", "canary_ci", "direct_push"] as const).map((id) => ({ id, label: L(id), ok: false, unknown: true, detail: why }));
  const prOk = c.published && c.draftOpened && c.closed;
  const ciOk = c.checks.length > 0;
  return [
    {
      id: "canary", label: L("canary"), ok: prOk,
      detail: prOk ? `Published, opened a draft pull request and closed it${c.cleaned ? "" : "; the canary branch could not be deleted"}.` : c.error ? `The canary failed: ${c.error}` : `Published: ${c.published}, draft opened: ${c.draftOpened}, closed: ${c.closed}.`,
    },
    prOk || c.published
      ? { id: "canary_ci", label: L("canary_ci"), ok: ciOk, detail: ciOk ? `CI reported ${c.checks.map((x) => x.name).join(", ")}.` : "CI reported no check on the canary branch. Check that the workflow runs on pull requests." }
      : { id: "canary_ci", label: L("canary_ci"), ok: false, unknown: true, detail: "No canary branch was published, so CI could not be observed." },
    c.directPush === "unknown"
      ? { id: "direct_push", label: L("direct_push"), ok: false, unknown: true, detail: c.directPushDetail || "The direct push gave no clear answer." }
      : { id: "direct_push", label: L("direct_push"), ok: c.directPush === "rejected", detail: c.directPushDetail },
  ];
}

/* ------------------------------------------------------------------ built-in guidelines ---- */

/** The factory guidelines a new install starts with (version 0 until the first save publishes version 1). Item ids gl-1 to gl-9 are the ones the checks name. */
export const DEFAULT_ORG_GUIDELINES: { items: GuidelineItem[]; may: string; mayNot: string } = {
  items: [
    { id: "gl-1", text: "CI runs on every PR and on main.", required: true },
    { id: "gl-2", text: "A single test command is documented in AGENTS.md.", required: true },
    { id: "gl-3", text: "main is protected: 1 review, status checks required.", required: true },
    { id: "gl-4", text: "CODEOWNERS covers every top-level directory.", required: false },
    { id: "gl-5", text: "Lint config is committed.", required: false },
    { id: "gl-6", text: "No secrets in history (secrets scan clean).", required: true },
    { id: "gl-7", text: "Build is reproducible from a clean checkout.", required: true },
    { id: "gl-8", text: "Dependency manifest with a lockfile.", required: true },
    { id: "gl-9", text: "MCP servers the repo needs are declared in .gantry/factory.yml.", required: false },
  ],
  may: "Guidance for the onboarding agent: it may propose whatever a repository needs to be ready, for example a project manifest and a smoke test for a new repository, a CI workflow, AGENTS.md, CODEOWNERS, .gantry/factory.yml, lint config, tool versions.",
  mayNot: "These need an explicit confirmation on the proposal: changes to existing application code or existing dependency versions, workflow files, ownership files. Branch protection and rulesets are GitHub settings; Gantry never changes them.",
};

/* ------------------------------------------------------------------ pull request checks ---- */

export interface ObservedCheck { name: string; status: string; conclusion: string | null; app?: string | null }
export type PrChecks = "pending" | "running" | "green" | "red" | "none";

const PASSED = new Set(["success", "neutral", "skipped"]);
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/**
 * The state of CI on a pull request head (spec 11.3 "PR checks"). `required` are the repo's required checks; with none configured every check that is not Gantry's own
 * gate counts. A required check that has not reported yet keeps the state at `running` once anything has reported, and `pending` while nothing has (`none` once the grace period has passed with nothing reported).
 */
export function prChecksState(required: string[], observed: ObservedCheck[], gateCheckName = "Gantry gates", o: { noneAfterGrace?: boolean } = {}): PrChecks {
  const seen = observed.filter((c) => c.name !== gateCheckName);
  // Nothing at all reported (no check run, no commit status) and the grace period is over: the repo has no CI. Not "pending" forever.
  if (!seen.length) return o.noneAfterGrace ? "none" : "pending";
  const counted = required.length ? seen.filter((c) => required.includes(c.name)) : seen;
  if (counted.some((c) => c.status === "completed" && c.conclusion && FAILED.has(c.conclusion))) return "red";
  const missing = required.filter((r) => !seen.some((c) => c.name === r));
  if (missing.length || counted.some((c) => c.status !== "completed")) return "running";
  return counted.length && counted.every((c) => c.conclusion && PASSED.has(c.conclusion)) ? "green" : "running";
}

/** Required guideline checks that are met on the repository as it is now. The checks that have their own live result (branch rules, code owners, Docker) are judged there. */
export function judgeGuidelines(findings: AssessedFinding[]): ReadinessResult {
  const own = new Set(["protect", "owners", "docker"]);
  const bad = findings.filter((x) => x.required && !x.ok && !own.has(x.id));
  return {
    id: "guidelines", label: READINESS_CHECKS.find((c) => c.id === "guidelines")!.label, ok: bad.length === 0,
    detail: bad.length ? `Not met: ${bad.map((x) => `${x.check} (${x.fix || x.detail})`).join("; ")}.` : "Every required guideline is met.",
  };
}
