import type { Adapters } from "../adapters.ts";
import { CACHE_DIR, isFrozen } from "../manifest.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { openTarget, readSection, sectionIdOf, sectionPath, subjects } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface GenerateOptions {}

export type GenerateResult = WriteReport;

/**
 * Writes one Section per Module, each Claim citing the code symbols it rests
 * on, then Overview and Architecture from those Module Sections, each Claim
 * citing the repo-wide Evidence it rests on (ADR-0005). Every Claim is verified
 * against its Evidence, and what was written is recorded in the manifest.
 * Sections a human has edited are left alone.
 */
export async function generate(
  repoDir: string,
  _options: GenerateOptions,
  { llm }: Pick<Adapters, "llm">,
): Promise<GenerateResult> {
  const target = await openTarget(repoDir);
  await gitIgnore(repoDir, CACHE_DIR);
  const result = emptyReport();
  const writer = sectionWriter(repoDir, target, llm, result);

  for (const subject of subjects(target)) {
    const section = sectionIdOf(target, subject);
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, target.manifest.sections[section])) {
      result.frozen.push(section);
      continue;
    }
    await writer.write(subject, existing);
  }
  return result;
}
