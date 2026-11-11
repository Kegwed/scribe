import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type CodeSymbol, typescriptAnalyser } from "./analyser.ts";
import { CONFIG_FILE, type Config, loadConfig } from "./config.ts";
import { isGitHubEvidence } from "./github.ts";
import { loadManifest, type Manifest, type SectionRecord } from "./manifest.ts";
import { detectModules, type Module } from "./modules.ts";

/** A Target repo as every command that reads its Guide sees it. */
export interface Target {
  config: Config;
  modules: Module[];
  /** Each Module's Section id, which is also its file's path in the Guide, without the extension. */
  sectionIds: Map<Module, string>;
  symbols: CodeSymbol[];
  manifest: Manifest;
}

/** Loads the config, resolves the Modules, analyses their code and loads the manifest. */
export async function openTarget(repoDir: string): Promise<Target> {
  const config = await loadConfig(repoDir);
  if (!config) throw new Error(`no ${CONFIG_FILE} here; run scribe init first`);
  const modules = config.modules ?? (await detectModules(repoDir));
  const sectionIds = uniqueSectionIds(modules);
  const { symbols } = await typescriptAnalyser.analyse(repoDir, modules);
  const manifest = await loadManifest(repoDir);
  return { config, modules, sectionIds, symbols, manifest };
}

/** Repo-relative path of a Section's file. */
export function sectionPath(config: Config, section: string): string {
  return `${config.guideDir}/${section}.md`;
}

/** Repo-relative path of the Proposal for a Section, written beside the Section's file (ADR-0002). */
export function proposalPath(config: Config, section: string): string {
  return `${config.guideDir}/${section}${PROPOSAL_SUFFIX}`;
}

export const PROPOSAL_SUFFIX = ".proposal.md";

/**
 * Ids of the symbols a Section cites whose text has changed or which no longer
 * exist; the Section is Stale if any. GitHub Evidence never counts: `status`
 * makes no network calls, so it can't see GitHub change.
 */
export function changedEvidence(record: SectionRecord, symbols: CodeSymbol[]): string[] {
  const hashes = new Map(symbols.map((s) => [s.id, s.hash]));
  return record.evidence.filter(({ id, hash }) => !isGitHubEvidence(id) && hashes.get(id) !== hash).map(({ id }) => id);
}

/** A Section file's content, or undefined if it doesn't exist. */
export async function readSection(repoDir: string, path: string): Promise<string | undefined> {
  const file = join(repoDir, path);
  return existsSync(file) ? await readFile(file, "utf8") : undefined;
}

/** The Module whose Section is `section`; throws if no current Module has it. */
export function sectionModule({ sectionIds }: Target, section: string): Module {
  const module = [...sectionIds].find(([, id]) => id === section)?.[0];
  if (!module) {
    const known = [...sectionIds.values()].join(", ");
    throw new Error(`no Module has the Section ${section}; the Sections are ${known || "(none)"}`);
  }
  return module;
}

/** Deletes a Section's pending Proposal; returns its repo-relative path, or undefined if there was none. */
export async function clearProposal(repoDir: string, config: Config, section: string): Promise<string | undefined> {
  const path = proposalPath(config, section);
  if (!existsSync(join(repoDir, path))) return undefined;
  await rm(join(repoDir, path));
  return path;
}

const MODULE_SECTIONS = "modules/";

/** Whether a recorded Section belongs to a Module that no longer exists; top-level Sections never do. */
export function isRemovedModuleSection({ sectionIds }: Target, section: string): boolean {
  return section.startsWith(MODULE_SECTIONS) && ![...sectionIds.values()].includes(section);
}

function uniqueSectionIds(modules: Module[]): Map<Module, string> {
  const ids = new Map<Module, string>();
  const owners = new Map<string, Module>();
  for (const module of modules) {
    const id = `${MODULE_SECTIONS}${module.path === "." ? "root" : module.path.replaceAll("/", "-")}`;
    const owner = owners.get(id);
    if (owner) throw new Error(`Modules ${owner.path} and ${module.path} would share the Section ${id}`);
    owners.set(id, module);
    ids.set(module, id);
  }
  return ids;
}
