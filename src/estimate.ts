import { BOTTOM_UP } from "./prompts.ts";

/** What estimates one Section's cost, as a SectionWriter does. */
interface SectionEstimator {
  estimate(section: string, existing: string | undefined, changedEvidence?: string[], moduleSectionsChange?: boolean): SectionCost;
}

/** What a run is expected to cost before any LLM call, Section by Section; work already cached costs nothing. */
export interface CostEstimate {
  sections: SectionCost[];
  tokens: number;
  /** US dollars, leaving out the tokens of `unpriced` models. */
  dollars: number;
  /** Models from the config whose price Scribe doesn't know. */
  unpriced: string[];
}

export interface SectionCost {
  section: string;
  tokens: number;
  /** US dollars, leaving out the tokens of `unpriced` models. */
  dollars: number;
  unpriced: string[];
}

export function totalCost(sections: SectionCost[]): CostEstimate {
  return {
    sections,
    tokens: sections.reduce((sum, s) => sum + s.tokens, 0),
    dollars: sections.reduce((sum, s) => sum + s.dollars, 0),
    unpriced: [...new Set(sections.flatMap((s) => s.unpriced))],
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

/** Assumed sizes of a written Section, of all its verdicts together and of one summary, for the cost estimate; not measured. */
export const WRITE_OUTPUT_TOKENS = 2000;
export const VERDICT_OUTPUT_TOKENS = 500;
export const SUMMARY_OUTPUT_TOKENS = 150;
/** Assumed size of the answer naming the Evidence for each of a human's Claims, for the cost estimate; not measured. */
export const ATTACH_OUTPUT_TOKENS = 500;

/** Assumed size of a Drift search's answer, for the cost estimate; not measured. */
export const DRIFT_OUTPUT_TOKENS = 500;
