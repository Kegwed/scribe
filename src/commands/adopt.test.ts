import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { fakeGitHub } from "../test/fake-github.ts";
import { recordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { STABLE } from "../test/sections.ts";
import { adopt } from "./adopt.ts";
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
const C = "docs/guide/modules/src-c.md";
const A_PROPOSAL = "docs/guide/modules/src-a.proposal.md";

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

describe("adopt against recorded responses", () => {
  it("records Evidence for the human's Claims the code backs and keeps the rest as Unsupported", async () => {
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "Pricing", path: "src/pricing" }] }),
      "src/pricing/price.ts": [
        "/** Rounds a price to whole cents. */",
        "export function roundPrice(price: number) {",
        "  return Math.round(price * 100) / 100;",
        "}",
        "",
        'export const CURRENCY = "EUR";',
        "",
      ].join("\n"),
    });
    await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "Prices are in euros.", evidence: ["src/pricing/price.ts#CURRENCY"] }] }] }) });
    const mine = "# Pricing\n\nroundPrice rounds a price to whole cents. Every price is in euros.\n\nThe team plans to add more currencies next year.\n";
    repo.commit({ "docs/guide/modules/src-pricing.md": mine });

    const { unsupportedClaims } = await adopt(repo.dir, "modules/src-pricing", {}, { llm: recordedLlm("adopt") });

    expect(read(repo.dir, "docs/guide/modules/src-pricing.md")).toBe(mine);
    const sentences = ["roundPrice rounds a price to whole cents.", "Every price is in euros.", "The team plans to add more currencies next year."];
    for (const { text } of unsupportedClaims) expect(sentences).toContain(text);
    const record = manifest(repo.dir).sections["modules/src-pricing"];
    expect(record.unsupportedClaims ?? []).toEqual(unsupportedClaims.map(({ text }) => text));
    const ids = record.evidence.map((e: { id: string }) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(["src/pricing/price.ts#roundPrice", "src/pricing/price.ts#CURRENCY"]).toContain(id);
    expect((await status(repo.dir)).sections[0]).toEqual(expect.objectContaining({ frozen: false, stale: false }));
  });
});

