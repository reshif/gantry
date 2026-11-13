import { defineConfig } from "vitest/config";

// DB tests create throwaway databases and share cluster-wide roles, so files run serially.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 } });
