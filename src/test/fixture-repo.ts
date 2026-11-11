import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export type Files = Record<string, string>;

export interface FixtureRepo {
  dir: string;
  /** Writes the files and commits them, dated `date` (any format git accepts) if given. */
  commit(files: Files, message?: string, date?: string): void;
  git(...args: string[]): string;
}

/**
 * Builds a Target repo as a real git repo in a temp dir, with `files` as its
 * first commit. Removed when the current test finishes.
 */
export function createFixtureRepo(files: Files = {}): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "scribe-fixture-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");

  const repo: FixtureRepo = {
    dir,
    git,
    commit(files, message = "fixture commit", date) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      git("add", "--all");
      const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
      execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", message], { cwd: dir, encoding: "utf8", env });
    },
  };
  repo.commit(files, "initial commit");
  return repo;
}
