// Packs scribe, installs the tarball into an empty directory and runs `scribe` there.
// Fails unless it prints its usage: proves the published package works on its own.
// Run through npm (`npm run smoke:pack`) so npm_execpath names the npm CLI to run with node.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run this through npm: npm run smoke:pack");
  process.exit(1);
}

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function mustSucceed(result, what) {
  if (result.status !== 0) {
    console.error(`${what} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
  return result;
}

const work = mkdtempSync(join(tmpdir(), "scribe-smoke-"));
try {
  const packed = mustSucceed(npm(["pack", "--json", "--pack-destination", work], root), "npm pack");
  // npm 11 prints an array of packs, npm 12 an object keyed by package name.
  const [{ filename }] = Object.values(JSON.parse(packed.stdout));

  const app = join(work, "app");
  mkdirSync(app);
  mustSucceed(npm(["install", "--no-audit", "--no-fund", join(work, filename)], app), "npm install");

  const run = npm(["exec", "--no", "--", "scribe"], app);
  const output = `${run.stdout}${run.stderr}`;
  if (run.status !== 0 || !output.includes("Usage: scribe <command>")) {
    console.error(`scribe did not print its usage (exit ${run.status}):\n${output}`);
    process.exit(1);
  }
  console.log(`${filename} installs and prints its usage.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
