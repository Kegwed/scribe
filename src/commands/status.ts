import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { typescriptAnalyser } from "../analyser.ts";
import { CONFIG_FILE, loadConfig } from "../config.ts";
import { isFrozen, loadManifest } from "../manifest.ts";
import { detectModules } from "../modules.ts";

export interface SectionStatus {
  section: string;
  /** Repo-relative path of the Section's file. */
  file: string;
  /** A human has edited the Section since Scribe last wrote it (ADR-0002). */
  frozen: boolean;
  /** Evidence the Section cites has changed since Scribe last wrote it. */
  stale: boolean;
  /** Ids of the cited symbols whose text changed or which no longer exist. */
  changedEvidence: string[];
}

export interface StatusResult {
  sections: SectionStatus[];
}

/**
 * Reports which Sections in the manifest are Stale, Frozen, or both, by
 * hashing the Target repo as it is now. Calls no LLM and no network service.
 */
export async function status(repoDir: string): Promise<StatusResult> {
  const config = await loadConfig(repoDir);
  if (!config) throw new Error(`no ${CONFIG_FILE} here; run scribe init first`);
  const modules = config.modules ?? (await detectModules(repoDir));
  const { symbols } = await typescriptAnalyser.analyse(repoDir, modules);
  const hashes = new Map(symbols.map((s) => [s.id, s.hash]));
  const manifest = await loadManifest(repoDir);

  const sections = await Promise.all(Object.entries(manifest.sections).map(async ([section, record]) => {
    const file = join(repoDir, record.file);
    const content = existsSync(file) ? await readFile(file, "utf8") : undefined;
    const changedEvidence = record.evidence.filter(({ id, hash }) => hashes.get(id) !== hash).map(({ id }) => id);
    return {
      section,
      file: record.file,
      frozen: isFrozen(content, record),
      stale: changedEvidence.length > 0,
      changedEvidence,
    };
  }));
  return { sections };
}
