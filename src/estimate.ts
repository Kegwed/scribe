import { estimateCost, inputTokens, type LlmRequest, OUTPUT_LIMITS, priceTokens, type RequestCost } from "./llm.ts";
import { BOTTOM_UP } from "./prompts.ts";

/** What estimates one Section's cost, as a SectionWriter does. */
interface SectionEstimator {
  estimate(section: string, existing: string | undefined, changedEvidence?: string[], moduleSectionsChange?: boolean): SectionCost;
}

/**
 * How many requests of each kind a run is expected to send. A count is
 * fractional where only some are expected, such as a repair, which a Section
 * needs only when one of its Claims fails verification.
 */
export type RequestCounts = Partial<Record<LlmRequest["kind"], number>>;

/**
 * What a run is expected to cost before any LLM call, Section by Section; work
 * already cached costs nothing. An estimate, not a quote: how many Claims a
 * Section gets, and so how many verdicts and repairs it needs, is known only
 * once it is written.
 */
export interface CostEstimate {
  sections: SectionCost[];
  tokens: number;
  /** US dollars, leaving out the tokens of `unpriced` models. */
  dollars: number;
  /** Models from the config whose price Scribe doesn't know. */
  unpriced: string[];
  requests: RequestCounts;
  /** Claims the run's writes are expected to make. */
  claims: number;
}

export interface SectionCost {
  section: string;
  tokens: number;
  /** US dollars, leaving out the tokens of `unpriced` models. */
  dollars: number;
  unpriced: string[];
  requests: RequestCounts;
  /** Claims its write is expected to make, each verified by a verdict of its own. */
  claims: number;
  /**
   * Why it costs nothing, when it doesn't: its requests are cached, or it has
   * no Evidence and so is written without the LLM.
   */
  free?: "cached" | "no-evidence";
}

export function totalCost(sections: SectionCost[]): CostEstimate {
  return {
    sections,
    tokens: sections.reduce((sum, s) => sum + s.tokens, 0),
    dollars: sections.reduce((sum, s) => sum + s.dollars, 0),
    unpriced: [...new Set(sections.flatMap((s) => s.unpriced))],
    requests: countByKind(sections.flatMap((s) => Object.entries(s.requests) as [LlmRequest["kind"], number][])),
    claims: sections.reduce((sum, s) => sum + s.claims, 0),
  };
}

/** Requests of `kind` expected `count` times, a fraction when they may not be sent at all, at `cost` each. */
export interface ExpectedRequests {
  kind: LlmRequest["kind"];
  count: number;
  cost: RequestCost;
}

function oneRequest(kind: LlmRequest["kind"], cost: RequestCost): ExpectedRequests {
  return { kind, count: 1, cost };
}

/** A cost estimate of one Section, from the requests it is expected to send and the Claims it is expected to make. */
export function sectionCost(section: string, expected: ExpectedRequests[], claims: number): SectionCost {
  const sent = expected.filter(({ count }) => count > 0);
  let tokens = 0;
  let dollars = 0;
  const unpriced = new Set<string>();
  for (const { kind, count, cost } of sent) {
    // A response cut off at its limit costs its input and the limit's output, and the retry costs what the request does.
    const cutOff = priceTokens(cost.model, cost.input, OUTPUT_LIMITS[kind]);
    tokens += (cost.tokens + cutOff.tokens * CUT_OFF_RATE) * count;
    if (cost.dollars === undefined) unpriced.add(cost.model);
    else dollars += (cost.dollars + cutOff.dollars! * CUT_OFF_RATE) * count;
  }
  const requests = countByKind(sent.map(({ kind, count }) => [kind, count]));
  return { section, tokens: Math.round(tokens), dollars, unpriced: [...unpriced], requests, claims };
}

/** The requests of each kind, summed. */
function countByKind(counts: [LlmRequest["kind"], number][]): RequestCounts {
  const requests: RequestCounts = {};
  for (const [kind, count] of counts) requests[kind] = (requests[kind] ?? 0) + count;
  return requests;
}

/**
 * Asked with a run's estimate before any LLM call, and the warnings the run
 * has raised so far, such as GitHub being skipped, which the estimate already
 * reflects; the run goes ahead only on true.
 */
export type Confirm = (estimate: CostEstimate, warnings: string[]) => Promise<boolean>;

