// Runs the whole test suite, then fails if a cassette holds a response no test asked for:
// one left behind when its prompt changed. Makes no LLM calls. With --prune it deletes them instead.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// A fresh clone or worktree has no node_modules.
if (!existsSync(join(root, "node_modules/vitest/vitest.mjs"))) {
  console.error("vitest isn't installed: run `npm ci` first.");
  process.exit(1);
}
const cassettes = join(root, "src/test/cassettes");
const used = mkdtempSync(join(tmpdir(), "scribe-used-keys-"));

try {
  const { SCRIBE_RECORD: _, ...env } = process.env;
  execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run"], {
    cwd: root,
    env: { ...env, SCRIBE_USED_KEYS: used },
    stdio: "inherit",
  });

  const asked = new Set();
  for (const file of readdirSync(used)) {
    const name = file.split(".")[0];
    for (const key of readFileSync(join(used, file), "utf8").split("\n").filter(Boolean)) asked.add(`${name}/${key}`);
  }

  const prune = process.argv.includes("--prune");
  const legacyFile = join(root, "src/test/legacy-recordings.json");
  const legacy = JSON.parse(readFileSync(legacyFile, "utf8"));
  const unused = [];
  for (const file of readdirSync(cassettes).filter((name) => name.endsWith(".json"))) {
    const name = file.replace(/\.json$/, "");
    const cassette = JSON.parse(readFileSync(join(cassettes, file), "utf8"));
    const stale = Object.keys(cassette).filter((key) => !asked.has(`${name}/${key}`));
    unused.push(...stale.map((key) => `${name}/${key}`));
    if (prune && stale.length > 0) {
      for (const key of stale) delete cassette[key];
      writeFileSync(join(cassettes, file), JSON.stringify(cassette, null, 2) + "\n");
      if (legacy[name]) legacy[name] = legacy[name].filter((key) => !stale.includes(key));
    }
  }

  if (prune) {
    writeFileSync(legacyFile, JSON.stringify(legacy, null, 2) + "\n");
    console.log(`Deleted ${unused.length} recorded responses no test asks for.`);
  } else if (unused.length > 0) {
    console.error(`\n${unused.length} recorded responses no test asks for:\n  ${unused.join("\n  ")}`);
    console.error("Delete them with node scripts/check-recordings.mjs --prune.");
    process.exit(1);
  } else {
    console.log("Every recorded response is asked for by a test.");
  }
} finally {
  rmSync(used, { recursive: true, force: true });
}
