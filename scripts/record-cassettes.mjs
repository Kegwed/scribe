// Replaces every recorded LLM response with a fresh one from Claude. Spends real money.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Anthropic SDK reads ANTHROPIC_API_KEY from the environment only; a git-ignored .env can supply it.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY, in the environment or in .env, before recording.");
  process.exit(1);
}

rmSync(fileURLToPath(new URL("../src/test/cassettes", import.meta.url)), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), "run"], {
  env: { ...process.env, SCRIBE_RECORD: "1" },
  stdio: "inherit",
});
