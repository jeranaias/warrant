import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Package boundaries are enforced here, not by convention. See each package's CLAUDE.md.
const restrict = (files, patterns, message) => ({
  files,
  rules: {
    "no-restricted-imports": ["error", { patterns: [{ group: patterns, message }] }],
  },
});

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "pnpm-lock.yaml"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  { languageOptions: { globals: { ...globals.node } } },
  restrict(
    ["packages/contracts/**"],
    ["@warrant/*"],
    "contracts is the leaf package: it imports zod only.",
  ),
  restrict(
    ["packages/agents/**"],
    [
      "@warrant/rails",
      "@warrant/rails/*",
      "@warrant/control",
      "@warrant/control/*",
      "@warrant/mocks",
    ],
    "Agents only submit proposals. They never touch rails or control internals.",
  ),
  restrict(
    ["packages/rails/**"],
    ["@warrant/agents", "@warrant/agents/*", "@warrant/control", "@warrant/control/*"],
    "Rails are called by control only and must not know about agents or control.",
  ),
  restrict(
    ["apps/dashboard/**"],
    ["@warrant/rails", "@warrant/rails/*", "@warrant/agents", "@warrant/agents/*"],
    "The dashboard talks to control, never to rails or agents directly.",
  ),
);
