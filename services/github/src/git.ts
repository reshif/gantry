/**
 * Running `git` safely (spec 5.2: the broker treats workspace content as untrusted data and never executes anything from it).
 *  - Nothing is ever run inside a workspace. Object data is copied out of it as plain files into a scratch bare repository the broker created itself,
 *    so the workspace's own `.git/config` (fsmonitor, sshCommand, hooks path, filters, includes) is never read.
 *  - System and global config are disabled, hooks are pointed at nothing, templates are empty, external diff and textconv are off.
 */
import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) { super(message); }
}

export interface GitOptions {
  gitBin: string;
  /** Extra environment for this one call (for example the fetch credential header). */
  env?: Record<string, string>;
  cwd?: string;
  input?: Buffer | string;
  /** Extra `-c key=value` settings (tests allow the file protocol this way). */
  config?: string[];
  maxOutput?: number;
  timeoutMs?: number;
}

const HARDENING = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "core.sshCommand=false",
  "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "diff.external=", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
  "-c", "core.symlinks=false", "-c", "credential.helper=", "-c", "safe.directory=*", "-c", "fetch.fsckObjects=false", "-c", "transfer.fsckObjects=false",
];

export function git(args: string[], o: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_ASKPASS: "/bin/false", ...o.env,
    };
    const p = spawn(o.gitBin, [...HARDENING, ...(o.config ?? []).flatMap((c) => ["-c", c]), ...args], { env, cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0, err = "", over = false;
    const max = o.maxOutput ?? 64 * 1024 * 1024;
    const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 120_000);
    p.stdout.on("data", (d: Buffer) => { size += d.length; if (size > max) { over = true; p.kill("SIGKILL"); } else out.push(d); });
    p.stderr.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString("utf8"); });
    p.on("error", (e) => { clearTimeout(timer); reject(new GitError(`could not run git: ${e.message}`, null, "")); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (over) return reject(new GitError("git output exceeded the allowed size", code, err));
      if (code !== 0) return reject(new GitError(`git ${args[0] ?? ""} failed`, code, redact(err)));
      resolve(Buffer.concat(out));
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(o.input);
  });
}

/** Strips anything that looks like a credential from git's stderr before it can be logged or returned. */
export const redact = (s: string): string => s.replace(/(Authorization:\s*\S+\s+)\S+/gi, "$1[redacted]").replace(/x-access-token:[^@\s]+/gi, "x-access-token:[redacted]").replace(/\b(ghs|ghp|gho|ghu|github_pat)_[A-Za-z0-9_]+/g, "[redacted]");

export const gitText = async (args: string[], o: GitOptions): Promise<string> => (await git(args, o)).toString("utf8");
