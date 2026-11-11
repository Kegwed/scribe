import type { Adapters } from "../adapters.ts";
import { CACHE_DIR, isFrozen } from "../manifest.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { guideSections, openTarget, readSection, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface GenerateOptions {}

export type GenerateResult = WriteReport;

/**
 * Writes one Section per Module and a Getting started Section, each Claim
 * citing the Evidence it rests on and verified against it, and records what
 * was written in the manifest. Every command Getting started names must be one
 * the repo's scripts, CI steps or docs give. Sections a human has edited are
 * left alone.
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

  for (const section of guideSections(target)) {
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, target.manifest.sections[section])) {
      result.frozen.push(section);
      continue;
    }
    await writer.write(section, existing);
  }
  return result;
}
