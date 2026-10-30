import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
}

export interface Manifest {
  version: 1;
  sections: Record<string, SectionRecord>;
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
