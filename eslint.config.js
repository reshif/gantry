// Lint for every workspace (a CI gate). Correctness rules only; formatting is left to the editor.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import webArchitecture from "./eslint.config.web.js";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.cache/**", "**/node_modules/**", "**/coverage/**", "legacy/**", "undefined/**", ".claude/**", "**/*.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      // `_name` marks a value that is deliberately unused (a destructured field left out, a callback argument).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true }],
      // Initial values that every branch overwrites are a style choice here, not a defect.
      "no-useless-assignment": "off",
      // Control characters in patterns are intentional here: sanitizers strip them from untrusted text.
      "no-control-regex": "off",
    },
  },
  // TypeScript checks names itself.
  { files: ["**/*.{ts,tsx}"], rules: { "no-undef": "off" } },
  { files: ["apps/web/**/*.{ts,tsx}"], languageOptions: { globals: { ...globals.browser } } },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
  ...webArchitecture,
  // Tests build fixtures and reach into internals; `any` is allowed there.
  { files: ["**/test/**", "**/*.test.{ts,tsx}", "test/e2e/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // Browser-side scripts run by playwright (page.evaluate) see the DOM.
  { files: ["test/e2e/**/*.mjs"], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
