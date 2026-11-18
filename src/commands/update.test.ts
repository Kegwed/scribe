import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CostEstimate } from "../estimate.ts";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { isSectionWrite, type RecordedLlm, recordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { HOT, STABLE, stableSection } from "../test/sections.ts";
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

/** Requests to write a Module Section. */
function writes(llm: RecordedLlm) {
  return llm.calls.filter((call) => isSectionWrite(call) && call.prompt.startsWith("Module: "));
}

/** Requests to write a top-level Section, by title. */
function topLevelWrites(llm: RecordedLlm, title: string) {
  return llm.calls.filter((call) => isSectionWrite(call) && call.prompt.startsWith(`Section: ${title}\n`));
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

  it("expects a revision, like a Proposal, to verify all its Claims anew and to be repaired", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": A_CHANGED });
    const estimateOf = async () => {
      let shown: CostEstimate | undefined;
      await update(repo.dir, { confirm: async (estimate) => ((shown = estimate), false) }, { llm: scriptedLlm({ paragraphs: [] }) });
      return shown!.sections[0]!;
    };

    const revision = await estimateOf();
    repo.commit({ [A]: "# A\n\nMy words.\n" });
    const proposal = await estimateOf();

    // Only one of A's two symbols changed, yet a rewritten Section's Claims miss their cached verdicts, and some fail and are repaired.
    for (const write of [revision, proposal]) {
      expect(write.requests.verdict).toBeGreaterThan(write.claims);
      expect(write.requests.write).toBeGreaterThan(1.5);
    }
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
      sections: [{ section: "modules/src-a", tokens: 0, dollars: 0, unpriced: [], requests: {}, claims: 0, free: "cached" }], tokens: 0, dollars: 0, unpriced: [], requests: {}, claims: 0,
    });
    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "A returns two.[^1]", ["[^1]: src/a/a.ts (a)"]));
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

    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "A returns two.[^1] K is three.[^2]", ["[^1]: src/a/a.ts (a)", "[^2]: src/a/a.ts (k)"]));
    expect(read(repo.dir, B)).toBe(before);
    expect(writes(llm)).toHaveLength(1);
    const { prompt } = writes(llm)[0]!;
    expect(prompt).toContain("A returns one.[^1] K is three.[^2]");
    expect(prompt).toContain("[^1]: src/a/a.ts#a");
    expect(prompt).toContain('<changed id="src/a/a.ts#a" status="changed"/>');
    expect(prompt).not.toContain('<changed id="src/a/a.ts#k"');
    // Scribe writes the churn Claim itself, so the model never sees it to revise.
    expect(prompt).not.toContain(STABLE);
    expect(prompt).not.toContain("history:");
    const { sections } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    expect(sections["modules/src-a"]).toEqual({
      file: A,
      evidence: [
        { id: "src/a/a.ts#a", hash: sha256("export function a() {\n  return 2;\n}") },
        kRecord,
        { id: "history:src/a", hash: sha256(STABLE) },
      ],
      contentHash: sha256(read(repo.dir, A)),
    });
  });

  it("rewrites a Section whose Module has turned hot, keeping the Claims the model wrote", async () => {
    const repo = await generated();
    const before = read(repo.dir, B);
    for (let i = 0; i < 4; i++) repo.commit({ "src/a/notes.md": `change ${i}\n` });
    const llm = scriptedLlm({
      paragraphs: [{ claims: [{ text: "A returns one.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }],
    });

    await update(repo.dir, {}, { llm });

    expect(read(repo.dir, A)).toBe(
      `# A\n\nA returns one.[^1] K is three.[^2]\n\n${HOT}[^3]\n\n[^1]: src/a/a.ts (a)\n[^2]: src/a/a.ts (k)\n[^3]: git history of src/a (90 days)\n`,
    );
    expect(read(repo.dir, B)).toBe(before);
    expect(writes(llm)[0]!.prompt).not.toContain("<changed ");
    expect(JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections["modules/src-a"].evidence).toContainEqual({ id: "history:src/a", hash: sha256(HOT) });
  });

  it("tells the model which cited symbols are gone", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": "export function a() {\n  return 1;\n}\n" });
    const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "A returns one.", evidence: ["src/a/a.ts#a"] }] }] });

    await update(repo.dir, {}, { llm });

    expect(writes(llm)[0]!.prompt).toContain('<changed id="src/a/a.ts#k" status="gone"/>');
    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "A returns one.[^1]", ["[^1]: src/a/a.ts (a)"]));
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
    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "K is three.[^1]", ["[^1]: src/a/a.ts (k)"]));
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

    expect(read(repo.dir, "docs/guide/modules/src-c.md")).toBe(stableSection("C", "src/c", "C is one.[^1]", ["[^1]: src/c/c.ts (c)"]));
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
    expect(Object.keys(JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections)).toEqual(["modules/src-a", "getting-started", "conventions", "key-decisions", "overview", "architecture"]);
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
    expect(read(repo.dir, A_PROPOSAL)).toBe(stableSection("A", "src/a", "A returns two.[^1] K is three.[^2]", ["[^1]: src/a/a.ts (a)", "[^2]: src/a/a.ts (k)"]));
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
    expect(read(repo.dir, A_PROPOSAL)).toBe(stableSection("A", "src/a", "K is three.[^1]", ["[^1]: src/a/a.ts (k)"]));
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

    expect(read(repo.dir, B)).toBe(stableSection("B", "src/b", "B is one.[^1]", ["[^1]: src/b/b.ts (b)"]));
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
      droppedClaims: [], verifiedClaims: [], frozen: [], reduced: [], warnings: [], removed: [], proposals: [],
      estimate: { sections: [], tokens: 0, dollars: 0, unpriced: [], requests: {}, claims: 0 }, declined: false, drift: [],
    });
  });

  describe("Overview and Architecture", () => {
    const OVERVIEW = "docs/guide/overview.md";
    const ARCHITECTURE = "docs/guide/architecture.md";
    const MODULES = [
      { paragraphs: [{ claims: [{ text: "A returns one.", evidence: ["src/a/a.ts#a"] }] }] },
      { paragraphs: [{ claims: [{ text: "B is one.", evidence: ["src/b/b.ts#b"] }] }] },
    ];
    const OVERVIEW_CLAIMS = { paragraphs: [{ claims: [{ text: "The repo has Modules A and B.", evidence: ["graph:modules"] }] }] };
    const NO_IMPORTS = { paragraphs: [{ claims: [{ text: "No Module imports another.", evidence: ["graph:imports"] }] }] };
    const B_IMPORTS_A = { paragraphs: [{ claims: [{ text: "B imports A.", evidence: ["graph:imports"] }] }] };

    /** Generates and commits the Guide, with Overview citing the Module list and Architecture the import graph. */
    async function layered() {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm(MODULES, {}, { topLevel: { Overview: OVERVIEW_CLAIMS, Architecture: NO_IMPORTS } }) });
      repo.commit({}, "generate the Guide");
      return repo;
    }
    const addImport = { "src/b/b.ts": 'import { k } from "../a/a.ts";\n\nexport const b = k - 2;\n' };

    it("leaves them as they are when only a symbol inside a Module changes", async () => {
      const repo = await layered();
      const before = [read(repo.dir, OVERVIEW), read(repo.dir, ARCHITECTURE)];
      repo.commit({ "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n" });
      const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "A returns two.", evidence: ["src/a/a.ts#a"] }] }] }, {}, {
        topLevel: { Overview: "unused", Architecture: "unused" },
      });

      await update(repo.dir, {}, { llm });

      expect(writes(llm)).toHaveLength(1);
      expect(topLevelWrites(llm, "Overview")).toEqual([]);
      expect(topLevelWrites(llm, "Architecture")).toEqual([]);
      expect([read(repo.dir, OVERVIEW), read(repo.dir, ARCHITECTURE)]).toEqual(before);
    });

    it("revises Architecture alone when an import between Modules is added, from its current text and the change", async () => {
      const repo = await layered();
      const overview = read(repo.dir, OVERVIEW);
      repo.commit(addImport);
      const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "B is k minus two.", evidence: ["src/b/b.ts#b"] }] }] }, {}, {
        topLevel: { Overview: "unused", Architecture: B_IMPORTS_A },
      });

      await update(repo.dir, {}, { llm });

      expect(read(repo.dir, ARCHITECTURE)).toBe("# Architecture\n\nB imports A.[^1]\n\n[^1]: Import graph between Modules\n");
      expect(read(repo.dir, OVERVIEW)).toBe(overview);
      expect(topLevelWrites(llm, "Overview")).toEqual([]);
      expect(topLevelWrites(llm, "Architecture")).toHaveLength(1);
      const { prompt } = topLevelWrites(llm, "Architecture")[0]!;
      expect(prompt).toContain("<current-section>\n# Architecture\n\nNo Module imports another.[^1]\n\n[^1]: graph:imports\n</current-section>");
      expect(prompt).toContain('<changed id="graph:imports" status="changed"/>');
      expect(prompt).toContain("src/b imports src/a");
      expect((await status(repo.dir)).sections.filter((s) => s.stale)).toEqual([]);
    });

    it("writes a Proposal beside a Frozen Architecture when an import is added", async () => {
      const repo = await layered();
      repo.commit({ ...addImport, [ARCHITECTURE]: "# Architecture\n\nMine.\n" });
      const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "B is k minus two.", evidence: ["src/b/b.ts#b"] }] }] }, {}, {
        topLevel: { Architecture: B_IMPORTS_A },
      });

      const result = await update(repo.dir, {}, { llm });

      expect(read(repo.dir, ARCHITECTURE)).toBe("# Architecture\n\nMine.\n");
      expect(read(repo.dir, "docs/guide/architecture.proposal.md")).toBe("# Architecture\n\nB imports A.[^1]\n\n[^1]: Import graph between Modules\n");
      expect(result.proposals).toEqual([{ section: "architecture", file: "docs/guide/architecture.proposal.md" }]);
    });

    it("writes them for a Guide generated before they existed", async () => {
      const repo = await layered();
      const manifest = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
      delete manifest.sections.overview;
      delete manifest.sections.architecture;
      repo.git("rm", "--quiet", OVERVIEW, ARCHITECTURE);
      repo.commit({ ".scribe/manifest.json": JSON.stringify(manifest) });
      const llm = scriptedLlm("unused", {}, { topLevel: { Overview: OVERVIEW_CLAIMS, Architecture: NO_IMPORTS } });

      await update(repo.dir, {}, { llm });

      expect(read(repo.dir, OVERVIEW)).toBe("# Overview\n\nThe repo has Modules A and B.[^1]\n\n[^1]: Modules of the repo\n");
      expect(read(repo.dir, ARCHITECTURE)).toBe("# Architecture\n\nNo Module imports another.[^1]\n\n[^1]: Import graph between Modules\n");
      expect(writes(llm)).toEqual([]);
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
