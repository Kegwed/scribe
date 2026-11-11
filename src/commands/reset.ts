import type { Adapters } from "../adapters.ts";
import { CACHE_DIR } from "../manifest.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { clearProposal, openTarget, readSection, sectionModule, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface ResetOptions {}

export interface ResetResult extends WriteReport {
  /** The Section's pending Proposal, deleted because the Section is regenerated. */
  clearedProposal?: string;
}

/**
 * Discards a human's edits to a Section and writes it afresh from the code,
 * verified like any other, so it is no longer Frozen (ADR-0002).
 */
export async function reset(
  repoDir: string,
  section: string,
  _options: ResetOptions,
  { llm }: Pick<Adapters, "llm">,
): Promise<ResetResult> {
  const target = await openTarget(repoDir);
  const module = sectionModule(target, section);
  await gitIgnore(repoDir, CACHE_DIR);
  const result: ResetResult = emptyReport();

  const existing = await readSection(repoDir, sectionPath(target.config, section));
  // An adopted record carries Unsupported Claims, so it is replaced even if the text comes out the same.
  const previous = target.manifest.sections[section]?.unsupportedClaims ? undefined : existing;
  await sectionWriter(repoDir, target, llm, result).write(module, previous);
  const clearedProposal = await clearProposal(repoDir, target.config, section);
  if (clearedProposal) result.clearedProposal = clearedProposal;
  return result;
}
