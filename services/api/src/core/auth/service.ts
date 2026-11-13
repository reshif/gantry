import { safeEqual } from "../crypto.js";

/** Which internal service a bearer token belongs to. Both comparisons always run (constant time). */
export function authenticateService(bearer: string, tokens: { edgeToken: string; githubToken: string }): "edge" | "github" | null {
  const e = safeEqual(bearer, tokens.edgeToken);
  const g = safeEqual(bearer, tokens.githubToken);
  return e ? "edge" : g ? "github" : null;
}
