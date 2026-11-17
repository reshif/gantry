import { isDraftDirty, useDraftVersion } from "../lib/useDraft";

/** A small dot on a roster row whose entity holds unsaved edits (a kept draft is otherwise invisible after selecting another row). */
export function DraftDot({ scope, id }: { scope: string; id: string }) {
  useDraftVersion();
  if (!isDraftDirty(scope, id)) return null;
  return <span className="draft-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />;
}
