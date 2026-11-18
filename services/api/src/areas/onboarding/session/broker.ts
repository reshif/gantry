/** The API's read-only look at a repository through the GitHub broker (the same inspect the worker's assessment uses). Tests replace it. */
import { RepoFacts } from "@gantry/domain";

export type Inspected = { ok: true; facts: RepoFacts } | { ok: false; code: string; msg: string };
export type InspectFn = (repo: string, o: { scan: boolean }) => Promise<Inspected>;

let override: InspectFn | null = null;
export const configureSessionBroker = (fn: InspectFn): void => void (override = fn);
export const resetSessionBroker = (): void => void (override = null);

export function brokerInspect(cfg: { brokerUrl?: string | undefined; token: string }): InspectFn {
  return async (repo, o) => {
    if (override) return override(repo, o);
    if (!cfg.brokerUrl) return { ok: false, code: "no_broker", msg: "GitHub is not configured for this install." };
    try {
      const res = await fetch(`${cfg.brokerUrl}/v1/onboarding/inspect`, {
        method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ repo, ...(o.scan ? {} : { scan: false }) }), signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return { ok: false, code: String(body.code ?? "github"), msg: String(body.msg ?? `GitHub answered ${res.status}.`) };
      const p = RepoFacts.safeParse(body);
      return p.success ? { ok: true, facts: p.data } : { ok: false, code: "bad_facts", msg: "The broker's facts for the repository are malformed." };
    } catch (e) {
      return { ok: false, code: "github", msg: `The GitHub broker did not answer: ${(e as Error).message}` };
    }
  };
}

/** One file at a commit, read-only. `content` is null when the file is binary or too large. */
export type FileRead = { ok: true; path: string; size: number; binary: boolean; tooLarge: boolean; content: string | null } | { ok: false; code: string; msg: string };
export type ReadFileFn = (repo: string, sha: string, path: string) => Promise<FileRead>;

let fileOverride: ReadFileFn | null = null;
export const configureSessionFileReader = (fn: ReadFileFn): void => void (fileOverride = fn);
export const resetSessionFileReader = (): void => void (fileOverride = null);

/** The same broker and the same service token as `brokerInspect`: the broker reads the blob with its one-repository installation token. */
export function brokerReadFile(cfg: { brokerUrl?: string | undefined; token: string }): ReadFileFn {
  return async (repo, sha, path) => {
    if (fileOverride) return fileOverride(repo, sha, path);
    if (!cfg.brokerUrl) return { ok: false, code: "no_broker", msg: "GitHub is not configured for this install." };
    try {
      const res = await fetch(`${cfg.brokerUrl}/v1/onboarding/file`, {
        method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ repo, sha, path }), signal: AbortSignal.timeout(30_000),
      });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return { ok: false, code: String(b.code ?? "github"), msg: String(b.msg ?? `GitHub answered ${res.status}.`) };
      return { ok: true, path, size: Number(b.size ?? 0), binary: b.binary === true, tooLarge: b.tooLarge === true, content: typeof b.content === "string" ? b.content : null };
    } catch (e) {
      return { ok: false, code: "github", msg: `The GitHub broker did not answer: ${(e as Error).message}` };
    }
  };
}
