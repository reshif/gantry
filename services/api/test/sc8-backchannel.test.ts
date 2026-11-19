import http from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOidcAdapter } from "../src/core/oidc.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

d("S-72: OIDC back-channel logout ends the Gantry sessions of a person the identity provider signed out", () => {
  let t: TestApp;
  let idp: http.Server;
  let issuer = "";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const token = (claims: Record<string, unknown>, key = privateKey): string => {
    const head = b64({ alg: "RS256", kid: "k1", typ: "logout+jwt" });
    const body = b64({ iss: issuer, aud: "gantry-web", iat: Math.floor(Date.now() / 1000), jti: `j-${Math.random()}`, events: { "http://schemas.openid.net/event/backchannel-logout": {} }, ...claims });
    return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url")}`;
  };
  beforeAll(async () => {
    idp = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/.well-known/openid-configuration")) return void res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/certs`, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` }));
      if (req.url?.endsWith("/certs")) return void res.end(JSON.stringify({ keys: [jwk] }));
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}/realm`;
    const oidc = createOidcAdapter({ issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "s", githubIdpAlias: null }, { allowInsecure: true });
    t = await startApp({ build: { oidc } });
  });
  afterAll(async () => { await t.close(); await new Promise((r) => idp.close(r)); });
  const w = world(() => t);
  const post = (logout_token: string | undefined) => t.app.inject({ method: "POST", url: "/auth/backchannel-logout", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: logout_token === undefined ? "" : `logout_token=${encodeURIComponent(logout_token)}` });

  it("a valid logout token for a sid or a subject revokes the matching sessions; a forged or wrong one changes nothing", async () => {
    const s1 = await t.session("p-tomas");
    const s2 = await t.session("p-tomas");
    await t.db.admin.query(`update sessions set idp_sid = 'sid-1' where id = $1`, [s1.id]);
    await t.db.admin.query(`update people set idp_subject = 'kc-tomas' where id = 'p-tomas'`);
    const alive = async (id: string) => (await w.q(`select revoked_at from sessions where id = $1`, [id]))[0].revoked_at === null;
    expect((await post(undefined)).statusCode).toBe(400);
    expect((await post(token({ sid: "sid-1" }, other.privateKey))).statusCode, "wrong key").toBe(400);
    expect((await post(token({ sid: "sid-1", iss: "https://evil.example" }))).statusCode, "wrong issuer").toBe(400);
    expect((await post(token({ sid: "sid-1", aud: "other-client" }))).statusCode, "wrong audience").toBe(400);
    expect((await post(token({ sid: "sid-1", events: {} }))).statusCode, "not a logout event").toBe(400);
    expect((await post(token({ sid: "sid-1", nonce: "x" }))).statusCode, "nonce").toBe(400);
    expect((await post(token({ sid: "sid-1", iat: 1 }))).statusCode, "old").toBe(400);
    expect(await alive(s1.id) && await alive(s2.id)).toBe(true);
    const bySid = await post(token({ sid: "sid-1" }));
    expect(bySid.statusCode, bySid.body).toBe(200);
    expect(await alive(s1.id)).toBe(false);
    expect(await alive(s2.id), "only the named provider session ends").toBe(true);
    const bySub = await post(token({ sub: "kc-tomas" }));
    expect(bySub.statusCode, bySub.body).toBe(200);
    expect(await alive(s2.id)).toBe(false);
    expect((await w.events("auth.backchannel_logout")).length).toBe(2);
    const me = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: s2.headers });
    expect(me.statusCode).toBe(401);
  });
});
