import { defineConfig } from "vitest/config";

// Roles are cluster-wide, so test files that create databases and run migrations must not race each other.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 } });
