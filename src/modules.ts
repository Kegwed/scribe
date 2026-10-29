import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A unit of a Target repo's structure that gets its own Section. */
export interface Module {
  name: string;
  /** Repo-relative, forward-slashed directory. */
  path: string;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Workspace packages if the repo has workspaces, otherwise top-level source
 * directories.
 */
export async function detectModules(repoDir: string): Promise<Module[]> {
  const patterns = await readWorkspacePatterns(repoDir);
  if (patterns) return workspaceModules(repoDir, patterns);
  return sourceDirectoryModules(repoDir);
}

/** Top-level, non-hidden directories holding source files git doesn't ignore. */
function sourceDirectoryModules(repoDir: string): Module[] {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoDir, encoding: "utf8" },
  ).split("\0");

  const dirs = new Set<string>();
  for (const file of files) {
    const [top, ...rest] = file.split("/");
    if (top && rest.length > 0 && !top.startsWith(".") && SOURCE_FILE.test(file)) dirs.add(top);
  }
  return [...dirs].sort().map((dir) => ({ name: dir, path: dir }));
}

async function readWorkspacePatterns(repoDir: string): Promise<string[] | undefined> {
  const manifest = await readJson(join(repoDir, "package.json"));
  const workspaces = manifest?.workspaces;
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
  const modules: Module[] = [];
  for await (const path of glob(patterns, { cwd: repoDir })) {
    const manifest = await readJson(join(repoDir, path, "package.json"));
    if (!manifest) continue;
    modules.push({ name: manifest.name ?? path, path: path.replaceAll("\\", "/") });
  }
  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

async function readJson(file: string): Promise<any> {
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8"));
}
