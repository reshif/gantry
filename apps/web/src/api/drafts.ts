/** Per-person, per-tab drafts (what someone typed and has not submitted yet). Cleared on sign-out so the next person on a shared tab never sees them. */
export const DRAFT_PREFIX = "gantry.draft.";

export function clearDrafts(): void {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(k);
  } catch {
    /* storage blocked: nothing was kept */
  }
}
