/**
 * What the harness may run in the shell. An agent that may "run tests" gets test commands, never a bare `Bash`: a prompt-injected agent with an
 * unrestricted shell can run anything the container allows, with the run token in its environment. The API emits only these patterns; the runner
 * enforces the same rule again on whatever list it is handed, so a stale or hand-edited allow-list cannot widen the shell.
 */
export const TEST_COMMANDS = [
  "Bash(npm test:*)",
  "Bash(npm run test:*)",
  "Bash(npx vitest:*)",
  "Bash(npx jest:*)",
  "Bash(pnpm test:*)",
  "Bash(yarn test:*)",
  "Bash(pytest:*)",
  "Bash(python -m pytest:*)",
  "Bash(go test:*)",
  "Bash(cargo test:*)",
] as const;

/** A rule that lets the shell run anything: `Bash`, `Bash(*)`, `Bash(:*)`, `Bash(**)`. */
const UNRESTRICTED_SHELL = /^Bash(?:\(\s*(?:\*+|:\*+)?\s*\))?$/;

/** The allow-list with every unrestricted shell rule replaced by the test commands. */
export function narrowShell(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of list) {
    if (UNRESTRICTED_SHELL.test(t.trim())) {
      for (const c of TEST_COMMANDS) if (!out.includes(c)) out.push(c);
    } else if (!out.includes(t)) out.push(t);
  }
  return out;
}
