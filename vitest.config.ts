import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A fixture test is about 1s of git and compiler work, with no single hot spot, but machine load can multiply that.
    testTimeout: 30_000,
    // Agent worktrees hold whole copies of the repo, whose tests would otherwise run again from the main checkout.
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
  },
});
