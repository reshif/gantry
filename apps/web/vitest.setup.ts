import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  // a view's own query state (?tab=, ?sort=) must not leak into the next test
  try {
    if (typeof window !== "undefined" && window.location.search) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  } catch {
    /* no history */
  }
});
