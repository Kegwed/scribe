import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generate } from "./commands/generate.ts";
import type { GitHub } from "./github.ts";
import type { Llm } from "./llm.ts";
import { main } from "./main.ts";
import { createFixtureRepo } from "./test/fixture-repo.ts";
import { scriptedLlm } from "./test/recorded-llm.ts";

const SKIPPED = "warning: GitHub skipped, so no pull requests or issues are cited: GitHub answered 502 Bad Gateway";

/** A GitHub that fails every call, as hono's did with a 502. */
const failingGitHub: GitHub = {
  async pullRequests() {
    throw new Error("GitHub answered 502 Bad Gateway");
  },
  async pullRequest() {
    throw new Error("GitHub answered 502 Bad Gateway");
  },
};

const written = { paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] };

function target() {
  return createFixtureRepo({
    "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
    "src/a/a.ts": "export const a = 1;\n",
  });
}

/**
 * Runs the CLI in this process against `llm` and a failing GitHub, answering
 * its question with `answer`; resolves to its exit code and everything it
 * printed to stdout and stderr, as one transcript in the order printed.
 */
async function scribe(dir: string, argv: string[], { llm = scriptedLlm(written), answer }: { llm?: Llm; answer?: string } = {}) {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
  const status = await main(argv, {
    dir,
    adapters: () => ({ llm, github: failingGitHub }),
    ask: async (question) => {
      lines.push(question);
      return answer;
    },
  });
  vi.restoreAllMocks();
  return { status, lines };
}

function at(lines: string[], start: string): number {
  const index = lines.findIndex((line) => line.startsWith(start));
  expect(index, `a line starting ${start}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("warnings raised before the cost estimate", () => {
  beforeEach(() => vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-dummy"));
  afterEach(() => vi.unstubAllEnvs());

  it("print before generate's estimate and prompt, once, even when the run is declined", async () => {
    const repo = target();

    const { status, lines } = await scribe(repo.dir, ["generate"], { answer: "n" });

    expect(lines.filter((line) => line === SKIPPED)).toHaveLength(1);
    expect(at(lines, SKIPPED)).toBeLessThan(at(lines, "Estimated cost:"));
    expect(at(lines, "Estimated cost:")).toBeLessThan(at(lines, "Continue?"));
    expect(lines.at(-1)).toMatch(/^Cancelled;/);
    expect(status).toBe(1);
  });

  it("print before the estimate with --yes, and those raised while writing print after it, once each", async () => {
    const repo = target();
    repo.git("remote", "add", "origin", "git@github.com:acme/app.git");
    writeFileSync(join(repo.dir, "src/a/a.ts"), "// uncommitted\nexport const a = 1;\n");

    const { status, lines } = await scribe(repo.dir, ["generate", "--yes"]);

    expect(lines).not.toContain("Continue? [y/N] ");
    expect(lines.filter((line) => line === SKIPPED)).toHaveLength(1);
    expect(at(lines, SKIPPED)).toBeLessThan(at(lines, "Estimated cost:"));
    const uncommitted = lines.filter((line) => line.startsWith("warning: modules/src-a cites uncommitted changes"));
    expect(uncommitted).toHaveLength(1);
    expect(at(lines, uncommitted[0]!)).toBeGreaterThan(at(lines, "An estimate, made before calling Claude"));
    expect(lines.at(-1)).toBe("Guide generated.");
    expect(status).toBe(0);
  });

  it("print before reset's estimate and prompt, once", async () => {
    const repo = target();
    await generate(repo.dir, {}, { llm: scriptedLlm(written) });
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nMy words.\n" });
    rmSync(join(repo.dir, ".scribe/cache"), { recursive: true });

    const { status, lines } = await scribe(repo.dir, ["reset", "modules/src-a"], { answer: "n" });

    expect(lines.filter((line) => line === SKIPPED)).toHaveLength(1);
    expect(at(lines, SKIPPED)).toBeLessThan(at(lines, "Estimated cost:"));
    expect(status).toBe(1);
  });

  it("still print, once, when the run costs nothing and so shows no estimate", async () => {
    const repo = target();
    await scribe(repo.dir, ["generate", "--yes"]);

    const { status, lines } = await scribe(repo.dir, ["generate"]);

    expect(lines).toEqual([SKIPPED, "Guide generated."]);
    expect(status).toBe(0);
  });
});
