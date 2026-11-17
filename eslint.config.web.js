// Architecture rules for apps/web (the frontend production bar, docs/ui/design-system.md and AGENTS.md).
// Every restriction is a WARNING that a shrinking baseline (apps/web/lint-baseline.json, ratchet in
// scripts/lint-ratchet.mjs) keeps from growing. Each message starts with a [tag]; the tag is the rule
// id used in the baseline, in AGENTS.md and in scripts/enforcement.json. Flip a tag to "error" per view
// (Wave 3) by moving that view out of the baseline and into an error override.
import jsxA11y from "eslint-plugin-jsx-a11y";

const ROLE_NAMES = ["factory_admin", "auditor", "factory_manager", "security_reviewer", "project_admin", "line_lead", "approver", "release_manager"];

const sel = (selector, tag, message) => ({ selector, message: `[${tag}] ${message}` });

/** Rules for view code: the screens under apps/web/src/views. */
export const viewSyntax = [
  sel("JSXOpeningElement[name.name='table']", "raw-table", "Use DataTable, not a raw <table>."),
  sel("JSXOpeningElement[name.name='button']", "raw-button", "Use Btn / IconBtn, not a raw <button>."),
  sel("JSXOpeningElement[name.name=/^(input|textarea|select)$/]", "raw-input", "Use Field and its controls, not a raw <input>, <textarea> or <select>."),
  sel("Property[key.name='queryKey'][value.type='ArrayExpression']", "literal-query-key", "Query keys come from the typed key factories in api/, never a literal array."),
  sel("LogicalExpression[operator='??'][left.property.name='data'][right.type='ArrayExpression']", "data-nullish-empty", "A failed read must not render as an empty list: put the read inside <Async>."),
  sel(`Literal[value=/^(${ROLE_NAMES.join("|")})$/]`, "role-literal", "Do not branch on role names: permissions come from server decisions (useCan / useGuard)."),
  sel("BinaryExpression[left.property.name='role'][right.type='Literal']", "role-literal", "Do not compare a role name: permissions come from server decisions (useCan / useGuard)."),
];

/** Rules for all non-test web code. */
export const srcSyntax = [
  sel("JSXAttribute[name.name='dangerouslySetInnerHTML']", "dangerous-html", "dangerouslySetInnerHTML is only allowed inside Icon."),
  sel("TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']", "as-unknown-as", "Do not cast through unknown: fix the type."),
];

export const viewImports = {
  paths: [{ name: "@tanstack/react-query", message: "[view-import-react-query] Views read through api/queries hooks and write through useCommand." }],
  patterns: [
    { regex: "(^|/)api/client(\\.[jt]sx?)?$", message: "[view-import-api-client] Views must not use the api client; use api/queries hooks and useCommand." },
    { regex: "(^|/)api/ops(\\.[jt]sx?)?$", message: "[view-import-ops] Views must not call ops.*; writes go through useCommand." },
  ],
};

const a11yWarn = Object.fromEntries(Object.keys(jsxA11y.flatConfigs.recommended.rules).map((k) => [k, "warn"]));

const TESTS = ["**/*.test.{ts,tsx}", "**/test/**", "**/e2e/**"];

export default [
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: TESTS,
    plugins: { "jsx-a11y": jsxA11y },
    rules: { ...a11yWarn, "no-restricted-syntax": ["warn", ...srcSyntax] },
  },
  // The Icon primitive is the one place that may inject markup (its SVG paths are static, in-repo data).
  { files: ["apps/web/src/ui/Icon.tsx"], rules: { "no-restricted-syntax": ["warn", ...srcSyntax.filter((s) => !s.message.startsWith("[dangerous-html]"))] } },
  {
    files: ["apps/web/src/views/**/*.{ts,tsx}"],
    ignores: TESTS,
    rules: {
      "no-restricted-syntax": ["warn", ...srcSyntax, ...viewSyntax],
      "no-restricted-imports": ["warn", viewImports],
    },
  },
  // Primitives and the data layer must not depend on views (an error: there are no violations to baseline).
  {
    files: ["apps/web/src/ui/**/*.{ts,tsx}", "apps/web/src/lib/**/*.{ts,tsx}", "apps/web/src/api/**/*.{ts,tsx}"],
    ignores: TESTS,
    rules: { "no-restricted-imports": ["error", { patterns: [{ regex: "(^|/)views(/|$)", message: "[ui-imports-views] ui, lib and api must not import views." }] }] },
  },
  // Playwright fixtures call `use(...)`, which is not a React hook.
  { files: ["apps/web/e2e/**/*.ts"], rules: { "react-hooks/rules-of-hooks": "off", "react-hooks/exhaustive-deps": "off" } },
  // Tests may exercise anything.
  { files: TESTS, rules: { "no-restricted-syntax": "off", "no-restricted-imports": "off" } },
];
