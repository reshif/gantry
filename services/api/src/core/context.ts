import type { Decision, Person } from "@gantry/domain";
import type { EventChannel, Queryable } from "@gantry/db";
import type pg from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { Hub } from "./stream.js";
import type { OidcAdapter } from "./oidc.js";
import type { IdpAdmin } from "./auth/idp-admin.js";
import type { SecurityCache } from "./security.js";
import type { ApiSettingsCache } from "../areas/apikeys/config.js";
import type { loadPolicyState } from "./read/state.js";

/** Who is calling. People act through a session; API keys through a bearer; services through /internal/v1. */
export type Principal =
  | { kind: "person"; id: string; name: string; sessionId: string }
  | { kind: "apikey"; id: string; name: string; projectId: string | null; scopes: string[] }
  | { kind: "service"; id: "edge" | "github"; name: string };

export interface SessionInfo {
  id: string;
  personId: string;
  method: string;
  authTime: number | null;
  createdAt: number;
  expiresAt: number;
}

export type PolicyStateLoaded = Awaited<ReturnType<typeof loadPolicyState>>;

export interface RequestCtx {
  orgId: string;
  principal: Principal | null;
  session: SessionInfo | null;
  ip: string;
  requestId: string;
  channel: EventChannel;
  reply: FastifyReply;
  /** Per-request cache: policy state (spec 14.3 "cached per request"). */
  state?: Promise<PolicyStateLoaded>;
  person?: Promise<Person | null>;
  /** Set by the read gate: this person reads a list endpoint through its project directory view (core/directory.ts). */
  directory?: boolean;
}

export interface Gantry {
  pool: pg.Pool;
  config: Config;
  orgId: string;
  hub: Hub;
  oidc: OidcAdapter;
  /** The identity provider admin API (scoped service account), or null when its secret is not provided. */
  idpAdmin: IdpAdmin | null;
  security: SecurityCache;
  /** The public API settings (rate limit, idempotency window, triggers master switch), cached for a few seconds. */
  apiSettings: ApiSettingsCache;
  /** SSE heartbeat interval in ms (15 s; tests shorten it). */
  heartbeatMs: number;
}

declare module "fastify" {
  interface FastifyInstance {
    gantry: Gantry;
  }
  interface FastifyRequest {
    gx: RequestCtx;
  }
}

export type Db = Queryable;
export type { Decision, FastifyInstance, FastifyReply, FastifyRequest };
