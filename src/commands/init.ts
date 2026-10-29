import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapters } from "../adapters.ts";
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig } from "../config.ts";
import { CACHE_DIR, emptyManifest, MANIFEST_PATH } from "../manifest.ts";
import { detectModules, type Module } from "../modules.ts";

export interface InitOptions {}

export interface InitResult {
  modules: Module[];
}

/**
 * Prepares a Target repo for Scribe: writes the config and an empty manifest
 * (keeping any that exist), git-ignores the LLM cache, and reports the Modules.
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

  const modules = config?.modules ?? (await detectModules(repoDir));
  return { modules };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** Appends `pattern` to the repo's root .gitignore unless it is already listed. */
async function gitIgnore(repoDir: string, pattern: string): Promise<void> {
  const file = join(repoDir, ".gitignore");
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";
  if (existing.split(/\r?\n/).some((line) => line.trim() === pattern)) return;

  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${separator}${pattern}\n`);
}
