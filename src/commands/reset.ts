import type { Adapters } from "../adapters.ts";
import { confirmed, type CostEstimate, estimateRun, type RunOptions } from "../estimate.ts";
import { CACHE_DIR } from "../manifest.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { clearProposal, sectionModule, openTarget, readSection, sectionDiscussions, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface ResetResult extends WriteReport {
  /** The Section's pending Proposal, deleted because the Section is regenerated. */
  clearedProposal?: string;
  /** What writing the Section was expected to cost. */
  estimate: CostEstimate;
  /** The estimate was declined, so nothing was written and no Proposal cleared. */
  declined: boolean;
}

/**
 * Discards a human's edits to a Section and writes it afresh from the code,
 * verified like any other, so it is no longer Frozen (ADR-0002).
 */
export async function reset(
  repoDir: string,
  section: string,
  { confirm }: RunOptions,
  { llm, github }: Adapters,
): Promise<ResetResult> {
  const target = await openTarget(repoDir);
  const module = sectionModule(target, section);
  const existing = await readSection(repoDir, sectionPath(target.config, section));
  const report = emptyReport();
  const { discussions, saveCache } = await sectionDiscussions(repoDir, section, module, github, report.warnings);
  const writer = sectionWriter(repoDir, target, llm, report, discussions);

  // An adopted record can carry Unsupported Claims, so it is replaced even if the text comes out the same.
  const record = target.manifest.sections[section];
  const previous = record?.adopted || record?.unsupportedClaims ? undefined : existing;
  const estimate = estimateRun(writer, [{ section, existing: previous }]);
  if (!(await confirmed(estimate, confirm, report.warnings))) return { ...report, estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  await saveCache();
  await writer.write(section, previous);
  const result: ResetResult = { ...report, estimate, declined: false };
  const clearedProposal = await clearProposal(repoDir, target.config, section);
  if (clearedProposal) result.clearedProposal = clearedProposal;
  return result;
}
