import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS } from "../llm.ts";
import { fakeGitHub } from "../test/fake-github.ts";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { type RecordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";

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

/** Its one Module has no code, so only Key decisions asks the LLM anything. */
const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "App", path: "lib" }] }),
  "README.md": "# App\n\nAn app that stores sessions.\n",
  "docs/adr/0001-sqlite.md": ADR,
};

const SECTION = "docs/guide/key-decisions.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

function writePrompts(llm: RecordedLlm): string[] {
  return llm.calls.filter((call) => call.model === MODELS.write).map((call) => call.prompt);
}

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
});
