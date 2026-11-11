import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";
import { status } from "./status.ts";

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

describe("existing docs as a Source", () => {
  it("lets a Section cite a heading of the README as Evidence", async () => {
    const repo = createFixtureRepo(TARGET);
    const llm = scriptedLlm({
      paragraphs: [{ claims: [{ text: "Sessions start with createSession.", evidence: ["README.md#sessions", "src/auth/session.ts#createSession"] }] }],
    });

    await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, SECTION)).toBe([
      "# Auth",
      "",
      "Sessions start with createSession.[^1][^2]",
      "",
      "[^1]: README.md (Sessions)",
      "[^2]: src/auth/session.ts (createSession)",
      "",
    ].join("\n"));
    const { evidence } = JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections["modules/src-auth"];
    expect(evidence.map((e: { id: string }) => e.id)).toEqual(["README.md#sessions", "src/auth/session.ts#createSession"]);
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
