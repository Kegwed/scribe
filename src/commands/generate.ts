import type { Adapters } from "../adapters.ts";
import { gitHubEvidence } from "../github.ts";
import { CACHE_DIR, isFrozen, recordedDrift } from "../manifest.ts";
import { type Confirm, confirmed, type CostEstimate, emptyReport, sectionWriter, totalCost, type WriteReport } from "../section-writer.ts";
import { guideSections, openTarget, readSection, sectionPath } from "../target.ts";
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
 * Writes one Section per Module, a Getting started Section and a Key
 * decisions Section from the ADRs and pull request threads, each Claim
 * citing the Evidence it rests on and verified against it, and records what
 * was written in the manifest. Every command Getting started names must be one
 * the repo's scripts, CI steps or docs give. Sections a human has edited are
 * left alone.
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

  const planned: { section: string; existing: string | undefined }[] = [];
  for (const section of guideSections(target)) {
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, target.manifest.sections[section])) report.frozen.push(section);
    else planned.push({ section, existing });
  }

  const estimate = totalCost(planned.map(({ section, existing }) => writer.estimate(section, existing)));
  if (!(await confirmed(estimate, confirm))) return { ...report, estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  for (const { section, existing } of planned) await writer.write(section, existing);
  return { ...report, estimate, declined: false, drift: recordedDrift(target.manifest) };
}
