import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PULL_REQUESTS_FOR_DECISIONS } from "../github.ts";
import { MODELS } from "../llm.ts";
import { fakeGitHub } from "../test/fake-github.ts";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { type RecordedLlm, recordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { adopt } from "./adopt.ts";
import { generate } from "./generate.ts";
import { reset } from "./reset.ts";
import { status } from "./status.ts";
import { update } from "./update.ts";

const ADR = [
  "# Use SQLite for storage",
  "",
  "## Decision",
  "",
  "Store sessions in SQLite.",
  "",
  "## Why",
  "",
  "One file is simpler to back up than a server.",
  "",
].join("\n");

/** Its one Module has no code, so only Key decisions asks the LLM anything; it has no ADRs. */
const NO_ADRS: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "App", path: "lib" }] }),
  "README.md": "# App\n\nAn app that stores sessions.\n",
};

const TARGET: Files = { ...NO_ADRS, "docs/adr/0001-sqlite.md": ADR };

const SECTION = "docs/guide/key-decisions.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

/** Prompts of every write but Overview's and Architecture's, which are written last. */
function writePrompts(llm: RecordedLlm): string[] {
  return llm.calls.filter((call) => call.model === MODELS.write && !call.prompt.startsWith("Section: ")).map((call) => call.prompt);
}

