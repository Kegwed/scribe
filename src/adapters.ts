import type { Llm } from "./llm.ts";

/**
 * External services a command depends on, injected so tests can substitute
 * record/replay or fake implementations. The CLI wires the real ones.
 * Commands take the subset they need; the GitHub adapter joins here when the
 * commands that use it land.
 */
export interface Adapters {
  llm: Llm;
}
