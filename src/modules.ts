import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A unit of a Target repo's Product code that gets its own Section. */
export interface Module {
  name: string;
  /** Repo-relative, forward-slashed directory; "." for the repo root. */
  path: string;
}

const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Tests, examples, fixtures and tooling: Evidence, never Modules. */
const NON_PRODUCT_DIRS = new Set([
  "test", "tests", "__tests__", "spec", "e2e", "__mocks__", "mocks",
  "fixtures", "__fixtures__", "examples", "example", "scripts",
  "bench", "benchmarks", "docs",
]);
const NON_PRODUCT_FILE = /\.(?:test|spec|config)\.[^.]+$/;

/**
 * Workspace packages if the repo has any, otherwise the subdirectories of the
 * Code root plus the files directly in it.
 */
export async function detectModules(repoDir: string): Promise<Module[]> {
  const packageJson = await readJson(join(repoDir, "package.json"));
  const patterns = await readWorkspacePatterns(repoDir, packageJson);
  const workspaces = patterns ? await workspaceModules(repoDir, patterns) : [];
  if (workspaces.length > 0) return workspaces;
  return codeRootModules(listProductCode(repoDir), packageJson?.name);
}

/** The innermost Module containing `file`, the only one it belongs to. */
export function moduleOf(file: string, modules: Module[]): Module | undefined {
  let innermost: Module | undefined;
  for (const module of modules) {
    const contains = module.path === "." || file.startsWith(`${module.path}/`);
    if (contains && (!innermost || innermost.path === "." || module.path.length > innermost.path.length)) {
      innermost = module;
    }
  }
  return innermost;
}

/** Repo-relative paths of Product code files that git doesn't ignore. */
export function listProductCode(repoDir: string): string[] {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoDir, encoding: "utf8" },
  ).split("\0");
  return files.filter(isProductCode);
}

function isProductCode(file: string): boolean {
  if (!CODE_FILE.test(file) || NON_PRODUCT_FILE.test(file)) return false;
  const segments = file.split("/");
  return segments.every((s, i) =>
    !s.startsWith(".") && (i === segments.length - 1 || !NON_PRODUCT_DIRS.has(s)),
  );
}

/**
 * Descends from the repo root while all Product code sits in one directory,
 * then yields a Module per subdirectory there, plus one for its loose files.
 */
function codeRootModules(files: string[], repoName: string | undefined): Module[] {
  let root = "";
  let remaining = files;
  for (;;) {
    const subdirs = new Set(remaining.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!));
    const hasLooseFiles = remaining.some((f) => !f.includes("/"));
    const [only] = subdirs;
    if (hasLooseFiles || subdirs.size !== 1 || only === undefined) {
      const modules = [...subdirs].sort().map((dir) => {
        const path = root + dir;
        return { name: path, path };
      });
      if (hasLooseFiles) {
        const path = root === "" ? "." : root.slice(0, -1);
        modules.unshift({ name: root === "" ? (repoName ?? ".") : path, path });
      }
      return modules;
    }
    root += `${only}/`;
    remaining = remaining.map((f) => f.slice(only.length + 1));
  }
}

async function readWorkspacePatterns(repoDir: string, packageJson: any): Promise<string[] | undefined> {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  if (Array.isArray(workspaces?.packages)) return workspaces.packages;

  const pnpmWorkspace = join(repoDir, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspace)) return parsePnpmPackages(await readFile(pnpmWorkspace, "utf8"));
  return undefined;
}

/** Reads the `packages:` block list; the only key Module detection needs. */
function parsePnpmPackages(yaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    const item = inPackages ? line.match(/^\s+-\s+(.+?)\s*$/) : null;
    if (item?.[1]) patterns.push(item[1].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return patterns;
}

async function workspaceModules(repoDir: string, patterns: string[]): Promise<Module[]> {
  const include = patterns.filter((p) => !p.startsWith("!"));
  const exclude = [
    ...patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1)),
    "**/node_modules",
  ];

  const modules: Module[] = [];
  for await (const path of glob(include, { cwd: repoDir, exclude })) {
    const packageJson = await readJson(join(repoDir, path, "package.json"));
    if (!packageJson) continue;
    modules.push({ name: packageJson.name ?? path, path: path.replaceAll("\\", "/") });
  }
  return modules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function readJson(file: string): Promise<any> {
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8"));
}
