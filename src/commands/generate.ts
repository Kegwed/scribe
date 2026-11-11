import type { Adapters } from "../adapters.ts";
import { CACHE_DIR, isFrozen, recordedDrift } from "../manifest.ts";
import type { Module } from "../modules.ts";
import { type Confirm, confirmed, type CostEstimate, emptyReport, sectionWriter, totalCost, type WriteReport } from "../section-writer.ts";
import { openTarget, readSection, sectionPath } from "../target.ts";
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
 * on and verified against them, and records what was written in the manifest.
 * Sections a human has edited are left alone.
 */
export async function generate(
  repoDir: string,
  { confirm }: GenerateOptions,
  { llm }: Pick<Adapters, "llm">,
): Promise<GenerateResult> {
  const target = await openTarget(repoDir);
  const report = emptyReport();
  const writer = sectionWriter(repoDir, target, llm, report);

  const planned: { module: Module; existing: string | undefined }[] = [];
  for (const module of target.modules) {
    const section = target.sectionIds.get(module)!;
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, target.manifest.sections[section])) report.frozen.push(section);
    else planned.push({ module, existing });
  }

  const estimate = totalCost(planned.map(({ module, existing }) => writer.estimate(module, existing)));
  if (!(await confirmed(estimate, confirm))) return { ...report, estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  for (const { module, existing } of planned) await writer.write(module, existing);
  return { ...report, estimate, declined: false, drift: recordedDrift(target.manifest) };
}
