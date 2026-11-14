/**
 * A fake GitHub HTTP API for tests (test/ only, never wired into the product): enough of the REST, git-data, checks and GraphQL surface for the broker.
 * It keeps a real git object model (blob, tree and commit ids are real git hashes), so tests can compare what the broker created with what git computes locally.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface Recorded { method: string; path: string; query: URLSearchParams; body: any; auth: string }

const sha1 = (b: Buffer | string): string => createHash("sha1").update(b).digest("hex");
const gitObj = (type: string, body: Buffer): string => sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));

interface Entry { mode: string; type: "blob" | "commit"; sha: string }
type Flat = Map<string, Entry>;

/** Real git tree hashing over a flat path->entry map. */
function treeSha(flat: Flat, prefix = ""): string {
  const names = new Map<string, Entry | "dir">();
  for (const [p, e] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf("/");
    if (i < 0) names.set(rest, e); else names.set(rest.slice(0, i), "dir");
  }
  const sorted = [...names.entries()].sort(([a, x], [b, y]) => { const ka = Buffer.from(x === "dir" ? `${a}/` : a), kb = Buffer.from(y === "dir" ? `${b}/` : b); return Buffer.compare(ka, kb); });
  const parts: Buffer[] = [];
  for (const [n, e] of sorted) {
    const [mode, sha] = e === "dir" ? ["40000", treeSha(flat, `${prefix}${n}/`)] : [e.mode, e.sha];
    parts.push(Buffer.from(`${mode} ${n}\0`), Buffer.from(sha, "hex"));
  }
  return gitObj("tree", Buffer.concat(parts));
}

export interface FakePr { number: number; id: number; node_id: string; title: string; body: string | null; state: "open" | "closed"; draft: boolean; head: { sha: string; ref: string }; base: { ref: string }; merged_at: string | null; merge_commit_sha: string | null; html_url: string; user: { login: string }; labels: { name: string }[]; mergeable: boolean; mergeable_state: string }

export class FakeGithub {
  readonly requests: Recorded[] = [];
  server!: Server;
  url = "";
  readonly appPermissions: Record<string, string> = { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "write", actions: "read", statuses: "read", administration: "read" };
  readonly tokens = new Map<string, { repos: string[]; permissions: Record<string, string>; revoked: boolean }>();
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, Flat>();
  readonly commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  readonly refs = new Map<string, string>();
  readonly pulls: FakePr[] = [];
  readonly reviews = new Map<number, any[]>();
  readonly checkRuns: any[] = [];
  readonly issues: any[] = [];
  readonly deliveries: any[] = [];
  rulesets: any[] = [];
  protection: any = null;
  defaultBranch = "main";
  language: string | null = "TypeScript";
  archived = false;
  /** Refs the rules protect: a PATCH to them is refused the way GitHub refuses a push that breaks a ruleset. */
  protectedRefs = new Set<string>();
  installationTargetType = "Organization";
  /** Repositories the App is not installed on: the installation lookup answers 404. */
  uninstalled = new Set<string>();
  installedRepos: { full_name: string; language: string | null; private: boolean; archived: boolean; default_branch: string }[] = [];
  /** Check runs the "CI" adds to a pushed head after `ciDelayRequests` further requests (0: immediately, -1: never). */
  ciOnPush: { name: string; conclusion: string } | null = null;
  mergeResponse: { status: number; body: any } | null = null;
  private n = 0;
  private id = 100;

