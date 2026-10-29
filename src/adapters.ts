/**
 * External services a command depends on, injected so tests can substitute
 * record/replay or fake implementations. The CLI wires the real ones.
 * Commands take the subset they need; the LLM and GitHub adapters join here
 * as the commands that use them land.
 */
export interface Adapters {}
