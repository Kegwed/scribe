// Totals a usage log written by scripts/usage-log.mjs into what the run actually spent, priced with
// Scribe's own price table, so it compares like for like with the estimate the CLI showed.
//
//   node scripts/spend.mjs run.log
import { readFileSync } from "node:fs";
import { priceTokens } from "../src/llm.ts";

// Anthropic bills a cache write at 1.25 times the input price and a cache read at 0.1 times.
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/spend.mjs <usage log>");
  process.exit(1);
}

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const byModel = {};
const unpriced = new Set();
let dollars = 0;
let tokens = 0;

for (const row of rows) {
  if (row.logError) {
    console.error(`log error: ${row.logError}`);
    continue;
  }
  const model = row.model ?? "unknown";
  const totals = (byModel[model] ??= { requests: 0, failed: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  totals.requests++;
  if (row.status !== 200) totals.failed++;
  for (const field of ["input", "cacheWrite", "cacheRead", "output"]) totals[field] += row[field];

  tokens += row.input + row.cacheWrite + row.cacheRead + row.output;
  const billedInput = row.input + row.cacheWrite * CACHE_WRITE + row.cacheRead * CACHE_READ;
  const cost = priceTokens(model, billedInput, row.output).dollars;
  if (cost === undefined) unpriced.add(model);
  else dollars += cost;
}

console.log(JSON.stringify(byModel, null, 2));
console.log(`${rows.length} responses, ${tokens.toLocaleString("en-US")} tokens, $${dollars.toFixed(2)}`);
if (unpriced.size > 0) console.log(`Not priced (unknown model): ${[...unpriced].join(", ")}`);
