import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Every Section's status but Overview's and Architecture's, which have their own tests below. */
async function sectionsBelowTop(dir: string) {
  return (await status(dir)).sections.filter((s) => s.section !== "overview" && s.section !== "architecture");
}

describe("status", () => {
  it("reports every Module Section current right after generate", async () => {
    const repo = await generated();

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections).toEqual([
      { section: "modules/src-a", file: "docs/guide/modules/src-a.md", added: false, removed: false, missing: false, frozen: false, stale: false, changedEvidence: [] },
      { section: "modules/src-b", file: "docs/guide/modules/src-b.md", added: false, removed: false, missing: false, frozen: false, stale: false, changedEvidence: [] },
      { section: "getting-started", file: "docs/guide/getting-started.md", added: false, removed: false, missing: false, frozen: false, stale: false, changedEvidence: [] },
    ]);
  });

  it("reports a Section Stale when a symbol it cites changes", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": "export function a() {\n  return 2;\n}\n" });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections).toEqual([
      expect.objectContaining({ section: "modules/src-a", frozen: false, stale: true, changedEvidence: ["src/a/a.ts#a"] }),
      expect.objectContaining({ section: "modules/src-b", stale: false }),
      expect.objectContaining({ section: "getting-started", stale: false }),
    ]);
  });

  it("doesn't report a Section Stale for edits outside the symbols it cites", async () => {
    const repo = await generated();
    repo.commit({ "src/a/a.ts": `import { b } from "../b/b.ts";\n\n${TARGET["src/a/a.ts"]}\nexport const c = b;\n` });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections.map((s) => s.stale)).toEqual([false, false, false]);
  });

  it("reports a Section Stale when a symbol it cites is gone", async () => {
    const repo = await generated();
    repo.commit({ "src/b/b.ts": "export const renamed = 1;\n" });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections[1]).toMatchObject({ section: "modules/src-b", stale: true, changedEvidence: ["src/b/b.ts#b"] });
  });

  it("reports a hand-edited Section Frozen", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nMy words.\n" });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections).toEqual([
      expect.objectContaining({ section: "modules/src-a", frozen: true, stale: false }),
      expect.objectContaining({ section: "modules/src-b", frozen: false }),
      expect.objectContaining({ section: "getting-started", frozen: false }),
    ]);
  });

  it("reports a Section both Frozen and Stale", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nMy words.\n", "src/a/a.ts": "export function a() {\n  return 2;\n}\n" });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections[0]).toMatchObject({ section: "modules/src-a", frozen: true, stale: true });
  });

  it("lists pending Proposals", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-b.proposal.md": "# B\n\nB is one.\n" });

    const { proposals } = await status(repo.dir);

    expect(proposals).toEqual([{ section: "modules/src-b", file: "docs/guide/modules/src-b.proposal.md" }]);
  });

  it("lists a pending Proposal whose Section's Module was removed", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", "-r", "src/b");
    repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });
    const manifest = JSON.parse(readFileSync(join(repo.dir, ".scribe/manifest.json"), "utf8"));
    delete manifest.sections["modules/src-b"];
    repo.commit({ ".scribe/manifest.json": JSON.stringify(manifest), "docs/guide/modules/src-b.proposal.md": "# B\n\nB is one.\n" });

    const { proposals } = await status(repo.dir);

    expect(proposals).toEqual([{ section: "modules/src-b", file: "docs/guide/modules/src-b.proposal.md" }]);
  });

  it("lists no Proposals when none are pending", async () => {
    const repo = await generated();

    const { proposals } = await status(repo.dir);

    expect(proposals).toEqual([]);
  });

  it("reports a Module added since generate as needing a Section", async () => {
    const repo = await generated();
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }, { name: "C", path: "src/c" }] }),
      "src/c/c.ts": "export const c = 1;\n",
    });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections).toEqual([
      expect.objectContaining({ section: "modules/src-a", added: false }),
      expect.objectContaining({ section: "modules/src-b", added: false }),
      expect.objectContaining({ section: "getting-started", added: false }),
      { section: "modules/src-c", file: "docs/guide/modules/src-c.md", added: true, removed: false, missing: false, frozen: false, stale: false, changedEvidence: [] },
    ]);
  });

  it("reports an added Module whose file a human already wrote as Frozen, not added", async () => {
    const repo = await generated();
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }, { name: "C", path: "src/c" }] }),
      "docs/guide/modules/src-c.md": "# C\n\nMine.\n",
    });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections.find((s) => s.section === "modules/src-c")).toMatchObject({ added: false, frozen: true });
  });

  it("reports the Section of a removed Module", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", "-r", "src/b");
    repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });

    const sections = await sectionsBelowTop(repo.dir);

    expect(sections).toEqual([
      expect.objectContaining({ section: "modules/src-a", removed: false }),
      expect.objectContaining({ section: "modules/src-b", removed: true }),
      expect.objectContaining({ section: "getting-started", removed: false }),
    ]);
  });

  describe("Overview and Architecture", () => {
    const LAYERED: Files = {
      ...TARGET,
      "package.json": JSON.stringify({ name: "app", description: "Counts." }),
    };

    /** Generates the Guide with Overview citing the Module list and package.json, and Architecture the import graph. */
    async function layered() {
      const repo = createFixtureRepo(LAYERED);
      await generate(repo.dir, {}, {
        llm: scriptedLlm([
          { paragraphs: [{ claims: [{ text: "A returns one.", evidence: ["src/a/a.ts#a"] }] }] },
          { paragraphs: [{ claims: [{ text: "B is one.", evidence: ["src/b/b.ts#b"] }] }] },
        ], {}, {
          topLevel: {
            Overview: { paragraphs: [{ claims: [{ text: "The repo counts, in Modules A and B.", evidence: ["file:package.json", "graph:modules"] }] }] },
            Architecture: { paragraphs: [{ claims: [{ text: "No Module imports another.", evidence: ["graph:imports"] }] }] },
          },
        }),
      });
      repo.commit({}, "generate the Guide");
      return repo;
    }
    const topLevel = async (dir: string) => (await status(dir)).sections.filter((s) => s.section === "overview" || s.section === "architecture");

    it("reports them current right after generate", async () => {
      const repo = await layered();

      expect(await topLevel(repo.dir)).toEqual([
        { section: "overview", file: "docs/guide/overview.md", added: false, removed: false, missing: false, frozen: false, stale: false, changedEvidence: [] },
        { section: "architecture", file: "docs/guide/architecture.md", added: false, removed: false, missing: false, frozen: false, stale: false, changedEvidence: [] },
      ]);
    });

    it("doesn't report them Stale when a symbol inside a Module changes", async () => {
      const repo = await layered();
      repo.commit({ "src/a/a.ts": "export function a() {\n  return 2;\n}\n" });

      const sections = await sectionsBelowTop(repo.dir);

      expect(sections.find((s) => s.section === "modules/src-a")).toMatchObject({ stale: true });
      expect((await topLevel(repo.dir)).map((s) => s.stale)).toEqual([false, false]);
    });

    it("reports Architecture Stale, and not Overview, when an import between Modules is added", async () => {
      const repo = await layered();
      repo.commit({ "src/a/a.ts": `import { b } from "../b/b.ts";\n\n${TARGET["src/a/a.ts"]}` });

      expect(await topLevel(repo.dir)).toEqual([
        expect.objectContaining({ section: "overview", stale: false }),
        expect.objectContaining({ section: "architecture", stale: true, changedEvidence: ["graph:imports"] }),
      ]);
    });

    it("reports Overview Stale when the root package.json changes", async () => {
      const repo = await layered();
      repo.commit({ "package.json": JSON.stringify({ name: "app", description: "Counts twice." }) });

      expect(await topLevel(repo.dir)).toEqual([
        expect.objectContaining({ section: "overview", stale: true, changedEvidence: ["file:package.json"] }),
        expect.objectContaining({ section: "architecture", stale: false }),
      ]);
    });

    it("reports one never written as added, needing a Section", async () => {
      const repo = await layered();
      const manifest = JSON.parse(readFileSync(join(repo.dir, ".scribe/manifest.json"), "utf8"));
      delete manifest.sections.overview;
      repo.git("rm", "--quiet", "docs/guide/overview.md");
      repo.commit({ ".scribe/manifest.json": JSON.stringify(manifest) });

      expect(await topLevel(repo.dir)).toEqual([
        expect.objectContaining({ section: "architecture", added: false }),
        { section: "overview", file: "docs/guide/overview.md", added: true, removed: false, missing: false, frozen: false, stale: false, changedEvidence: [] },
      ]);
    });

    it("never reports one removed", async () => {
      const repo = await layered();
      repo.git("rm", "--quiet", "-r", "src/b");
      repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });

      expect((await topLevel(repo.dir)).map((s) => s.removed)).toEqual([false, false]);
    });
  });

  it("asks for scribe init when the repo has no config", async () => {
    const repo = createFixtureRepo({ "src/index.ts": "export const a = 1;\n" });

    await expect(status(repo.dir)).rejects.toThrow(/scribe init/);
  });
});
