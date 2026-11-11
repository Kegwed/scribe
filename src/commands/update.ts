import type { Adapters } from "../adapters.ts";
import { CACHE_DIR, isFrozen, saveManifest } from "../manifest.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { changedEvidence, isModuleSection, openTarget, readSection, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface UpdateOptions {}

export interface UpdateResult extends WriteReport {
  /** Sections whose Module no longer exists: their records are dropped, their files left for a human to delete. */
  removed: { section: string; file: string }[];
}

/**
 * Regenerates each Stale Section a human hasn't edited, keeping the text its
 * changed Evidence doesn't affect, and leaves every other Section untouched.
 */
export async function update(
  repoDir: string,
  _options: UpdateOptions,
  { llm }: Pick<Adapters, "llm">,
): Promise<UpdateResult> {
  const target = await openTarget(repoDir);
  await gitIgnore(repoDir, CACHE_DIR);
  const result: UpdateResult = { ...emptyReport(), removed: [] };
  const writer = sectionWriter(repoDir, target, llm, result);

  const current = new Set(target.sectionIds.values());
  const { sections } = target.manifest;
  for (const [section, { file }] of Object.entries(sections)) {
    if (!isModuleSection(section) || current.has(section)) continue;
    result.removed.push({ section, file });
    delete sections[section];
  }
  if (result.removed.length > 0) await saveManifest(repoDir, target.manifest);

  for (const module of target.modules) {
    const section = target.sectionIds.get(module)!;
    const record = target.manifest.sections[section];
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    const changed = record ? changedEvidence(record, target.symbols) : [];
    const fresh = !record || existing === undefined;
    if (!fresh && changed.length === 0) continue;
    if (isFrozen(existing, record)) {
      result.frozen.push(section);
      continue;
    }
    await writer.write(module, existing, fresh ? undefined : changed);
  }
  return result;
}
