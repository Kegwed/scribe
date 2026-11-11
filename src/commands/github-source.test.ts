import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS } from "../llm.ts";
import { fakeGitHub } from "../test/fake-github.ts";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { type RecordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";

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
});
