/** Committed record of what Scribe last wrote, compared against to detect Stale and Frozen Sections (ADR-0002). */
export const SCRIBE_DIR = ".scribe";
export const MANIFEST_PATH = `${SCRIBE_DIR}/manifest.json`;
/** LLM responses cached by content hash; never committed. */
export const CACHE_DIR = `${SCRIBE_DIR}/cache/`;

export interface Manifest {
  version: 1;
  sections: Record<string, never>;
}

export function emptyManifest(): Manifest {
  return { version: 1, sections: {} };
}
