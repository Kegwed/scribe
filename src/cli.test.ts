import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adopt } from "./commands/adopt.ts";
import { generate } from "./commands/generate.ts";
import { createFixtureRepo } from "./test/fixture-repo.ts";
import { scriptedLlm } from "./test/recorded-llm.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI with no API key and Claude's endpoint unreachable, so any LLM call would fail; `input` is its stdin. */
function scribe(dir: string, ...args: string[]) {
  return scribeWithInput(dir, "", ...args);
}

function scribeWithInput(dir: string, input: string, ...args: string[]) {
  const { ANTHROPIC_API_KEY: _, ...env } = process.env;
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    input,
    env: { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
  });
  return { status, stdout, stderr };
}

describe("scribe generate's cost estimate", () => {
  function target() {
    return createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }] }),
      "src/a/a.ts": "export const a = 1;\n",
      "src/b/b.ts": "export const b = 1;\n",
    });
  }

  it("prints the estimate per Section and, declined, writes nothing and exits non-zero", () => {
    const repo = target();

    const { status, stdout } = scribeWithInput(repo.dir, "n\n", "generate");

    expect(stdout).toMatch(/^Estimated cost: \$\d+\.\d+ for 2 Sections, about [\d,]+ tokens\n  modules\/src-a  \$\d+\.\d+\n  modules\/src-b  \$\d+\.\d+\n  plus 1 cached Section at no cost\nContinue\? \[y\/N\] /);
    expect(stdout).toMatch(/Cancelled; no LLM was called and nothing was written\.\n$/);
    expect(status).toBe(1);
    expect(repo.git("status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
  });

  it("declines when stdin closes without an answer", () => {
    const repo = target();

    const { status, stdout } = scribe(repo.dir, "generate");

    expect(stdout).toContain("Cancelled;");
    expect(status).toBe(1);
  });

  it("skips the prompt with --yes and goes on to call the LLM", () => {
    const repo = target();

    const { status, stdout, stderr } = scribe(repo.dir, "generate", "--yes");

    expect(stdout).toMatch(/^Estimated cost: /);
    expect(stdout).not.toContain("Continue?");
    expect(stdout).not.toContain("Cancelled;");
    // No API key is set, so reaching the LLM is what fails the run.
    expect(stderr).toMatch(/^scribe: /);
    expect(status).toBe(1);
  });
});

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

    expect(stdout).toBe("All 3 Sections current.\n");
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

  it("lists a pending Proposal and exits non-zero while it exists", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-b.md": "# B\n\nMy words.\n", "docs/guide/modules/src-b.proposal.md": "# B\n\nB is one.\n" });

    const pending = scribe(repo.dir, "status");

    expect(pending.stdout).toBe([
      "Frozen: modules/src-b",
      "Proposal to merge by hand: modules/src-b (docs/guide/modules/src-b.proposal.md)",
      "",
    ].join("\n"));
    expect(pending.status).toBe(1);

    repo.git("rm", "--quiet", "docs/guide/modules/src-b.proposal.md");
    expect(scribe(repo.dir, "status").status).toBe(0);
  });

  it("lists a Section whose file is gone and exits non-zero", async () => {
    const repo = await generated();
    repo.git("rm", "--quiet", "docs/guide/modules/src-b.md");

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe("Missing: modules/src-b\n");
    expect(status).toBe(1);
  });

  it("lists a Module added since generate as needing a Section and exits non-zero", async () => {
    const repo = await generated();
    repo.commit({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }, { name: "B", path: "src/b" }, { name: "C", path: "src/c" }] }),
    });

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe("Module added, no Section yet: modules/src-c\n");
    expect(status).toBe(1);
  });

  it("lists an adopted Section's Unsupported Claims but exits 0", async () => {
    const repo = await generated();
    repo.commit({ "docs/guide/modules/src-b.md": "# B\n\nB is fast.\n" });
    await adopt(repo.dir, "modules/src-b", {}, { llm: scriptedLlm("unused") });

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe("Unsupported Claim in modules/src-b: B is fast.\n");
    expect(status).toBe(0);
  });

  it("lists the Section of a removed Module and exits non-zero", async () => {
    const repo = await generated();
    repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe("Module removed: modules/src-b\n");
    expect(status).toBe(1);
  });
});

