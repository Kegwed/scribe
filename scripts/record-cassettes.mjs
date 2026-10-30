// Replaces every recorded LLM response with a fresh one from Claude. Spends real money.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync(fileURLToPath(new URL("../src/test/cassettes", import.meta.url)), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), "run"], {
  env: { ...process.env, SCRIBE_RECORD: "1" },
  stdio: "inherit",
});