describe("Key decisions against recorded responses", () => {
  it("lists decisions from an ADR and a pull request thread, every Claim citing one and verified", async () => {
    const repo = createFixtureRepo(TARGET);
    const github = fakeGitHub([{
      number: 12,
      files: ["README.md"],
      title: "Expire sessions after a day",
      body: "Sessions now expire 24 hours after they start.",
      comments: ["Why a day? Most people sign in once a day, so a shorter limit would make them sign in twice."],
    }]);
    const llm = recordedLlm("key-decisions");

    await generate(repo.dir, {}, { llm, github });

    const content = read(repo.dir, SECTION);
    expect(content).toMatch(/^# Key decisions\n/);
    const [, ...prose] = content.split("\n\n").filter((block) => !block.startsWith("[^"));
    expect(prose.length).toBeGreaterThan(0);
    for (const paragraph of prose) expect(paragraph).toMatch(/\[\^\d+\]$/);
    const footnotes = content.split("\n").filter((line) => line.startsWith("[^"));
    for (const note of footnotes) {
      expect(note).toMatch(/^\[\^\d+\]: (?:docs\/adr\/0001-sqlite\.md \(.+\)|\[PR #12(?:, review comment)?\]\(https:\/\/github\.com\/acme\/app\/pull\/12\S*\))$/);
    }
    expect(llm.calls.some((call) => call.model === MODELS.verify)).toBe(true);
  });
});

describe("generate: Key decisions", () => {
  it("writes Key decisions from the repo's ADRs alone, each entry citing one", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm({
      paragraphs: [{
        claims: [
          { text: "Sessions are stored in SQLite.", evidence: ["docs/adr/0001-sqlite.md#decision"] },
          { text: "One file is simpler to back up than a server.", evidence: ["docs/adr/0001-sqlite.md#why"] },
        ],
      }],
    });

    await generate(repo.dir, {}, { llm });

    const [prompt] = writePrompts(llm);
    expect(prompt).toContain("Store sessions in SQLite.");
    expect(prompt).not.toContain("An app that stores sessions.");
    expect(read(repo.dir, SECTION)).toBe([
      "# Key decisions",
      "",
      "Sessions are stored in SQLite.[^1] One file is simpler to back up than a server.[^2]",
      "",
      "[^1]: docs/adr/0001-sqlite.md (Decision)",
      "[^2]: docs/adr/0001-sqlite.md (Why)",
      "",
    ].join("\n"));
    const { sections } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    expect(sections["key-decisions"].evidence.map((e: { id: string }) => e.id))
      .toEqual(["docs/adr/0001-sqlite.md#decision", "docs/adr/0001-sqlite.md#why"]);
  });

  it("writes Key decisions from pull request threads alone, citing them as links", async () => {
    const repo = createFixtureRepo(NO_ADRS);
    const github = fakeGitHub([{
      number: 12,
      files: ["README.md"],
      title: "Store sessions in SQLite",
      comments: ["Why not Postgres? One file is simpler to back up than a server."],
    }]);
    const llm = scriptedLlm({
      paragraphs: [{
        claims: [
          { text: "Sessions are stored in SQLite.", evidence: ["github:pr/12"] },
          { text: "One file is simpler to back up than a server.", evidence: ["github:pr/12/comment/1201"] },
        ],
      }],
    });

    await generate(repo.dir, {}, { llm, github });

    expect(writePrompts(llm)[0]).toContain("Why not Postgres?");
    expect(read(repo.dir, SECTION)).toBe([
      "# Key decisions",
      "",
      "Sessions are stored in SQLite.[^1] One file is simpler to back up than a server.[^2]",
      "",
      "[^1]: [PR #12](https://github.com/acme/app/pull/12)",
      "[^2]: [PR #12, review comment](https://github.com/acme/app/pull/12#discussion_r1201)",
      "",
    ].join("\n"));
  });

  it("is offered only the repo's most-discussed pull requests, wherever they touched", async () => {
    const repo = createFixtureRepo(TARGET);
    const discussed = Array.from({ length: PULL_REQUESTS_FOR_DECISIONS }, (_, i) => ({
      number: i + 1,
      files: [i % 2 === 0 ? "README.md" : "lib/app.ts"],
      title: `Discussed pull ${i + 1}`,
      comments: ["One.", "Two."],
    }));
    const github = fakeGitHub([...discussed, { number: 99, files: ["README.md"], title: "Quiet pull", comments: [] }]);
    const llm = scriptedLlm({ paragraphs: [] });

    await generate(repo.dir, {}, { llm, github });

    const prompt = writePrompts(llm).at(-1)!;
    expect(prompt).toContain("Store sessions in SQLite.");
    for (const { title } of discussed) expect(prompt).toContain(title);
    expect(prompt).not.toContain("Quiet pull");
  });

  it("drops an entry citing neither an ADR nor a pull request thread, and one the verifier rejects", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm({
      paragraphs: [
        { claims: [{ text: "Sessions are stored in SQLite.", evidence: ["docs/adr/0001-sqlite.md#decision"] }] },
        { claims: [{ text: "The app stores sessions.", evidence: ["README.md"] }] },
        { claims: [{ text: "Postgres was too slow.", evidence: ["docs/adr/0001-sqlite.md#why"] }] },
      ],
    }, { "Postgres was too slow.": { confirmed: false, reason: "The ADR says nothing of speed." } });

    const { droppedClaims } = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe([
      "# Key decisions",
      "",
      "Sessions are stored in SQLite.[^1]",
      "",
      "[^1]: docs/adr/0001-sqlite.md (Decision)",
      "",
    ].join("\n"));
    expect(droppedClaims).toEqual([
      { section: "key-decisions", text: "The app stores sessions.", reason: "cites no ADR or pull request thread" },
      { section: "key-decisions", text: "Postgres was too slow.", reason: "The ADR says nothing of speed." },
    ]);
  });

  it("writes Key decisions bare, asking the LLM nothing, with neither ADRs nor GitHub", async () => {
    const repo = createFixtureRepo(NO_ADRS);
    const llm = scriptedLlm({ paragraphs: [] });

    await generate(repo.dir, {}, { llm });

    // Overview and Architecture still are, from the Module list.
    expect(llm.calls.filter((call) => !call.prompt.startsWith("Section: "))).toEqual([]);
    expect(read(repo.dir, SECTION)).toBe("# Key decisions\n");
  });

  describe("keeping it current", () => {
    const CITING = { paragraphs: [{ claims: [{ text: "Sessions are stored in SQLite.", evidence: ["docs/adr/0001-sqlite.md#decision"] }] }] };

    it("makes Key decisions Stale when a cited ADR passage changes, and update rewrites it", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm(CITING) });
      repo.commit({ "docs/adr/0001-sqlite.md": ADR.replace("Store sessions in SQLite.", "Store sessions in SQLite, one file per tenant.") });

      const before = (await status(repo.dir)).sections.find((s) => s.section === "key-decisions");
      expect(before).toMatchObject({ stale: true, changedEvidence: ["docs/adr/0001-sqlite.md#decision"] });

      const llm = scriptedLlm({ paragraphs: [{ claims: [{ text: "Each tenant's sessions are in its own SQLite file.", evidence: ["docs/adr/0001-sqlite.md#decision"] }] }] });
      await update(repo.dir, {}, { llm });

      expect(writePrompts(llm)[0]).toContain("<current-section>");
      expect(read(repo.dir, SECTION)).toContain("Each tenant's sessions are in its own SQLite file.[^1]");
      expect((await status(repo.dir)).sections.find((s) => s.section === "key-decisions")).toMatchObject({ stale: false });
    });

    it("leaves Key decisions alone for edits to ADR passages it doesn't cite", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm(CITING) });
      repo.commit({ "docs/adr/0001-sqlite.md": ADR.replace("simpler to back up", "easier to back up") });

      const llm = scriptedLlm(CITING);
      await update(repo.dir, {}, { llm });

      expect(llm.calls).toEqual([]);
    });

    it("keeps offering pull request threads when a human resets or adopts Key decisions", async () => {
      const repo = createFixtureRepo(NO_ADRS);
      const pulls = [{ number: 12, files: ["README.md"], comments: ["One file is simpler to back up than a server."] }];
      const PR_CITING = { paragraphs: [{ claims: [{ text: "A file is simpler to back up.", evidence: ["github:pr/12/comment/1201"] }] }] };
      await generate(repo.dir, {}, { llm: scriptedLlm(PR_CITING), github: fakeGitHub(pulls) });
      repo.commit({ [SECTION]: "# Key decisions\n\nA file is simpler to back up.\n" });

      await reset(repo.dir, "key-decisions", {}, { llm: scriptedLlm(PR_CITING), github: fakeGitHub(pulls) });
      expect(read(repo.dir, SECTION)).toContain("[^1]: [PR #12, review comment](https://github.com/acme/app/pull/12#discussion_r1201)");

      repo.commit({ [SECTION]: "# Key decisions\n\nA file is simpler to back up.\n" });
      const llm = scriptedLlm({ paragraphs: [] }, {}, { attachments: { "A file is simpler to back up.": ["github:pr/12/comment/1201"] } });
      const { unsupportedClaims } = await adopt(repo.dir, "key-decisions", {}, { llm, github: fakeGitHub(pulls) });
      expect(unsupportedClaims).toEqual([]);
    });
  });
});
