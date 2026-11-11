// Runs generate with the live LLM on every repo in eval/repos.json and appends
// the confirmed-Claim rates to eval/results.jsonl. Spends real money: each
// repo's cost estimate is shown and asked about first, unless --yes is given.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { liveEval, runEval } from "../src/eval.ts";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

// The Anthropic SDK reads ANTHROPIC_API_KEY from the environment only; a git-ignored .env can supply it.
if (existsSync(root(".env"))) process.loadEnvFile(root(".env"));
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY, in the environment or in .env, before running the eval.");
  process.exit(1);
}

const yes = process.argv.includes("--yes");
// A url starting with "." is a path relative to Scribe's own repo, so "." is Scribe itself.
const repos = JSON.parse(readFileSync(root("eval/repos.json"), "utf8"))
  .map((repo) => (repo.url.startsWith(".") ? { ...repo, url: root(repo.url) } : repo));

async function confirm({ dollars, tokens }) {
  console.log(`Estimated cost: $${dollars.toFixed(2)}, about ${tokens.toLocaleString("en-US")} tokens`);
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question("Continue? [y/N] ")).trim());
  } finally {
    rl.close();
  }
}

const deps = liveEval(root(".eval"), root("eval/results.jsonl"), confirm);
const run = await runEval(repos, {
  ...deps,
  async generate(dir) {
    console.log(`\n${dir}`);
    return deps.generate(dir);
  },
});
if (!run) {
  console.log("Cancelled; nothing was recorded.");
  process.exit(1);
}
const percent = (rate) => (rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`);
for (const { name, written, confirmedRate, keptRate } of [...run.repos, { name: "overall", ...run.overall }]) {
  console.log(`${name}: ${written} Claims, ${percent(confirmedRate)} confirmed first time, ${percent(keptRate)} kept`);
}
console.log("Appended to eval/results.jsonl.");
