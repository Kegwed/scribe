import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "../test/fixture-repo.ts";
import { init } from "./init.ts";

const pkg = (name: string, extra: object = {}) =>
  JSON.stringify({ name, ...extra }, null, 2);

describe("init", () => {
  it("yields one Module per workspace package when the repo has workspaces", async () => {
    const repo = createFixtureRepo({
      "package.json": pkg("root", { private: true, workspaces: ["packages/*", "apps/web"] }),
      "packages/core/package.json": pkg("@acme/core"),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "packages/utils/package.json": pkg("@acme/utils"),
      "packages/utils/index.js": "module.exports = {};\n",
      "apps/web/package.json": pkg("web"),
      "apps/web/main.ts": "console.log('hi');\n",
      "apps/cli/package.json": pkg("not-a-workspace"),
      "scripts/release.ts": "// not a module\n",
    });

    const result = await init(repo.dir);

    expect(result.modules).toEqual([
      { name: "web", path: "apps/web" },
      { name: "@acme/core", path: "packages/core" },
      { name: "@acme/utils", path: "packages/utils" },
    ]);
  });

  it("honours negated workspace patterns and never treats dependencies as Modules", async () => {
    const repo = createFixtureRepo({
      "package.json": pkg("root", { private: true, workspaces: ["packages/**", "!packages/private"] }),
      ".gitignore": "node_modules/\n",
      "packages/core/package.json": pkg("@acme/core"),
      "packages/core/node_modules/dep/package.json": pkg("dep"),
      "packages/private/package.json": pkg("@acme/private"),
    });

    const result = await init(repo.dir);

    expect(result.modules).toEqual([{ name: "@acme/core", path: "packages/core" }]);
  });

  it("reads pnpm workspaces from pnpm-workspace.yaml", async () => {
    const repo = createFixtureRepo({
      "package.json": pkg("root", { private: true }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - \"tools/lint\" # the linter\n",
      "packages/api/package.json": pkg("api"),
      "tools/lint/package.json": pkg("lint"),
    });

    const result = await init(repo.dir);

    expect(result.modules).toEqual([
      { name: "api", path: "packages/api" },
      { name: "lint", path: "tools/lint" },
    ]);
  });

  it("yields one Module per top-level source directory when the repo has no workspaces", async () => {
    const repo = createFixtureRepo({
      "package.json": pkg("app"),
      ".gitignore": "node_modules/\ndist/\n",
      "index.ts": "export * from './src/index.ts';\n",
      "src/index.ts": "export const app = 1;\n",
      "src/auth/session.ts": "export function createSession() {}\n",
      "lib/legacy.js": "module.exports = {};\n",
      "scripts/build.mjs": "console.log('build');\n",
      "docs/intro.md": "# Intro\n",
      ".github/workflows/check.js": "// hidden dirs are not source\n",
      "node_modules/dep/index.js": "module.exports = {};\n",
      "dist/index.js": "export const app = 1;\n",
    });

    const result = await init(repo.dir);

    expect(result.modules).toEqual([
      { name: "lib", path: "lib" },
      { name: "scripts", path: "scripts" },
      { name: "src", path: "src" },
    ]);
  });

  it("uses the Modules configured in scribe.config.json instead of detecting them", async () => {
    const repo = createFixtureRepo({
      "package.json": pkg("root", { private: true, workspaces: ["packages/*"] }),
      "packages/core/package.json": pkg("@acme/core"),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "packages/core/src/parser/index.ts": "export const parse = 1;\n",
      "scribe.config.json": JSON.stringify({
        modules: [
          { name: "Parser", path: "packages/core/src/parser" },
          { name: "Core", path: "packages/core" },
        ],
      }),
    });

    const result = await init(repo.dir);

    expect(result.modules).toEqual([
      { name: "Parser", path: "packages/core/src/parser" },
      { name: "Core", path: "packages/core" },
    ]);
  });

  it("writes a default config, an empty manifest, and git-ignores the cache directory", async () => {
    const repo = createFixtureRepo({
      "package.json": pkg("app"),
      ".gitignore": "node_modules/\n",
      "src/index.ts": "export const app = 1;\n",
    });

    await init(repo.dir);

    expect(readJson(repo.dir, "scribe.config.json")).toEqual({ guideDir: "docs/guide" });
    expect(readJson(repo.dir, ".scribe/manifest.json")).toEqual({ version: 1, sections: {} });
    expect(isIgnored(repo, ".scribe/cache/some-response.json")).toBe(true);
    expect(isIgnored(repo, ".scribe/manifest.json")).toBe(false);
    expect(isIgnored(repo, "node_modules/dep/index.js")).toBe(true);
  });

  it("keeps an existing config and manifest when run again", async () => {
    const repo = createFixtureRepo({ "src/index.ts": "export const app = 1;\n" });
    await init(repo.dir);
    const config = { guideDir: "handbook" };
    const manifest = { version: 1, sections: { overview: { contentHash: "abc" } } };
    repo.commit({
      "scribe.config.json": JSON.stringify(config),
      ".scribe/manifest.json": JSON.stringify(manifest),
    });

    await init(repo.dir);

    expect(readJson(repo.dir, "scribe.config.json")).toEqual(config);
    expect(readJson(repo.dir, ".scribe/manifest.json")).toEqual(manifest);
    const gitignore = readFileSync(join(repo.dir, ".gitignore"), "utf8");
    expect(gitignore.match(/^\.scribe\/cache\/$/gm)).toHaveLength(1);
  });
});

function readJson(dir: string, path: string): unknown {
  return JSON.parse(readFileSync(join(dir, path), "utf8"));
}

function isIgnored(repo: FixtureRepo, path: string): boolean {
  try {
    repo.git("check-ignore", "--quiet", "--no-index", path);
    return true;
  } catch {
    return false;
  }
}
