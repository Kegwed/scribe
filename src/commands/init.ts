import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapters } from "../adapters.ts";
import { typescriptAnalyser } from "../analyser.ts";
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig } from "../config.ts";
import { CACHE_DIR, emptyManifest, MANIFEST_PATH } from "../manifest.ts";
import { detectModules, type Module } from "../modules.ts";

export interface InitOptions {}

export interface InitResult {
  modules: Module[];
  /** The names each Module exports, keyed by Module path. */
  publicSurface: Record<string, string[]>;
  /** Problems the maintainer should fix by hand. */
  warnings: string[];
}

/**
 * Prepares a Target repo for Scribe: writes the config and an empty manifest
 * (keeping any that exist), git-ignores the LLM cache, and reports the Modules
 * with their public surface.
 */
export async function init(
  repoDir: string,
  _options: InitOptions = {},
  _adapters: Adapters = {},
): Promise<InitResult> {
  const config = await loadConfig(repoDir);
  if (!config) await writeJson(join(repoDir, CONFIG_FILE), DEFAULT_CONFIG);

  const manifestFile = join(repoDir, MANIFEST_PATH);
  if (!existsSync(manifestFile)) await writeJson(manifestFile, emptyManifest());
  await gitIgnore(repoDir, CACHE_DIR);

  const warnings: string[] = [];
  if (isIgnored(repoDir, MANIFEST_PATH)) {
    warnings.push(
      `${MANIFEST_PATH} is git-ignored; un-ignore it so the manifest is committed and shared.`,
    );
  }

  const modules = config?.modules ?? (await detectModules(repoDir));
  const analysis = await typescriptAnalyser.analyse(repoDir, modules);
  const publicSurface = Object.fromEntries(
    Object.entries(analysis.publicSurface).map(([path, symbols]) => [path, symbols.flatMap((s) => s.exportedAs)]),
  );
  return { modules, publicSurface, warnings };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** Appends `dir` to the repo's root .gitignore unless git already ignores it. */
async function gitIgnore(repoDir: string, dir: string): Promise<void> {
  if (isIgnored(repoDir, `${dir}any-file`)) return;

  const file = join(repoDir, ".gitignore");
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${separator}${dir}\n`);
}

function isIgnored(repoDir: string, path: string): boolean {
  const { status, stderr } = spawnSync("git", ["check-ignore", "--quiet", "--no-index", path], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error(`git check-ignore failed: ${stderr.trim()}`);
}
