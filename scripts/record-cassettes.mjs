// Records fresh LLM responses from Claude. Spends real money.
//   npm run record                  re-records every cassette
//   npm run record -- adopt reduce  re-records just those cassettes, running only the tests that use them
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cassettes = join(root, "src/test/cassettes");
const legacyFile = join(root, "src/test/legacy-recordings.json");

// The Anthropic SDK reads ANTHROPIC_API_KEY from the environment only; a git-ignored .env can supply it.
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY, in the environment or in .env, before recording.");
  process.exit(1);
}

const names = process.argv.slice(2);
const legacy = JSON.parse(readFileSync(legacyFile, "utf8"));
let testFiles = [];

if (names.length === 0) {
  rmSync(cassettes, { recursive: true, force: true });
  for (const name of Object.keys(legacy)) delete legacy[name];
} else {
  const tests = testsIn(join(root, "src"));
  for (const name of names) {
    const users = tests.filter((file) => readFileSync(file, "utf8").includes(`recordedLlm("${name}"`));
    if (users.length === 0) {
      console.error(`No test replays a cassette named ${name}.`);
      process.exit(1);
    }
    rmSync(join(cassettes, `${name}.json`), { force: true });
    delete legacy[name];
    testFiles.push(...users.map((file) => relative(root, file)));
  }
  testFiles = [...new Set(testFiles)];
}
writeFileSync(legacyFile, JSON.stringify(legacy, null, 2) + "\n");

// Several live calls in one test exceed the replay timeout in vitest.config.ts.
execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--testTimeout=600000", ...testFiles], {
  cwd: root,
  env: { ...process.env, SCRIBE_RECORD: "1" },
  stdio: "inherit",
});

function testsIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testsIn(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
