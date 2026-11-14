// TEST/SANDBOX ONLY: a standalone fake GitHub for the compose end-to-end run. Never part of deploy/compose.yml.
// Serves, on one port (default 8090):
//   /api/v3/*            the fake REST/git-data/checks/GraphQL surface from ../fake-github.ts (GitHub Enterprise Server layout)
//   /<owner>/<repo>.git  git smart HTTP (upload-pack) for the seed clone, backed by a real bare repository created at start
//   /_fake/state         JSON: pulls, check runs, refs, request log (for assertions)
//   /_fake/review        POST {number, user, state:"APPROVED"} adds a review (not used by the Gantry-gate E2E)
// Needs git on PATH and `node --experimental-strip-types` semantics (Node >= 22.18 strips types by default).
import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGithub } from "../fake-github.ts";

const PORT = Number(process.env.FAKE_GITHUB_PORT ?? 8090);
const REPO = process.env.FAKE_GITHUB_REPO ?? "acme/payments-api";
const root = mkdtempSync(join(tmpdir(), "fake-gh-"));
const FIXED = "2026-01-01T00:00:00Z"; // fixed dates: the seed commit id is the same on every start
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: FIXED, GIT_COMMITTER_DATE: FIXED } }).trim();

const files = {
  "README.md": "# payments-api\n\nSeed repository for the Gantry end-to-end run.\n",
  "src/index.js": "export const hello = () => 'hello';\n",
  "package.json": '{"name":"payments-api","version":"0.0.0","type":"module"}\n',
};
const work = join(root, "work");
mkdirSync(work, { recursive: true });
git(work, "init", "-q", "-b", "main");
for (const [p, c] of Object.entries(files)) { mkdirSync(join(work, p, ".."), { recursive: true }); writeFileSync(join(work, p), c); }
git(work, "add", "-A"); git(work, "commit", "-q", "-m", "seed");
const head = git(work, "rev-parse", "HEAD");
const barePath = join(root, "srv", `${REPO}.git`);
mkdirSync(join(root, "srv", REPO.split("/")[0]), { recursive: true });
git(work, "clone", "-q", "--bare", work, barePath);
git(barePath, "config", "uploadpack.allowAnySHA1InWant", "true");
git(barePath, "config", "uploadpack.allowReachableSHA1InWant", "true");

const written = new Set();
const gh = new FakeGithub();
const TLS = existsSync("/certs/tls.key"); // GitHub Enterprise Server is https-only for the broker's git (protocol.allow=never, https=always)
gh.url = `${TLS ? "https" : "http"}://fake-github:${PORT}/api/v3`;
const tree = gh.registerCommit(head, files);
if (tree !== git(work, "rev-parse", "HEAD^{tree}")) throw new Error("fake tree hash differs from git");
gh.setRef("refs/heads/main", head);
written.add(head);