/** Options of a run that writes the Guide, such as `generate` or `update`. */
export interface RunOptions {
  /**
   * Asked before any LLM call, unless the run costs nothing; the run stops
   * there, changing no files, unless it answers true. Without it the run goes ahead.
   */
  confirm?: Confirm;
}

/** Whether a run may go ahead: one that costs nothing always may, and so may one nobody is asked about. */
export async function confirmed(estimate: CostEstimate, confirm: Confirm | undefined, warnings: string[]): Promise<boolean> {
  return estimate.tokens === 0 || !confirm || (await confirm(estimate, [...warnings]));
}

/**
 * Estimates the Sections a run will write, in the order it writes them.
 * Overview and Architecture are written from the Module Sections, so once a
 * Module Section ahead of them is to be rewritten at a cost, their requests
 * can't be the ones already cached.
 */
export function estimateRun(
  writer: SectionEstimator,
  planned: { section: string; existing: string | undefined; changed?: string[] }[],
): CostEstimate {
  const costs: SectionCost[] = [];
  for (const { section, existing, changed } of planned) {
    const moduleSectionsChange = isBottomUp(section) && costs.some((c) => c.tokens > 0 && !isBottomUp(c.section));
    costs.push(writer.estimate(section, existing, changed, moduleSectionsChange));
  }
  return totalCost(costs);
}

/** Whether a Section is Overview or Architecture, built from the Module Sections. */
function isBottomUp(section: string): boolean {
  return Object.hasOwn(BOTTOM_UP, section);
}

/** A symbol's summary. */
export function summaryRequest(request: LlmRequest): ExpectedRequests {
  return oneRequest("summary", estimateCost(request, SUMMARY_OUTPUT_TOKENS));
}

/** The request naming the Evidence for each of a human's Claims. */
export function attachRequest(request: LlmRequest): ExpectedRequests {
  return oneRequest("attach", estimateCost(request, ATTACH_OUTPUT_TOKENS));
}

/** A search of a Module's docs and code for Drift, and a verdict at `verdict` on each Drift it is expected to find. */
export function driftSearch(request: LlmRequest, verdict: RequestCost): ExpectedRequests[] {
  return [oneRequest("drift", estimateCost(request, DRIFT_OUTPUT_TOKENS)), { kind: "verdict", count: DRIFT_PER_SEARCH, cost: verdict }];
}

/** A verdict for each of `requests`. */
export function verdicts(requests: LlmRequest[]): ExpectedRequests[] {
  return requests.map((request) => oneRequest("verdict", verdictCost(request)));
}

/**
 * A Section's write from `request` and the Claims it is expected to make: the
 * first write, the Section's one repair, sent when any Claim fails, and their
 * verdicts at `verdict` each. Every Claim is verified anew, even a revision's:
 * rewritten, its Claims miss the verdicts cached for the Section before. A
 * revision's Claims fail more rarely than a first write's.
 */
export function expectedWrite(
  request: LlmRequest,
  revises: boolean,
  verdict: RequestCost,
): { claims: number; requests: ExpectedRequests[] } {
  const input = inputTokens(request);
  const claims = expectedClaims(input);
  const output = claims * OUTPUT_TOKENS_PER_CLAIM;
  const failureRate = revises ? REVISION_FAILURE_RATE : CLAIM_FAILURE_RATE;
  const failing = claims * failureRate;
  // The repair's prompt carries the first prompt, the first answer and why each Claim failed.
  const repairChance = 1 - (1 - failureRate) ** claims;
  const repairInput = input + output + (repairChance > 0 ? (failing / repairChance) * FAILURE_TOKENS : 0);
  return {
    claims,
    requests: [
      oneRequest("write", priceTokens(request.model, input, output)),
      { kind: "write", count: repairChance, cost: priceTokens(request.model, repairInput, output) },
      // The first verification's verdicts, then those of the Claims the repair rewrote.
      { kind: "verdict", count: claims + failing, cost: verdict },
    ],
  };
}

/**
 * The characters of prose, citations stripped, that a Module Section written
 * from `request` is expected to have: those of the Claims it is expected to make.
 */
export function expectedProseChars(request: LlmRequest): number {
  return Math.round(expectedClaims(inputTokens(request)) * SECTION_CHARS_PER_CLAIM);
}

/**
 * A verdict on a Claim not yet written, or on a Drift not yet found, from
 * `request`, built with an empty Claim citing nothing: it is expected to carry
 * a Module Section's prose per Claim, and about `CITED_PER_CLAIM` pieces of the average size of `evidence`,
 * rendered as the verifier sees them.
 */
