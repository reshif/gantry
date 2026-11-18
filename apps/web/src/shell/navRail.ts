/**
 * The collapsible left nav: one rule for "is the nav a rail right now". The person's choice (prefs.navRail) wins; with
 * no choice the rail is the default at medium widths (1025-1279px). Phones and tablets under 1025px keep the drawer.
 */
import { useSyncExternalStore } from "react";
import { getPrefs, updatePrefs, usePrefs } from "../lib/prefs";

const MEDIUM = "(min-width: 1025px) and (max-width: 1279px)";
const DRAWER = "(max-width: 1024px)";

function mq(q: string): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q) : null;
  } catch {
    return null;
  }
}

function useMatch(q: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const m = mq(q);
      m?.addEventListener?.("change", fn);
      return () => m?.removeEventListener?.("change", fn);
    },
    () => mq(q)?.matches ?? false,
    () => false,
  );
}

/** True when the nav is a drawer (phone / small tablet): there the rail does not apply. */
export const useDrawerWidth = (): boolean => useMatch(DRAWER);

/** True when the nav should render as the icon rail. */
export function useNavRail(): boolean {
  const pref = usePrefs().navRail;
  const medium = useMatch(MEDIUM);
  const drawer = useMatch(DRAWER);
  if (drawer) return false;
  return pref ?? medium;
}

/** Flip the rail for the current width and remember it as the person's choice. */
export function toggleNavRail(): void {
  const medium = mq(MEDIUM)?.matches ?? false;
  const drawer = mq(DRAWER)?.matches ?? false;
  if (drawer) return;
  const now = getPrefs().navRail ?? medium;
  updatePrefs({ navRail: !now });
}

/** Fold or unfold one section of the expanded nav. */
export const toggleNavSection = (group: string): void =>
  updatePrefs((p) => ({ navCollapsed: { ...p.navCollapsed, [group]: !p.navCollapsed[group] } }));

/** The tiny mono tag a section carries in the rail. */
export const SECTION_TAG: Record<string, string> = { Overview: "OV", Project: "LINE", Agents: "AGT", Connect: "CON", Govern: "GOV", Reference: "REF" };
export const sectionTag = (g: string): string => SECTION_TAG[g] ?? g.slice(0, 3).toUpperCase();

/** Is the key press typed into something (so a bare "[" must not toggle the nav)? */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || !!el.closest?.("[contenteditable='true'],[role='textbox'],[role='combobox']");
}
