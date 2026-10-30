import { describe, expect, it } from "vitest";
import { type Analysis, typescriptAnalyser } from "./analyser.ts";
import type { Module } from "./modules.ts";
import { createFixtureRepo, type Files } from "./test/fixture-repo.ts";

const APP: Module[] = [{ name: "src", path: "src" }];

const SESSION = `import { randomUUID } from "node:crypto";

export function createSession(user: string) {
  return { id: randomUUID(), user };
}

export function endSession(id: string) {
  return id;
}
`;

async function analyseBeforeAndAfter(before: Files, after: Files, modules = APP) {
  const repo = createFixtureRepo(before);
  const first = await typescriptAnalyser.analyse(repo.dir, modules);
  repo.commit(after);
  const second = await typescriptAnalyser.analyse(repo.dir, modules);
  return [first, second] as const;
}

function hashOf(analysis: Analysis, id: string): string {
  const symbol = analysis.symbols.find((s) => s.id === id);
  if (!symbol) throw new Error(`no symbol ${id} in ${analysis.symbols.map((s) => s.id).join(", ")}`);
  return symbol.hash;
}

describe("public surface", () => {
  it("is each Module's exported symbols, a file counting only towards its innermost Module", async () => {
    const repo = createFixtureRepo({
      "src/cli.ts": "export function main() {}\nfunction usage() {}\n",
      "src/auth/session.ts": [
        "export function createSession() {}",
        "function sign() {}",
        "const TTL = 60;",
        "export { TTL as SESSION_TTL };",
        "export * from '../cli.ts';",
        "",
      ].join("\n"),
      "src/auth/token.js": "export const token = () => 'abc';\nexport default class Token {}\n",
      "src/auth/session.test.ts": "export function helper() {}\n",
      "src/auth/fixtures/user.ts": "export const user = {};\n",
    });
    const modules = [
      { name: "src", path: "src" },
      { name: "auth", path: "src/auth" },
    ];

    const analysis = await typescriptAnalyser.analyse(repo.dir, modules);

    const surface = (path: string) =>
      analysis.publicSurface[path]?.map((s) => `${s.id} as ${s.exportedAs.join(", ")}`).sort();
    expect(surface("src")).toEqual(["src/cli.ts#main as main"]);
    expect(surface("src/auth")).toEqual([
      "src/auth/session.ts#TTL as SESSION_TTL",
      "src/auth/session.ts#createSession as createSession",
      "src/auth/token.js#Token as default",
      "src/auth/token.js#token as token",
    ]);
  });

  it("is empty for a Module with no exports", async () => {
    const repo = createFixtureRepo({ "src/main.ts": "console.log('hi');\n" });

    const analysis = await typescriptAnalyser.analyse(repo.dir, APP);

    expect(analysis.publicSurface).toEqual({ src: [] });
  });
});

describe("import graph", () => {
  it("links Modules whose files import, re-export or require each other's files", async () => {
    const repo = createFixtureRepo({
      "src/cli.ts": "import { init } from './commands/init.ts';\nimport chalk from 'chalk';\nexport { init };\n",
      "src/config.ts": "import { join } from 'node:path';\nexport const config = {};\n",
      "src/commands/init.ts": "import { config } from '../config.js';\nimport { status } from './status';\nexport function init() {}\n",
      "src/commands/status.ts": "export const status = () => import('../auth');\n",
      "src/auth/index.js": "const { config } = require('../config');\nexport * from './session.ts';\n",
      "src/auth/session.ts": "import type { Fixture } from '../../test/fixture.ts';\nexport const session = 1;\n",
      "test/fixture.ts": "export type Fixture = {};\n",
    });
    const modules = [
      { name: "src", path: "src" },
      { name: "src/auth", path: "src/auth" },
      { name: "src/commands", path: "src/commands" },
    ];

    const analysis = await typescriptAnalyser.analyse(repo.dir, modules);

    expect(analysis.imports).toEqual([
      { from: "src", to: "src/commands" },
      { from: "src/auth", to: "src" },
      { from: "src/commands", to: "src" },
      { from: "src/commands", to: "src/auth" },
    ]);
  });

  it("links workspace packages that import each other by package name", async () => {
    const repo = createFixtureRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "packages/web/package.json": JSON.stringify({ name: "@acme/web" }),
      "packages/web/src/app.ts": "import { core } from '@acme/core';\nimport { parse } from '@acme/core/parser';\nimport x from '@acme/corelib';\n",
    });
    const modules = [
      { name: "Core", path: "packages/core" },
      { name: "Web", path: "packages/web" },
    ];

    const analysis = await typescriptAnalyser.analyse(repo.dir, modules);

    expect(analysis.imports).toEqual([{ from: "packages/web", to: "packages/core" }]);
  });
});

