import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/node/**/*.ts", "src/shared/**/*.ts", "src/page/**/*.ts"],
      thresholds: {
        autoUpdate: (new_threshold) => Math.floor(new_threshold),
        lines: 0,
        statements: 0,
        functions: 0,
        branches: 0,
      },
    },
  },
});
