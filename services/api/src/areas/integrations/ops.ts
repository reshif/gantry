/**
 * Connector operations: test and health (spec 12.1). Each makes the real call: Slack `auth.test`, an SMTP handshake, a signed ping to a webhook, the GitHub
 * broker's installation listing. Outbound chat and webhook traffic goes through the egress proxy (`httpFromEnv`). Nothing here is simulated.
 */
import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import type { IntegrationType } from "@gantry/domain";
import { NetworkError, type OutboundHttp } from "../notifications/http.js";
import { SLACK_API, slackAuthTest } from "../notifications/slack.js";
import type { SecretSet } from "./secrets.js";

export interface TestResult {
  ok: boolean;
  ms: number;
  /** One line per check: `ok` or `fail`, and what happened. */
  lines: Array<["ok" | "fail", string]>;
}

export interface OpsEnv {
  http: OutboundHttp;
  now: () => number;
  /** Slack API base (tests point it at a double). */
  slackBase: string;
  /** GitHub broker (`GITHUB_BROKER_URL`) and its service token. */
  broker: { url: string | undefined; token: string | null };
  /** The platform SMTP relay (`SMTP_HOST`, `SMTP_PORT`) used when an email instance names no host. */
  smtp: { host: string | null; port: number };
}

export interface Candidate {
  type: Pick<IntegrationType, "id" | "name" | "fields" | "destination" | "source" | "actions" | "events" | "auth">;
  config: Record<string, unknown>;
  secrets: SecretSet;
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** The signature a receiver verifies: `t=<unix>,v1=<hmac_sha256(secret, "<t>.<body>")>`. */
export const signBody = (secret: string, body: string, t: number): string => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

/** The endpoint URL and signing secret of a webhook-like type: its first `url` field and first `secret` field. */
export function endpointOf(c: Candidate): { url: string | null; secret: string | null } {
  const u = c.type.fields.find((f) => f.type === "url");
  const s = c.type.fields.find((f) => f.type === "secret");
  const url = u && typeof c.config[u.key] === "string" ? (c.config[u.key] as string) : null;
  return { url, secret: s ? c.secrets[s.key] ?? null : null };
}

export async function testConnector(env: OpsEnv, c: Candidate): Promise<TestResult> {
  const t0 = env.now();
  const lines: TestResult["lines"] = [];
  const finish = (ok: boolean): TestResult => ({ ok, ms: Math.max(1, env.now() - t0), lines });
  const fail = (m: string): TestResult => {
    lines.push(["fail", m]);
    return finish(false);
  };
  try {
    switch (c.type.id) {
      case "slack": {
        const token = c.secrets.botToken;
        if (!token) return fail("The bot token is missing.");
        const r = await slackAuthTest(env.http, token, env.slackBase);
        if (!r.ok) return fail(`Slack refused the bot token: ${r.error ?? "unknown error"}.`);
        lines.push(["ok", `Reached ${hostOf(env.slackBase)}.`]);
        lines.push(["ok", `Authenticated as ${String(r.data.user ?? "the bot")} in ${String(r.data.team ?? "the workspace")}.`]);
        if (!c.secrets.signingSecret) lines.push(["fail", "No signing secret: button clicks and slash commands will be refused."]);
        else lines.push(["ok", "A signing secret is set, so clicks and slash commands can be verified."]);
        return finish(!!c.secrets.signingSecret);
      }
      case "email": {
        const host = (typeof c.config.smtpHost === "string" && c.config.smtpHost.trim()) || env.smtp.host;
        if (!host) return fail("No SMTP host: set one here or configure the platform relay (SMTP_HOST).");
        const port = Number(c.config.smtpPort || env.smtp.port || 25);
        const user = typeof c.config.smtpUser === "string" ? c.config.smtpUser : "";
        const transport = nodemailer.createTransport({
          host, port, secure: port === 465, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10_000,
          ...(user ? { auth: { user, pass: c.secrets.smtpPassword ?? "" } } : {}),
        });
        try {
          await transport.verify();
        } catch (e) {
          return fail(`SMTP ${host}:${port} did not accept the connection: ${(e as Error).message}.`);
        } finally {
          transport.close();
        }
        lines.push(["ok", `Connected to ${host}:${port}.`]);
        if (user) lines.push(["ok", `Authenticated as ${user}.`]);
        return finish(true);
      }
      case "github": {
        if (!env.broker.url) return fail("The GitHub broker is not configured for this install.");
        const res = await env.http.request({ method: "GET", url: `${env.broker.url}/v1/installation/repos`, headers: { authorization: `Bearer ${env.broker.token ?? ""}` }, timeoutMs: 20_000 }).catch((e: unknown) => ({ status: 0, body: String((e as Error).message) }));
        let body: { repos?: unknown[]; msg?: string } = {};
        try {
          body = JSON.parse(res.body) as typeof body;
        } catch {
          /* judged by the status */
        }
        if (res.status !== 200 || !Array.isArray(body.repos)) return fail(`The GitHub broker answered ${res.status || "nothing"}${body.msg ? `: ${body.msg}` : res.status === 0 ? `: ${res.body}` : ""}.`);
        lines.push(["ok", "Reached the GitHub broker."]);
        lines.push(["ok", `The App can see ${body.repos.length} repositor${body.repos.length === 1 ? "y" : "ies"}.`]);
        if (!c.secrets.webhookSecret) lines.push(["fail", "No webhook secret: GitHub deliveries will be refused."]);
        else lines.push(["ok", "A webhook secret is set."]);
        return finish(!!c.secrets.webhookSecret);
      }
      default: {
        if (!c.type.destination) {
          // A source-only custom type receives signed deliveries; there is nothing to call.
          const has = c.type.fields.some((f) => f.type === "secret") ? Object.values(c.secrets).some(Boolean) : true;
          lines.push([has ? "ok" : "fail", has ? "Receives signed deliveries; send one to test it." : "No signing secret set."]);
          return finish(has);
        }
        const { url, secret } = endpointOf(c);
        if (!url) return fail("The endpoint URL is missing.");
        const body = JSON.stringify({ event: "gantry.ping", at: new Date(env.now()).toISOString(), integration: c.type.id });
        const t = Math.floor(env.now() / 1000);
        const res = await env.http.request({
          method: "POST", url, body, timeoutMs: 10_000,
          headers: { "content-type": "application/json", "user-agent": "gantry", "x-gantry-event": "gantry.ping", ...(secret ? { "x-gantry-signature": signBody(secret, body, t) } : {}) },
        });
        lines.push(["ok", `Reached ${hostOf(url)}.`]);
        if (res.status < 200 || res.status >= 300) return fail(`${hostOf(url)} answered HTTP ${res.status}.`);
        lines.push(["ok", `Answered HTTP ${res.status}${secret ? " to a signed ping" : ""}.`]);
        return finish(true);
      }
    }
  } catch (e) {
    return fail(e instanceof NetworkError ? e.message : `The test failed: ${(e as Error).message}`);
  }
}

export const defaultSlackBase = (env: NodeJS.ProcessEnv = process.env): string => env.GANTRY_SLACK_API || SLACK_API;
