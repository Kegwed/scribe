import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";

const ESLINT = [
  "export default [",
  "  {",
  "    rules: {",
  '      "prefer-const": "error",',
  '      "no-var": "error",',
  "    },",
  "  },",
  "];",
  "",
].join("\n");

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "App", path: "src" }] }),
  "eslint.config.js": ESLINT,
  ".prettierrc": '{ "singleQuote": true }\n',
  "CONTRIBUTING.md": "# Contributing\n\n## Style\n\nName files in kebab-case.\n",
  "src/parse-input.ts": "export function parseInput(text: string): string[] {\n  return text.split(\",\");\n}\n",
};

const SECTION = "docs/guide/conventions.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

const section = (...claims: [string, string[]][]) => ({
  paragraphs: [{ claims: claims.map(([text, evidence]) => ({ text, evidence })) }],
});

/**
 * The Module's Section is written first, with no Claims; Getting started has no
 * Evidence in these fixtures, so it asks nothing; Conventions gets `claims`.
 */
function conventionsLlm(...claims: [string, string[]][]) {
  return scriptedLlm([{ paragraphs: [] }, section(...claims)]);
}

describe("generate: Conventions", () => {
  it("writes a Conventions Section citing lint and format config, code and CONTRIBUTING", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = conventionsLlm(
      ["Lint rules require `const` where a binding is never reassigned.", ["eslint.config.js"]],
      ["Strings use single quotes.", [".prettierrc"]],
      ["Files are named in kebab-case.", ["CONTRIBUTING.md#style", "src/parse-input.ts#parseInput"]],
    );

    const result = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe([
      "# Conventions",
      "",
      "Lint rules require `const` where a binding is never reassigned.[^1] Strings use single quotes.[^2] Files are named in kebab-case.[^3][^4]",
      "",
      "[^1]: eslint.config.js (ESLint config)",
      "[^2]: .prettierrc (Prettier config)",
      "[^3]: CONTRIBUTING.md (Style)",
      "[^4]: src/parse-input.ts (parseInput)",
      "",
    ].join("\n"));
    expect(result.droppedClaims).toEqual([]);
    const { sections } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    expect(sections.conventions).toMatchObject({
      file: SECTION,
      evidence: ["eslint.config.js", ".prettierrc", "CONTRIBUTING.md#style", "src/parse-input.ts#parseInput"].map((id) => ({ id, hash: expect.any(String) })),
    });
  });
});