describe("Drift", () => {
  async function drifting() {
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "README.md": "# App\n\n## Usage\n\n`a` is two.\n",
      "src/a/a.ts": "export const a = 1;\n",
    });
    await generate(repo.dir, {}, {
      llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] }, {}, {
        drift: [{ description: "The README says a is two, but it is one.", docs: ["README.md#usage"], code: ["src/a/a.ts#a"] }],
      }),
    });
    repo.commit({}, "generate the Guide");
    return repo;
  }
  const LINE = "Drift: The README says a is two, but it is one. (docs: README.md#usage; code: src/a/a.ts#a; found for modules/src-a)";

  it("scribe status lists Drift with the Evidence on both sides, and exits 0 when nothing else needs attention", async () => {
    const repo = await drifting();

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe(`${LINE}\n`);
    expect(status).toBe(0);
  });

  it("scribe update reports the Drift in its run report", async () => {
    const repo = await drifting();

    const { status, stdout } = scribe(repo.dir, "update");

    expect(stdout).toBe(`${LINE}\nGuide updated.\n`);
    expect(status).toBe(0);
  });
});

describe("scribe generate", () => {
  it("says which Modules were reduced to fit one writing request, and how", async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => `  const step${i} = value + ${i};`).join("\n");
    const repo = createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "src/a/a.ts": `export const a = 1;\n\nfunction huge(value: number) {\n${huge}\n  return value;\n}\n`,
    });
    // Answered once in-process and cached, so the CLI's run makes no LLM call.
    await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] }) });

    const { status, stdout } = scribe(repo.dir, "generate");

    expect(stdout).toBe([
      "Reduced to fit one writing request: modules/src-a (left out: src/a/a.ts#huge)",
      "Guide generated.",
      "",
    ].join("\n"));
    expect(status).toBe(0);
  });
});

describe("scribe update", () => {
  it("reports a removed Module's Section, after which status is clean", async () => {
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
    repo.commit({ "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }) });

    const update = scribe(repo.dir, "update");

    expect(update.stdout).toBe([
      "Module removed: modules/src-b; delete docs/guide/modules/src-b.md if it is no longer wanted.",
      "Guide updated.",
      "",
    ].join("\n"));
    expect(update.status).toBe(0);
    expect(scribe(repo.dir, "status").stdout).toBe("All 2 Sections current.\n");
  });
});

describe("scribe adopt and scribe reset", () => {
  function target() {
    return createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "src/a/a.ts": "export const a = 1;\n",
    });
  }

  it("adopt reports the Unsupported Claims it kept and the Proposal it cleared", async () => {
    const repo = target();
    await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] }) });
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nA is fast.\n", "docs/guide/modules/src-a.proposal.md": "# A\n\nA is one.\n" });
    // Adopted once in-process to fill the git-ignored cache, then undone, so the CLI needs no LLM.
    await adopt(repo.dir, "modules/src-a", {}, { llm: scriptedLlm("unused") });
    repo.git("checkout", "--quiet", "--", ".");

    const { status, stdout } = scribe(repo.dir, "adopt", "modules/src-a");

    expect(stdout).toBe([
      "Unsupported Claim, kept: A is fast.",
      "Proposal deleted: docs/guide/modules/src-a.proposal.md",
      "Adopted modules/src-a.",
      "",
    ].join("\n"));
    expect(status).toBe(0);
  });

  it("reset reports the Section it regenerated", async () => {
    const repo = target();
    await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] }) });
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nMy words.\n" });

    // Written from scratch, the requests are the ones generate made, so the cache answers them.
    const { status, stdout } = scribe(repo.dir, "reset", "modules/src-a");

    expect(stdout).toBe("Reset modules/src-a.\n");
    expect(status).toBe(0);
  });

  it("adopt and reset without a Section print usage and exit 1", () => {
    const repo = target();

    for (const command of ["adopt", "reset"]) {
      const { status, stderr } = scribe(repo.dir, command);
      expect(stderr).toMatch(new RegExp(`Usage: scribe ${command} <section>`));
      expect(status).toBe(1);
    }
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
