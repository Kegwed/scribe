import type { LlmRequest } from "./llm.ts";
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
}

export function totalCost(sections: SectionCost[]): CostEstimate {
  const requests: RequestCounts = {};
  for (const s of sections) {
    for (const [kind, count] of Object.entries(s.requests) as [LlmRequest["kind"], number][]) requests[kind] = (requests[kind] ?? 0) + count;
  }
  return {
    sections,
    tokens: sections.reduce((sum, s) => sum + s.tokens, 0),
    dollars: sections.reduce((sum, s) => sum + s.dollars, 0),
    unpriced: [...new Set(sections.flatMap((s) => s.unpriced))],
    requests,
    claims: sections.reduce((sum, s) => sum + s.claims, 0),
  };
}

/** Asked with a run's estimate before any LLM call; the run goes ahead only on true. */
export type Confirm = (estimate: CostEstimate) => Promise<boolean>;

/** Options of a run that writes the Guide, such as `generate` or `update`. */
export interface RunOptions {
  /**
   * Asked before any LLM call, unless the run costs nothing; the run stops
   * there, changing no files, unless it answers true. Without it the run goes ahead.
   */
  confirm?: Confirm;
}

/** Whether a run may go ahead: one that costs nothing always may, and so may one nobody is asked about. */
export async function confirmed(estimate: CostEstimate, confirm: Confirm | undefined): Promise<boolean> {
  return estimate.tokens === 0 || !confirm || (await confirm(estimate));
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

/*
 * The sizes and rates below were measured on a `generate` of honojs/hono
 * (9 Modules, 14 Sections, 687 requests) and the `update` after it.
 */

/**
 * Claims a Section's write is expected to make, from the tokens of its prompt:
 * more Evidence gives more Claims, though far from in proportion. On hono, a
 * prompt of about 7,000 tokens gave about 15 Claims, and one of 165,000 gave 45.
 */
export function expectedClaims(promptTokens: number): number {
  return 0.67 * Math.max(promptTokens, 1) ** 0.35;
}

/** Output tokens a write spends per Claim, citations included; about 126 on hono's first writes and 172 on its repairs. */
export const OUTPUT_TOKENS_PER_CLAIM = 150;
/** Characters of a Module Section's prose per Claim, once its citations are stripped: about 180 on hono. */
export const SECTION_CHARS_PER_CLAIM = 180;
/** The share of Claims a first verification fails, each failure calling for the Section's one repair: 76 of 259 on hono. */
export const CLAIM_FAILURE_RATE = 0.3;
/**
 * The share of a revision's newly verified Claims that fail: none of 31 on
 * hono's `update`, since a revision builds on Claims already verified; assumed
 * one in twenty.
 */
export const REVISION_FAILURE_RATE = 0.05;
/** Tokens a repair prompt adds per failed Claim, for its text and the verifier's reason. */
export const FAILURE_TOKENS = 150;
/** Output tokens of one verdict: about 450 on hono. */
export const VERDICT_OUTPUT_TOKENS = 450;
/** Pieces of Evidence a Claim is expected to cite, so its verdict carries them. */
export const CITED_PER_CLAIM = 2;
/** Output tokens of one summary: about 210 on hono. */
export const SUMMARY_OUTPUT_TOKENS = 200;
/** Assumed size of the answer naming the Evidence for each of a human's Claims, for the cost estimate; not measured. */
export const ATTACH_OUTPUT_TOKENS = 500;

/** Assumed size of a Drift search's answer, for the cost estimate; most find nothing. */
export const DRIFT_OUTPUT_TOKENS = 500;
