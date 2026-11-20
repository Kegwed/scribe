// Totals a usage log written by scripts/usage-log.mjs into what the run actually spent, priced with
// Scribe's own price table, so it compares like for like with the estimate the CLI showed. Breaks it
// down by model, by request kind and by Section.
//
//   node scripts/spend.mjs run.log
import { readLog, report, totals } from "./usage.mjs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/spend.mjs <usage log>");
  process.exit(1);
}

console.log(report(totals(readLog(file))));
