import type { GitHub } from "./github.ts";
import type { Llm } from "./llm.ts";

/**
 * External services a command depends on, injected so tests can substitute
 * record/replay or fake implementations. The CLI wires the real ones.
 * Commands take the subset they need.
 */
export interface Adapters {
  llm: Llm;
  /** Absent unless `origin` is on GitHub and a token is available; Scribe then uses its other Sources. */
  github?: GitHub;
}
