import type { Adapters } from "../adapters.ts";
import { gitHubEvidence } from "../github.ts";
import { CACHE_DIR, isFrozen, recordedDrift } from "../manifest.ts";
import { confirmed, type CostEstimate, estimateRun, type RunOptions } from "../estimate.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { allEvidence, changedEvidence, guideSections, openTarget, readSection, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface GenerateResult extends WriteReport {
  estimate: CostEstimate;
  /** The estimate was declined, so nothing was written. */
  declined: boolean;
}

/**
 * Writes one Section per Module, a Getting started Section, a Conventions
 * Section from the repo's lint and format config and CONTRIBUTING, a Key
 * decisions Section from the ADRs and pull request threads, then Overview and
 * Architecture from the Module Sections (ADR-0005), each Claim
 * citing the Evidence it rests on and verified against it, and records what
 * was written in the manifest. Every command Getting started names must be one
 * the repo's scripts, CI steps or docs give. Sections a human has edited are
 * left alone, and an adopted one is revised only once it is Stale.
 */
export async function generate(
  repoDir: string,
  { confirm }: RunOptions,
  { llm, github }: Adapters,
): Promise<GenerateResult> {
  const target = await openTarget(repoDir);
  const report = emptyReport();
  const { discussions, saveCache } = await gitHubEvidence(repoDir, github, target.modules, report.warnings);
  const writer = sectionWriter(repoDir, target, llm, report, discussions);

  const evidence = allEvidence(target);
  const planned: { section: string; existing: string | undefined; changed?: string[] }[] = [];
  for (const section of guideSections(target)) {
    const record = target.manifest.sections[section];
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, record)) report.frozen.push(section);
    else if (record && existing !== undefined && (record.adopted || record.unsupportedClaims)) {
      // A human's words written afresh would be lost, so they are revised as update would, only once Stale.
      const changed = changedEvidence(record, evidence);
      if (changed.length > 0) planned.push({ section, existing, changed });
    } else planned.push({ section, existing });
  }

  const estimate = estimateRun(writer, planned);
  if (!(await confirmed(estimate, confirm, report.warnings))) return { ...report, estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  await saveCache();
  for (const { section, existing, changed } of planned) await writer.write(section, existing, changed);
  return { ...report, estimate, declined: false, drift: recordedDrift(target.manifest) };
}
