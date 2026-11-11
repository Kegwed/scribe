import type { Adapters } from "../adapters.ts";
import { CACHE_DIR, isFrozen, recordedDrift, saveManifest } from "../manifest.ts";
import type { Module } from "../modules.ts";
import { type Confirm, confirmed, type CostEstimate, emptyReport, sectionWriter, totalCost, type WriteReport } from "../section-writer.ts";
import { changedEvidence, isRemovedModuleSection, openTarget, readSection, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface UpdateOptions {
  /**
   * Asked before any LLM call, unless the run costs nothing; the run stops
   * there, changing no files, unless it answers true. Without it the run goes ahead.
   */
  confirm?: Confirm;
}

export interface UpdateResult extends WriteReport {
  /** Sections whose Module no longer exists: their records are dropped, their files left for a human to delete. */
  removed: { section: string; file: string }[];
  /** Proposals written for Frozen, Stale Sections, for a human to merge by hand (ADR-0002). */
  proposals: { section: string; file: string }[];
  /** What the Sections and Proposals to write were expected to cost. */
  estimate: CostEstimate;
  /** The estimate was declined, so nothing was written and no record dropped. */
  declined: boolean;
}

type Planned =
  | { kind: "write"; module: Module; existing: string | undefined; changed: string[] | undefined }
  | { kind: "propose"; module: Module };

/**
 * Regenerates each Stale Section a human hasn't edited, keeping the text its
 * changed Evidence doesn't affect, writes a Proposal beside each one a human
 * has, and leaves every other Section untouched.
 */
export async function update(
  repoDir: string,
  { confirm }: UpdateOptions,
  { llm }: Pick<Adapters, "llm">,
): Promise<UpdateResult> {
  const target = await openTarget(repoDir);
  const report = emptyReport();
  const writer = sectionWriter(repoDir, target, llm, report);

  const { sections } = target.manifest;
  const removed = Object.entries(sections)
    .filter(([section]) => isRemovedModuleSection(target, section))
    .map(([section, { file }]) => ({ section, file }));

  const planned: Planned[] = [];
  for (const module of target.modules) {
    const section = target.sectionIds.get(module)!;
    const record = sections[section];
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    const changed = record ? changedEvidence(record, target) : [];
    const fromScratch = !record || existing === undefined;
    if (!fromScratch && changed.length === 0) continue;
    if (isFrozen(existing, record)) {
      // Only a recorded Section can be Stale: one Scribe never wrote cites no Evidence to have changed.
      if (record && changed.length > 0) planned.push({ kind: "propose", module });
      else report.frozen.push(section);
      continue;
    }
    planned.push({ kind: "write", module, existing, changed: fromScratch ? undefined : changed });
  }

  const estimate = totalCost(planned.map((p) =>
    p.kind === "write" ? writer.estimate(p.module, p.existing, p.changed) : writer.estimate(p.module, undefined)));
  if (!(await confirmed(estimate, confirm))) return { ...report, removed: [], proposals: [], estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  for (const { section } of removed) delete sections[section];
  if (removed.length > 0) await saveManifest(repoDir, target.manifest);

  const proposals: UpdateResult["proposals"] = [];
  for (const p of planned) {
    const section = target.sectionIds.get(p.module)!;
    if (p.kind === "propose") proposals.push({ section, file: await writer.propose(p.module) });
    else await writer.write(p.module, p.existing, p.changed);
  }
  return { ...report, removed, proposals, estimate, declined: false, drift: recordedDrift(target.manifest) };
}
