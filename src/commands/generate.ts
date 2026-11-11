import type { Adapters } from "../adapters.ts";
import { gitHubEvidence } from "../github.ts";
import { CACHE_DIR, isFrozen } from "../manifest.ts";
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
  { llm, github }: Adapters,
): Promise<GenerateResult> {
  const target = await openTarget(repoDir);
  await gitIgnore(repoDir, CACHE_DIR);
  const result = emptyReport();
  const discussions = github && (await gitHubEvidence(repoDir, github, target.modules, result.warnings));
  const writer = sectionWriter(repoDir, target, llm, result, discussions);

  for (const module of target.modules) {
    const section = target.sectionIds.get(module)!;
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    if (isFrozen(existing, target.manifest.sections[section])) {
      result.frozen.push(section);
      continue;
    }
    await writer.write(module, existing);
  }
  return result;
}
