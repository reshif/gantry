#!/usr/bin/env node
// Registers the Gantry GitHub App from a manifest and writes its credentials into the secrets directory (spec 11.1).
//
//   node deploy/secrets/create-github-app.mjs --org my-org            # App owned by an organisation (recommended, spec 11.1)
//   node deploy/secrets/create-github-app.mjs                         # App owned by your personal account
//   node deploy/secrets/create-github-app.mjs --org my-org --host https://ghe.example.com   # GitHub Enterprise Server
//
// Flow (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
//   1. Opens http://localhost:<port>/ which posts the manifest to GitHub; you confirm the App name there.
//   2. GitHub redirects back with a one-time code; the script exchanges it for the App id, private key and webhook secret.
//   3. Your browser is sent on to install the App on selected repositories; GitHub redirects back with the installation id.
//   4. github_app.pem and github_app.json are written, then: docker compose -f deploy/compose.yml restart gantry-github
//
// Options:
//   --org <login>          Organisation that owns the App (omit for a personal account)
//   --name <name>          App name, must be unique on GitHub (default: gantry-<org or "local">-<random>)
//   --host <url>           GitHub web URL (default https://github.com); the API URL is derived (GHES: <host>/api/v3)
//   --port <n>             Local callback port (default 3456)
//   --webhook-url <url>    Public URL that reaches POST /hooks/github. Omitted: the App gets no webhook (GitHub refuses
//                          localhost URLs); gantry-github polls instead (spec 11.6). Add one later in the App settings.
//   --force                Overwrite non-placeholder github_app.pem / github_app.json
//
// Secrets directory: $GANTRY_SECRETS_DIR, else this script's directory. Nothing is sent anywhere except GitHub.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const host = (args.host ?? "https://github.com").replace(/\/+$/, "");
const apiUrl = host === "https://github.com" ? "https://api.github.com" : `${host}/api/v3`;
const port = Number(args.port ?? 3456);
const org = args.org;
const name = args.name ?? `gantry-${org ?? "local"}-${randomBytes(3).toString("hex")}`;
const dir = process.env.GANTRY_SECRETS_DIR || dirname(fileURLToPath(import.meta.url));
const mode = parseInt(process.env.GANTRY_SECRETS_MODE ?? "0644", 8); // same rule as generate.sh: containers run as other uids
const pemPath = join(dir, "github_app.pem");
const jsonPath = join(dir, "github_app.json");
const base = `http://localhost:${port}`;
const state = randomBytes(16).toString("hex");

if (!args.force) {
  const realPem = existsSync(pemPath) && readFileSync(pemPath, "utf8").includes("BEGIN");
  const realJson = existsSync(jsonPath) && !readFileSync(jsonPath, "utf8").includes("_placeholder");
  if (realPem || realJson) die(`${realPem ? pemPath : jsonPath} already holds real credentials. Re-run with --force to replace them.`);
}

// Spec 11.1: Metadata read; Contents, Pull requests, Issues, Checks write; Actions, Commit statuses, Administration read.
// Never requested: Administration write, Secrets, organisation administration. Workflows write is added by hand only if needed.
const manifest = {
  name,
  url: "https://localhost",
  description: "Gantry software factory: clones, publishes commits, opens pull requests, sets the Gantry gate check.",
  public: false,
  redirect_url: `${base}/callback`,
  setup_url: `${base}/installed`,
  setup_on_update: false,
  // GitHub rejects a hook URL it cannot reach (even inactive), so without --webhook-url the App has no webhook at all.
  ...(args["webhook-url"] ? { hook_attributes: { url: args["webhook-url"], active: true } } : {}),
  default_permissions: {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "write",
    actions: "read",
    statuses: "read",
    administration: "read",
  },
  // Events handled by services/api/src/areas/github and areas/triggers. GitHub requires a hook URL for any subscribed event,
  // so without --webhook-url the App subscribes to none and gantry-github polls (spec 11.6).
  ...(args["webhook-url"] ? { default_events: ["pull_request", "pull_request_review", "check_run", "check_suite", "issues", "issue_comment", "workflow_run"] } : {}),
};

