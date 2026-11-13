import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The API is same-origin in production (Caddy routes /api, /auth, /hooks to gantry-api).
// In dev, proxy those paths to a locally running API.
const api = process.env.GANTRY_DEV_API ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": api, "/auth": api, "/hooks": api },
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
