import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CodeSymbol, typescriptAnalyser } from "./analyser.ts";
import { CONFIG_FILE, type Config, loadConfig } from "./config.ts";
import { type DocEvidence, readDocs } from "./docs.ts";
import { loadManifest, type Manifest, type SectionRecord } from "./manifest.ts";
import { detectModules, type Module } from "./modules.ts";

/** A Target repo as every command that reads its Guide sees it. */
export interface Target {
  config: Config;
  modules: Module[];
  /** Each Module's Section id, which is also its file's path in the Guide, without the extension. */
  sectionIds: Map<Module, string>;
  symbols: CodeSymbol[];
  /** The repo's existing docs, which Sections can cite but Scribe never edits. */
  docs: DocEvidence[];
  manifest: Manifest;
}

/** Loads the config, resolves the Modules, analyses their code and loads the manifest. */
export async function openTarget(repoDir: string): Promise<Target> {
  const config = await loadConfig(repoDir);
  if (!config) throw new Error(`no ${CONFIG_FILE} here; run scribe init first`);
  const modules = config.modules ?? (await detectModules(repoDir));
  const sectionIds = uniqueSectionIds(modules);
  const { symbols } = await typescriptAnalyser.analyse(repoDir, modules);
  const docs = await readDocs(repoDir, config.guideDir);
  const manifest = await loadManifest(repoDir);
  return { config, modules, sectionIds, symbols, docs, manifest };
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
 * Ids of the Evidence a Section or its Drift cites whose text has changed or
 * which no longer exists; the Section is Stale if any, so that rewriting it
 * checks its Drift again.
 */
export function changedEvidence(record: SectionRecord, { symbols, docs }: Pick<Target, "symbols" | "docs">): string[] {
  const hashes = new Map([...symbols, ...docs].map((e) => [e.id, e.hash]));
  const cited = [...record.evidence, ...(record.drift ?? []).flatMap((d) => [...d.docs, ...d.code])];
  return [...new Set(cited.filter(({ id, hash }) => hashes.get(id) !== hash).map(({ id }) => id))];
}

/** A Section file's content, or undefined if it doesn't exist. */
export async function readSection(repoDir: string, path: string): Promise<string | undefined> {
  const file = join(repoDir, path);
  return existsSync(file) ? await readFile(file, "utf8") : undefined;
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
