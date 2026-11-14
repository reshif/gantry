/**
 * What the connector operations need from the process: the outbound HTTP client, the Slack API base, the platform SMTP relay and the GitHub broker.
 * Read from the environment on first use; tests replace parts with `configureRuntime`.
 */
import type { FastifyInstance } from "fastify";
import { httpFromEnv, type OutboundHttp } from "../notifications/http.js";
import { defaultSlackBase, type OpsEnv } from "./ops.js";

interface Overrides { http?: OutboundHttp; slackBase?: string; smtp?: OpsEnv["smtp"]; now?: () => number }
let overrides: Overrides = {};
let cachedHttp: OutboundHttp | null = null;

export function configureRuntime(o: Overrides): void {
  overrides = o;
}
export const resetRuntime = (): void => configureRuntime({});

export function opsEnv(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): OpsEnv {
  const g = app.gantry;
  cachedHttp ??= httpFromEnv(env);
  return {
    http: overrides.http ?? cachedHttp,
    now: overrides.now ?? Date.now,
    slackBase: overrides.slackBase ?? defaultSlackBase(env),
    broker: { url: g.config.brokerUrl, token: g.config.secrets.githubToken ?? null },
    smtp: overrides.smtp ?? { host: env.SMTP_HOST || null, port: Number(env.SMTP_PORT || 25) },
  };
}