// Objects the broker creates through the REST git-data API live in the fake's in-memory model; real git clients (the seed of the next station) fetch them from the
// bare repository, so mirror them there before serving. Ids are identical because the fake hashes exactly like git.
function gitIn(input, ...a) { return execFileSync("git", ["-C", barePath, ...a], { input, encoding: "utf8" }).trim(); }
function writeTree(flat, prefix = "") {
  const entries = new Map();
  for (const [p, e] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length), i = rest.indexOf("/");
    if (i < 0) entries.set(rest, `${e.mode} ${e.type} ${e.sha}\t${rest}`);
    else if (!entries.has(rest.slice(0, i))) entries.set(rest.slice(0, i), `40000 tree ${writeTree(flat, `${prefix}${rest.slice(0, i)}/`)}\t${rest.slice(0, i)}`);
  }
  return gitIn([...entries.values()].join("\n") + "\n", "mktree");
}
function syncBare() {
  for (const [sha, b] of gh.blobs) if (!written.has(sha)) { gitIn(b, "hash-object", "-w", "--stdin"); written.add(sha); }
  const order = [];
  const visit = (sha) => { if (written.has(sha) || !gh.commits.has(sha)) return; for (const p of gh.commits.get(sha).parents) visit(p); order.push(sha); written.add(sha); };
  for (const sha of gh.commits.keys()) visit(sha);
  for (const sha of order) {
    const c = gh.commits.get(sha);
    const flat = gh.trees.get(c.tree);
    const tree = writeTree(flat);
    if (tree !== c.tree) throw new Error(`tree mismatch ${tree} != ${c.tree}`);
    const text = `tree ${c.tree}\n${c.parents.map((p) => `parent ${p}\n`).join("")}author Gantry App <app@example.com> 1700000000 +0000\ncommitter Gantry App <app@example.com> 1700000000 +0000\n\n${c.message}`;
    const got = gitIn(text, "hash-object", "-t", "commit", "-w", "--stdin");
    if (got !== sha) throw new Error(`commit mismatch ${got} != ${sha}`);
  }
  for (const [ref, sha] of gh.refs) if (/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(ref) && gh.commits.has(sha)) gitIn(undefined, "update-ref", ref, sha);
}

function smartHttp(req, res, url) {
  try { syncBare(); } catch (e) { console.error("syncBare", e.message); }
  const m = /^\/(.+?\.git)\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
  if (!m || `/${m[1]}` !== `/${REPO}.git`) { res.statusCode = 404; return res.end("not found"); }
  const proto = String(req.headers["git-protocol"] ?? "");
  const env = { ...process.env, GIT_PROTOCOL: proto };
  if (m[2] === "info/refs") {
    if (url.searchParams.get("service") !== "git-upload-pack") { res.statusCode = 403; return res.end("only upload-pack"); }
    res.setHeader("content-type", "application/x-git-upload-pack-advertisement");
    res.setHeader("cache-control", "no-cache");
    if (!proto.includes("version=2")) { const l = "# service=git-upload-pack\n"; res.write((l.length + 4).toString(16).padStart(4, "0") + l + "0000"); }
    const p = spawn("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", barePath], { env });
    p.stdout.pipe(res); p.on("error", () => res.end());
    return;
  }
  res.setHeader("content-type", "application/x-git-upload-pack-result");
  res.setHeader("cache-control", "no-cache");
  const p = spawn("git", ["upload-pack", "--stateless-rpc", barePath], { env });
  req.pipe(p.stdin); p.stdout.pipe(res); p.on("error", () => res.end());
}

const handler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") { res.end("ok"); return; }
  if (url.pathname === "/_fake/state") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ head, pulls: gh.pulls, checkRuns: gh.checkRuns, refs: [...gh.refs], requests: gh.requests.map((r) => ({ method: r.method, path: r.path })) }));
    return;
  }
  if (url.pathname.startsWith("/api/v3/")) {
    const rm = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/|$)/.exec(url.pathname);
    if (rm && `${rm[1]}/${rm[2]}` !== REPO) { // only one repository is installed: every other one is invisible, as on GitHub
      res.statusCode = 404; res.setHeader("content-type", "application/json"); gh.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body: undefined, auth: "" }); return res.end(JSON.stringify({ message: "Not Found" }));
    }
    req.url = url.pathname.slice("/api/v3".length) + url.search;
    return gh.handle(req, res);
  }
  if (url.pathname.endsWith(".git/info/refs") || url.pathname.endsWith(".git/git-upload-pack")) return smartHttp(req, res, url);
  res.statusCode = 404; res.end("not found");
};
(TLS ? createHttps({ key: readFileSync("/certs/tls.key"), cert: readFileSync("/certs/tls.crt") }, handler) : createHttp(handler)).listen(PORT, "0.0.0.0", () => console.log(`fake github on :${PORT} (${TLS ? "https" : "http"}), repo ${REPO} at ${head}`));
