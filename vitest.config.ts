import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fixture repos are real git repos, and spawning git is slow on some machines.
    testTimeout: 30_000,
  },
});
