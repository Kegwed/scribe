import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adopt } from "./commands/adopt.ts";
import { generate } from "./commands/generate.ts";
import { CUT_OFF, fakeClaude } from "./test/fake-claude.ts";
import { createFixtureRepo } from "./test/fixture-repo.ts";
import { scriptedLlm } from "./test/recorded-llm.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI with a dummy API key and Claude's endpoint unreachable, so any LLM call would fail. */
function scribe(dir: string, ...args: string[]) {
  return scribeWithInput(dir, "", ...args);
}

/** As `scribe`, with `input` as its stdin. */
function scribeWithInput(dir: string, input: string, ...args: string[]) {
  return run(dir, { input, key: "sk-ant-dummy" }, ...args);
}

/** Runs the CLI with Claude's endpoint unreachable; `key` undefined leaves `ANTHROPIC_API_KEY` unset. */
function run(dir: string, { input = "", key }: { input?: string; key?: string }, ...args: string[]) {
  const { ANTHROPIC_API_KEY: _, ...env } = process.env;
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    input,
    env: { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ...(key === undefined ? {} : { ANTHROPIC_API_KEY: key }) },
  });
  return { status, stdout, stderr };
}

/** Runs the CLI with a dummy API key against the Claude endpoint at `url`, without blocking, so a fake in this process can answer. */
function scribeAgainst(url: string, dir: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: dir,
    env: { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "sk-ant-dummy" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("a missing ANTHROPIC_API_KEY", () => {
  function target() {
    return createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "src/a/a.ts": "export const a = 1;\n",
    });
  }
  const commands = [["generate"], ["update"], ["reset", "modules/src-a"], ["adopt", "modules/src-a"]];

  for (const [name, missing] of [["unset", undefined], ["empty", ""]] as const) {
    for (const args of commands) {
      it(`stops scribe ${args[0]} before any estimate when ${name}, writing nothing`, () => {
        const repo = target();

        const { status, stdout, stderr } = run(repo.dir, { input: "y\n", key: missing }, ...args, "--yes");

        expect(stdout).toBe("");
        expect(stderr).toContain("ANTHROPIC_API_KEY");
        expect(stderr).toContain("https://console.anthropic.com/settings/keys");
        expect(stderr).toMatch(/bash\/zsh:\s+export ANTHROPIC_API_KEY=/);
        expect(stderr).toMatch(/PowerShell:\s+\$env:ANTHROPIC_API_KEY\s*=\s*"/);
        expect(stderr).toMatch(/cmd:\s+set ANTHROPIC_API_KEY=/);
        // The key check runs before the adapters are built, so the GitHub Source isn't reported on.
        expect(stderr).not.toContain("GitHub Source");
        expect(status).toBe(1);
        expect(repo.git("status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
      });
    }
  }

  it("doesn't stop scribe init or scribe status", () => {
    const repo = createFixtureRepo({ "src/a/a.ts": "export const a = 1;\n" });

    const init = run(repo.dir, {}, "init");
    expect(init.stdout).toContain("Detected");
    expect(init.status).toBe(0);

    // Nothing is generated yet, so status lists the missing Sections and exits 1 for them.
    const status = run(repo.dir, {}, "status");
    expect(status.stderr).toBe("");
    expect(status.stdout).toContain("Not written yet: overview");
  });
});

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

    expect(stdout).toMatch(/^Estimated cost: \$\d+\.\d+ for 4 Sections, about [\d,]+ tokens\n  modules\/src-a  \$\d+\.\d+\n  modules\/src-b  \$\d+\.\d+\n  overview       \$\d+\.\d+\n  architecture   \$\d+\.\d+\n  plus 3 Sections with no Evidence, written without Claude: getting-started, conventions, key-decisions\nAn estimate, made before calling Claude: about [\d,]+ requests \([\d,]+ Section writes and repairs, [\d,]+ verdicts\) for about [\d,]+ expected Claims\. The run can spend more or less\.\nContinue\? \[y\/N\] /);
    expect(stdout).toMatch(/Cancelled; no LLM was called and nothing was written\.\n$/);
    expect(status).toBe(1);
    expect(repo.git("status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
  });

  it("says in one stderr line that the GitHub Source is off because origin isn't on GitHub", () => {
    const repo = target();

    const { stderr } = scribeWithInput(repo.dir, "n\n", "generate");

    expect(stderr).toBe("warning: the GitHub Source is off because `origin` isn't on GitHub; there's nothing to fix.\n");
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
    // Claude's endpoint is unreachable, so reaching the LLM is what fails the run.
    expect(stderr).toMatch(/^scribe: /m);
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

    expect(stdout).toBe("All 7 Sections current.\n");
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

  it("lists a top-level Section the Guide predates as not written yet and exits non-zero", async () => {
    const repo = await generated();
    const manifestFile = `${repo.dir}/.scribe/manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    delete manifest.sections.architecture;
    repo.git("rm", "--quiet", "docs/guide/architecture.md");
    repo.commit({ ".scribe/manifest.json": JSON.stringify(manifest) });

    const { status, stdout } = scribe(repo.dir, "status");

    expect(stdout).toBe("Not written yet: architecture\n");
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
    expect(scribe(repo.dir, "status").stdout).toBe("All 6 Sections current.\n");
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

  /** A generated, committed Guide whose Section A a human edited, with the cache gone so resetting it costs something. */
  async function uncached() {
    const repo = target();
    await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] }) });
    repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nMy words.\n" });
    rmSync(join(repo.dir, ".scribe/cache"), { recursive: true });
    return repo;
  }

  it("reset prints the Section's estimate and, declined, writes nothing and exits 1", async () => {
    const repo = await uncached();

    const { status, stdout } = scribeWithInput(repo.dir, "n\n", "reset", "modules/src-a");

    expect(stdout).toMatch(/^Estimated cost: \$\d+\.\d+ for 1 Section, about [\d,]+ tokens\n  modules\/src-a  \$\d+\.\d+\nAn estimate, made before calling Claude: about [\d,]+ requests \([^)]+\) for about [\d,]+ expected Claims\. The run can spend more or less\.\nContinue\? \[y\/N\] /);
    expect(stdout).toMatch(/Cancelled; no LLM was called and nothing was written\.\n$/);
    expect(status).toBe(1);
    expect(repo.git("status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
  });

  it("reset declines when stdin closes without an answer", async () => {
    const repo = await uncached();

    const { status, stdout } = scribe(repo.dir, "reset", "modules/src-a");

    expect(stdout).toContain("Continue? [y/N] ");
    expect(stdout).toContain("Cancelled;");
    expect(status).toBe(1);
    expect(repo.git("status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
  });

  it("reset skips the prompt with --yes and goes on to call the LLM", async () => {
    const repo = await uncached();

    const { status, stdout, stderr } = scribe(repo.dir, "reset", "modules/src-a", "--yes");

    expect(stdout).toMatch(/^Estimated cost: \$\d+\.\d+ for 1 Section/);
    expect(stdout).not.toContain("Continue?");
    expect(stdout).not.toContain("Cancelled;");
    // Claude's endpoint is unreachable, so reaching the LLM is what fails the run.
    expect(stderr).toMatch(/^scribe: /m);
    expect(status).toBe(1);
  });

  describe("adopt's cost estimate", () => {
    /** A generated, then rewritten by a human: "A is one." the code backs, "A is fast." it doesn't. */
    async function frozen() {
      const repo = target();
      await generate(repo.dir, {}, { llm: scriptedLlm({ paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] }) });
      repo.commit({ "docs/guide/modules/src-a.md": "# A\n\nA is one. A is fast.\n" });
      return repo;
    }

    it("prints the estimate naming the Section and, declined, writes nothing and exits non-zero", async () => {
      const repo = await frozen();
      const before = repo.git("status", "--porcelain", "--untracked-files=all", "--ignored");

      const { status, stdout } = scribeWithInput(repo.dir, "n\n", "adopt", "modules/src-a");

      expect(stdout).toMatch(/^Estimated cost: \$\d+\.\d+ for 1 Section, about [\d,]+ tokens\n  modules\/src-a  \$\d+\.\d+\nAn estimate, made before calling Claude: about [\d,]+ requests \([^)]+\) for about [\d,]+ expected Claims\. The run can spend more or less\.\nContinue\? \[y\/N\] Cancelled; no LLM was called and nothing was written\.\n$/);
      expect(status).toBe(1);
      expect(repo.git("status", "--porcelain", "--untracked-files=all", "--ignored")).toBe(before);
    });

    it("skips the prompt with --yes and adopts the Section, recording its Evidence and Unsupported Claims", async () => {
      const repo = await frozen();
      const claude = await fakeClaude(({ prompt, schema }) =>
        JSON.stringify(schema).includes("attachments")
          ? { attachments: [...prompt.matchAll(/<claim index="(\d+)">/g)].map(([, i]) => ({ claim: Number(i), evidence: ["src/a/a.ts#a"] })) }
          : prompt.includes("A is fast.") ? { confirmed: false, reason: "nothing shows speed" } : { confirmed: true, reason: "a is 1" });
      try {
        const { status, stdout } = await scribeAgainst(claude.url, repo.dir, "adopt", "modules/src-a", "--yes");

        expect(stdout).toMatch(/^Estimated cost: \$\d+\.\d+ for 1 Section, about [\d,]+ tokens\n  modules\/src-a  \$\d+\.\d+\nAn estimate, made before calling Claude: about [\d,]+ requests \([^)]+\) for about [\d,]+ expected Claims\. The run can spend more or less\.\nUnsupported Claim, kept: A is fast\.\nAdopted modules\/src-a\.\n$/);
        expect(status).toBe(0);
        expect(claude.requests.length).toBeGreaterThan(0);
        const record = JSON.parse(readFileSync(join(repo.dir, ".scribe/manifest.json"), "utf8")).sections["modules/src-a"];
        expect(record.evidence.map((e: { id: string }) => e.id)).toEqual(["src/a/a.ts#a"]);
        expect(record.unsupportedClaims).toEqual(["A is fast."]);
      } finally {
        await claude.close();
      }
    });
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

describe("a response cut off at its output limit", () => {
  function target() {
    return createFixtureRepo({
      "scribe.config.json": JSON.stringify({ modules: [{ name: "A", path: "src/a" }] }),
      "src/a/a.ts": "export const a = 1;\n",
    });
  }
  const isWrite = (schema: unknown) => JSON.stringify(schema).includes("paragraphs");
  const written = { paragraphs: [{ claims: [{ text: "A is one.", evidence: ["src/a/a.ts#a"] }] }] };
  const confirmed = { confirmed: true, reason: "a is 1" };

  it("is asked again once, and the run goes on when the retry ends normally", async () => {
    const repo = target();
    let writes = 0;
    const claude = await fakeClaude(({ schema }) => (isWrite(schema) ? (writes++ === 0 ? CUT_OFF : written) : confirmed));
    try {
      const { status, stderr } = await scribeAgainst(claude.url, repo.dir, "generate", "--yes");

      expect(stderr).not.toMatch(/^scribe: /m);
      expect(status).toBe(0);
      expect(readFileSync(join(repo.dir, "docs/guide/modules/src-a.md"), "utf8")).toContain("A is one.");
    } finally {
      await claude.close();
    }
  });

  it("cut off again, fails the run naming the request kind and the Section, and writes nothing of that Section", async () => {
    const repo = target();
    const claude = await fakeClaude(({ schema }) => (isWrite(schema) ? CUT_OFF : confirmed));
    try {
      const { status, stderr } = await scribeAgainst(claude.url, repo.dir, "generate", "--yes");

      expect(stderr).toMatch(/^scribe: a write from claude-sonnet-5-5 was cut off at its 32,000-token output limit twice, writing Section modules\/src-a$/m);
      expect(status).toBe(1);
      expect(existsSync(join(repo.dir, "docs/guide/modules/src-a.md"))).toBe(false);
      const manifest = join(repo.dir, ".scribe/manifest.json");
      expect(existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).sections["modules/src-a"] : undefined).toBeUndefined();
    } finally {
      await claude.close();
    }
  });
});

it("scribe --help says which commands print an estimate and ask, and that --yes skips asking", () => {
  const repo = createFixtureRepo({});

  const { status, stderr } = scribe(repo.dir, "--help");

  expect(stderr).toContain("generate, update, reset and adopt print a cost estimate and ask before calling the LLM; --yes skips asking.");
  expect(status).toBe(0);
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