const newAppUrl = org ? `${host}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${host}/settings/apps/new`;
let app = null; // conversion result
let finished = false;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", base);
  try {
    if (url.pathname === "/") return html(res, startPage());
    if (url.pathname === "/callback") {
      if (url.searchParams.get("state") !== state) return html(res, page("State mismatch", "<p>This callback did not come from the form this script served. Start again.</p>"), 400);
      const code = url.searchParams.get("code");
      if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) return html(res, page("No code", "<p>GitHub did not return a code.</p>"), 400);
      const r = await fetch(`${apiUrl}/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gantry-setup" },
      });
      if (!r.ok) return html(res, page("Conversion failed", `<p>GitHub answered ${r.status}: <code>${esc(await r.text())}</code></p>`), 502);
      app = await r.json();
      writeSecrets(undefined);
      log(`App created: ${app.html_url} (id ${app.id}). Credentials written; waiting for installation...`);
      res.writeHead(302, { Location: `${app.html_url}/installations/new` });
      return res.end();
    }
    if (url.pathname === "/installed") {
      const inst = url.searchParams.get("installation_id");
      if (!app) return html(res, page("Out of order", "<p>No App was created in this session.</p>"), 400);
      if (!inst || !/^\d+$/.test(inst)) return html(res, page("No installation", "<p>GitHub did not return an installation id. Install the App, then add <code>installationId</code> to github_app.json by hand.</p>"), 400);
      writeSecrets(Number(inst));
      log(`Installed: installation id ${inst}. Wrote ${jsonPath}`);
      html(res, page("Gantry GitHub App ready", `<p>App <b>${esc(app.slug)}</b> (id ${app.id}) is installed (installation ${inst}).</p>
        <p>Credentials are in <code>${esc(dir)}</code>. Restart the broker:</p><pre>docker compose -f deploy/compose.yml restart gantry-github</pre>
        <p>The webhook secret is in github_app.json as <code>webhookSecret</code>; enter it on the GitHub integration in Gantry if you enable webhooks.</p><p>You can close this tab.</p>`));
      finished = true;
      setTimeout(() => { server.close(); process.exit(0); }, 300);
      return;
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error(e);
    html(res, page("Error", `<pre>${esc(String(e?.stack ?? e))}</pre>`), 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  log(`Creating GitHub App "${name}" on ${org ? `organisation ${org}` : "your personal account"} at ${host}`);
  log(`Open ${base}/ if the browser does not open by itself.`);
  openBrowser(`${base}/`);
});
process.on("SIGINT", () => {
  if (app && !finished) log(`Stopped before installation. github_app.json has appId ${app.id} but no installationId; install from ${app.html_url}/installations/new and add it by hand.`);
  process.exit(130);
});

function writeSecrets(installationId) {
  atomicWrite(pemPath, app.pem.endsWith("\n") ? app.pem : `${app.pem}\n`);
  const settings = {
    appId: app.id,
    ...(apiUrl !== "https://api.github.com" ? { baseUrl: apiUrl } : {}),
    ...(installationId ? { installationId } : {}),
    // Not read by gantry-github (the API keeps webhook secrets per integration); kept here so it is not lost.
    slug: app.slug,
    webhookSecret: app.webhook_secret,
  };
  atomicWrite(jsonPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function startPage() {
  return page("Create the Gantry GitHub App", `
    <p>This sends the manifest below to <b>${esc(newAppUrl)}</b>. GitHub asks you to confirm the name, then returns here.</p>
    <form id="f" method="post" action="${esc(newAppUrl)}?state=${state}">
      <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
      <button type="submit">Create GitHub App</button>
    </form>
    <details><summary>Manifest</summary><pre>${esc(JSON.stringify(manifest, null, 2))}</pre></details>`);
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
  <style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}pre{background:#f4f4f4;padding:.75rem;overflow:auto}button{font-size:1rem;padding:.5rem 1rem}</style>
  <h1>${esc(title)}</h1>${body}`;
}

function html(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function openBrowser(u) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(cmd, [u], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* print-only fallback */ }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0].replace(/^#!.*\n/, "").replace(/^\/\/ ?/gm, "")); process.exit(0); }
    if (a === "--force") { out.force = true; continue; }
    if (!a.startsWith("--") || i + 1 >= argv.length) die(`unknown or incomplete option: ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

function log(m) { console.log(`[github-app] ${m}`); }
function die(m) { console.error(`[github-app] ${m}`); process.exit(1); }
