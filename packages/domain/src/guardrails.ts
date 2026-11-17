/**
 * Guardrails enforced in code (spec 13.3): the paths an agent must never modify, the repository's protected paths and the largest diff an agent
 * may deliver. The system prompt tells the agent about them; this is what actually checks the observed change, so a prompt-injected agent that
 * ignores its instructions still cannot slip a forbidden path through. Matching is case-insensitive (a checkout on a case-insensitive
 * filesystem must not turn `.GitHub/workflows` into a bypass).
 */

const cache = new Map<string, RegExp>();

/** A glob: `**` crosses directories, `*` and `?` stay inside one. A pattern with no slash matches at any depth; one with no glob characters matches the path itself and everything under it. */
export function pathMatches(path: string, pattern: string): boolean {
  const p = path.replace(/^\.?\/+/, "").toLowerCase();
  const rooted = /^\.?\/+/.test(pattern.trim());
  let g = pattern.trim().replace(/^\.?\/+/, "").toLowerCase();
  if (!g) return false;
  const dir = g.endsWith("/");
  if (dir) g = g.slice(0, -1);
  if (!g) return false;
  // Gitignore style: a pattern with no slash matches at any depth (`.env`, `*.pem`, `package.json`).
  if (!rooted && !g.includes("/") && !g.startsWith("**")) g = `**/${g}`;
  let re = cache.get(g);
  if (!re) {
    let src = "";
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!;
      if (c === "*") {
        if (g[i + 1] === "*") {
          i++;
          if (g[i + 1] === "/") {
            i++;
            src += "(?:.*/)?";
          } else src += ".*";
        } else src += "[^/]*";
      } else if (c === "?") src += "[^/]";
      else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    // The path itself or anything beneath it (a directory name guards its whole tree).
    re = new RegExp(`^${src}(?:/.*)?$`);
    cache.set(g, re);
  }
  return re.test(p);
}

export interface GuardrailFinding {
  /** Lines changed (additions + deletions) over every file. */
  size: number;
  /** The diff is larger than the agent's `maxDiff` (0 means no limit). */
  over: boolean;
  /** Files matching the agent's own forbidden paths. */
  forbiddenTouched: string[];
  /** Files matching the repository's protected paths. */
  protectedTouched: string[];
}

export function evaluateGuardrails(files: ReadonlyArray<{ path: string; additions?: number; deletions?: number; plus?: number; minus?: number }>, g: { forbidden?: readonly string[]; protectedPaths?: readonly string[]; maxDiff?: number }): GuardrailFinding {
  const hit = (pats: readonly string[] | undefined): string[] => (pats?.length ? [...new Set(files.filter((f) => pats.some((p) => pathMatches(f.path, p))).map((f) => f.path))] : []);
  const size = files.reduce((a, f) => a + (Number(f.additions ?? f.plus) || 0) + (Number(f.deletions ?? f.minus) || 0), 0);
  return { size, over: !!g.maxDiff && g.maxDiff > 0 && size > g.maxDiff, forbiddenTouched: hit(g.forbidden), protectedTouched: hit(g.protectedPaths) };
}
