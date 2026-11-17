/** Sign-in that comes back to the same screen: the hash route travels as `return_to` (same shape the step-up sign-in uses). */
import { loginUrl } from "../../api/ops";

/** "/#record/wo-1" for the page the person is on, or null at the root (nothing to return to). Only a hash route is ever sent. */
export function currentReturnTo(hash: string = typeof window === "undefined" ? "" : window.location.hash): string | null {
  if (hash.length <= 1) return null;
  return `/${hash.startsWith("#") ? hash : `#${hash}`}`;
}

export function loginUrlWithReturn(method: "sso" | "github", loginHint?: string, hash?: string): string {
  const base = loginUrl(method, loginHint);
  const rt = currentReturnTo(hash);
  return rt ? `${base}&return_to=${encodeURIComponent(rt)}` : base;
}
