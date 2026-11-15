import type { Adapters } from "../adapters.ts";
import { confirmed, type CostEstimate, type RunOptions, totalCost } from "../estimate.ts";
import { CACHE_DIR } from "../manifest.ts";
import { emptyReport, sectionWriter } from "../section-writer.ts";
import { clearProposal, sectionModule, openTarget, readSection, sectionDiscussions, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface AdoptResult {
  /** The adopted Section's Claims for which the verifier found no Evidence; kept in the Section, never deleted. */
  unsupportedClaims: { section: string; text: string }[];
  /** The Section's pending Proposal, deleted because the adopted text is now the baseline. */
  clearedProposal?: string;
  /** Problems the maintainer should fix by hand, such as GitHub being unreachable. */
  warnings: string[];
  /** What adopting the Section was expected to cost. */
  estimate: CostEstimate;
  /** The estimate was declined, so no LLM was called and nothing was written. */
  declined: boolean;
}

/**
 * Takes a Section's text as a human left it as the new baseline, so it is no
 * longer Frozen: Evidence is recorded for each Claim the verifier can back, and
 * the rest are recorded as Unsupported Claims. The text itself is never changed (ADR-0002).
 */
export async function adopt(
  repoDir: string,
  section: string,
  { confirm }: RunOptions,
  { llm, github }: Adapters,
): Promise<AdoptResult> {
  const target = await openTarget(repoDir);
  const module = sectionModule(target, section);
  const path = sectionPath(target.config, section);
  const content = await readSection(repoDir, path);
  if (content === undefined) throw new Error(`${path} doesn't exist, so there is nothing to adopt; scribe reset ${section} writes it`);

  const report = emptyReport();
  const { discussions, saveCache } = await sectionDiscussions(repoDir, section, module, github, report.warnings);
  const writer = sectionWriter(repoDir, target, llm, report, discussions);
  const estimate: CostEstimate = totalCost([writer.estimateAdopt(section, content)]);
  if (!(await confirmed(estimate, confirm))) return { unsupportedClaims: [], warnings: report.warnings, estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  await saveCache();
  const unsupported = await writer.adopt(section, content);
  const clearedProposal = await clearProposal(repoDir, target.config, section);
  return {
    unsupportedClaims: unsupported.map((text) => ({ section, text })),
    ...(clearedProposal ? { clearedProposal } : {}),
    warnings: report.warnings,
    estimate,
    declined: false,
  };
}
