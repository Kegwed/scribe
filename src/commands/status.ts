import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { type DriftReport, isFrozen, recordedDrift } from "../manifest.ts";
import { allEvidence, changedEvidence, guideSections, isRemovedModuleSection, openTarget, PROPOSAL_SUFFIX, proposalPath, readSection, sectionPath } from "../target.ts";

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
  /** Where existing docs contradicted the code when Scribe last wrote each Section, as recorded in the manifest. */
  drift: DriftReport[];
  /** Claims in adopted Sections for which no Evidence was found, as the manifest records them. */
  unsupportedClaims: { section: string; text: string }[];
}

/**
 * Reports each Section in the manifest as Stale, Frozen, missing or removed,
 * each Module without one as added, and each pending Proposal, by hashing the Target repo as it is
 * now, and the Drift recorded for each Section. Calls no LLM and no network service.
 */
export async function status(repoDir: string): Promise<StatusResult> {
  const target = await openTarget(repoDir);
  const { config, manifest } = target;
  const evidence = allEvidence(target);

  const recorded = await Promise.all(Object.entries(manifest.sections).map(async ([section, record]) => {
    const content = await readSection(repoDir, record.file);
    const changed = changedEvidence(record, evidence);
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
  const unrecorded = await Promise.all(guideSections(target).filter((section) => !manifest.sections[section]).map(async (section) => {
    const file = sectionPath(config, section);
    const frozen = isFrozen(await readSection(repoDir, file), undefined);
    return { section, file, added: !frozen, removed: false, missing: false, frozen, stale: false, changedEvidence: [] };
  }));
  const unsupportedClaims = Object.entries(manifest.sections)
    .flatMap(([section, record]) => (record.unsupportedClaims ?? []).map((text) => ({ section, text })));
  return { sections: [...recorded, ...unrecorded], proposals: await pendingProposals(repoDir, config), unsupportedClaims, drift: recordedDrift(manifest) };
}

/** Every Proposal file in the Guide, including one whose Section's Module has since been removed. */
async function pendingProposals(repoDir: string, config: Config): Promise<{ section: string; file: string }[]> {
  const guide = join(repoDir, config.guideDir);
  if (!existsSync(guide)) return [];
  const files = (await readdir(guide, { recursive: true })).map((f) => f.replaceAll("\\", "/")).sort();
  return files.filter((f) => f.endsWith(PROPOSAL_SUFFIX)).map((f) => {
    const section = f.slice(0, -PROPOSAL_SUFFIX.length);
    return { section, file: proposalPath(config, section) };
  });
}
