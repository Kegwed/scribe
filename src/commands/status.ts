import { existsSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "../manifest.ts";
import { changedEvidence, isRemovedModuleSection, openTarget, proposalPath, readSection, sectionPath } from "../target.ts";

export interface SectionStatus {
  section: string;
  /** Repo-relative path of the Section's file. */
  file: string;
  /** The Section's Module was added since Scribe last wrote the Guide, and has no Section yet; `update` writes one. */
  added: boolean;
  /** The Section's Module no longer exists; `update` drops its record and leaves its file for a human to delete. */
  removed: boolean;
  /** The Section's file is gone; `generate` and `update` write it again. */
  missing: boolean;
  /** A human has edited the Section since Scribe last wrote it (ADR-0002). */
  frozen: boolean;
  /** Evidence the Section cites has changed since Scribe last wrote it. */
  stale: boolean;
  /** Ids of the cited symbols whose text changed or which no longer exist. */
  changedEvidence: string[];
}

export interface StatusResult {
  sections: SectionStatus[];
  /** Proposals `update` wrote for Frozen, Stale Sections, pending until a human merges and deletes them (ADR-0002). */
  proposals: { section: string; file: string }[];
}

/**
 * Reports each Section in the manifest as Stale, Frozen, missing or removed,
 * each Module without one as added, and each pending Proposal, by hashing the Target repo as it is
 * now. Calls no LLM and no network service.
 */
export async function status(repoDir: string): Promise<StatusResult> {
  const target = await openTarget(repoDir);
  const { config, sectionIds, symbols, manifest } = target;

  const recorded = await Promise.all(Object.entries(manifest.sections).map(async ([section, record]) => {
    const content = await readSection(repoDir, record.file);
    const changed = changedEvidence(record, symbols);
    return {
      section,
      file: record.file,
      added: false,
      removed: isRemovedModuleSection(target, section),
      missing: content === undefined,
      frozen: isFrozen(content, record),
      stale: changed.length > 0,
      changedEvidence: changed,
    };
  }));
  const unrecorded = await Promise.all([...sectionIds.values()].filter((section) => !manifest.sections[section]).map(async (section) => {
    const file = sectionPath(config, section);
    const frozen = isFrozen(await readSection(repoDir, file), undefined);
    return { section, file, added: !frozen, removed: false, missing: false, frozen, stale: false, changedEvidence: [] };
  }));
  const proposals = Object.keys(manifest.sections)
    .map((section) => ({ section, file: proposalPath(config, section) }))
    .filter(({ file }) => existsSync(join(repoDir, file)));
  return { sections: [...recorded, ...unrecorded], proposals };
}
