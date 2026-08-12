import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "benchmark/**/*.test.ts"],
    environment: "node",
  },
});