export function unwrittenVerdict(request: LlmRequest, evidence: string[]): RequestCost {
  return verdictCost(request, SECTION_CHARS_PER_CLAIM + citedChars(evidence));
}

/** A verdict on a Claim whose Evidence isn't found yet, from `request`, built with the Claim citing nothing: it carries Evidence as `unwrittenVerdict`'s does. */
export function uncitedVerdict(request: LlmRequest, evidence: string[]): ExpectedRequests {
  return oneRequest("verdict", verdictCost(request, citedChars(evidence)));
}

/** A verdict from `request`, `extraChars` longer than it is for text it will carry. */
function verdictCost(request: LlmRequest, extraChars = 0): RequestCost {
  return priceTokens(request.model, inputTokens(request, extraChars), VERDICT_OUTPUT_TOKENS);
}

/** The characters of about `CITED_PER_CLAIM` pieces of the average size of `evidence`. */
function citedChars(evidence: string[]): number {
  return Math.round((evidence.join("").length / Math.max(evidence.length, 1)) * Math.min(CITED_PER_CLAIM, evidence.length));
}

/*
 * Each size and rate below is marked measured or assumed. "On hono" means the
 * #28 measurement: a `generate` of honojs/hono (9 Modules, 14 Sections, 687
 * requests) and the `update` after it, with Claude's usage logged per request.
 * "Hono's #37 `update`" means a later measurement of that `update`, from
 * 61f7c59e to f6fbaf02, which rewrote 3 Sections in 130 requests.
 */

/**
 * Claims a Section's write is expected to make, from the tokens of its prompt.
 * Measured: on hono, a prompt of about 7,000 tokens gave about 15 Claims, and
 * one of 165,000 gave 45; this curve fits both.
 */
function expectedClaims(promptTokens: number): number {
  return 0.67 * Math.max(promptTokens, 1) ** 0.35;
}

/** Output tokens a write spends per Claim, citations included. Measured: about 126 on hono's first writes and 172 on its repairs. */
const OUTPUT_TOKENS_PER_CLAIM = 150;
/** Characters of a Module Section's prose per Claim, once its citations are stripped. Measured: about 180 on hono. */
const SECTION_CHARS_PER_CLAIM = 180;
/** The share of Claims a first verification fails, each failure calling for the Section's one repair. Measured: 76 of 259 on hono. */
const CLAIM_FAILURE_RATE = 0.3;
/**
 * The share of a revision's Claims a first verification fails. Measured on
 * hono's #37 `update` (logged by kind with `scripts/measure.mjs`): its 3
 * revisions sent 103 verdicts on their first writes and 13 on the Claims their
 * repairs rewrote, about 13%, and 2 of the 3 were repaired. #31's run of the
 * same `update`, its kinds inferred from request order, came to about 15%,
 * the rate #37's estimate ran with, within 1% of what it spent.
 */
const REVISION_FAILURE_RATE = 0.15;
/** Tokens a repair prompt adds per failed Claim, for its text and the verifier's reason. Assumed; not measured. */
const FAILURE_TOKENS = 150;
/** Output tokens of one verdict. Measured: about 450 on hono. */
const VERDICT_OUTPUT_TOKENS = 450;
/** Pieces of Evidence a Claim is expected to cite, so its verdict carries them. Assumed; not measured. */
const CITED_PER_CLAIM = 2;
/** Output tokens of one summary. Measured: about 210 on hono. */
const SUMMARY_OUTPUT_TOKENS = 200;
/** Output tokens of the answer naming the Evidence for each of a human's Claims. Assumed; not measured. */
const ATTACH_OUTPUT_TOKENS = 500;
/**
 * Output tokens of a Drift search's answer. Assumed; not measured. Most answers
 * are short: 8 of hono's 10 Drift searches found no Drift.
 */
const DRIFT_OUTPUT_TOKENS = 500;
/**
 * The share of responses cut off at their output limit, each retried once.
 * Measured: 1 of 1,035 on hono, the #28 `generate` and `update` and the failed
 * #31 `generate`, whose runaway summary ran to 64,000 tokens.
 */
const CUT_OFF_RATE = 0.001;
/** Drift a search is expected to find, each verified by a verdict of its own. Measured: hono's 10 Drift searches found 4. */
const DRIFT_PER_SEARCH = 0.4;
