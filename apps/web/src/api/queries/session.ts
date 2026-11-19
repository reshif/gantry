/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError, get, setCsrfToken } from "../client";
import { qk } from "../keys";
import { readIfAllowed } from "../can";
import { noteUnauthorized } from "../../lib/session/session";
import type { Me, Page, PublicConfig, SecuritySettings, Session, SignIn } from "../types";

const SECURITY = ["security.manage", "policy.view"] as const;

/* ---------- session ---------- */

export type MeState = { status: "in"; me: Me } | { status: "out"; config: PublicConfig | null; reason: string; needs?: string };

/** GET /api/v1/me. A 401 is a normal answer (nobody signed in), not an error; its body may carry the public config. */
export async function fetchMe(): Promise<MeState> {
  const res = await fetch(api("me"), { credentials: "include", headers: { Accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401) {
    noteUnauthorized(); // an expiry found by a /me refetch alone is still an expiry (drafts and layout choices are kept)
    setCsrfToken(null);
    const b = (body ?? {}) as { config?: PublicConfig; msg?: string; needs?: string };
    return { status: "out", config: b.config ?? null, reason: b.msg ?? "", ...(b.needs ? { needs: b.needs } : {}) };
  }
  if (!res.ok) throw new ApiError(res.status, "Could not load your session.", body);
  const me = body as Me;
  setCsrfToken(typeof me.csrf === "string" ? me.csrf : null);
  return { status: "in", me };
}

export const useMeState = (): UseQueryResult<MeState> =>
  useQuery({ queryKey: qk.me(), queryFn: fetchMe, staleTime: 30_000, retry: 1, refetchOnWindowFocus: true });

/** The signed-in session, or null while loading or signed out. */
export function useMe(): Me | null {
  const q = useMeState();
  return q.data?.status === "in" ? q.data.me : null;
}

/** `all`: everyone's sessions (Security screen); the server returns only the caller's own without security.manage. */
export const useSessions = (o: { all?: boolean } = {}) =>
  useQuery({ queryKey: o.all ? qk.sessionsAll() : qk.sessions(), queryFn: () => get<Session[]>(api("sessions"), o.all ? { all: "1" } : undefined) });
export const useSecurity = () => useQuery({ queryKey: qk.security(), queryFn: () => readIfAllowed(SECURITY, () => get<SecuritySettings>(api("security"))) });
export const useSignins = (q: { cursor?: string; limit?: number; all?: "1" } = {}) =>
  useQuery({ queryKey: qk.signinsList(q), queryFn: () => get<SignIn[] | Page<SignIn>>(api("signins"), q) });
