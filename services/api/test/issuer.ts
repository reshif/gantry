import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface IssuerClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  gantry_id?: string;
  gantry_title?: string;
  auth_time?: number;
  [k: string]: unknown;
}

interface Code {
  nonce: string;
  challenge: string;
  redirectUri: string;
  claims: IssuerClaims;
}

/** A small local OpenID provider: discovery, JWKS and a token endpoint that checks the PKCE verifier and client secret and signs an RS256 ID token. */
export async function startIssuer(clientId: string, clientSecret: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, Code>();
  let base = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, end_session_endpoint: `${base}/logout`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const f = new URLSearchParams(raw);
        const c = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        const ok =
          c && f.get("client_secret") === clientSecret && f.get("client_id") === clientId && f.get("redirect_uri") === c.redirectUri &&
          createHash("sha256").update(verifier).digest("base64url") === c.challenge;
        if (!ok) return json(400, { error: "invalid_grant" });
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({ ...c.claims, nonce: c.nonce })
          .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(base).setAudience(clientId).setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
        return json(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer: base,
    /** Plays the browser at the provider: takes the authorization URL the API redirected to and returns the callback URL (path and query) with a code. */
    authorize(authUrl: string, claims: IssuerClaims, o: { state?: string } = {}): string {
      const u = new URL(authUrl);
      const code = randomBytes(12).toString("hex");
      codes.set(code, { nonce: u.searchParams.get("nonce")!, challenge: u.searchParams.get("code_challenge")!, redirectUri: u.searchParams.get("redirect_uri")!, claims });
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("code", code);
      cb.searchParams.set("state", o.state ?? u.searchParams.get("state")!);
      cb.searchParams.set("iss", base);
      return cb.pathname + cb.search;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
