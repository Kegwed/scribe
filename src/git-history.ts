import { spawnSync } from "node:child_process";
import { contentHash } from "./hash.ts";
import type { Module } from "./modules.ts";

/** How far back from HEAD's commit date a Module's commits count towards its churn. */
export const CHURN_DAYS = 90;
/** Commits within `CHURN_DAYS` that make a Module hot rather than stable. */
export const HOT_COMMITS = 5;

/**
 * Evidence from git history that a Module is hot or stable. Drawn from commit
 * dates and paths only, never authors, so the Guide names no people. Hashed by
 * its statement alone, so its Section goes Stale only when the Module turns hot
 * or stable, not on every commit.
 */
export interface ChurnEvidence {
  kind: "history";
  /** `history:<Module path>`. */
  id: string;
  /** Path of the Module, as git's pathspec. */
  module: string;
  /** The Claim Scribe writes from it, true by construction. */
  statement: string;
  /** Hash of `statement`. */
  hash: string;
}

const ID_PREFIX = "history:";

export function isChurnEvidence(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/**
 * Each Module's churn Evidence keyed by Module path, counting the commits that
 * changed its files in the `CHURN_DAYS` up to HEAD's commit date, so the
 * verdict depends on the repo alone and not on when Scribe runs. A commit to a
 * nested Module counts towards that Module only. Empty when the Target repo has
 * no git history.
 */
export function churnEvidence(repoDir: string, modules: Module[]): Map<string, ChurnEvidence> {
  const evidence = new Map<string, ChurnEvidence>();
  const head = git(repoDir, "log", "-1", "--format=%ct", "HEAD");
  if (head === undefined) return evidence;
  const since = Number(head) - CHURN_DAYS * 24 * 60 * 60;

  for (const module of modules) {
    const nested = modules.filter((m) => m !== module && contains(module.path, m.path));
    const pathspecs = [module.path, ...nested.map((m) => `:(exclude)${m.path}`)];
    const log = git(repoDir, "log", "--format=%ct", "HEAD", "--", ...pathspecs) ?? "";
    const commits = log.split("\n").filter((date) => date !== "" && Number(date) >= since).length;
    const statement = commits >= HOT_COMMITS
      ? `This Module is hot: ${HOT_COMMITS} or more commits changed it in the ${CHURN_DAYS} days of git history cited.`
      : `This Module is stable: fewer than ${HOT_COMMITS} commits changed it in the ${CHURN_DAYS} days of git history cited.`;
    evidence.set(module.path, { kind: "history", id: `${ID_PREFIX}${module.path}`, module: module.path, statement, hash: contentHash(statement) });
  }
  return evidence;
}

function contains(outer: string, inner: string): boolean {
  return outer === "." || inner.startsWith(`${outer}/`);
}

/** The command's trimmed output, or undefined if it failed. */
function git(repoDir: string, ...args: string[]): string | undefined {
  const { status, stdout } = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
  return status === 0 ? stdout.trim() : undefined;
}
