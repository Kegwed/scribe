import type { Adapters } from "../adapters.ts";
import { CACHE_DIR, isFrozen, recordedDrift } from "../manifest.ts";
import { emptyReport, sectionWriter, type WriteReport } from "../section-writer.ts";
import { openTarget, readSection, sectionPath } from "../target.ts";
import { gitIgnore } from "./init.ts";

export interface GenerateOptions {}

export type GenerateResult = WriteReport;

/**
 * Writes one Section per Module, each Claim citing the code symbols it rests
 * on and verified against them, and records what was written in the manifest.
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

  for (const module of target.modules) {
    const section = target.sectionIds.get(module)!;
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, target.manifest.sections[section])) {
      result.frozen.push(section);
      continue;
    }
    await writer.write(module, existing);
  }
  result.drift = recordedDrift(target.manifest);
  return result;
}
