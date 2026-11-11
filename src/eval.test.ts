import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvalRepo, runEval } from "./eval.ts";
import type { WriteReport } from "./section-writer.ts";

const REPOS: EvalRepo[] = [
  { name: "alpha", url: "https://example.com/alpha.git" },
  { name: "beta", url: "https://example.com/beta.git", ref: "v1.0.0" },
];

const VERIFIED: Record<string, WriteReport["verifiedClaims"]> = {
  alpha: [
    { section: "modules/src-a", written: 4, confirmed: 3, kept: 4 },
    { section: "overview", written: 0, confirmed: 0, kept: 0 },
  ],
  beta: [{ section: "modules/src-b", written: 4, confirmed: 2, kept: 3 }],
};

function resultsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "scribe-eval-")), "results.jsonl");
}

function fakes(file: string, { declined = [] as string[], at = "2026-11-11T09:00:00.000Z" } = {}) {
  return {
    resultsFile: file,
    now: () => new Date(at),
    prepare: async ({ name }: EvalRepo) => ({ dir: `/checkouts/${name}`, commit: `${name}-sha` }),
    generate: async (dir: string) => {
      const name = dir.split("/").pop()!;
      return { declined: declined.includes(name), verifiedClaims: VERIFIED[name]! };
    },
  };
}

function lines(file: string): unknown[] {
  return readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

describe("runEval", () => {
  it("appends the confirmed-Claim rate per repo and overall, with a timestamp and the commit each repo was run at", async () => {
    const file = resultsFile();

    await runEval(REPOS, fakes(file));

    expect(lines(file)).toEqual([{
      at: "2026-11-11T09:00:00.000Z",
      repos: [
        { name: "alpha", commit: "alpha-sha", written: 4, confirmed: 3, kept: 4, confirmedRate: 0.75, keptRate: 1 },
        { name: "beta", commit: "beta-sha", written: 4, confirmed: 2, kept: 3, confirmedRate: 0.5, keptRate: 0.75 },
      ],
      overall: { written: 8, confirmed: 5, kept: 7, confirmedRate: 0.625, keptRate: 0.875 },
    }]);
  });

  it("keeps earlier runs, so successive runs can be compared", async () => {
    const file = resultsFile();
    writeFileSync(file, '{"at":"earlier"}\n');

    await runEval(REPOS, fakes(file, { at: "2026-11-12T09:00:00.000Z" }));

    expect(lines(file)).toEqual([{ at: "earlier" }, expect.objectContaining({ at: "2026-11-12T09:00:00.000Z" })]);
  });

  it("gives no rate for a repo whose Guide has no Claims", async () => {
    const file = resultsFile();
    const run = fakes(file);

    await runEval([{ name: "empty", url: "unused" }], {
      ...run,
      generate: async () => ({ declined: false, verifiedClaims: [{ section: "overview", written: 0, confirmed: 0, kept: 0 }] }),
    });

    expect(lines(file)).toEqual([expect.objectContaining({
      repos: [{ name: "empty", commit: "empty-sha", written: 0, confirmed: 0, kept: 0, confirmedRate: null, keptRate: null }],
      overall: { written: 0, confirmed: 0, kept: 0, confirmedRate: null, keptRate: null },
    })]);
  });

  it("records nothing when a repo's cost estimate is declined", async () => {
    const file = resultsFile();
    writeFileSync(file, '{"at":"earlier"}\n');

    const run = await runEval(REPOS, fakes(file, { declined: ["beta"] }));

    expect(run).toBeUndefined();
    expect(lines(file)).toEqual([{ at: "earlier" }]);
  });
});
