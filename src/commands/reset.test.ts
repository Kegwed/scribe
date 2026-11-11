import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { scriptedLlm } from "../test/recorded-llm.ts";
import { stableSection } from "../test/sections.ts";
import { adopt } from "./adopt.ts";
import { generate } from "./generate.ts";
import { reset } from "./reset.ts";
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
const CHANGED_A = "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

function manifest(dir: string) {
  return JSON.parse(read(dir, ".scribe/manifest.json"));
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

const A_TWO = { paragraphs: [{ claims: [{ text: "A returns two.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }] };

describe("reset", () => {
  it("discards a human's edits to a Frozen, Stale Section, regenerating it from the code and clearing its Proposal", async () => {
    const repo = await generated();
    const b = read(repo.dir, B);
    repo.commit({ [A]: "# A\n\nMy words.\n", "src/a/a.ts": CHANGED_A });
    await update(repo.dir, {}, { llm: scriptedLlm(A_TWO) });
    expect(existsSync(join(repo.dir, A_PROPOSAL))).toBe(true);
    const llm = scriptedLlm(A_TWO);

    const result = await reset(repo.dir, "modules/src-a", { llm });

    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "A returns two.[^1] K is three.[^2]", ["[^1]: src/a/a.ts (a)", "[^2]: src/a/a.ts (k)"]));
    expect(read(repo.dir, B)).toBe(b);
    expect(existsSync(join(repo.dir, A_PROPOSAL))).toBe(false);
    expect(result.clearedProposal).toBe(A_PROPOSAL);
    const after = await status(repo.dir);
    expect(after.sections.find((s) => s.section === "modules/src-a")).toEqual(expect.objectContaining({ frozen: false, stale: false }));
    expect(after.proposals).toEqual([]);
    // Written from the code alone, not revised from the human's text.
    expect(llm.calls.some((call) => call.prompt.includes("My words."))).toBe(false);
  });

  it("verifies the regenerated Section, dropping and reporting Claims its repair leaves unconfirmed", async () => {
    const repo = await generated();
    repo.commit({ [A]: "# A\n\nMy words.\n", "src/a/a.ts": CHANGED_A });
    const wrong = { paragraphs: [{ claims: [{ text: "A returns three.", evidence: ["src/a/a.ts#a"] }, { text: "K is three.", evidence: ["src/a/a.ts#k"] }] }] };

    const result = await reset(repo.dir, "modules/src-a", { llm: scriptedLlm(wrong, { "A returns three.": { confirmed: false, reason: "a returns 2" } }) });

    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "K is three.[^1]", ["[^1]: src/a/a.ts (k)"]));
    expect(result.droppedClaims).toEqual([{ section: "modules/src-a", text: "A returns three.", reason: "a returns 2" }]);
  });

  it("clears an adopted Section's Unsupported Claims", async () => {
    const repo = await generated();
    repo.commit({ [A]: "# A\n\nA is fast.\n" });
    await adopt(repo.dir, "modules/src-a", { llm: scriptedLlm("unused") });
    expect((await status(repo.dir)).unsupportedClaims).toEqual([{ section: "modules/src-a", text: "A is fast." }]);

    await reset(repo.dir, "modules/src-a", { llm: scriptedLlm("unused") });

    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "A returns one.[^1] K is three.[^2]", ["[^1]: src/a/a.ts (a)", "[^2]: src/a/a.ts (k)"]));
    expect((await status(repo.dir)).unsupportedClaims).toEqual([]);
    expect(manifest(repo.dir).sections["modules/src-a"]).not.toHaveProperty("unsupportedClaims");
  });

  it("writes a Section again when its file is gone", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", B);

    await reset(repo.dir, "modules/src-b", { llm: scriptedLlm("unused") });

    expect(read(repo.dir, B)).toBe(stableSection("B", "src/b", "B is one.[^1]", ["[^1]: src/b/b.ts (b)"]));
  });

  it("writes over a Section a human wrote for a Module Scribe never wrote one for", async () => {
    const repo = await generated();
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }, { name: "C", path: "src/c" }] }),
      "src/c/c.ts": "export const c = 1;\n",
      "docs/guide/modules/src-c.md": "# C\n\nMine.\n",
    });

    await reset(repo.dir, "modules/src-c", { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "C is one.", evidence: ["src/c/c.ts#c"] }] }] }) });

    expect(read(repo.dir, "docs/guide/modules/src-c.md")).toBe(stableSection("C", "src/c", "C is one.[^1]", ["[^1]: src/c/c.ts (c)"]));
    expect((await status(repo.dir)).sections.find((s) => s.section === "modules/src-c")).toEqual(
      expect.objectContaining({ frozen: false, added: false }),
    );
  });

  it("changes nothing and asks no LLM when the Section is already as Scribe would write it", async () => {
    const repo = await generated();
    const llm = scriptedLlm("unused");

    await reset(repo.dir, "modules/src-a", { llm });

    expect(llm.calls).toEqual([]);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("regenerates a Stale Section no human edited from the code, not as a revision", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": CHANGED_A });
    const llm = scriptedLlm(A_TWO);

    await reset(repo.dir, "modules/src-a", { llm });

    expect(read(repo.dir, A)).toBe(stableSection("A", "src/a", "A returns two.[^1] K is three.[^2]", ["[^1]: src/a/a.ts (a)", "[^2]: src/a/a.ts (k)"]));
    expect(llm.calls.some((call) => call.prompt.includes("<current-section>"))).toBe(false);
    expect((await status(repo.dir)).sections.find((s) => s.section === "modules/src-a")).toEqual(expect.objectContaining({ frozen: false, stale: false }));
  });

  it("discards a human's edits to a top-level Section, regenerating it", async () => {
    const repo = await generated();
    const written = read(repo.dir, "docs/guide/overview.md");
    repo.commit({ "docs/guide/overview.md": "# Overview\n\nMine.\n" });

    // Written from the same request generate made, so from the cache.
    await reset(repo.dir, "overview", { llm: scriptedLlm("unused") });

    expect(read(repo.dir, "docs/guide/overview.md")).toBe(written);
    expect((await status(repo.dir)).sections.find((s) => s.section === "overview")).toEqual(expect.objectContaining({ frozen: false, stale: false }));
  });

  it("refuses a Section whose file can't be read, naming it, and writes nothing", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", A);
    repo.commit({ [`${A}/notes.txt`]: "A directory where the Section's file was.\n" });
    const llm = scriptedLlm("unused");

    await expect(reset(repo.dir, "modules/src-a", { llm })).rejects.toThrow(/can't read docs\/guide\/modules\/src-a\.md/);
    expect(llm.calls).toEqual([]);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("refuses a Section no current Module has, such as a removed Module's", async () => {
    const repo = await generated();
    repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });

    await expect(reset(repo.dir, "modules/src-b", { llm: scriptedLlm("unused") })).rejects.toThrow(/no Module has the Section modules\/src-b/);
    expect(manifest(repo.dir).sections["modules/src-b"]).toBeDefined();
  });
});
