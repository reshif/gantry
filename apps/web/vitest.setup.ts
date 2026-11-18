import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// URL state (`?tab=`, `?q=`) lives in the address bar; a test must not inherit the query string of the one before it.
beforeEach(() => {
  try {
    if (window.location.search) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash);
  } catch {
    /* no history in this environment */
  }
});

afterEach(() => {
  cleanup();
});
