import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MODELS, type Models } from "./llm.ts";
import type { Module } from "./modules.ts";

export const CONFIG_FILE = "scribe.config.json";

export interface Config {
  /** Repo-relative directory the Guide is written to. */
  guideDir: string;
  /** When set, replaces Module detection entirely. */
  modules?: Module[];
  /** Overrides the default model for each kind of request it names. */
  models?: Partial<Models>;
}

/** The models to use: the config's overrides over the defaults (ADR-0003). */
export function modelsOf(config: Config): Models {
  return { ...MODELS, ...config.models };
}

export const DEFAULT_CONFIG: Config = { guideDir: "docs/guide" };

/** The Target repo's config merged over the defaults, or undefined if it has none. */
export async function loadConfig(repoDir: string): Promise<Config | undefined> {
  const file = join(repoDir, CONFIG_FILE);
  if (!existsSync(file)) return undefined;

  const raw = JSON.parse(await readFile(file, "utf8"));
  const config: Config = { ...DEFAULT_CONFIG, ...raw };
  if (config.modules !== undefined && !isModuleList(config.modules)) {
    throw new Error(`${CONFIG_FILE}: "modules" must be a list of { "name": string, "path": string }`);
  }
  return config;
}

function isModuleList(value: unknown): value is Module[] {
  return (
    Array.isArray(value) &&
    value.every((m) => typeof m?.name === "string" && typeof m?.path === "string")
  );
}
