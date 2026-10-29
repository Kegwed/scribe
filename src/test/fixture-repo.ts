import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export type Files = Record<string, string>;

export interface FixtureRepo {
  dir: string;
  /** Writes the files and commits them. */
  commit(files: Files, message?: string): void;
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
    commit(files, message = "fixture commit") {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      git("add", "--all");
      git("commit", "--quiet", "--allow-empty", "-m", message);
    },
  };
  repo.commit(files, "initial commit");
  return repo;
}
