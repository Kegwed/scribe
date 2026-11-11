import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generate } from "./commands/generate.ts";
import { createFixtureRepo } from "./test/fixture-repo.ts";
import { scriptedLlm } from "./test/recorded-llm.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI with no API key and Claude's endpoint unreachable, so any LLM call would fail. */
function scribe(dir: string, ...args: string[]) {
  const { ANTHROPIC_API_KEY: _, ...env } = process.env;
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
  });
  return { status, stdout, stderr };
}

describe("scribe status", () => {
  async function generated() {
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }] }),
      "src/a/a.ts": "export const a = 1;\n",
      "src/b/b.ts": "export const b = 1;\n",
    });
    await generate(repo.dir, {}, {
      llm: scriptedLlm([
        { paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] },
        { paragraphs: [{ claims: [{ text: "B is one.", evidence: ["src/b/b.ts#b"] }] }] },
      ]),
    });
    repo.commit({}, "generate the Guide");
    return repo;
  }

  it("says everything is current and exits 0 right after generate", async () => {
    const repo = await generated();

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe("All 2 Sections current.\n");
    expect(status).toBe(0);
  });

  it("lists Stale and Frozen Sections and exits non-zero", async () => {
    const repo = await generated();
    repo.commit({
      "src/a/a.ts": "export const a = 2;\n",
      "docs/guide/modules/src-a.md": "# A\n\nMy words.\n",
      "src/b/b.ts": "export const b = 2;\n",
    });

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe([
      "Frozen and Stale: modules/src-a (changed: src/a/a.ts#a)",
      "Stale: modules/src-b (changed: src/b/b.ts#b)",
      "",
    ].join("\n"));
    expect(status).toBe(1);
  });

  it("lists a Frozen Section that isn't Stale but exits 0", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-b.md": "# B\n\nMy words.\n" });

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe("Frozen: modules/src-b\n");
    expect(status).toBe(0);
  });
});

it("scribe init prints the detected Modules and their public surface", () => {
  const repo = createFixtureRepo({
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
    "packages/core/src/index.ts": "export function parse() {}\nexport type Ast = {};\n",
    "packages/web/package.json": JSON.stringify({ name: "@acme/web" }),
  });

  const stdout = execFileSync(process.execPath, [cli, "init"], { cwd: repo.dir, encoding: "utf8" });

  expect(stdout).toMatch(/@acme\/core\s+packages\/core\r?\n\s+exports: parse, Ast\r?\n/);
  expect(stdout).toMatch(/@acme\/web\s+packages\/web/);
});
