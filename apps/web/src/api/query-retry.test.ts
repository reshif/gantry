import { describe, expect, it } from "vitest";
import { makeQueryClient } from "../App";
import { ApiError } from "./client";

const opts = () => makeQueryClient().getDefaultOptions().queries!;
const err = (status: number) => new ApiError(status, "x", null);

describe("a failed read reaches the failed state quickly", () => {
  it("retries a 5xx once, with a short delay, and a 4xx never", () => {
    const o = opts();
    const retry = o.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, err(500))).toBe(true);
    expect(retry(1, err(500))).toBe(false);
    expect(retry(0, err(404))).toBe(false);
    expect(o.retryDelay).toBeLessThanOrEqual(500);
  });
});
