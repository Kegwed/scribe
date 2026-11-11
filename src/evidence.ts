import type { GitHubEvidence } from "./github.ts";

/** What a Claim can cite: Evidence in a file of the Target repo, GitHub discussion, or Evidence about the repo as a whole. */
export type Evidence = FileEvidence | GitHubEvidence | RepoEvidence;

/**
 * Evidence in a file of the Target repo: a code `symbol`, a passage of an
 * existing `doc`, a `setup` item (a script, CI step or doc shell block) for
 * Getting started, or a lint or format `config`.
 */
export interface FileEvidence {
  kind: "symbol" | "doc" | "setup" | "config";
  /** `<file>#<name>`, stable across moves within the file. */
  id: string;
  /** Labels the Evidence in its citation. */
  name: string;
  /** Repo-relative, forward-slashed path of the file it is in. */
  file: string;
  /** Its text, line endings normalised. */
  text: string;
  /** Hash of `text`. */
  hash: string;
  /** 1-based lines it spans in the file as it is now. */
  startLine: number;
  endLine: number;
}

/**
 * Evidence about the Target repo as a whole, which Overview and Architecture
 * cite directly instead of the Module Sections they are built from (ADR-0005).
 */
export interface RepoEvidence {
  kind: "repo";
  /** `graph:<name>` for what Scribe derives from the code, `file:<path>` for a file's content. */
  id: string;
  /** Labels the Evidence in its citation. */
  label: string;
  text: string;
  /** Hash of `text`. */
  hash: string;
  /** The lines of a file it is, if it is a file's content, which its citation links to. */
  lines?: { file: string; startLine: number; endLine: number };
}

export function isRepoEvidence(item: Evidence): item is RepoEvidence {
  return item.kind === "repo";
}

export function inFile(item: Evidence): item is FileEvidence {
  return item.kind !== "repo" && item.kind !== "github";
}
