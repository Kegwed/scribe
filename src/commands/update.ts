import type { Adapters } from "../adapters.ts";
import { CACHE_DIR, isFrozen, saveManifest } from "../manifest.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { allEvidence, changedEvidence, guideSections, isRemovedModuleSection, openTarget, readSection, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface UpdateOptions {}

export interface UpdateResult extends WriteReport {
  /** Sections whose Module no longer exists: their records are dropped, their files left for a human to delete. */
  removed: { section: string; file: string }[];
  /** Proposals written for Frozen, Stale Sections, for a human to merge by hand (ADR-0002). */
  proposals: { section: string; file: string }[];
}

/**
 * Regenerates each Stale Section a human hasn't edited, keeping the text its
 * changed Evidence doesn't affect, writes a Proposal beside each one a human
 * has, and leaves every other Section untouched.
 */
export async function update(
  repoDir: string,
  _options: UpdateOptions,
  { llm }: Pick<Adapters, "llm">,
): Promise<UpdateResult> {
  const target = await openTarget(repoDir);
  await gitIgnore(repoDir, CACHE_DIR);
  const result: UpdateResult = { ...emptyReport(), removed: [], proposals: [] };
  const writer = sectionWriter(repoDir, target, llm, result);

  const { sections } = target.manifest;
  for (const [section, { file }] of Object.entries(sections)) {
    if (!isRemovedModuleSection(target, section)) continue;
    result.removed.push({ section, file });
    delete sections[section];
  }
  if (result.removed.length > 0) await saveManifest(repoDir, target.manifest);

  const evidence = allEvidence(target);
  for (const section of guideSections(target)) {
    const record = target.manifest.sections[section];
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    const changed = record ? changedEvidence(record, evidence) : [];
    const fromScratch = !record || existing === undefined;
    if (!fromScratch && changed.length === 0) continue;
    if (isFrozen(existing, record)) {
      // Only a recorded Section can be Stale: one Scribe never wrote cites no Evidence to have changed.
      if (record && changed.length > 0) result.proposals.push({ section, file: await writer.propose(section) });
      else result.frozen.push(section);
      continue;
    }
    await writer.write(section, existing, fromScratch ? undefined : changed);
  }
  return result;
}