describe("adopt", () => {
  it("makes a Frozen Section's text the baseline, recording the Evidence the verifier confirms", async () => {
    const repo = await generated();
    const generatedEvidence = manifest(repo.dir).sections["modules/src-a"].evidence;
    const mine = "# A\n\nA returns one. K is three.\n\nA is fast.\n";
    repo.commit({ [A]: mine });
    const llm = scriptedLlm(
      "unused",
      { "A is fast.": { confirmed: false, reason: "nothing shows speed" } },
      { attachments: { "A returns one.": ["src/a/a.ts#a"], "K is three.": ["src/a/a.ts#k"], "A is fast.": ["src/a/a.ts#a"] } },
    );

    const result = await adopt(repo.dir, "modules/src-a", {}, { llm });

    expect(read(repo.dir, A)).toBe(mine);
    expect(result.unsupportedClaims).toEqual([{ section: "modules/src-a", text: "A is fast." }]);
    const { sections, unsupportedClaims } = await status(repo.dir);
    expect(sections.find((s) => s.section === "modules/src-a")).toEqual(expect.objectContaining({ frozen: false, stale: false }));
    expect(unsupportedClaims).toEqual([{ section: "modules/src-a", text: "A is fast." }]);
    expect(manifest(repo.dir).sections["modules/src-a"]).toEqual({
      file: A,
      // The same symbols, unchanged, that generate cited for these two Claims; the human dropped the churn Claim.
      evidence: generatedEvidence.filter((e: { id: string }) => !e.id.startsWith("history:")),
      contentHash: sha256(mine),
      unsupportedClaims: ["A is fast."],
    });
  });

  it("clears a Frozen, Stale Section's Proposal and leaves it neither Frozen nor Stale", async () => {
    const repo = await generated();
    const mine = "# A\n\nA returns two.\n";
    repo.commit({ [A]: mine, "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n" });
    await update(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "A returns two.", evidence: ["src/a/a.ts#a"] }] }] }) });
    expect(existsSync(join(repo.dir, A_PROPOSAL))).toBe(true);

    const result = await adopt(repo.dir, "modules/src-a", {}, { llm: scriptedLlm("unused", {}, { attachments: { "A returns two.": ["src/a/a.ts#a"] } }) });

    expect(existsSync(join(repo.dir, A_PROPOSAL))).toBe(false);
    expect(result).toEqual({ unsupportedClaims: [], clearedProposal: A_PROPOSAL, warnings: [] });
    expect(read(repo.dir, A)).toBe(mine);
    const after = await status(repo.dir);
    expect(after.sections.find((s) => s.section === "modules/src-a")).toEqual(expect.objectContaining({ frozen: false, stale: false }));
    expect(after.proposals).toEqual([]);
    expect(after.unsupportedClaims).toEqual([]);
    expect(manifest(repo.dir).sections["modules/src-a"]).not.toHaveProperty("unsupportedClaims");
  });

  it("records a Claim the verifier is given no Evidence for as Unsupported, without asking it", async () => {
    const repo = await generated();
    const mine = "# A\n\nRead this first.[^1] A gives back one.[^2]\n\n[^1]: my notes\n[^2]: src/a/a.ts (a)\n";
    repo.commit({ [A]: mine });
    const llm = scriptedLlm("unused", {}, { attachments: { "A gives back one.": ["src/a/a.ts#a"] } });

    const result = await adopt(repo.dir, "modules/src-a", {}, { llm });

    expect(result.unsupportedClaims).toEqual([{ section: "modules/src-a", text: "Read this first." }]);
    expect(read(repo.dir, A)).toBe(mine);
    const verified = llm.calls.filter((call) => call.prompt.startsWith("<claim>"));
    expect(verified.map((call) => call.prompt.split("\n")[1])).toEqual(["A gives back one."]);
    expect(manifest(repo.dir).sections["modules/src-a"].evidence.map((e: { id: string }) => e.id)).toEqual(["src/a/a.ts#a"]);
  });

  it("adopts a Section a human wrote for a Module Scribe never wrote one for", async () => {
    const repo = await generated();
    const mine = "# C\n\nC is one.\n";
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }, { name: "C", path: "src/c" }] }),
      "src/c/c.ts": "export const c = 1;\n",
      [C]: mine,
    });

    const result = await adopt(repo.dir, "modules/src-c", {}, { llm: scriptedLlm("unused", {}, { attachments: { "C is one.": ["src/c/c.ts#c"] } }) });

    expect(result.unsupportedClaims).toEqual([]);
    expect(read(repo.dir, C)).toBe(mine);
    expect((await status(repo.dir)).sections.find((s) => s.section === "modules/src-c")).toEqual(
      expect.objectContaining({ added: false, frozen: false, stale: false }),
    );
  });

  it("re-baselines a Stale Section Scribe wrote, recording the Claims its changed Evidence no longer backs as Unsupported", async () => {
    const repo = await generated();
    const before = read(repo.dir, A);
    repo.commit({ "src/a/a.ts": "export function a() {\n  return 2;\n}\n\nexport const k = 3;\n" });
    const llm = scriptedLlm(
      "unused",
      { "A returns one.": { confirmed: false, reason: "a returns 2" } },
      { attachments: { "A returns one.": ["src/a/a.ts#a"], "K is three.": ["src/a/a.ts#k"] } },
    );

    const result = await adopt(repo.dir, "modules/src-a", {}, { llm });

    expect(read(repo.dir, A)).toBe(before);
    expect(result.unsupportedClaims).toEqual([{ section: "modules/src-a", text: "A returns one." }]);
    expect((await status(repo.dir)).sections.find((s) => s.section === "modules/src-a")).toEqual(
      expect.objectContaining({ frozen: false, stale: false }),
    );
  });

  it("keeps the churn Claim's git history Evidence when the human kept it as Scribe wrote it, asking no model about it", async () => {
    const repo = await generated();
    repo.commit({ [A]: `# A\n\nA returns one.\n\n${STABLE}[^1]\n\n[^1]: git history of src/a (90 days)\n` });
    const llm = scriptedLlm("unused", {}, { attachments: { "A returns one.": ["src/a/a.ts#a"] } });

    const result = await adopt(repo.dir, "modules/src-a", {}, { llm });

    expect(result.unsupportedClaims).toEqual([]);
    for (const call of llm.calls) expect(call.prompt).not.toContain(STABLE);
    expect(manifest(repo.dir).sections["modules/src-a"].evidence).toEqual([
      expect.objectContaining({ id: "src/a/a.ts#a" }),
      { id: "history:src/a", hash: sha256(STABLE) },
    ]);
    expect((await status(repo.dir)).sections.find((s) => s.section === "modules/src-a")).toEqual(expect.objectContaining({ frozen: false, stale: false }));
  });

  it("records a review comment as Evidence for a human's Claim when GitHub is connected", async () => {
    const repo = await generated();
    repo.commit({ [A]: "# A\n\nK stays a constant because callers cache it.\n" });
    const github = fakeGitHub([{ number: 12, files: ["src/a/a.ts"], comments: ["Keep k a constant: callers cache it."] }]);
    const llm = scriptedLlm("unused", {}, { attachments: { "K stays a constant because callers cache it.": ["src/a/a.ts#k", "github:pr/12/comment/1201"] } });

    const result = await adopt(repo.dir, "modules/src-a", {}, { llm, github });

    expect(result.unsupportedClaims).toEqual([]);
    expect(manifest(repo.dir).sections["modules/src-a"].evidence.map((e: { id: string }) => e.id)).toEqual(["src/a/a.ts#k", "github:pr/12/comment/1201"]);
  });

  it("records every Claim Unsupported, asking no LLM, when the Module has no symbols", async () => {
    const repo = await generated();
    repo.commit({ "src/b/b.ts": "// Nothing here yet.\n", [B]: "# B\n\nB is one.\n" });
    const llm = scriptedLlm("unused");

    const result = await adopt(repo.dir, "modules/src-b", {}, { llm });

    expect(llm.calls).toEqual([]);
    expect(result.unsupportedClaims).toEqual([{ section: "modules/src-b", text: "B is one." }]);
  });

  it("changes nothing and asks no LLM when adopting the same text again", async () => {
    const repo = await generated();
    repo.commit({ [A]: "# A\n\nA returns one.\n" });
    await adopt(repo.dir, "modules/src-a", {}, { llm: scriptedLlm("unused", {}, { attachments: { "A returns one.": ["src/a/a.ts#a"] } }) });
    repo.commit({}, "adopt A");
    const llm = scriptedLlm("unused");

    await adopt(repo.dir, "modules/src-a", {}, { llm });

    expect(llm.calls).toEqual([]);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("refuses a Section whose file is gone, pointing to scribe reset", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", A);

    await expect(adopt(repo.dir, "modules/src-a", {}, { llm: scriptedLlm("unused") })).rejects.toThrow(/scribe reset modules\/src-a/);
  });

  it("refuses a Section no current Module has, such as a removed Module's", async () => {
    const repo = await generated();
    repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });

    await expect(adopt(repo.dir, "modules/src-b", {}, { llm: scriptedLlm("unused") })).rejects.toThrow(/no Module has the Section modules\/src-b/);
    expect(manifest(repo.dir).sections["modules/src-b"]).toBeDefined();
  });
});
