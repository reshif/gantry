import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Every test starts from a clean browser: no stored preferences or drafts, no URL state (path, `?tab=`, `#/route`),
// and the in-memory preference store reloaded from that empty storage. Without this, files that share one worker
// (single-fork mode) inherit the project pick, hash and query string of the file before them.
beforeEach(async () => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage unavailable in this environment */
  }
  try {
    // "/#" (an empty fragment) rather than "/": tests start with `window.location.hash = ""`, and on a URL that already has an
    // empty fragment that is a no-op. On "/" jsdom queues a `hashchange` that lands mid-test and makes the router's route-state
    // listener drop the `?tab=` the test just wrote, which is what failed Security, Trust and Onboarding in single-fork runs.
    window.history.replaceState(null, "", "/#");
  } catch {
    /* no history in this environment */
  }
  try {
    const prefs = await import("./src/lib/prefs");
    prefs.reloadPrefs();
  } catch {
    /* the module is mocked away or unavailable */
  }
});

afterEach(async () => {
  cleanup();
  // jsdom delivers `hashchange` (set by `location.hash = ...`) as a queued task. Left to arrive during the next test, it clears
  // that test's `?tab=` and `?sort=` (queryState drops a route's keys when the hash route changes). Let it land here instead.
  if (!vi.isFakeTimers()) await new Promise<void>((r) => window.setTimeout(r, 0));
});
