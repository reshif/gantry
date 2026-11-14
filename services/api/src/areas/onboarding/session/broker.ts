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
