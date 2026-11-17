/**
 * Unsaved work must not vanish on a stray click.
 *
 * `useLeaveGuard(dirty)` marks the calling form as holding unsaved input:
 *  - inside a dialog (see `DirtyScope`, provided by `Dialog`), the dialog asks before closing on scrim, Escape or Cancel;
 *  - anywhere else it guards the page: `beforeunload` (tab close, reload) and `hashchange` (in-app navigation)
 *    ask first, and a declined navigation puts the previous route back.
 *  A dirty form inside a dialog also arms `beforeunload` (reload, Ctrl+W), so a hard leave cannot lose its input either.
 *
 * INTERIM: the `hashchange` guard uses a blocking `window.confirm` and reverts with `location.replace`, because the router
 * (lib/router.ts, a Foundation file) has no blocker registry. When the router gains one, route this through it and drop the
 * revert. Flagged for the Foundation track; accepted as interim.
 */
import { createContext, useContext, useEffect, useRef } from "react";

export interface DirtyScopeApi {
  mark(id: symbol, dirty: boolean): void;
}
/** Provided by a dialog or drawer so its forms mark that layer, not the page behind it. */
export const DirtyScope = createContext<DirtyScopeApi | null>(null);

export const LEAVE_MESSAGE = "You have unsaved changes. Leave and discard them?";

const pageDirty = new Set<symbol>();
/** Dirty forms inside a dialog: they guard tab close and reload (beforeunload), not in-app navigation. */
const dialogDirty = new Set<symbol>();
let lastHref = typeof window === "undefined" ? "" : window.location.href;
let installed = false;
let reverting = false;

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!pageDirty.size && !dialogDirty.size) return;
  e.preventDefault();
  e.returnValue = "";
}
function onHashChange(): void {
  if (reverting) {
    reverting = false;
    lastHref = window.location.href;
    return;
  }
  if (pageDirty.size && !window.confirm(LEAVE_MESSAGE)) {
    reverting = true;
    window.location.replace(lastHref);
    return;
  }
  lastHref = window.location.href;
}
function install(): void {
  if (installed) return;
  installed = true;
  lastHref = window.location.href;
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", onHashChange);
}
function uninstall(): void {
  if (!installed || pageDirty.size || dialogDirty.size) return;
  installed = false;
  window.removeEventListener("beforeunload", onBeforeUnload);
  window.removeEventListener("hashchange", onHashChange);
}

/** True while any page-level form holds unsaved input. */
export const pageHasUnsaved = (): boolean => pageDirty.size > 0;

export function useLeaveGuard(dirty: boolean): void {
  const scope = useContext(DirtyScope);
  const id = useRef<symbol>(Symbol("leave-guard"));
  useEffect(() => {
    const me = id.current;
    if (scope) {
      scope.mark(me, dirty);
      if (!dirty) return () => scope.mark(me, false);
      // The dialog asks before its own dismissal; a reload or tab close would still lose the input, so arm beforeunload too.
      dialogDirty.add(me);
      install();
      return () => {
        scope.mark(me, false);
        dialogDirty.delete(me);
        uninstall();
      };
    }
    if (!dirty) return;
    pageDirty.add(me);
    install();
    return () => {
      pageDirty.delete(me);
      uninstall();
    };
  }, [dirty, scope]);
}
