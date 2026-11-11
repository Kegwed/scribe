import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS } from "../llm.ts";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { recordedLlm, type RecordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";
import { status } from "./status.ts";
import { update } from "./update.ts";

/** Its one Module has no code, so only Getting started asks the LLM anything. */
const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "App", path: "lib" }] }),
  "package.json": JSON.stringify({ name: "app", scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }, null, 2),
  "package-lock.json": "{}\n",
  ".github/workflows/ci.yml": [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - name: Check",
    "        run: |",
    "          npm run lint",
    "          npm test",
    "",
  ].join("\n"),
  "README.md": "# App\n\nInstall the dependencies:\n\n```sh\n$ npm install\n```\n",
  "src/index.ts": "export const answer = 42;\n",
};

/** Every command the fixture's scripts, CI workflow and README give. */
const KNOWN_COMMANDS = ["npm run build", "npm run test", "npm test", "npm run lint", "npm ci", "npm install"];

const SECTION = "docs/guide/getting-started.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

describe("generate: Getting started", () => {
  it("writes a Getting started Section citing the repo's scripts, CI steps and docs", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = recordedLlm("getting-started");

    await generate(repo.dir, {}, { llm });

    const content = read(repo.dir, SECTION);
    expect(content).toMatch(/^# Getting started\n/);
    const [, ...prose] = content.split("\n\n").filter((block) => !block.startsWith("[^"));
    expect(prose.length).toBeGreaterThan(0);
    for (const paragraph of prose) expect(paragraph).toMatch(/\[\^\d+\]$/);
    expect(content).toMatch(/^\[\^\d+\]: (package\.json|\.github\/workflows\/ci\.yml|README\.md) \(.+\)$/m);
    const commands = [...content.matchAll(/`([^`]+)`/g)].map(([, command]) => command);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(KNOWN_COMMANDS).toContain(command);
    expect(llm.calls.some((call) => call.model === MODELS.verify)).toBe(true);
    const { sections } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    expect(sections["getting-started"]).toMatchObject({ file: SECTION, evidence: expect.arrayContaining([expect.anything()]) });
  });

  const SCRIPT = ["package.json#scripts.test"];
  const claims = (...texts: string[]) => ({ paragraphs: [{ claims: texts.map((text) => ({ text, evidence: SCRIPT })) }] });

  it("keeps commands that a script, a CI step or a doc gives", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm(claims(
      "Run `npm test` or `npm run test`.",
      "Build with `npm  run build`.",
      "CI installs with `npm ci` and lints with `npm run lint`.",
      "The README installs with `npm install`.",
    ));

    const result = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe([
      "# Getting started",
      "",
      "Run `npm test` or `npm run test`.[^1] Build with `npm  run build`.[^1] CI installs with `npm ci` and lints with `npm run lint`.[^1] The README installs with `npm install`.[^1]",
      "",
      "[^1]: package.json (scripts.test)",
      "",
    ].join("\n"));
    expect(result.droppedClaims).toEqual([]);
  });

  it("removes a Claim naming a command the repo doesn't have, without asking a model, and reports it", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm(claims("Run `npm test`.", "Deploy with `npm run deploy`."));

    const result = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe("# Getting started\n\nRun `npm test`.[^1]\n\n[^1]: package.json (scripts.test)\n");
    expect(result.droppedClaims).toEqual([{
      section: "getting-started",
      text: "Deploy with `npm run deploy`.",
      reason: "names `npm run deploy`, which no package.json script, CI workflow step or existing doc runs",
    }]);
    const verified = llm.calls.filter((call) => call.model === MODELS.verify);
    expect(verified.some((call) => call.prompt.includes("npm run deploy"))).toBe(false);
    expect(writes(llm)[1]?.prompt).toContain("names `npm run deploy`");
  });

  it("keeps a Claim whose command the repair corrects", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm([claims("Deploy with `npm run deploy`."), claims("Lint with `npm run lint`.")]);

    const result = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toContain("Lint with `npm run lint`.[^1]");
    expect(result.droppedClaims).toEqual([]);
  });

  it("runs scripts with the package manager the lockfile names", async () => {
    const { "package-lock.json": _, ...rest } = TARGET;
    const repo = createFixtureRepo({ ...rest, "pnpm-lock.yaml": "lockfileVersion: 9\n" });
    const llm = scriptedLlm(claims("Run `pnpm test`.", "Or `npm run build`."));

    const result = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toContain("Run `pnpm test`.[^1]");
    expect(result.droppedClaims).toEqual([expect.objectContaining({ text: "Or `npm run build`." })]);
  });

  it("never takes a command from the Guide itself", async () => {
    const repo = createFixtureRepo({ ...TARGET, "docs/guide/modules/src.md": "# App\n\n```sh\nnpm run deploy\n```\n" });
    const llm = scriptedLlm(claims("Deploy with `npm run deploy`."));

    const result = await generate(repo.dir, {}, { llm });

    expect(result.droppedClaims).toContainEqual(expect.objectContaining({ section: "getting-started", text: "Deploy with `npm run deploy`." }));
  });

  it("counts Getting started in the cost estimate", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm("unused");
    let sections: { section: string; tokens: number }[] = [];

    await generate(repo.dir, { confirm: async (estimate) => ((sections = estimate.sections), false) }, { llm });

    expect(sections.find((s) => s.section === "getting-started")?.tokens).toBeGreaterThan(0);
    expect(llm.calls).toEqual([]);
  });

  it("writes a bare Getting started, without asking the LLM, when the repo has no scripts, CI or docs", async () => {
    const repo = createFixtureRepo({ "scribe.config.json": JSON.stringify({ modules: [{ name: "Empty", path: "src/empty" }] }) });
    const llm = scriptedLlm("unused");

    await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe("# Getting started\n");
    expect(llm.calls).toEqual([]);
  });

  it("never overwrites a Getting started a human edited, and reports it Frozen", async () => {
    const repo = createFixtureRepo({ ...TARGET, [SECTION]: "# My setup notes\n" });

    const result = await generate(repo.dir, {}, { llm: scriptedLlm(claims("Run `npm test`.")) });

    expect(read(repo.dir, SECTION)).toBe("# My setup notes\n");
    expect(result.frozen).toContain("getting-started");
  });

  it("is current in status after generate, and Stale once a script it cites changes", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: scriptedLlm(claims("Run `npm test`.")) });

    const before = (await status(repo.dir)).sections.find((s) => s.section === "getting-started");
    repo.commit({ "package.json": JSON.stringify({ name: "app", scripts: { build: "tsc", test: "vitest", lint: "eslint ." } }, null, 2) });
    const after = (await status(repo.dir)).sections.find((s) => s.section === "getting-started");

    expect(before).toMatchObject({ stale: false, frozen: false, added: false });
    expect(after).toMatchObject({ stale: true, changedEvidence: ["package.json#scripts.test"] });
  });

  it("is regenerated by update when a script it cites changes", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: scriptedLlm(claims("Run `npm test`.")) });
    repo.commit({ "package.json": JSON.stringify({ name: "app", scripts: { test: "vitest" } }, null, 2) });

    const llm = scriptedLlm(claims("Test with `npm test`."));
    await update(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe("# Getting started\n\nTest with `npm test`.[^1]\n\n[^1]: package.json (scripts.test)\n");
    expect(writes(llm)[0]!.prompt).toContain('<changed id="package.json#scripts.test" status="changed"/>');
  });
});

function writes(llm: RecordedLlm) {
  return llm.calls.filter((call) => call.model === MODELS.write);
}
