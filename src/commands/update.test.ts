import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS } from "../llm.ts";
import type { CostEstimate } from "../section-writer.ts";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { type RecordedLlm, recordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";
import { status } from "./status.ts";
import { update } from "./update.ts";

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }] }),
  "src/a/a.ts": "export function a() {\n  return 1;\n}\n\nexport const k = 3;\n",
  "src/b/b.ts": "export const b = 1;\n",
};
const A = "docs/guide/modules/src-a.md";
const B = "docs/guide/modules/src-b.md";
const A_PROPOSAL = "docs/guide/modules/src-a.proposal.md";
const B_PROPOSAL = "docs/guide/modules/src-b.proposal.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function writes(llm: RecordedLlm) {
  return llm.calls.filter((call) => call.model === MODELS.write);
}

/** Generates and commits the Guide: A with two Claims citing a and k, B with one citing b. */
async function generated(files: Files = TARGET) {
  const repo = createFixtureRepo(files);
  await generate(repo.dir, {}, {
    llm: scriptedLlm([
      { paragraphs: [{ claims: [{ text: "A returns one.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }] },
      { paragraphs: [{ claims: [{ text: "B is one.", evidence: ["src/b/b.ts#b"] }] }] },
    ]),
  });
  repo.commit({}, "generate the Guide");
  return repo;
}

describe("update against recorded responses", () => {
  const PRICING: Files = {
    "scribe.config.json": JSON.stringify({ modules: [{ name: "Pricing", path: "src/pricing" }, { name: "Greeting", path: "src/greeting" }] }),
    "src/pricing/price.ts": [
      "/** Rounds a price to whole cents. */",
      "export function roundPrice(price: number) {",
      "  return Math.round(price * 100) / 100;",
      "}",
      "",
      'export const CURRENCY = "EUR";',
      "",
    ].join("\n"),
    "src/greeting/greet.ts": "export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n",
  };
  const PRICING_SECTION = "docs/guide/modules/src-pricing.md";
  const GREETING_SECTION = "docs/guide/modules/src-greeting.md";

  it("revises the Stale Section, keeping the Claim on the symbol that didn't change", async () => {
    const repo = createFixtureRepo(PRICING);
    await generate(repo.dir, {}, { llm: recordedLlm("update") });
    repo.commit({}, "generate the Guide");
    const greeting = read(repo.dir, GREETING_SECTION);
    repo.commit({
      "src/pricing/price.ts": PRICING["src/pricing/price.ts"]!
        .replace("Rounds a price to whole cents", "Rounds a price down to whole cents")
        .replace("Math.round", "Math.floor"),
    });

    await update(repo.dir, {}, { llm: recordedLlm("update") });

    const pricing = read(repo.dir, PRICING_SECTION);
    expect(pricing).toMatch(/^\[\^\d+\]: src\/pricing\/price\.ts \(roundPrice\)$/m);
    expect(pricing).toMatch(/^\[\^\d+\]: src\/pricing\/price\.ts \(CURRENCY\)$/m);
    const [, ...prose] = pricing.split("\n\n").filter((block) => !block.startsWith("[^"));
    for (const paragraph of prose) expect(paragraph).toMatch(/\[\^\d+\]$/);
    expect(read(repo.dir, GREETING_SECTION)).toBe(greeting);
    expect((await status(repo.dir)).sections.filter((s) => s.stale)).toEqual([]);
  });
});

describe("update's cost estimate", () => {
  const A_CHANGED = "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n";

  it("covers only the Stale Section; declining calls no LLM and changes no files", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": A_CHANGED });
    const llm = scriptedLlm({ paragraphs: [] });
    const asked: CostEstimate[] = [];

    const result = await update(repo.dir, { confirm: async (estimate) => (asked.push(estimate), false) }, { llm });

    expect(asked.map((e) => e.sections.map((s) => s.section))).toEqual([["modules/src-a"]]);
    expect(asked[0]!.dollars).toBeGreaterThan(0);
    expect(result.declined).toBe(true);
    expect(llm.calls).toEqual([]);
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("counts a Proposal for a Frozen, Stale Section, and declining writes none", async () => {
    const repo = await generated();
    repo.commit({ [A]: "# A\n\nMy words.\n", "src/a/a.ts": A_CHANGED });
    const asked: CostEstimate[] = [];

    await update(repo.dir, { confirm: async (estimate) => (asked.push(estimate), false) }, { llm: scriptedLlm({ paragraphs: [] }) });

    expect(asked.map((e) => e.sections.map((s) => s.section))).toEqual([["modules/src-a"]]);
    expect(existsSync(join(repo.dir, A_PROPOSAL))).toBe(false);
  });

  it("keeps a removed Module's record when declined", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", "-r", "src/b");
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "src/a/a.ts": A_CHANGED,
    });

    const result = await update(repo.dir, { confirm: async () => false }, { llm: scriptedLlm({ paragraphs: [] }) });

    expect(result.declined).toBe(true);
    expect(result.removed).toEqual([]);
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("estimates Stale Sections whose rewrite is already cached at zero, without asking", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": A_CHANGED });
    const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "A returns two.", evidence: ["src/a/a.ts#a"] }] }] });
    await update(repo.dir, {}, { llm });
    repo.git("checkout", "--", ".");
    let asked = false;

    const result = await update(repo.dir, { confirm: async () => (asked = true) }, { llm });

    expect(asked).toBe(false);
    expect(result.estimate).toEqual({
      sections: [{ section: "modules/src-a", tokens: 0, dollars: 0, unpriced: [] }], tokens: 0, dollars: 0, unpriced: [],
    });
    expect(read(repo.dir, A)).toBe("# A\n\nA returns two.[^1]\n\n[^1]: src/a/a.ts (a)\n");
  });
});

