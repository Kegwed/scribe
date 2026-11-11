import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectGitHub } from "../github.ts";
import { MODELS } from "../llm.ts";
import { type CannedPullRequest, fakeGitHub } from "../test/fake-github.ts";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { type RecordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";
import { status } from "./status.ts";
import { update } from "./update.ts";

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }] }),
  "src/a/a.ts": "export const a = 1;\n",
  "src/b/b.ts": "export const b = 1;\n",
};
const A = "docs/guide/modules/src-a.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

function writePrompts(llm: RecordedLlm): string[] {
  return llm.calls.filter((call) => call.model === MODELS.write).map((call) => call.prompt);
}

describe("the GitHub Source", () => {
  it("lets a Module Section cite a review comment on a pull request that touched it", async () => {
    const repo = createFixtureRepo(TARGET);
    const github = fakeGitHub([{ number: 12, files: ["src/a/a.ts"], comments: ["Keep a constant: callers cache it."] }]);
    const llm = scriptedLlm([
      { paragraphs: [{ claims: [{ text: "A is a constant callers cache.", evidence: ["src/a/a.ts#a", "github:pr/12/comment/1201"] }] }] },
      { paragraphs: [{ claims: [{ text: "B is one.", evidence: ["src/b/b.ts#b"] }] }] },
    ]);

    await generate(repo.dir, {}, { llm, github });

    expect(writePrompts(llm)[0]).toContain("Keep a constant: callers cache it.");
    expect(read(repo.dir, A)).toBe([
      "# A",
      "",
      "A is a constant callers cache.[^1][^2]",
      "",
      "[^1]: src/a/a.ts (a)",
      "[^2]: [PR #12, review comment](https://github.com/acme/app/pull/12#discussion_r1201)",
      "",
    ].join("\n"));
  });

  it("offers a Module only the merged pull requests that touched its files, and the issues they link to", async () => {
    const repo = createFixtureRepo(TARGET);
    const github = fakeGitHub([
      { number: 1, files: ["src/a/a.ts"], title: "Merged into A", linkedIssues: [{ number: 7, title: "Linked from A", body: "Why A changed." }] },
      { number: 2, files: ["src/a/a.ts"], title: "Never merged", mergedAt: null },
      { number: 3, files: ["src/b/b.ts"], title: "Merged into B" },
      { number: 4, files: ["README.md"], title: "Merged elsewhere" },
    ]);
    const llm = scriptedLlm({ paragraphs: [] });

    await generate(repo.dir, {}, { llm, github });

    const [a, b] = writePrompts(llm);
    expect(a).toContain("Merged into A");
    expect(a).toContain('id="github:issue/7"');
    expect(a).toContain("Why A changed.");
    expect(a).not.toContain("Never merged");
    expect(a).not.toContain("Merged into B");
    expect(a).not.toContain("Merged elsewhere");
    expect(b).toContain("Merged into B");
    expect(b).not.toContain("Merged into A");
    expect(github.calls).not.toContain("pullRequest 2");
  });

  describe("when it is active", () => {
    const token = () => "a-token";
    const noToken = () => undefined;

    it("is active when origin is on GitHub and a token is available", () => {
      const repo = createFixtureRepo(TARGET);
      repo.git("remote", "add", "origin", "git@github.com:acme/app.git");

      expect(connectGitHub(repo.dir, token)).toBeDefined();
    });

    it("is skipped without a token", () => {
      const repo = createFixtureRepo(TARGET);
      repo.git("remote", "add", "origin", "https://github.com/acme/app.git");

      expect(connectGitHub(repo.dir, noToken)).toBeUndefined();
    });

    it("is skipped when origin is not on GitHub, or there is none", () => {
      const elsewhere = createFixtureRepo(TARGET);
      elsewhere.git("remote", "add", "origin", "https://gitlab.com/acme/github.com.git");

      expect(connectGitHub(elsewhere.dir, token)).toBeUndefined();
      expect(connectGitHub(createFixtureRepo(TARGET).dir, token)).toBeUndefined();
    });

    it("leaves Scribe on its other Sources, with a warning, when GitHub fails", async () => {
      const repo = createFixtureRepo(TARGET);
      const github = fakeGitHub([]);
      github.pullRequests = async () => { throw new Error("rate limited"); };
      const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "One.", evidence: ["src/a/a.ts#a", "src/b/b.ts#b"] }] }] });

      const result = await generate(repo.dir, {}, { llm, github });

      expect(result.warnings).toEqual([expect.stringContaining("rate limited")]);
      expect(read(repo.dir, A)).toContain("[^1]: src/a/a.ts (a)");
    });
  });

  describe("keeping the Guide current", () => {
    const PULLS: CannedPullRequest[] = [{ number: 12, files: ["src/a/a.ts"], comments: ["Keep a constant: callers cache it."] }];
    const CITING = [
      { paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }, { text: "Callers cache A.", evidence: ["github:pr/12/comment/1201"] }] }] },
      { paragraphs: [{ claims: [{ text: "B is one.", evidence: ["src/b/b.ts#b"] }] }] },
    ];

    it("doesn't count cited GitHub Evidence as changed, so status reports the Guide current", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm(CITING), github: fakeGitHub(PULLS) });

      const { sections } = await status(repo.dir);

      expect(sections.filter((s) => s.stale)).toEqual([]);
    });

    it("keeps citing GitHub Evidence when update revises a Stale Section", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm(CITING), github: fakeGitHub(PULLS) });
      repo.commit({ "src/a/a.ts": "export const a = 2;\n" });

      const llm = scriptedLlm({
        paragraphs: [{ claims: [{ text: "A is two.", evidence: ["src/a/a.ts#a"] }, { text: "Callers cache A.", evidence: ["github:pr/12/comment/1201"] }] }],
      });
      await update(repo.dir, {}, { llm, github: fakeGitHub(PULLS) });

      expect(writePrompts(llm)[0]).toContain("Keep a constant: callers cache it.");
      expect(read(repo.dir, A)).toContain("[^2]: [PR #12, review comment](https://github.com/acme/app/pull/12#discussion_r1201)");
    });
  });

  describe("caching", () => {
    const PULLS: CannedPullRequest[] = [
      { number: 1, files: ["src/a/a.ts"], comments: ["Why A."] },
      { number: 2, files: ["src/b/b.ts"], comments: ["Why B."] },
    ];

    it("asks GitHub nothing when re-run at the same commit", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }), github: fakeGitHub(PULLS) });

      const github = fakeGitHub(PULLS);
      await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }), github });

      expect(github.calls).toEqual([]);
    });

    it("after a new commit, lists pull requests again but fetches only new or updated ones", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }), github: fakeGitHub(PULLS) });
      repo.commit({ "src/a/a.ts": "export const a = 2;\n" });

      const github = fakeGitHub([
        { ...PULLS[0]!, updatedAt: "2026-02-01T00:00:00Z" },
        PULLS[1]!,
        { number: 3, files: ["src/a/a.ts"] },
      ]);
      await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }), github });

      expect(github.calls.sort()).toEqual(["pullRequest 1", "pullRequest 3", "pullRequests"]);
    });

    it("never caches a pull request it can't use", async () => {
      const repo = createFixtureRepo(TARGET);
      const broken = fakeGitHub(PULLS);
      broken.pullRequest = async () => ({ number: 1 }) as never;
      await expect(generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }), github: broken })).rejects.toThrow(/malformed/);

      const github = fakeGitHub(PULLS);
      await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }), github });

      expect(github.calls).toContain("pullRequest 1");
    });
  });

  describe("ranking", () => {
    /** Six merged pull requests touching A, more than a Module is offered; `overrides` sets each one's fields by number. */
    function sixPulls(overrides: Record<number, Partial<CannedPullRequest>>): CannedPullRequest[] {
      return [1, 2, 3, 4, 5, 6].map((number) => ({
        number,
        files: ["src/a/a.ts"],
        title: `Pull ${number}`,
        comments: ["Looks right."],
        ...overrides[number],
      }));
    }

    async function offeredToA(pulls: CannedPullRequest[]): Promise<string> {
      const repo = createFixtureRepo(TARGET);
      const llm = scriptedLlm({ paragraphs: [] });
      await generate(repo.dir, {}, { llm, github: fakeGitHub(pulls) });
      return writePrompts(llm)[0]!;
    }

    it("leaves out the pull request with the shortest review discussion", async () => {
      const prompt = await offeredToA(sixPulls({
        1: { title: "Quiet pull", comments: [] },
        2: { comments: ["One.", "Two.", "Three."] },
        3: { comments: ["One.", "Two.", "Three."] },
        4: { comments: ["One.", "Two.", "Three."] },
        5: { comments: ["One.", "Two.", "Three."] },
        6: { comments: ["One.", "Two.", "Three."] },
      }));

      expect(prompt).not.toContain("Quiet pull");
      expect(prompt).toContain("Pull 2");
      expect(prompt).toContain("Pull 6");
    });

    it("leaves out the oldest pull request among equal discussions", async () => {
      const prompt = await offeredToA(sixPulls({ 4: { title: "Old pull", mergedAt: "2020-01-01T00:00:00Z" } }));

      expect(prompt).not.toContain("Old pull");
      expect(prompt).toContain("Pull 1");
      expect(prompt).toContain("Pull 6");
    });
  });
});
