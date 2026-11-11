import type { Adapters } from "../adapters.ts";
import { gitHubEvidence } from "../github.ts";
import { CACHE_DIR, isFrozen, saveManifest } from "../manifest.ts";
import { type Confirm, type CostEstimate, confirmed, emptyReport, estimateRun, sectionWriter, type WriteReport } from "../section-writer.ts";
import {
  changedEvidence,
  isRemovedModuleSection,
  localEvidence,
  openTarget,
  readSection,
  sectionIdOf,
  sectionPath,
  type Subject,
  subjects,
} from "../target.ts";
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
  | { kind: "write"; subject: Subject; existing: string | undefined; changed: string[] | undefined }
  | { kind: "propose"; subject: Subject };

/**
 * Regenerates each Stale Section a human hasn't edited, keeping the text its
 * changed Evidence doesn't affect, writes a Proposal beside each one a human
 * has, and leaves every other Section untouched. Overview and Architecture are
 * Stale only when Evidence they cite directly changes, never because a Module
 * Section they were built from was regenerated (ADR-0005).
 */
export async function update(
  repoDir: string,
  { confirm }: UpdateOptions,
  { llm, github }: Adapters,
): Promise<UpdateResult> {
  const target = await openTarget(repoDir);
  const report = emptyReport();
  const discussions = github && (await gitHubEvidence(repoDir, github, target.modules, report.warnings));
  const writer = sectionWriter(repoDir, target, llm, report, discussions);

  const { sections } = target.manifest;
  const removed = Object.entries(sections)
    .filter(([section]) => isRemovedModuleSection(target, section))
    .map(([section, { file }]) => ({ section, file }));

  const evidence = localEvidence(target);
  const planned: Planned[] = [];
  for (const subject of subjects(target)) {
    const section = sectionIdOf(target, subject);
    const record = sections[section];
    const existing = await readSection(repoDir, sectionPath(target.config, section));
    const changed = record ? changedEvidence(record, evidence) : [];
    const fromScratch = !record || existing === undefined;
    if (!fromScratch && changed.length === 0) continue;
    if (isFrozen(existing, record)) {
      // Only a recorded Section can be Stale: one Scribe never wrote cites no Evidence to have changed.
      if (record && changed.length > 0) planned.push({ kind: "propose", subject });
      else report.frozen.push(section);
      continue;
    }
    planned.push({ kind: "write", subject, existing, changed: fromScratch ? undefined : changed });
  }

  const estimate = await estimateRun(writer, planned.map((p) =>
    p.kind === "write" ? { subject: p.subject, existing: p.existing, changed: p.changed } : { subject: p.subject, existing: undefined }));
  if (!(await confirmed(estimate, confirm))) return { ...report, removed: [], proposals: [], estimate, declined: true };

  await gitIgnore(repoDir, CACHE_DIR);
  for (const { section } of removed) delete sections[section];
  if (removed.length > 0) await saveManifest(repoDir, target.manifest);

  // In order: Module Sections first, so a top-level Section is written from them as updated.
  const proposals: UpdateResult["proposals"] = [];
  for (const p of planned) {
    const section = sectionIdOf(target, p.subject);
    if (p.kind === "propose") proposals.push({ section, file: await writer.propose(p.subject) });
    else await writer.write(p.subject, p.existing, p.changed);
  }
  return { ...report, removed, proposals, estimate, declined: false };
}