  /** Registers an existing commit chain (the repo's history before Gantry) from flat file maps. */
  seedCommit(files: Record<string, string>, parent: string | null = null, message = "seed"): string {
    const flat: Flat = new Map();
    for (const [p, c] of Object.entries(files)) { const b = Buffer.from(c); const s = gitObj("blob", b); this.blobs.set(s, b); flat.set(p, { mode: "100644", type: "blob", sha: s }); }
    return this.addCommit(flat, parent ? [parent] : [], message);
  }
  /** Registers a commit that exists in a real git repository (same id), so the broker can build on it. Returns its tree id. */
  registerCommit(realSha: string, files: Record<string, string>): string {
    const flat: Flat = new Map();
    for (const [p, c] of Object.entries(files)) { const b = Buffer.from(c); const s = gitObj("blob", b); this.blobs.set(s, b); flat.set(p, { mode: "100644", type: "blob", sha: s }); }
    const tree = treeSha(flat);
    this.trees.set(tree, flat);
    this.commits.set(realSha, { tree, parents: [], message: "seed" });
    return tree;
  }
  private addCommit(flat: Flat, parents: string[], message: string): string {
    const tree = treeSha(flat);
    this.trees.set(tree, flat);
    const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author Gantry App <app@example.com> 1700000000 +0000\ncommitter Gantry App <app@example.com> 1700000000 +0000\n\n${message}`;
    const sha = gitObj("commit", Buffer.from(text));
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }
  setRef(name: string, sha: string): void { this.refs.set(name, sha); }
  addPull(p: Partial<FakePr> & { head: { sha: string; ref: string } }): FakePr {
    const number = p.number ?? this.pulls.length + 1;
    const pr: FakePr = { number, id: 5000 + number, node_id: `PR_${number}`, title: "t", body: null, state: "open", draft: false, base: { ref: "main" }, merged_at: null, merge_commit_sha: null, html_url: `${this.url}/pull/${number}`, user: { login: "gantry[bot]" }, labels: [], mergeable: true, mergeable_state: "clean", ...p };
    this.pulls.push(pr);
    return pr;
  }
  of(method: string, re: RegExp): Recorded[] { return this.requests.filter((r) => r.method === method && re.test(r.path)); }
  writes(): Recorded[] { return this.requests.filter((r) => r.method !== "GET" && !/access_tokens|\/installation\/token/.test(r.path)); }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url ?? "/", "http://x");
    const body = raw ? JSON.parse(raw) : undefined;
    const rec: Recorded = { method: req.method ?? "GET", path: decodeURIComponent(u.pathname), query: u.searchParams, body, auth: String(req.headers.authorization ?? "") };
    this.requests.push(rec);
    const send = (status: number, data?: unknown): void => { res.statusCode = status; if (data === undefined) return void res.end(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
    try {
      const r = this.route(rec);
      if (r) send(r[0], r[1]); else send(404, { message: "Not Found" });
    } catch (e) { send(500, { message: String(e) }); }
  }

  private repoAuth(rec: Recorded, repo: string): { status: number; message: string } | null {
    const tok = this.tokens.get(rec.auth.replace(/^(token|Bearer) /, ""));
    if (!tok || tok.revoked) return { status: 401, message: "Bad credentials" };
    if (!tok.repos.includes(repo)) return { status: 404, message: "Not Found" };
    return null;
  }

  private route(rec: Recorded): [number, unknown?] | null {
    const { method: m, path: p, body } = rec;
    let x: RegExpExecArray | null;
    if (m === "GET" && (x = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(p))) return this.uninstalled.has(`${x[1]}/${x[2]}`) ? [404, { message: "Not Found" }] : [200, { id: 77, app_slug: "gantry-test" }];
    if (m === "POST" && (x = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p))) {
      for (const [k, v] of Object.entries(body.permissions ?? {})) {
        const have = this.appPermissions[k];
        if (!have || (v === "write" && have !== "write")) return [422, { message: `The permissions requested are not granted to this installation: ${k}` }];
      }
      const token = `ghs_fake${++this.n}`;
      this.tokens.set(token, { repos: body.repositories ?? [], permissions: body.permissions ?? {}, revoked: false });
      return [201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions, repository_selection: "selected" }];
    }
    if (m === "DELETE" && p === "/installation/token") { const t = this.tokens.get(rec.auth.replace(/^(token|Bearer) /, "")); if (t) t.revoked = true; return [204]; }
    if (m === "GET" && /^\/app\/installations\/77$/.test(p)) return [200, { id: 77, app_slug: "gantry-test", permissions: this.appPermissions, repository_selection: "selected", target_type: this.installationTargetType }];
    if (m === "GET" && p === "/app/installations") return [200, [{ id: 77 }]];
    if (m === "GET" && p === "/installation/repositories") return [200, { total_count: this.installedRepos.length, repositories: this.installedRepos }];
    if (m === "GET" && p === "/meta") return [200, { installed_version: "3.14.0" }];
    if (m === "GET" && p === "/app/hook/deliveries") return [200, this.deliveries];
    if (m === "POST" && (x = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(p))) return [202, {}];

    x = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (x) {
      const [, , repo, rest = ""] = x;
      const denied = this.repoAuth(rec, repo!);
      if (denied) return [denied.status, { message: denied.message }];
      return this.repoRoute(rec, rest, body);
    }
    if (m === "POST" && p === "/graphql") {
      const pr = this.pulls.find((q) => q.node_id === body.variables?.id);
      if (!pr) return [200, { errors: [{ message: "not found" }] }];
      pr.draft = true;
      return [200, { data: { convertPullRequestToDraft: { pullRequest: { id: pr.node_id, isDraft: true } } } }];
    }
    return null;
  }

  private repoRoute(rec: Recorded, rest: string, body: any): [number, unknown?] | null {
    const m = rec.method;
    let x: RegExpExecArray | null;
    if (m === "GET" && rest === "") return [200, { default_branch: this.defaultBranch, language: this.language, archived: this.archived }];
    if (m === "GET" && rest === "/languages") return [200, this.language ? { [this.language]: 1000 } : {}];
    if (m === "GET" && (x = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest))) {
      const flat = this.trees.get(x[1]!);
      if (!flat) return [404, { message: "Not Found" }];
      return [200, { sha: x[1], truncated: false, tree: [...flat.entries()].map(([path, e]) => ({ path, mode: e.mode, type: e.type, sha: e.sha, size: this.blobs.get(e.sha)?.length ?? 0 })) }];
    }
    if (m === "GET" && (x = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest))) {
      const b = this.blobs.get(x[1]!);
      return b ? [200, { sha: x[1], encoding: "base64", content: b.toString("base64"), size: b.length }] : [404, { message: "Not Found" }];
    }
    if (m === "DELETE" && (x = /^\/git\/refs\/(.+)$/.exec(rest))) { const key = `refs/${x[1]}`; if (!this.refs.has(key)) return [422, { message: "Reference does not exist" }]; this.refs.delete(key); return [204]; }
    if (m === "POST" && /^\/issues\/\d+\/comments$/.test(rest)) return [201, { id: ++this.id, body: body.body }];
    if (m === "POST" && rest === "/git/blobs") {
      const b = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
      const s = gitObj("blob", b); this.blobs.set(s, b); return [201, { sha: s }];
    }
    if (m === "POST" && rest === "/git/trees") {
      const base = this.trees.get(body.base_tree);
      if (!base) return [422, { message: "base_tree not found" }];
      const flat: Flat = new Map(base);
      for (const e of body.tree) {
        if (e.sha === null) { flat.delete(e.path); continue; }
        if (e.type === "blob" && !this.blobs.has(e.sha)) return [422, { message: `blob ${e.sha} missing` }];
        flat.set(e.path, { mode: e.mode, type: e.type, sha: e.sha });
      }
      const s = treeSha(flat); this.trees.set(s, flat); return [201, { sha: s }];
    }
    if (m === "POST" && rest === "/git/commits") {
      if (!this.trees.has(body.tree)) return [422, { message: "tree missing" }];
      for (const par of body.parents) if (!this.commits.has(par)) return [422, { message: "parent missing" }];
      const sha = this.addCommit(this.trees.get(body.tree)!, body.parents, body.message);
      return [201, { sha, tree: { sha: body.tree } }];
    }
    if (m === "GET" && (x = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = this.commits.get(x[1]!); return c ? [200, { sha: x[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message }] : [404, { message: "Not Found" }];
    }
    if (m === "GET" && (x = /^\/git\/ref\/(.+)$/.exec(rest))) { const s = this.refs.get(`refs/${x[1]}`); return s ? [200, { ref: `refs/${x[1]}`, object: { sha: s, type: "commit" } }] : [404, { message: "Not Found" }]; }
    if (m === "POST" && rest === "/git/refs") { if (this.refs.has(body.ref)) return [422, { message: "Reference already exists" }]; if (!this.commits.has(body.sha)) return [422, { message: "Object does not exist" }]; this.refs.set(body.ref, body.sha); if (this.ciOnPush) this.checkRuns.push({ id: ++this.id, name: this.ciOnPush.name, status: "completed", conclusion: this.ciOnPush.conclusion, head_sha: body.sha, app: { slug: "github-actions" } }); return [201, { ref: body.ref, object: { sha: body.sha } }]; }
    if (m === "PATCH" && (x = /^\/git\/refs\/(.+)$/.exec(rest))) { const key = `refs/${x[1]}`; if (!this.refs.has(key)) return [422, { message: "Reference does not exist" }]; if (this.protectedRefs.has(key)) return [403, { message: "Protected branch update failed: changes must be made through a pull request" }]; this.refs.set(key, body.sha); return [200, { ref: key, object: { sha: body.sha } }]; }
    if (m === "GET" && rest === "/pulls") {
      const head = rec.query.get("head")?.split(":")[1]; const state = rec.query.get("state") ?? "open";
      return [200, this.pulls.filter((q) => (!head || q.head.ref === head) && (state === "all" || q.state === state))];
    }
    if (m === "POST" && rest === "/pulls") {
      const pr = this.addPull({ title: body.title, body: body.body, draft: body.draft === true, base: { ref: body.base }, head: { ref: body.head, sha: this.refs.get(`refs/heads/${body.head}`) ?? "" } });
      return [201, pr];
    }
    if ((x = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = this.pulls.find((q) => q.number === Number(x![1])); if (!pr) return [404, { message: "Not Found" }];
      if (m === "GET") return [200, pr];
      if (m === "PATCH") { Object.assign(pr, body.title ? { title: body.title } : {}, body.body !== undefined ? { body: body.body } : {}, body.state ? { state: body.state } : {}); return [200, pr]; }
    }
    if (m === "PUT" && (x = /^\/pulls\/(\d+)\/merge$/.exec(rest))) {
      if (this.mergeResponse) return [this.mergeResponse.status, this.mergeResponse.body];
      const pr = this.pulls.find((q) => q.number === Number(x![1]))!;
      if (body.sha !== pr.head.sha) return [409, { message: "Head branch was modified. Review and try the merge again." }];
      pr.state = "closed"; pr.merged_at = "2026-01-01T00:00:00Z"; pr.merge_commit_sha = sha1(`merge-${pr.number}`);
      return [200, { merged: true, sha: pr.merge_commit_sha, message: "Pull Request successfully merged" }];
    }
    if (m === "GET" && (x = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) return [200, this.reviews.get(Number(x[1])) ?? []];
    if (m === "GET" && (x = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) {
      const name = rec.query.get("check_name");
      return [200, { total_count: 0, check_runs: this.checkRuns.filter((c) => c.head_sha === x![1] && (!name || c.name === name)) }];
    }
    if (m === "GET" && /^\/commits\/[^/]+\/status$/.test(rest)) return [200, { state: "success" }];
    if (m === "POST" && rest === "/check-runs") { const c = { id: ++this.id, app: { slug: "gantry-test" }, completed_at: body.status === "completed" ? "2026-01-01T00:00:00Z" : null, ...body }; this.checkRuns.push(c); return [201, c]; }
    if (m === "PATCH" && (x = /^\/check-runs\/(\d+)$/.exec(rest))) { const c = this.checkRuns.find((q) => q.id === Number(x![1])); if (!c) return [404, { message: "Not Found" }]; Object.assign(c, body); return [200, c]; }
    if (m === "GET" && rest === "/issues") { const l = rec.query.get("labels"); return [200, this.issues.filter((i) => !l || i.labels.some((q: any) => q.name === l))]; }
    if (m === "GET" && /^\/branches\/[^/]+\/protection$/.test(rest)) return this.protection ? [200, this.protection] : [404, { message: "Branch not protected" }];
    if (m === "GET" && rest === "/rulesets") return [200, this.rulesets.map((r) => ({ id: r.id, name: r.name }))];
    if (m === "GET" && (x = /^\/rulesets\/(\d+)$/.exec(rest))) { const r = this.rulesets.find((q) => q.id === Number(x![1])); return r ? [200, r] : [404, { message: "Not Found" }]; }
    return null;
  }
}
