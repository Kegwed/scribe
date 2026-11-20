// Measures what Scribe's estimate says against what Claude bills, on a real repository: `generate` at
// one commit, then `update` after merging a later one, each with its usage logged by usage-log.mjs.
// Spends real money with the ANTHROPIC_API_KEY in the environment or the git-ignored .env.
//
//   npm run measure -- <repo url> <from commit> <to commit> <out dir>          print generate's estimate only
//   npm run measure -- <repo url> <from commit> <to commit> <out dir> --yes    run both and compare
//
// The out dir holds the clone, both usage logs and both CLI transcripts. Without --yes it clones and
// runs `init`, then prints generate's estimate and spends nothing beyond a one-token check that the
// key works; rerun with --yes on the same out dir to go ahead. A finished out dir is never reused,
// since a second run would find its responses cached and measure nothing.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../src/llm.ts";
import { readLog, report, totals } from "./usage.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const yes = args.includes("--yes");
const [url, from, to, outArg] = args.filter((a) => a !== "--yes");
if (!url || !from || !to || !outArg) {
  console.error("Usage: npm run measure -- <repo url> <from commit> <to commit> <out dir> [--yes]");
  process.exit(1);
}
const out = resolve(outArg);
const repo = join(out, "repo");
const log = (run) => join(out, `${run}.log`);

const npmCli = process.env.npm_execpath;
if (!npmCli) fail("Run this through npm: npm run measure -- ...");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
if (!process.env.ANTHROPIC_API_KEY) fail("Set ANTHROPIC_API_KEY, in the environment or in .env, before measuring.");
if (existsSync(log("generate"))) fail(`${out} already holds a measured run; give a new out dir.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const git = (...gitArgs) => run("git", gitArgs, repo);

/** Runs the CLI in the clone, echoing and keeping its output; stdin is closed, so without --yes it declines. */
function scribe(command, flags, usageLog) {
  const cli = join(root, "dist", "cli.js");
  const nodeArgs = [...(usageLog ? ["--import", pathToFileURL(join(root, "scripts", "usage-log.mjs")).href] : []), cli, command, ...flags];
  return new Promise((done) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: repo,
      env: { ...process.env, ...(usageLog ? { USAGE_LOG: usageLog } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        text += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on("close", (code) => done({ code, text }));
  });
}

/** The dollars and tokens of the estimate a CLI transcript printed. */
function shownEstimate(text) {
  const match = /Estimated cost: \$([\d.]+) for .*?, about ([\d,]+) tokens/.exec(text);
  return match ? { dollars: Number(match[1]), tokens: Number(match[2].replaceAll(",", "")) } : undefined;
}

// A key with no credit fails here, on one token, before a run spends anything.
try {
  await new Anthropic().messages.create({ model: MODELS.verify, max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
} catch (error) {
  fail(`The API key can't be used: ${error instanceof Error ? error.message : String(error)}`);
}

console.log("Building Scribe...");
run(process.execPath, [npmCli, "run", "--silent", "build"], root);

if (!existsSync(repo)) {
  mkdirSync(out, { recursive: true });
  run("git", ["clone", "--quiet", url, repo], out);
  git("switch", "--quiet", "--detach", from);
  git("switch", "--quiet", "-c", "measure");
  const init = await scribe("init", []);
  if (init.code !== 0) fail("scribe init failed.");
  git("add", "-A");
  git("commit", "--quiet", "-m", "scribe init");
}

if (!yes) {
  await scribe("generate", []);
  console.log(`\nNothing spent but the key check. The update's estimate comes once generate has run. To spend, rerun with --yes on ${out}.`);
  process.exit(0);
}

const results = [];
for (const [runName, before] of [["generate", () => {}], ["update", () => {
  git("add", "-A");
  git("commit", "--quiet", "-m", "scribe generate");
  git("merge", "--quiet", "--no-ff", "--no-edit", to);
}]]) {
  before();
  const { code, text } = await scribe(runName, ["--yes"], log(runName));
  writeFileSync(join(out, `${runName}.out`), text);
  const spent = existsSync(log(runName)) ? totals(readLog(log(runName))) : undefined;
  results.push({ runName, code, shown: shownEstimate(text), spent });
  if (code !== 0) break;
}

console.log("");
for (const { runName, code, spent } of results) {
  console.log(`== ${runName}${code === 0 ? "" : ` (exited ${code}; see ${join(out, `${runName}.out`)})`}`);
  if (spent) console.log(report(spent));
}
console.log("\n| Run | Estimate shown | Actually spent | Estimate vs actual |\n| --- | --- | --- | --- |");
for (const { runName, shown, spent } of results) {
  const est = shown ? `$${shown.dollars.toFixed(2)}, about ${shown.tokens.toLocaleString("en-US")} tokens` : "none shown";
  const act = spent ? `$${spent.dollars.toFixed(2)}, ${spent.tokens.toLocaleString("en-US")} tokens` : "nothing logged";
  const percent = shown && spent && spent.dollars > 0 ? Math.round((shown.dollars / spent.dollars - 1) * 100) : undefined;
  const diff = percent === undefined ? "n/a" : `${percent > 0 ? "+" : ""}${percent}%`;
  console.log(`| \`${runName}\` | ${est} | ${act} | ${diff} |`);
}
console.log(`\nLogs and transcripts: ${out}`);
