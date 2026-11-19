/**
 * The one definition of a research host (hostname or `*.suffix`) for the factory allow-list, the work order's plan and the agent-proposed plan.
 * IP literals are refused: the edge's connect-time guard cannot see a private range behind a literal, so a research host must be a DNS name
 * (the edge resolves it and refuses private answers). A name whose last label has no letter (`10.0.0.5`, `0x7f.1`, `127.1`) is an address in
 * some parser's eyes, so it is refused too.
 */
const SHAPE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isResearchHost(h: string): boolean {
  if (h.length > 253 || !SHAPE.test(h)) return false;
  const last = h.split(".").pop() ?? "";
  return /[a-z]/.test(last);
}
