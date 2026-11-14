/**
 * Registry for actions the command palette (and other shell parts) can run but whose UI lives in a
 * screen module: later-wave screens register their dialogs here, e.g.
 *   registerCommand("newWorkOrder", () => ui.dialog(...))
 * The shell lists an action only when its command is registered.
 */
type Handler = () => void;
const handlers = new Map<string, Handler>();

export function registerCommand(id: string, fn: Handler): () => void {
  handlers.set(id, fn);
  return () => {
    if (handlers.get(id) === fn) handlers.delete(id);
  };
}
export const hasCommand = (id: string): boolean => handlers.has(id);
export function runCommand(id: string): boolean {
  const h = handlers.get(id);
  if (!h) return false;
  h();
  return true;
}
