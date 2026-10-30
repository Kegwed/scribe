import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A fixture test is about 1s of git and compiler work, with no single hot spot, but machine load can multiply that.
    testTimeout: 30_000,
  },
});
