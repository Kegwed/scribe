import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generate } from "./commands/generate.ts";
import { init } from "./commands/init.ts";
import { CONFIG_FILE } from "./config.ts";
import { CACHE_DIR } from "./manifest.ts";
import { connectGitHub } from "./github.ts";
import { claudeLlm } from "./llm.ts";
import type { Confirm } from "./estimate.ts";
import type { WriteReport } from "./section-writer.ts";

/**
 * The eval: `generate` run with the live LLM on real Target repos, scored by
 * the verifier's confirmed-Claim rate so prompt changes can be compared over
 * time. It is run by `npm run eval`, never by the test suite, since it spends money.
 */

/** A Target repo in the eval set, cloned from `url` and run at `ref`, or at its default branch when none is given. */
export interface EvalRepo {
  name: string;
  url: string;
  ref?: string;
}

/**
 * How the verifier judged a Guide's Claims: of the Claims first written, the
 * share it `confirmed` before any repair, and the share `kept` once repairs
 * were verified. A rate is null when no Claim was written.
 */
export interface ClaimRate {
  written: number;
  confirmed: number;
  kept: number;
  confirmedRate: number | null;
  keptRate: number | null;
}

export interface EvalRun {
  /** When the run finished, as an ISO timestamp. */
  at: string;
  repos: ({ name: string; /** The SHA the repo was run at. */ commit: string } & ClaimRate)[];
  /** Pooled over every repo's Claims, so a repo with more Claims weighs more. */
  overall: ClaimRate;
}

export interface EvalDeps {
  /** One JSON line per run is appended here. */
  resultsFile: string;
  now: () => Date;
  /** A checkout of the repo at its ref, ready for `generate`. */
  prepare: (repo: EvalRepo) => Promise<{ dir: string; commit: string }>;
  generate: (dir: string) => Promise<Pick<WriteReport, "verifiedClaims"> & { declined: boolean }>;
}

/**
 * Runs `generate` on each repo in turn and appends the confirmed-Claim rates
 * to the results file. If any repo's cost estimate is declined, the run stops
 * and nothing is recorded.
 */
export async function runEval(repos: EvalRepo[], { resultsFile, now, prepare, generate }: EvalDeps): Promise<EvalRun | undefined> {
  const results: EvalRun["repos"] = [];
  for (const repo of repos) {
    const { dir, commit } = await prepare(repo);
    const { declined, verifiedClaims } = await generate(dir);
    if (declined) return undefined;
    results.push({ name: repo.name, commit, ...rate(verifiedClaims) });
  }
  const run: EvalRun = { at: now().toISOString(), repos: results, overall: rate(results) };
  await mkdir(dirname(resultsFile), { recursive: true });
  await appendFile(resultsFile, JSON.stringify(run) + "\n");
  return run;
}

function rate(counts: { written: number; confirmed: number; kept: number }[]): ClaimRate {
  const sum = (key: "written" | "confirmed" | "kept") => counts.reduce((total, c) => total + c[key], 0);
  const written = sum("written");
  const confirmed = sum("confirmed");
  const kept = sum("kept");
  return {
    written,
    confirmed,
    kept,
    confirmedRate: written === 0 ? null : confirmed / written,
    keptRate: written === 0 ? null : kept / written,
  };
}

/**
 * The live wiring: each repo is cloned once under `checkouts`, then reset to
 * its ref with Scribe's earlier output removed, so every run is a fresh
 * `generate`. The LLM cache is kept, so a re-run with unchanged prompts and
 * repos costs nothing.
 */
export function liveEval(checkouts: string, resultsFile: string, confirm: Confirm): EvalDeps {
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  return {
    resultsFile,
    now: () => new Date(),
    async prepare({ name, url, ref }) {
      const dir = join(checkouts, name);
      if (!existsSync(dir)) {
        await mkdir(checkouts, { recursive: true });
        git(checkouts, "clone", "--quiet", url, name);
      } else {
        git(dir, "fetch", "--quiet", "--tags", "origin");
      }
      git(dir, "checkout", "--quiet", "--force", "--detach", ref ?? "origin/HEAD");
      git(dir, "clean", "--quiet", "-fd", "-e", CACHE_DIR);
      return { dir, commit: git(dir, "rev-parse", "HEAD") };
    },
    async generate(dir) {
      if (!existsSync(join(dir, CONFIG_FILE))) await init(dir);
      const github = connectGitHub(dir);
      return generate(dir, { confirm }, { llm: claudeLlm(), ...(github ? { github } : {}) });
    },
  };
}
