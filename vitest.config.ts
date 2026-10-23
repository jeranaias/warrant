import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "bench/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
