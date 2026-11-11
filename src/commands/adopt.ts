import type { Adapters } from "../adapters.ts";
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
}

/**
 * Takes a Section's text as a human left it as the new baseline, so it is no
 * longer Frozen: Evidence is recorded for each Claim the verifier can back, and
 * the rest are recorded as Unsupported Claims. The text itself is never changed (ADR-0002).
 */
export async function adopt(
  repoDir: string,
  section: string,
  { llm, github }: Adapters,
): Promise<AdoptResult> {
  const target = await openTarget(repoDir);
  const module = sectionModule(target, section);
  const path = sectionPath(target.config, section);
  const content = await readSection(repoDir, path);
  if (content === undefined) throw new Error(`${path} doesn't exist, so there is nothing to adopt; scribe reset ${section} writes it`);
  await gitIgnore(repoDir, CACHE_DIR);

  const report = emptyReport();
  const { discussions, saveCache } = await sectionDiscussions(repoDir, section, module, github, report.warnings);
  await saveCache();
  const unsupported = await sectionWriter(repoDir, target, llm, report, discussions).adopt(section, content);
  const clearedProposal = await clearProposal(repoDir, target.config, section);
  return {
    unsupportedClaims: unsupported.map((text) => ({ section, text })),
    ...(clearedProposal ? { clearedProposal } : {}),
    warnings: report.warnings,
  };
}
