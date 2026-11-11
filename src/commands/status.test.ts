import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";
import { status } from "./status.ts";

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }] }),
  "src/a/a.ts": "export function a() {\n  return 1;\n}\n",
  "src/b/b.ts": "export const b = 1;\n",
};

/** Writes each Section with one Claim citing its Module's only symbol. */
async function generated(files: Files = TARGET) {
  const repo = createFixtureRepo(files);
  const llm = scriptedLlm([
    { paragraphs: [{ claims: [{ text: "A returns one.", evidence: ["src/a/a.ts#a"] }] }] },
    { paragraphs: [{ claims: [{ text: "B is one.", evidence: ["src/b/b.ts#b"] }] }] },
  ]);
  await generate(repo.dir, {}, { llm });
  repo.commit({}, "generate the Guide");
  return repo;
}

describe("status", () => {
  it("reports every Section current right after generate", async () => {
    const repo = await generated();

    const { sections } = await status(repo.dir);

    expect(sections).toEqual([
      { section: "modules/src-a", file: "docs/guide/modules/src-a.md", missing: false, frozen: false, stale: false, changedEvidence: [] },
      { section: "modules/src-b", file: "docs/guide/modules/src-b.md", missing: false, frozen: false, stale: false, changedEvidence: [] },
    ]);
  });

  it("reports a Section Stale when a symbol it cites changes", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": "export function a() {\n  return 2;\n}\n" });

    const { sections } = await status(repo.dir);

    expect(sections).toEqual([
      expect.objectContaining({ section: "modules/src-a", frozen: false, stale: true, changedEvidence: ["src/a/a.ts#a"] }),
      expect.objectContaining({ section: "modules/src-b", stale: false }),
    ]);
  });

  it("doesn't report a Section Stale for edits outside the symbols it cites", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": `import { b } from "../b/b.ts";\n\n${TARGET["src/a/a.ts"]}\nexport const c = b;\n` });

    const { sections } = await status(repo.dir);

    expect(sections.map((s) => s.stale)).toEqual([false, false]);
  });

  it("reports a Section Stale when a symbol it cites is gone", async () => {
    const repo = await generated();
    repo.commit({ "src/b/b.ts": "export const renamed = 1;\n" });

    const { sections } = await status(repo.dir);

    expect(sections[1]).toMatchObject({ section: "modules/src-b", stale: true, changedEvidence: ["src/b/b.ts#b"] });
  });

  it("reports a hand-edited Section Frozen", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nMy words.\n" });

    const { sections } = await status(repo.dir);

    expect(sections).toEqual([
      expect.objectContaining({ section: "modules/src-a", frozen: true, stale: false }),
      expect.objectContaining({ section: "modules/src-b", frozen: false }),
    ]);
  });

  it("reports a Section both Frozen and Stale", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nMy words.\n", "src/a/a.ts": "export function a() {\n  return 2;\n}\n" });

    const { sections } = await status(repo.dir);

    expect(sections[0]).toMatchObject({ section: "modules/src-a", frozen: true, stale: true });
  });

  it("asks for scribe init when the repo has no config", async () => {
    const repo = createFixtureRepo({ "src/index.ts": "export const a = 1;\n" });

    await expect(status(repo.dir)).rejects.toThrow(/scribe init/);
  });
});
