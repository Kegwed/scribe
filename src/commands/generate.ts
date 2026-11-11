import type { Adapters } from "../adapters.ts";
import { gitHubEvidence } from "../github.ts";
import { CACHE_DIR, isFrozen } from "../manifest.ts";
import { type Confirm, type CostEstimate, confirmed, emptyReport, estimateRun, sectionWriter, type WriteReport } from "../section-writer.ts";
import { openTarget, readSection, sectionIdOf, sectionPath, type Subject, subjects } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface GenerateOptions {
  /**
   * Asked before any LLM call, unless the run costs nothing; the run stops
   * there, changing no files, unless it answers true. Without it the run goes ahead.
   */
  confirm?: Confirm;
}

export interface GenerateResult extends WriteReport {
  estimate: CostEstimate;
  /** The estimate was declined, so nothing was written. */
  declined: boolean;
}

/**
 * Writes one Section per Module, each Claim citing the code symbols it rests
 * on, then Overview and Architecture from those Module Sections, each Claim
 * citing the repo-wide Evidence it rests on (ADR-0005). Every Claim is verified
 * against its Evidence, and what was written is recorded in the manifest.
 * Sections a human has edited are left alone.
 */
export async function generate(
  repoDir: string,
  { confirm }: GenerateOptions,
  { llm, github }: Adapters,
): Promise<GenerateResult> {
  const target = await openTarget(repoDir);
  const report = emptyReport();
  const discussions = github && (await gitHubEvidence(repoDir, github, target.modules, report.warnings));
  const writer = sectionWriter(repoDir, target, llm, report, discussions);

  const planned: { subject: Subject; existing: string | undefined }[] = [];
  for (const subject of subjects(target)) {
    const section = sectionIdOf(target, subject);
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, target.manifest.sections[section])) report.frozen.push(section);
    else planned.push({ subject, existing });
  }

  const estimate = await estimateRun(writer, planned);
  if (!(await confirmed(estimate, confirm))) return { ...report, estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  // In order: the top-level Sections are written from the Module Sections as just written.
  for (const { subject, existing } of planned) await writer.write(subject, existing);
  return { ...report, estimate, declined: false };
}
