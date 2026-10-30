import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type Files } from "../test/fixture-repo.ts";
import { recordedLlm, scriptedLlm } from "../test/recorded-llm.ts";
import { generate } from "./generate.ts";

const TARGET: Files = {
  "scribe.config.json": JSON.stringify({ guideDir: "docs/guide" }),
  "package.json": JSON.stringify({ name: "app" }),
  "src/auth/session.ts": [
    'import { sign } from "./sign.ts";',
    "",
    "/** Starts a session for a user. */",
    "export function createSession(user: string) {",
    "  return sign(user);",
    "}",
    "",
  ].join("\n"),
  "src/auth/sign.ts": "export function sign(value: string) {\n  return `signed:${value}`;\n}\n",
  "src/billing/invoice.ts": "export function sendInvoice(amount: number) {\n  return amount > 0;\n}\n",
};

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

describe("generate", () => {
  it("writes one Section per Module, citing Evidence for every Claim", async () => {
    const repo = createFixtureRepo(TARGET);

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    const auth = read(repo.dir, "docs/guide/modules/src-auth.md");
    expect(auth).toMatch(/^# src\/auth\n/);
    expect(auth).toContain("`createSession` starts a session for a user.[^1]");
    expect(auth).toContain("[^1]: src/auth/session.ts (createSession)");
    expect(existsSync(join(repo.dir, "docs/guide/modules/src-billing.md"))).toBe(true);
  });

  it("gives a symbol cited twice one footnote", async () => {
    const repo = createFixtureRepo(TARGET);

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    const auth = read(repo.dir, "docs/guide/modules/src-auth.md");
    expect(auth).toContain("prefixes the value with `signed:`.[^1][^2]");
    expect(auth.match(/^\[\^\d+\]:/gm)).toHaveLength(2);
  });

  it("writes the Guide to the configured directory", async () => {
    const repo = createFixtureRepo({ ...TARGET, "scribe.config.json": JSON.stringify({ guideDir: "handbook" }) });

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(existsSync(join(repo.dir, "handbook/modules/src-auth.md"))).toBe(true);
  });

  it("cites SHA-pinned permalinks with the current line range when origin is on GitHub", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "git@github.com:acme/app.git");
    const sha = repo.git("rev-parse", "HEAD").trim();

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toContain(
      `[^1]: [src/auth/session.ts (createSession)](https://github.com/acme/app/blob/${sha}/src/auth/session.ts#L3-L6)`,
    );
    expect(result.warnings).toEqual([]);
  });

  it("understands https GitHub origins", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "https://github.com/acme/app.git");

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toContain("(https://github.com/acme/app/blob/");
  });

  it("cites repo-relative paths when origin is elsewhere", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "https://gitlab.com/acme/github.com.git");

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toContain("[^1]: src/auth/session.ts (createSession)");
  });

  it("warns when a permalink's file differs from the pinned commit", async () => {
    const repo = createFixtureRepo(TARGET);
    repo.git("remote", "add", "origin", "git@github.com:acme/app.git");
    writeFileSync(join(repo.dir, "src/billing/invoice.ts"), `// uncommitted\n${TARGET["src/billing/invoice.ts"]}`);

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(result.warnings).toEqual([expect.stringContaining("src/billing/invoice.ts")]);
  });

  it("records each Section's Evidence hashes and written-content hash in the manifest", async () => {
    const repo = createFixtureRepo(TARGET);

    await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    const { sections } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    expect(Object.keys(sections)).toEqual(["modules/src-auth", "modules/src-billing"]);
    expect(sections["modules/src-billing"]).toEqual({
      file: "docs/guide/modules/src-billing.md",
      evidence: [{
        id: "src/billing/invoice.ts#sendInvoice",
        hash: sha256("export function sendInvoice(amount: number) {\n  return amount > 0;\n}"),
      }],
      contentHash: sha256(read(repo.dir, "docs/guide/modules/src-billing.md")),
    });
  });

  it("makes no LLM calls when re-run with unchanged inputs", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: recordedLlm("generate") });
    const before = read(repo.dir, "docs/guide/modules/src-auth.md");

    const llm = recordedLlm("generate");
    await generate(repo.dir, {}, { llm });

    expect(llm.calls).toEqual([]);
    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toBe(before);
  });

  it("never caches a response it can't use", async () => {
    const repo = createFixtureRepo(TARGET);
    await expect(generate(repo.dir, {}, { llm: scriptedLlm("not json") })).rejects.toThrow();

    const llm = recordedLlm("generate");
    await generate(repo.dir, {}, { llm });

    expect(llm.calls).toHaveLength(2);
  });

  it("drops Claims that cite nothing, or nothing in the Module, and reports them", async () => {
    const repo = createFixtureRepo({ "scribe.config.json": "{}", "src/a/a.ts": "export const a = 1;\n", "src/b/b.ts": "export const b = 1;\n" });
    const llm = scriptedLlm({
      paragraphs: [{
        claims: [
          { text: "Uncited.", evidence: [] },
          { text: "Invented.", evidence: ["src/a/a.ts#missing"] },
          { text: "Backed.", evidence: ["src/a/a.ts#missing", "src/a/a.ts#a"] },
        ],
      }],
    });

    const result = await generate(repo.dir, {}, { llm });

    const a = read(repo.dir, "docs/guide/modules/src-a.md");
    expect(a).toBe("# src/a\n\nBacked.[^1]\n\n[^1]: src/a/a.ts (a)\n");
    expect(result.droppedClaims).toContainEqual({ section: "modules/src-a", text: "Uncited." });
    expect(result.droppedClaims).toContainEqual({ section: "modules/src-a", text: "Invented." });
  });

  it("never overwrites a Section a human edited, and reports it Frozen", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: recordedLlm("generate") });
    const { sections: before } = JSON.parse(read(repo.dir, ".scribe/manifest.json"));
    writeFileSync(join(repo.dir, "docs/guide/modules/src-auth.md"), "# My words\n");

    const llm = recordedLlm("generate");
    const result = await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toBe("# My words\n");
    expect(result.frozen).toEqual(["modules/src-auth"]);
    expect(JSON.parse(read(repo.dir, ".scribe/manifest.json")).sections).toEqual(before);
  });

  it("treats an existing file Scribe never wrote as Frozen", async () => {
    const repo = createFixtureRepo({ ...TARGET, "docs/guide/modules/src-auth.md": "# Already here\n" });

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(read(repo.dir, "docs/guide/modules/src-auth.md")).toBe("# Already here\n");
    expect(result.frozen).toEqual(["modules/src-auth"]);
  });

  it("doesn't Freeze a Section whose line endings a checkout changed", async () => {
    const repo = createFixtureRepo(TARGET);
    await generate(repo.dir, {}, { llm: recordedLlm("generate") });
    const file = join(repo.dir, "docs/guide/modules/src-auth.md");
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));

    const result = await generate(repo.dir, {}, { llm: recordedLlm("generate") });

    expect(result.frozen).toEqual([]);
  });

  it("writes a bare Section for a Module with no symbols, without asking the LLM", async () => {
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "Empty", path: "src/empty" }] }),
    });
    const llm = recordedLlm("generate");

    await generate(repo.dir, {}, { llm });

    expect(read(repo.dir, "docs/guide/modules/src-empty.md")).toBe("# Empty\n");
    expect(llm.calls).toEqual([]);
  });

  it("refuses Modules whose Section files would collide", async () => {
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({
        modules: [{ name: "One", path: "a/b" }, { name: "Two", path: "a-b" }],
      }),
    });

    await expect(generate(repo.dir, {}, { llm: recordedLlm("generate") })).rejects.toThrow(/a\/b.*a-b/);
  });

  it("asks for scribe init when the repo has no config", async () => {
    const repo = createFixtureRepo({ "src/index.ts": "export const a = 1;\n" });

    await expect(generate(repo.dir, {}, { llm: recordedLlm("generate") })).rejects.toThrow(/scribe init/);
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
