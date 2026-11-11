import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contentHash } from "./hash.ts";

/** Committed record of what Scribe last wrote, compared against to detect Stale and Frozen Sections (ADR-0002). */
export const SCRIBE_DIR = ".scribe";
export const MANIFEST_PATH = `${SCRIBE_DIR}/manifest.json`;
/** LLM responses cached by content hash; never committed. */
export const CACHE_DIR = `${SCRIBE_DIR}/cache/`;

export interface EvidenceRecord {
  /** The cited symbol's id. */
  id: string;
  hash: string;
}

export interface SectionRecord {
  /** Repo-relative path of the Section's file. */
  file: string;
  evidence: EvidenceRecord[];
  /** Hash of the content Scribe last wrote. */
  contentHash: string;
  /** Where existing docs contradicted the code when Scribe last wrote the Section; absent if nowhere. */
  drift?: DriftRecord[];
}

/** A contradiction between existing docs and the code, with the Evidence on each side; the code is treated as correct. */
export interface DriftRecord {
  description: string;
  docs: EvidenceRecord[];
  code: EvidenceRecord[];
}

/** A Drift as reported: the Section it was found for, and the ids of the Evidence on each side. */
export interface DriftReport {
  section: string;
  description: string;
  docs: string[];
  code: string[];
}

/** Every Drift the manifest records, Section by Section. */
export function recordedDrift({ sections }: Manifest): DriftReport[] {
  return Object.entries(sections).flatMap(([section, { drift = [] }]) => drift.map(({ description, docs, code }) => ({
    section, description, docs: docs.map((e) => e.id), code: code.map((e) => e.id),
  })));
}

export interface Manifest {
  version: 1;
  sections: Record<string, SectionRecord>;
}

/** Whether a human has edited a Section's file, given its content (undefined if absent) and its record. */
export function isFrozen(content: string | undefined, record: SectionRecord | undefined): boolean {
  return content !== undefined && contentHash(content) !== record?.contentHash;
}

export function emptyManifest(): Manifest {
  return { version: 1, sections: {} };
}

export async function loadManifest(repoDir: string): Promise<Manifest> {
  const file = join(repoDir, MANIFEST_PATH);
  return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : emptyManifest();
}

export async function saveManifest(repoDir: string, manifest: Manifest): Promise<void> {
  const file = join(repoDir, MANIFEST_PATH);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
}