describe("symbol hashes", () => {
  it("are unchanged by an added import", async () => {
    const [before, after] = await analyseBeforeAndAfter(
      { "src/session.ts": SESSION },
      { "src/session.ts": `import { log } from "./log.ts";\n${SESSION}`, "src/log.ts": "export const log = 1;\n" },
    );

    expect(hashOf(after, "src/session.ts#createSession")).toBe(hashOf(before, "src/session.ts#createSession"));
  });

  it("are unchanged by edits to neighbouring symbols", async () => {
    const [before, after] = await analyseBeforeAndAfter(
      { "src/session.ts": SESSION },
      { "src/session.ts": SESSION.replace("return id;", "console.log(id);\n  return id;") },
    );

    expect(hashOf(after, "src/session.ts#createSession")).toBe(hashOf(before, "src/session.ts#createSession"));
  });

  it("are unchanged by reformatting neighbouring symbols", async () => {
    const [before, after] = await analyseBeforeAndAfter(
      { "src/session.ts": SESSION },
      {
        "src/session.ts": SESSION.replace(
          "export function endSession(id: string) {\n  return id;\n}",
          "export function endSession(\n  id: string,\n) { return id }",
        ),
      },
    );

    expect(hashOf(after, "src/session.ts#createSession")).toBe(hashOf(before, "src/session.ts#createSession"));
  });

  it("are unchanged by moving a symbol within its file", async () => {
    const createSession = `export function createSession(user: string) {\n  return { id: randomUUID(), user };\n}\n`;
    const [before, after] = await analyseBeforeAndAfter(
      { "src/session.ts": SESSION },
      { "src/session.ts": `${SESSION.replace(createSession, "")}\n${createSession}` },
    );

    expect(hashOf(after, "src/session.ts#createSession")).toBe(hashOf(before, "src/session.ts#createSession"));
  });

  it("change when the symbol's own text changes", async () => {
    const [before, after] = await analyseBeforeAndAfter(
      { "src/session.ts": SESSION },
      { "src/session.ts": SESSION.replace("{ id: randomUUID(), user }", "{ id: randomUUID(), user, at: Date.now() }") },
    );

    expect(hashOf(after, "src/session.ts#createSession")).not.toBe(hashOf(before, "src/session.ts#createSession"));
  });

  it("change when a symbol is exported or unexported, whatever its kind", async () => {
    const [before, after] = await analyseBeforeAndAfter(
      { "src/limits.ts": "const LIMIT = 10;\nfunction check() {}\n" },
      { "src/limits.ts": "export const LIMIT = 10;\nexport function check() {}\n" },
    );

    expect(hashOf(after, "src/limits.ts#LIMIT")).not.toBe(hashOf(before, "src/limits.ts#LIMIT"));
    expect(hashOf(after, "src/limits.ts#check")).not.toBe(hashOf(before, "src/limits.ts#check"));
  });

  it("are the same whether the file is checked out with CRLF or LF line endings", async () => {
    const lf = createFixtureRepo({ "src/session.ts": SESSION });
    const crlf = createFixtureRepo({ "src/session.ts": SESSION.replaceAll("\n", "\r\n") });

    const [fromLf, fromCrlf] = await Promise.all([
      typescriptAnalyser.analyse(lf.dir, APP),
      typescriptAnalyser.analyse(crlf.dir, APP),
    ]);

    expect(hashOf(fromCrlf, "src/session.ts#createSession")).toBe(hashOf(fromLf, "src/session.ts#createSession"));
  });

  it("cover every kind of top-level declaration, with its doc comment", async () => {
    const files = {
      "src/kinds.ts": [
        "/** A user. */",
        "export interface User { name: string }",
        "export type Id = string;",
        "export class Store { get(id: Id) { return id; } }",
        "export enum Role { Admin, Member }",
        "export const LIMIT = 10, OTHER = 20;",
        "export default function () {}",
        "export function parse(input: string): number;",
        "export function parse(input: number): number;",
        "export function parse(input: unknown) { return Number(input); }",
        "",
      ].join("\n"),
    };
    const [before, after] = await analyseBeforeAndAfter(files, {
      "src/kinds.ts": files["src/kinds.ts"]
        .replace("/** A user. */", "/** A signed-in user. */")
        .replace("OTHER = 20", "OTHER = 21")
        .replace("parse(input: number)", "parse(input: bigint)"),
    });

    expect(before.symbols.map((s) => s.id).sort()).toEqual([
      "src/kinds.ts#LIMIT",
      "src/kinds.ts#OTHER",
      "src/kinds.ts#Role",
      "src/kinds.ts#Store",
      "src/kinds.ts#User",
      "src/kinds.ts#default",
      "src/kinds.ts#parse",
      "src/kinds.ts#Id",
    ].sort());
    const changed = after.symbols.filter((s) => s.hash !== hashOf(before, s.id)).map((s) => s.id).sort();
    expect(changed).toEqual(["src/kinds.ts#OTHER", "src/kinds.ts#User", "src/kinds.ts#parse"]);
  });
});
