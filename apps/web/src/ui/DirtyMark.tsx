import { useLeaveGuard } from "../lib/useLeaveGuard";

/**
 * Marks the surrounding dialog (or the page, outside one) as holding unsaved input. Dialog bodies are often built by the
 * component that opens the dialog, outside the dialog's own tree, so they render `<DirtyMark dirty={...} />` inside the body.
 */
export function DirtyMark({ dirty }: { dirty: boolean }) {
  useLeaveGuard(dirty);
  return null;
}
