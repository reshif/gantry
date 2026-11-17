/**
 * The project's own test command, as a narrow shell permission. Onboarding detects and proposes one (a Makefile `test` target, `uv run pytest`, `npm test`);
 * a person with `onboarding.manage` confirms it in the repository's settings (`config.testCommands`). Only a confirmed command reaches an agent's allow-list,
 * and only as `Bash(<command>:*)`: a prefix rule for that one command, never a bare `Bash`. A command that could run arbitrary code (a shell or interpreter
 * with its own `-c`, a network tool, `env`, `sudo`, `git`) is refused here, at confirmation, and again when the run spec is composed.
 */
const TOKEN = /^[A-Za-z0-9_-][A-Za-z0-9_./@=:+-]*$/;
const REFUSED_FIRST = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "env", "sudo", "su", "doas", "eval", "exec", "xargs", "nohup", "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "git", "rm", "mv", "dd", "chmod", "chown", "perl", "ruby", "php", "awk", "sed", "find", "node", "python", "python3", "deno", "bun"]);
const REFUSED_FLAGS = new Set(["-c", "-e", "-p", "--eval", "--command", "--exec", "-exec", "-m", "--print"]);
export const MAX_TEST_COMMANDS = 5;

/** The command in its normal form (single spaces), or null (with the reason) when it may not become a shell permission. */
export function checkTestCommand(raw: unknown): { ok: true; command: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "A test command is text." };
  const command = raw.trim().replace(/\s+/g, " ");
  if (!command) return { ok: false, reason: "A test command cannot be empty." };
  if (command.length > 120) return { ok: false, reason: "A test command is at most 120 characters." };
  const tokens = command.split(" ");
  if (tokens.length > 8) return { ok: false, reason: "A test command is at most 8 words." };
  if (!tokens.every((t) => TOKEN.test(t) && !t.includes(".."))) return { ok: false, reason: "A test command is plain words only: no quotes, pipes, redirects, substitutions or wildcards." };
  if (REFUSED_FIRST.has(tokens[0]!)) return { ok: false, reason: `${tokens[0]} can run anything, so it cannot be a test permission. Name the test runner or a Makefile target instead (for example "make test").` };
  if (tokens.some((t) => REFUSED_FLAGS.has(t))) return { ok: false, reason: "A flag that runs code given on the command line cannot be part of a test permission." };
  return { ok: true, command };
}

/** The shell rules for the confirmed commands of a repository; anything that no longer passes the check is left out. */
export function testCommandRules(confirmed: unknown): string[] {
  if (!Array.isArray(confirmed)) return [];
  const out: string[] = [];
  for (const c of confirmed.slice(0, MAX_TEST_COMMANDS)) {
    const r = checkTestCommand(c);
    if (r.ok && !out.includes(`Bash(${r.command}:*)`)) out.push(`Bash(${r.command}:*)`);
  }
  return out;
}
