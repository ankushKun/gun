import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS } from "./tests/shared/constants.js";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
