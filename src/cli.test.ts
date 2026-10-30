import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createFixtureRepo } from "./test/fixture-repo.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

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
