import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { scriptedLlm } from "../test/recorded-llm.ts";
import { adopt } from "./adopt.ts";
import { generate } from "./generate.ts";
import { status } from "./status.ts";

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }] }),
  "src/a/a.ts": "export function a() {\n  return 1;\n}\n\nexport const k = 3;\n",
  "src/b/b.ts": "export const b = 1;\n",
};
const A = "docs/guide/modules/src-a.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

function manifest(dir: string) {
  return JSON.parse(read(dir, ".scribe/manifest.json"));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

describe("adopt", () => {
  it("makes a Frozen Section's text the baseline, recording the Evidence the verifier confirms", async () => {
    const repo = await generated();
    const generatedEvidence = manifest(repo.dir).sections["modules/src-a"].evidence;
    const mine = "# A\n\nA returns one. K is three.\n\nA is fast.\n";
    repo.commit({ [A]: mine });
    const llm = scriptedLlm(
      "unused",
      { "A is fast.": { confirmed: false, reason: "nothing shows speed" } },
      { "A returns one.": ["src/a/a.ts#a"], "K is three.": ["src/a/a.ts#k"], "A is fast.": ["src/a/a.ts#a"] },
    );

    const result = await adopt(repo.dir, "modules/src-a", {}, { llm });

    expect(read(repo.dir, A)).toBe(mine);
    expect(result.unsupportedClaims).toEqual([{ section: "modules/src-a", text: "A is fast." }]);
    const { sections, unsupportedClaims } = await status(repo.dir);
    expect(sections.find((s) => s.section === "modules/src-a")).toEqual(expect.objectContaining({ frozen: false, stale: false }));
    expect(unsupportedClaims).toEqual([{ section: "modules/src-a", text: "A is fast." }]);
    expect(manifest(repo.dir).sections["modules/src-a"]).toEqual({
      file: A,
      // The same symbols, unchanged, that generate cited for these two Claims.
      evidence: generatedEvidence,
      contentHash: sha256(mine),
      unsupportedClaims: ["A is fast."],
    });
  });
});
