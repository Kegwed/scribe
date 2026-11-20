// What a usage log from scripts/usage-log.mjs says a run spent: by model, by request kind and by Section.
// Shared by scripts/spend.mjs and scripts/measure.mjs.
import { readFileSync } from "node:fs";
import { DRIFT_SCHEMA, VERIFY_DRIFT_SYSTEM } from "../src/drift.ts";
import { SUMMARY_SCHEMA } from "../src/fit.ts";
import { ATTACH_SCHEMA } from "../src/human-claims.ts";
import { priceTokens } from "../src/llm.ts";
import { SECTION_SCHEMA, VERDICT_SCHEMA } from "../src/prompts.ts";

// Anthropic bills a cache write at 1.25 times the input price and a cache read at 0.1 times.
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

// Each kind of request asks for its own output schema, so the schema names the kind exactly.
const KINDS = [
  ["write", SECTION_SCHEMA],
  ["verdict", VERDICT_SCHEMA],
  ["summary", SUMMARY_SCHEMA],
  ["drift", DRIFT_SCHEMA],
  ["attach", ATTACH_SCHEMA],
].map(([kind, schema]) => [kind, JSON.stringify(schema)]);

/**
 * The kind of a Messages request from its JSON body: a Drift's verdict is a
 * "drift-verdict", and a write carries its prompt's first line, which names its
 * Module or Section. A Key decisions, Getting started or Conventions write asks
 * for a schema of its own, so it is "other", with its first line too.
 */
export function classify(body) {
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    return { kind: "unknown" };
  }
  const schema = JSON.stringify(request.output_config?.format?.schema);
  const kind = KINDS.find(([, known]) => known === schema)?.[0] ?? "other";
  const system = typeof request.system === "string" ? request.system : "";
  if (kind === "verdict" && system === VERIFY_DRIFT_SYSTEM) return { kind: "drift-verdict" };
  if (kind !== "write" && kind !== "other") return { kind };
  const prompt = request.messages?.[0]?.content;
  const head = typeof prompt === "string" ? prompt.split("\n")[0].slice(0, 100) : undefined;
  return { kind, head };
}

/**
 * Totals the rows of a usage log. Scribe writes one Section at a time, so each
 * request is attributed by its place in the log: a summary to the next write,
 * anything else to the last write. A write straight after another of the same
 * Section is its repair; verdicts sent after it re-verify the Claims it rewrote.
 * A Section whose write was cached has no write in the log, so its other
 * requests land on the Section before it.
 */
export function totals(rows) {
  const byModel = {};
  const byKind = {};
  const sections = [];
  const unpriced = new Set();
  const errors = [];
  let pendingSummaries = [];
  let tokens = 0;
  let dollars = 0;
  let current;

  for (const row of rows) {
    if (row.logError) {
      errors.push(row.logError);
      continue;
    }
    const model = row.model ?? "unknown";
    const m = (byModel[model] ??= { requests: 0, failed: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    m.requests++;
    if (row.status !== 200) m.failed++;
    for (const field of ["input", "cacheWrite", "cacheRead", "output"]) m[field] += row[field];

    const rowTokens = row.input + row.cacheWrite + row.cacheRead + row.output;
    const billedInput = row.input + row.cacheWrite * CACHE_WRITE + row.cacheRead * CACHE_READ;
    const cost = priceTokens(model, billedInput, row.output).dollars;
    if (cost === undefined) unpriced.add(model);
    tokens += rowTokens;
    dollars += cost ?? 0;

    let kind = row.kind ?? "unknown";
    const priced = { tokens: rowTokens, dollars: cost ?? 0 };
    if (kind === "write" || kind === "other") {
      if (current && current.section === row.head && current.repairs === 0 && !current.closed) {
        kind = "repair";
        current.repairs++;
      } else {
        if (current) current.closed = true;
        current = { section: row.head ?? "unknown", writes: 0, repairs: 0, verdicts: 0, reverdicts: 0, summaries: 0, drift: 0, driftVerdicts: 0, tokens: 0, dollars: 0 };
        sections.push(current);
        current.writes++;
        for (const s of pendingSummaries) add(current, s);
        current.summaries += pendingSummaries.length;
        pendingSummaries = [];
      }
      add(current, priced);
    } else if (kind === "summary") {
      pendingSummaries.push(priced);
    } else if (current) {
      if (kind === "verdict") current[current.repairs > 0 ? "reverdicts" : "verdicts"]++;
      if (kind === "drift") current.drift++;
      if (kind === "drift-verdict") current.driftVerdicts++;
      // A Drift search ends its Section: a write after it is the next Section's, even if it names the same one.
      if (kind === "drift") current.closed = true;
      add(current, priced);
    }
    const k = (byKind[kind] ??= { requests: 0, tokens: 0, dollars: 0 });
    k.requests++;
    k.tokens += rowTokens;
    k.dollars += cost ?? 0;
  }
  for (const s of sections) delete s.closed;
  return { responses: rows.length - errors.length, tokens, dollars, unpriced: [...unpriced], errors, byModel, byKind, sections, unattributedSummaries: pendingSummaries.length };
}

function add(section, { tokens, dollars }) {
  section.tokens += tokens;
  section.dollars += dollars;
}

export function readLog(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** A run's totals as text: by model, by kind and by Section. */
export function report({ responses, tokens, dollars, unpriced, errors, byModel, byKind, sections, unattributedSummaries }) {
  const lines = [];
  for (const error of errors) lines.push(`log error: ${error}`);
  lines.push(JSON.stringify(byModel, null, 2));
  const unknown = byKind.unknown?.requests ?? 0;
  lines.push("", "By kind:");
  for (const [kind, k] of Object.entries(byKind)) lines.push(`  ${kind.padEnd(14)} ${String(k.requests).padStart(4)} requests  ${k.tokens.toLocaleString("en-US").padStart(10)} tokens  $${k.dollars.toFixed(2)}`);
  if (unknown > 0) lines.push(`  (${unknown} rows carry no kind: logged before usage-log.mjs recorded kinds)`);
  if (sections.length > 0) {
    lines.push("", "By Section, attributed by order (verdicts before repair / after it):");
    for (const s of sections) {
      lines.push(`  ${s.section}`);
      lines.push(`    ${s.writes} write, ${s.repairs} repair, ${s.verdicts} / ${s.reverdicts} verdicts, ${s.summaries} summaries, ${s.drift} Drift searches, ${s.driftVerdicts} Drift verdicts; ${s.tokens.toLocaleString("en-US")} tokens, $${s.dollars.toFixed(2)}`);
    }
  }
  if (unattributedSummaries > 0) lines.push(`  ${unattributedSummaries} summaries came after the last write`);
  lines.push("", `${responses} responses, ${tokens.toLocaleString("en-US")} tokens, $${dollars.toFixed(2)}`);
  if (unpriced.length > 0) lines.push(`Not priced (unknown model): ${unpriced.join(", ")}`);
  return lines.join("\n");
}