describe("update", () => {
  it("rewrites only the Section citing a changed symbol, from its current text and the change", async () => {
    const repo = await generated();
    const before = read(repo.dir, B);
    const kRecord = JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections["modules/src-a"].evidence[1];
    repo.commit({ "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n" });
    const llm = scriptedLlm({
      paragraphs: [{ claims: [{ text: "A returns two.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }],
    });

    await update(repo.dir, {}, { llm });

    expect(read(repo.dir, A)).toBe("# A\n\nA returns two.[^1] K is three.[^2]\n\n[^1]: src/a/a.ts (a)\n[^2]: src/a/a.ts (k)\n");
    expect(read(repo.dir, B)).toBe(before);
    expect(writes(llm)).toHaveLength(1);
    const { prompt } = writes(llm)[0]!;
    expect(prompt).toContain("A returns one.[^1] K is three.[^2]");
    expect(prompt).toContain("[^1]: src/a/a.ts#a");
    expect(prompt).toContain('<changed id="src/a/a.ts#a" status="changed"/>');
    expect(prompt).not.toContain('<changed id="src/a/a.ts#k"');
    const { sections } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    expect(sections["modules/src-a"]).toEqual({
      file: A,
      evidence: [
        { id: "src/a/a.ts#a", hash: sha256("export function a() {\n  return 2;\n}") },
        kRecord,
      ],
      contentHash: sha256(read(repo.dir, A)),
    });
  });

  it("tells the model which cited symbols are gone", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": "export function a() {\n  return 1;\n}\n" });
    const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "A returns one.", evidence: ["src/a/a.ts#a"] }] }] });

    await update(repo.dir, {}, { llm });

    expect(writes(llm)[0]!.prompt).toContain('<changed id="src/a/a.ts#k" status="gone"/>');
    expect(read(repo.dir, A)).toBe("# A\n\nA returns one.[^1]\n\n[^1]: src/a/a.ts (a)\n");
  });

  it("verifies a regenerated Section, dropping and reporting Claims its repair leaves unconfirmed", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n" });
    const revised = { paragraphs: [{ claims: [{ text: "A returns three.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }] };
    const llm = scriptedLlm(revised, { "A returns three.": { confirmed: false, reason: "a returns 2" } });

    const result = await update(repo.dir, {}, { llm });

    expect(writes(llm)).toHaveLength(2);
    expect(writes(llm)[1]!.prompt).toContain("a returns 2");
    expect(writes(llm)[1]!.prompt).toContain("<current-section>\n# A\n\nA returns one.[^1] K is three.[^2]");
    expect(read(repo.dir, A)).toBe("# A\n\nK is three.[^1]\n\n[^1]: src/a/a.ts (k)\n");
    expect(result.droppedClaims).toEqual([{ section: "modules/src-a", text: "A returns three.", reason: "a returns 2" }]);
  });

  it("writes a Section for a newly added Module, leaving the others alone", async () => {
    const repo = await generated();
    const before = [read(repo.dir, A), read(repo.dir, B)];
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }, { name: "C", path: "src/c" }] }),
      "src/c/c.ts": "export const c = 1;\n",
    });
    const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "C is one.", evidence: ["src/c/c.ts#c"] }] }] });

    await update(repo.dir, {}, { llm });

    expect(read(repo.dir, "docs/guide/modules/src-c.md")).toBe("# C\n\nC is one.[^1]\n\n[^1]: src/c/c.ts (c)\n");
    expect([read(repo.dir, A), read(repo.dir, B)]).toEqual(before);
    expect(writes(llm)).toHaveLength(1);
    expect(writes(llm)[0]!.prompt).not.toContain("<current-section>");
  });

  it("reports a removed Module's Section, leaving its file and dropping its manifest record", async () => {
    const repo = await generated();
    const before = read(repo.dir, B);
    repo.git("rm", "--quiet", "-r", "src/b");
    repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });
    const llm = scriptedLlm("unused");

    const result = await update(repo.dir, {}, { llm });

    expect(result.removed).toEqual([{ section: "modules/src-b", file: B }]);
    expect(read(repo.dir, B)).toBe(before);
    expect(Object.keys(JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections)).toEqual(["modules/src-a", "getting-started", "conventions"]);
    expect(llm.calls).toEqual([]);
  });

  it("never modifies a Frozen Section, Stale or not, and writes a Proposal alongside the Stale one", async () => {
    const repo = await generated();
    const { sections: before } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    repo.commit({
      [A]: "# A\n\nMy words.\n",
      [B]: "# B\n\nMine too.\n",
      "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n",
    });
    const llm = scriptedLlm({
      paragraphs: [{ claims: [{ text: "A returns two.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }],
    });

    const result = await update(repo.dir, {}, { llm });

    expect(read(repo.dir, A)).toBe("# A\n\nMy words.\n");
    expect(read(repo.dir, B)).toBe("# B\n\nMine too.\n");
    expect(read(repo.dir, A_PROPOSAL)).toBe("# A\n\nA returns two.[^1] K is three.[^2]\n\n[^1]: src/a/a.ts (a)\n[^2]: src/a/a.ts (k)\n");
    expect(existsSync(join(repo.dir, B_PROPOSAL))).toBe(false);
    expect(result.frozen).toEqual([]);
    expect(result.proposals).toEqual([{ section: "modules/src-a", file: A_PROPOSAL }]);
    expect(JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections).toEqual(before);
    // Regenerated from the code, not revised from the human's text.
    expect(writes(llm)).toHaveLength(1);
    expect(writes(llm)[0]!.prompt).not.toContain("<current-section>");
    expect(writes(llm)[0]!.prompt).not.toContain("My words.");
  });

  it("verifies a Proposal, dropping and reporting Claims its repair leaves unconfirmed", async () => {
    const repo = await generated();
    repo.commit({
      [A]: "# A\n\nMy words.\n",
      "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n",
    });
    const proposal = { paragraphs: [{ claims: [{ text: "A returns three.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }] };
    const llm = scriptedLlm(proposal, { "A returns three.": { confirmed: false, reason: "a returns 2" } });

    const result = await update(repo.dir, {}, { llm });

    expect(writes(llm)).toHaveLength(2);
    expect(writes(llm)[1]!.prompt).toContain("a returns 2");
    expect(read(repo.dir, A_PROPOSAL)).toBe("# A\n\nK is three.[^1]\n\n[^1]: src/a/a.ts (k)\n");
    expect(read(repo.dir, A)).toBe("# A\n\nMy words.\n");
    expect(result.droppedClaims).toEqual([{ section: "modules/src-a", text: "A returns three.", reason: "a returns 2", proposal: true }]);
  });

  it("writes no Proposal for a hand-written Section Scribe never recorded", async () => {
    const repo = await generated();
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }, { name: "C", path: "src/c" }] }),
      "src/c/c.ts": "export const c = 1;\n",
      "docs/guide/modules/src-c.md": "# C\n\nMine.\n",
    });
    const llm = scriptedLlm("unused");

    const result = await update(repo.dir, {}, { llm });

    expect(existsSync(join(repo.dir, "docs/guide/modules/src-c.proposal.md"))).toBe(false);
    expect(result.proposals).toEqual([]);
    expect(llm.calls).toEqual([]);
  });

  it("leaves a pending Proposal as it is when re-run with nothing changed", async () => {
    const repo = await generated();
    repo.commit({
      [A]: "# A\n\nMy words.\n",
      "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n",
    });
    const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "A returns two.", evidence: ["src/a/a.ts#a"] }] }] });
    await update(repo.dir, {}, { llm });
    repo.commit({}, "write the Proposal");

    const again = scriptedLlm("unused");
    const result = await update(repo.dir, {}, { llm: again });

    expect(again.calls).toEqual([]);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(result.proposals).toEqual([{ section: "modules/src-a", file: A_PROPOSAL }]);
  });

  it("writes a Section again when its file is gone", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", B);
    const llm = scriptedLlm("unused");

    await update(repo.dir, {}, { llm });

    expect(read(repo.dir, B)).toBe("# B\n\nB is one.[^1]\n\n[^1]: src/b/b.ts (b)\n");
    // Written from scratch, the request is the one generate made, so the cache answers it.
    expect(llm.calls).toEqual([]);
  });

  it("changes nothing and asks no LLM when no Section is Stale, new, missing or removed", async () => {
    const repo = await generated();
    const llm = scriptedLlm("unused");

    const result = await update(repo.dir, {}, { llm });

    expect(llm.calls).toEqual([]);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(result).toEqual({
      droppedClaims: [], frozen: [], reduced: [], warnings: [], removed: [], proposals: [],
      estimate: { sections: [], tokens: 0, dollars: 0, unpriced: [] }, declined: false, drift: [],
    });
  });

  it("asks for scribe init when the repo has no config", async () => {
    const repo = createFixtureRepo({ "src/index.ts": "export const a = 1;\n" });

    await expect(update(repo.dir, {}, { llm: scriptedLlm("unused") })).rejects.toThrow(/scribe init/);
  });

  describe("a Module too large for one writing request", () => {
    const LIMIT = 1500;
    const large = (offset: number): Files => ({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "src/a/a.ts": [
        "export function run(value: number) {",
        "  return helper(value);",
        "}",
        "",
        "function helper(value: number) {",
        ...Array.from({ length: 40 }, (_, i) => `  const step${i} = value + ${i + offset};`),
        "  return value;",
        "}",
        "",
        `export const NAMES = [${Array.from({ length: 40 }, (_, i) => `"n${i}"`).join(", ")}];`,
        "",
      ].join("\n"),
    });
    const CLAIM = { paragraphs: [{ claims: [{ text: "Run delegates to a helper.", evidence: ["src/a/a.ts#run", "src/a/a.ts#helper"] }] }] };

    async function generatedLarge() {
      const repo = createFixtureRepo(large(0));
      await generate(repo.dir, {}, { llm: scriptedLlm(CLAIM, {}, { promptLimit: LIMIT }) });
      repo.commit(large(1), "change the helper");
      return repo;
    }

    it("revises its Stale Section from summaries, within the limit and with the Section's current text", async () => {
      const repo = await generatedLarge();
      const llm = scriptedLlm(CLAIM, {}, { promptLimit: LIMIT });

      const result = await update(repo.dir, {}, { llm });

      const [revision] = writes(llm);
      expect(revision!.prompt.length).toBeLessThanOrEqual(LIMIT);
      expect(revision!.prompt).toContain("Run delegates to a helper.");
      expect(revision!.prompt).toContain('<changed id="src/a/a.ts#helper" status="changed"/>');
      expect(result.reduced).toEqual([{ section: "modules/src-a", summarised: ["src/a/a.ts#helper"], leftOut: [] }]);
    });

    it("reports the reduction as the Proposal's when the Section is Frozen", async () => {
      const repo = await generatedLarge();
      repo.commit({ [A]: "# A\n\nMy words.\n" });

      const result = await update(repo.dir, {}, { llm: scriptedLlm(CLAIM, {}, { promptLimit: LIMIT }) });

      expect(read(repo.dir, A_PROPOSAL)).toContain("Run delegates to a helper.");
      expect(result.reduced).toEqual([{ section: "modules/src-a", summarised: ["src/a/a.ts#helper"], leftOut: [], proposal: true }]);
    });
  });
});
