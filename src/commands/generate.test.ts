import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { MODELS } from "../llm.ts";
import { recordedLlm, type RecordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import type { CostEstimate } from "../section-writer.ts";
import { generate } from "./generate.ts";

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ guideDir: "docs/guide" }),
  "package.json": JSON.stringify({ name: "app" }),
  "src/auth/session.ts": [
    'import { sign } from "./sign.ts";',
    "",
    "/** Starts a session for a user. */",
    "export function createSession(user: string) {",
    "  return sign(user);",
    "}",
    "",
  ].join("\n"),
  "src/auth/sign.ts": "export function sign(value: string) {\n  return `signed:${value}`;\n}\n",
  "src/billing/invoice.ts": "export function sendInvoice(amount: number) {\n  return amount > 0;\n}\n",
};

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

function writes(llm: RecordedLlm) {
  return llm.calls.filter((call) => call.model === MODELS.write);
}

describe("generate", () => {
  it("writes one Section per Module, citing Evidence for every Claim", async () => {
    const repo = createFixtureRepo(TARGET);

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    const auth = read(repo.dir, "docs/guide/modules/src-auth.md");
    expect(auth).toMatch(/^# src\/auth\n/);
    expect(auth).toMatch(/^\[\^\d+\]: src\/auth\/session\.ts \(createSession\)$/m);
    const [, ...prose] = auth.split("\n\n").filter((block) => !block.startsWith("[^"));
    expect(prose.length).toBeGreaterThan(0);
    for (const paragraph of prose) expect(paragraph).toMatch(/\[\^\d+\]$/);
    expect(existsSync(join(repo.dir, "docs/guide/modules/src-billing.md"))).toBe(true);
  });

  it("gives a symbol cited twice one footnote", async () => {
    const repo = createFixtureRepo({ "scribe.config.json": "{}", "src/a/a.ts": "export const a = 1;\n", "src/b/b.ts": "export const b = 1;\n" });
    const llm = scriptedLlm({
      paragraphs: [{ claims: [{ text: "One.", evidence: ["src/a/a.ts#a"] }, { text: "Two.", evidence: ["src/a/a.ts#a"] }] }],
    });

    await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, "docs/guide/modules/src-a.md")).toBe("# src/a\n\nOne.[^1] Two.[^1]\n\n[^1]: src/a/a.ts (a)\n");
  });

  it("writes the Guide to the configured directory", async () => {
    const repo = createFixtureRepo({ ...TARGET, "scribe.config.json": JSON.stringify({ guideDir: "handbook" }) });

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(existsSync(join(repo.dir, "handbook/modules/src-auth.md"))).toBe(true);
  });

  it("cites SHA-pinned permalinks with the current line range when origin is on GitHub", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "git@github.com:acme/app.git");
    const sha = repo.git("rev-parse", "HEAD").trim();

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toContain(
      `: [src/auth/session.ts (createSession)](https://github.com/acme/app/blob/${sha}/src/auth/session.ts#L3-L6)`,
    );
    expect(result.warnings).toEqual([]);
  });

  it("understands https GitHub origins", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "https://github.com/acme/app.git");

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toContain("(https://github.com/acme/app/blob/");
  });

  it("cites repo-relative paths when origin is elsewhere", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "https://gitlab.com/acme/github.com.git");

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toContain(": src/auth/session.ts (createSession)");
  });

  it("warns when a permalink's file differs from the pinned commit", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "git@github.com:acme/app.git");
    writeFileSync(join(repo.dir, "src/billing/invoice.ts"), `// uncommitted\n${TARGET["src/billing/invoice.ts"]}`);

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(result.warnings).toEqual([expect.stringContaining("src/billing/invoice.ts")]);
  });

  it("records each Section's Evidence hashes and written-content hash in the manifest", async () => {
    const repo = createFixtureRepo(TARGET);

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    const { sections } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    expect(Object.keys(sections)).toEqual(["modules/src-auth", "modules/src-billing"]);
    expect(sections["modules/src-billing"]).toEqual({
      file: "docs/guide/modules/src-billing.md",
      evidence: [{
        id: "src/billing/invoice.ts#sendInvoice",
        hash: sha256("export function sendInvoice(amount: number) {\n  return amount > 0;\n}"),
      }],
      contentHash: sha256(read(repo.dir, "docs/guide/modules/src-billing.md")),
    });
  });

  it("makes no LLM calls when re-run with unchanged inputs", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: recordedLlm("generate") });
    const before = read(repo.dir, "docs/guide/modules/src-auth.md");

    const llm = recordedLlm("generate");
    await generate(repo.dir, {}, { llm });

    expect(llm.calls).toEqual([]);
    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toBe(before);
  });

  describe("cost estimate", () => {
    it("asks for confirmation with an estimate per Section; declining calls no LLM and changes no files", async () => {
      const repo = createFixtureRepo(TARGET);
      const llm = scriptedLlm({ paragraphs: [] });
      const asked: CostEstimate[] = [];

      const result = await generate(repo.dir, { confirm: async (estimate) => (asked.push(estimate), false) }, { llm });

      expect(asked).toHaveLength(1);
      const [estimate] = asked;
      expect(estimate!.sections.map((s) => s.section)).toEqual(["modules/src-auth", "modules/src-billing"]);
      for (const section of estimate!.sections) {
        expect(section.tokens).toBeGreaterThan(0);
        expect(section.dollars).toBeGreaterThan(0);
      }
      expect(estimate!.dollars).toBeCloseTo(estimate!.sections[0]!.dollars + estimate!.sections[1]!.dollars);
      expect(result.declined).toBe(true);
      expect(llm.calls).toEqual([]);
      expect(repo.git("status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
    });

    it("writes the Guide once confirmed", async () => {
      const repo = createFixtureRepo(TARGET);

      const result = await generate(repo.dir, { confirm: async () => true }, { llm: recordedLlm("generate") });

      expect(result.declined).toBe(false);
      expect(existsSync(join(repo.dir, "docs/guide/modules/src-auth.md"))).toBe(true);
    });

    it("estimates a fully cached run at zero, without asking", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: recordedLlm("generate") });
      let asked = false;

      const result = await generate(repo.dir, { confirm: async () => (asked = true) }, { llm: recordedLlm("generate") });

      expect(asked).toBe(false);
      expect(result.estimate.tokens).toBe(0);
      expect(result.estimate.dollars).toBe(0);
    });
  });

  it("never caches a response it can't use", async () => {
    const repo = createFixtureRepo(TARGET);
    await expect(generate(repo.dir, {}, { llm: scriptedLlm("not json") })).rejects.toThrow();

    const llm = recordedLlm("generate");
    await generate(repo.dir, {}, { llm });

    expect(writes(llm).length).toBeGreaterThanOrEqual(2);
  });

  it("never caches a response whose Claims are malformed", async () => {
    const repo = createFixtureRepo(TARGET);
    await expect(generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{}] }) })).rejects.toThrow(/malformed/);

    const llm = recordedLlm("generate");
    await generate(repo.dir, {}, { llm });

    expect(writes(llm).length).toBeGreaterThanOrEqual(2);
  });

  it("git-ignores the cache even when the config was written by hand", async () => {
    const repo = createFixtureRepo(TARGET);

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(repo.git("status", "--porcelain", "--untracked-files=all")).not.toContain(".scribe/cache/");
  });

  it("leaves a Section as it is when only HEAD has moved since it was written", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "git@github.com:acme/app.git");
    await generate(repo.dir, {}, { llm: recordedLlm("generate") });
    const before = read(repo.dir, "docs/guide/modules/src-auth.md");
    repo.commit({}, "commit the Guide");

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toBe(before);
    expect(repo.git("status", "--porcelain", "--", "docs/guide")).toBe("");
  });

  it("drops Claims that cite nothing, or nothing in the Module, and reports them", async () => {
    const repo = createFixtureRepo({ "scribe.config.json": "{}", "src/a/a.ts": "export const a = 1;\n", "src/b/b.ts": "export const b = 1;\n" });
    const llm = scriptedLlm({
      paragraphs: [{
        claims: [
          { text: "Uncited.", evidence: [] },
          { text: "Invented.", evidence: ["src/a/a.ts#missing"] },
          { text: "Backed.", evidence: ["src/a/a.ts#missing", "src/a/a.ts#a"] },
        ],
      }],
    });

    const result = await generate(repo.dir, {}, { llm });

    const a = read(repo.dir, "docs/guide/modules/src-a.md");
    expect(a).toBe("# src/a\n\nBacked.[^1]\n\n[^1]: src/a/a.ts (a)\n");
    expect(result.droppedClaims).toContainEqual({ section: "modules/src-a", text: "Uncited.", reason: expect.any(String) });
    expect(result.droppedClaims).toContainEqual({ section: "modules/src-a", text: "Invented.", reason: expect.any(String) });
  });

  it("never overwrites a Section a human edited, and reports it Frozen", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: recordedLlm("generate") });
    const { sections: before } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    writeFileSync(join(repo.dir, "docs/guide/modules/src-auth.md"), "# My words\n");

    const llm = recordedLlm("generate");
    const result = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toBe("# My words\n");
    expect(result.frozen).toEqual(["modules/src-auth"]);
    expect(JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections).toEqual(before);
  });

  it("treats an existing file Scribe never wrote as Frozen", async () => {
    const repo = createFixtureRepo({ ...TARGET, "docs/guide/modules/src-auth.md": "# Already here\n" });

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toBe("# Already here\n");
    expect(result.frozen).toEqual(["modules/src-auth"]);
  });

  it("doesn't Freeze a Section whose line endings a checkout changed", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: recordedLlm("generate") });
    const file = join(repo.dir, "docs/guide/modules/src-auth.md");
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(result.frozen).toEqual([]);
  });

  it("writes a bare Section for a Module with no symbols, without asking the LLM", async () => {
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "Empty", path: "src/empty" }] }),
    });
    const llm = recordedLlm("generate");

    await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, "docs/guide/modules/src-empty.md")).toBe("# Empty\n");
    expect(llm.calls).toEqual([]);
  });

  it("refuses Modules whose Section files would collide", async () => {
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({
        modules: [{ name: "One", path: "a/b" }, { name: "Two", path: "a-b" }],
      }),
    });

    await expect(generate(repo.dir, {}, { llm: recordedLlm("generate") })).rejects.toThrow(/a\/b.*a-b/);
  });

  it("asks for scribe init when the repo has no config", async () => {
    const repo = createFixtureRepo({ "src/index.ts": "export const a = 1;\n" });

    await expect(generate(repo.dir, {}, { llm: recordedLlm("generate") })).rejects.toThrow(/scribe init/);
  });

  describe("verification", () => {
    const ONE_MODULE: Files = {
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "src/a/a.ts": "export const a = 1;\n",
    };
    const SECTION = "docs/guide/modules/src-a.md";
    const CITED = ["src/a/a.ts#a"];
    const section = (...texts: string[]) => ({
      paragraphs: [{ claims: texts.map((text) => ({ text, evidence: CITED })) }],
    });

    it("writes a Section whose Claims all verify unchanged, checking each with the verifier", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const llm = scriptedLlm(section("One.", "Two."));

      const result = await generate(repo.dir, {}, { llm });

      expect(read(repo.dir, SECTION)).toBe("# A\n\nOne.[^1] Two.[^1]\n\n[^1]: src/a/a.ts (a)\n");
      expect(writes(llm)).toHaveLength(1);
      expect(llm.calls.filter((call) => call.model === MODELS.verify)).toHaveLength(2);
      expect(result.droppedClaims).toEqual([]);
    });

    it("regenerates a Section with a failing Claim once, passing on the verifier's feedback", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const llm = scriptedLlm(section("Good.", "Wrong."), {
        "Wrong.": { confirmed: false, reason: "a is not a function" },
      });

      await generate(repo.dir, {}, { llm });

      expect(writes(llm)).toHaveLength(2);
      expect(writes(llm)[1]!.prompt).toContain("a is not a function");
    });

    it("gives the repair its feedback in Claim order, however the verifier's answers arrive", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const llm = scriptedLlm(section("First.", "Second."), {
        "First.": { confirmed: false, reason: "reason one" },
        "Second.": { confirmed: false, reason: "reason two" },
      });

      await generate(repo.dir, {}, { llm });

      const { prompt } = writes(llm)[1]!;
      expect(prompt.indexOf("reason one")).toBeLessThan(prompt.indexOf("reason two"));
    });

    it("writes the repaired Section when the repair verifies", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const llm = scriptedLlm([section("Good.", "Wrong."), section("Good.", "Right.")], {
        "Wrong.": { confirmed: false, reason: "a is not a function" },
      });

      const result = await generate(repo.dir, {}, { llm });

      expect(read(repo.dir, SECTION)).toBe("# A\n\nGood.[^1] Right.[^1]\n\n[^1]: src/a/a.ts (a)\n");
      expect(result.droppedClaims).toEqual([]);
    });

    it("removes Claims the repair leaves unconfirmed, without a third write, and reports why", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const llm = scriptedLlm([section("Good.", "Wrong."), section("Good.", "Still wrong.")], {
        "Wrong.": { confirmed: false, reason: "a is not a function" },
        "Still wrong.": { confirmed: false, reason: "a is a number" },
      });

      const result = await generate(repo.dir, {}, { llm });

      expect(read(repo.dir, SECTION)).toBe("# A\n\nGood.[^1]\n\n[^1]: src/a/a.ts (a)\n");
      expect(writes(llm)).toHaveLength(2);
      expect(result.droppedClaims).toEqual([
        { section: "modules/src-a", text: "Still wrong.", reason: "a is a number" },
      ]);
    });

    it("never writes a Claim without Evidence, even after a repair", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const uncited = { paragraphs: [{ claims: [{ text: "Uncited.", evidence: [] }, { text: "Good.", evidence: CITED }] }] };
      const llm = scriptedLlm(uncited);

      const result = await generate(repo.dir, {}, { llm });

      expect(read(repo.dir, SECTION)).toBe("# A\n\nGood.[^1]\n\n[^1]: src/a/a.ts (a)\n");
      expect(writes(llm)).toHaveLength(2);
      expect(result.droppedClaims).toEqual([
        { section: "modules/src-a", text: "Uncited.", reason: expect.stringContaining("no Evidence") },
      ]);
    });

    it("leaves a Section with only unconfirmed Claims bare, citing nothing", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const llm = scriptedLlm(section("Wrong."), { "Wrong.": { confirmed: false, reason: "no" } });

      await generate(repo.dir, {}, { llm });

      expect(read(repo.dir, SECTION)).toBe("# A\n");
      expect(JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections["modules/src-a"].evidence).toEqual([]);
    });

    it("costs nothing to re-run after a repair", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      const verdicts = { "Wrong.": { confirmed: false, reason: "no" } };
      await generate(repo.dir, {}, { llm: scriptedLlm([section("Wrong."), section("Right.")], verdicts) });

      const llm = scriptedLlm("unused");
      await generate(repo.dir, {}, { llm });

      expect(llm.calls).toEqual([]);
    });

    it("never caches a verdict it can't use", async () => {
      const repo = createFixtureRepo(ONE_MODULE);
      await expect(generate(repo.dir, {}, { llm: scriptedLlm(section("One."), { "One.": { confirmed: "yes" } }) })).rejects.toThrow(/malformed/);

      await generate(repo.dir, {}, { llm: scriptedLlm(section("One.")) });

      expect(read(repo.dir, SECTION)).toContain("One.");
    });
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
