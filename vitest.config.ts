import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    singleThread: true,
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 30_000,
    reporter: "verbose",
  },
});
