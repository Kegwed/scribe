import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { recordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { stableSection } from "../test/sections.ts";
import { adopt } from "./adopt.ts";
import { generate } from "./generate.ts";
import { status } from "./status.ts";
import { update } from "./update.ts";

const README = [
  "# App",
  "",
  "An app.",
  "",
  "## Sessions",
  "",
  "Call `createSession(user)` to start a session.",
  "",
].join("\n");

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ modules: [{ name: "Auth", path: "src/auth" }] }),
  "README.md": README,
  "src/auth/session.ts": "export function createSession(user: string) {\n  return user;\n}\n",
};

const SECTION = "docs/guide/modules/src-auth.md";

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

/** The Auth Module's Section as `status` reports it. */
async function authStatus(dir: string) {
  return (await status(dir)).sections.find((s) => s.section === "modules/src-auth");
}

describe("existing docs as a Source", () => {
  it("lets a Section cite a heading of the README as Evidence", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm({
      paragraphs: [{ claims: [{ text: "Sessions start with createSession.", evidence: ["README.md#sessions", "src/auth/session.ts#createSession"] }] }],
    });

    await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe(stableSection("Auth", "src/auth", "Sessions start with createSession.[^1][^2]", [
      "[^1]: README.md (Sessions)",
      "[^2]: src/auth/session.ts (createSession)",
    ]));
    const { evidence } = JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections["modules/src-auth"];
    expect(evidence.map((e: { id: string }) => e.id)).toEqual(["README.md#sessions", "src/auth/session.ts#createSession", "history:src/auth"]);
  });

  it("tells the verifier of a Claim citing a doc passage that the passage is Evidence too", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm({
      paragraphs: [{ claims: [{ text: "Sessions start with createSession.", evidence: ["README.md#sessions"] }, { text: "It returns the user.", evidence: ["src/auth/session.ts#createSession"] }] }],
    });

    await generate(repo.dir, {}, { llm });

    const verifying = (text: string) => llm.calls.find((c) => c.prompt.startsWith(`<claim>\n${text}\n`))!.system;
    expect(verifying("Sessions start with createSession.")).toContain("<doc>");
    expect(verifying("It returns the user.")).not.toContain("<doc>");
  });

  describe("staleness", () => {
    const CITING = {
      paragraphs: [{ claims: [{ text: "Sessions start with createSession.", evidence: ["README.md#sessions"] }] }],
    };

    it("makes a Section citing a doc passage Stale when that passage changes, and update rewrites it", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm(CITING) });
      repo.commit({ "README.md": README.replace("to start a session", "to begin a session") });

      expect(await authStatus(repo.dir)).toMatchObject({ stale: true, changedEvidence: ["README.md#sessions"] });
      const llm = scriptedLlm(CITING);
      await update(repo.dir, {}, { llm });
      expect(llm.calls.some((c) => c.prompt.includes("to begin a session"))).toBe(true);
      expect(await authStatus(repo.dir)).toMatchObject({ stale: false });
    });

    it("doesn't make a Section Stale for edits to doc passages it doesn't cite", async () => {
      const repo = createFixtureRepo(TARGET);
      await generate(repo.dir, {}, { llm: scriptedLlm(CITING) });
      repo.commit({ "README.md": README.replace("An app.", "An app for sessions.") });

      expect(await authStatus(repo.dir)).toMatchObject({ stale: false });
    });
  });

  it("leaves every existing doc byte for byte as it was", async () => {
    const adr = "# Use sessions\r\n\r\n`createSession` starts them.\r\n";
    const repo = createFixtureRepo({ ...TARGET, "docs/adr/0001-sessions.md": adr, "CONTRIBUTING.md": "createSession\n" });
    const docs = ["README.md", "docs/adr/0001-sessions.md", "CONTRIBUTING.md"];
    const before = docs.map((d) => readFileSync(join(repo.dir, d)));

    await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }, {}, { drift: [] }) });
    repo.commit({ "src/auth/session.ts": "export function createSession(user: string) {\n  return user + 1;\n}\n" });
    await update(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [] }) });

    expect(docs.map((d) => readFileSync(join(repo.dir, d)))).toEqual(before);
  });

  describe("Drift", () => {
    const CONTRADICTING: Files = {
      ...TARGET,
      "README.md": README.replace("`createSession(user)`", "`createSession(user, ttl)`"),
    };
    const DRIFT = {
      description: "The README says createSession takes a ttl, but it takes only a user.",
      docs: ["README.md#sessions"],
      code: ["src/auth/session.ts#createSession"],
    };
    const llm = (drift: unknown[] = [DRIFT], verdicts: Record<string, unknown> = {}) => scriptedLlm({
      paragraphs: [{ claims: [{ text: "createSession takes a user.", evidence: ["src/auth/session.ts#createSession"] }] }],
    }, verdicts, { drift });

    it("reports a README contradicting the code as Drift citing both sides, in the run report and in status", async () => {
      const repo = createFixtureRepo(CONTRADICTING);

      const result = await generate(repo.dir, {}, { llm: llm() });

      expect(result.drift).toEqual([{ section: "modules/src-auth", ...DRIFT }]);
      expect((await status(repo.dir)).drift).toEqual([{ section: "modules/src-auth", ...DRIFT }]);
    });

    it("finds Drift, and writes a Section that may cite the docs, with recorded responses", async () => {
      const repo = createFixtureRepo(CONTRADICTING);

      const result = await generate(repo.dir, {}, { llm: recordedLlm("existing-docs") });

      expect(result.drift).toEqual([{
        section: "modules/src-auth",
        description: expect.any(String),
        docs: ["README.md#sessions"],
        code: ["src/auth/session.ts#createSession"],
      }]);
      const [, ...prose] = read(repo.dir, SECTION).split("\n\n").filter((block) => !block.startsWith("[^"));
      expect(prose.length).toBeGreaterThan(0);
      for (const paragraph of prose) expect(paragraph).toMatch(/\[\^\d+\]$/);
    });

    it("makes a Section Stale when a doc it found Drift in is fixed, and update clears the Drift", async () => {
      const repo = createFixtureRepo(CONTRADICTING);
      await generate(repo.dir, {}, { llm: llm() });
      repo.commit({ "README.md": README });

      expect(await authStatus(repo.dir)).toMatchObject({ stale: true, changedEvidence: ["README.md#sessions"] });
      const result = await update(repo.dir, {}, { llm: llm([]) });

      expect(result.drift).toEqual([]);
      expect((await status(repo.dir)).drift).toEqual([]);
      expect(await authStatus(repo.dir)).toMatchObject({ stale: false });
    });

    it("keeps reporting the Drift of a Section that isn't rewritten", async () => {
      const repo = createFixtureRepo(CONTRADICTING);
      await generate(repo.dir, {}, { llm: llm() });

      const scripted = llm([]);
      const result = await update(repo.dir, {}, { llm: scripted });

      expect(scripted.calls).toEqual([]);
      expect(result.drift).toEqual([{ section: "modules/src-auth", ...DRIFT }]);
      expect((await status(repo.dir)).drift).toEqual([{ section: "modules/src-auth", ...DRIFT }]);
    });

    it("estimates more for a Module docs are about, and nothing once its writes and Drift search are cached", async () => {
      const repo = createFixtureRepo(CONTRADICTING);
      const quiet = createFixtureRepo({ ...CONTRADICTING, "README.md": README.replace("`createSession(user)`", "`startSession(user)`") });
      const asked = async (dir: string) => {
        let tokens = -1;
        await generate(dir, { confirm: async (estimate) => ((tokens = estimate.tokens), false) }, { llm: llm() });
        return tokens;
      };

      expect(await asked(repo.dir)).toBeGreaterThan(await asked(quiet.dir));
      await generate(repo.dir, {}, { llm: llm() });
      expect((await generate(repo.dir, {}, { llm: llm() })).estimate.tokens).toBe(0);
    });

    it("estimates the verdicts on the Drift a search may find, beside the search itself", async () => {
      // A Section with no Claims: any verdict it is expected to need is on Drift.
      const repo = createFixtureRepo({ ...CONTRADICTING, [SECTION]: "# Auth\n" });
      let requests: Record<string, number> = {};

      await adopt(repo.dir, "modules/src-auth", { confirm: async (estimate) => ((requests = estimate.requests), false) }, { llm: llm() });

      expect(requests.drift).toBe(1);
      expect(requests.verdict).toBeGreaterThan(0);
    });

    it("keeps reporting Drift once a human's edited Section is adopted", async () => {
      const repo = createFixtureRepo(CONTRADICTING);
      await generate(repo.dir, {}, { llm: llm() });
      repo.commit({ [SECTION]: "# Auth\n\ncreateSession takes a user.\n" });

      await adopt(repo.dir, "modules/src-auth", {}, { llm: llm() });

      expect((await status(repo.dir)).drift).toEqual([{ section: "modules/src-auth", ...DRIFT }]);
    });

    it("asks the verifier whether the doc says what the Drift says it does and the code shows otherwise", async () => {
      const repo = createFixtureRepo(CONTRADICTING);
      const scripted = llm();

      await generate(repo.dir, {}, { llm: scripted });

      const check = scripted.calls.find((c) => c.prompt.startsWith(`<claim>\n${DRIFT.description}\n`))!;
      expect(check.system).toContain("<doc>");
      expect(check.system).toContain("contradict");
    });

    it("reports no Drift the verifier can't confirm against both sides", async () => {
      const repo = createFixtureRepo(CONTRADICTING);

      const result = await generate(repo.dir, {}, { llm: llm([DRIFT], { [DRIFT.description]: { confirmed: false, reason: "no" } }) });

      expect(result.drift).toEqual([]);
      expect((await status(repo.dir)).drift).toEqual([]);
    });

    it("reports no Drift that doesn't cite both a doc and the code", async () => {
      const repo = createFixtureRepo(CONTRADICTING);

      const result = await generate(repo.dir, {}, {
        llm: llm([{ ...DRIFT, docs: [] }, { ...DRIFT, code: ["src/auth/session.ts#invented"] }, { ...DRIFT, docs: ["README.md#invented"] }]),
      });

      expect(result.drift).toEqual([]);
    });

    it("never looks for Drift in a Module no doc mentions", async () => {
      const repo = createFixtureRepo({ ...TARGET, "README.md": "# App\n\nAn app.\n" });
      const scripted = llm();

      const result = await generate(repo.dir, {}, { llm: scripted });

      expect(result.drift).toEqual([]);
      expect(scripted.calls.map((c) => c.prompt).join("\n")).not.toContain("<doc");
    });
  });
});
