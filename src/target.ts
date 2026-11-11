import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CodeSymbol, type ModuleImport, typescriptAnalyser } from "./analyser.ts";
import { CONFIG_FILE, type Config, loadConfig } from "./config.ts";
import { contentHash } from "./hash.ts";
import { loadManifest, type Manifest, type SectionRecord } from "./manifest.ts";
import { detectModules, type Module } from "./modules.ts";

/**
 * Evidence about the Target repo as a whole, which Overview and Architecture
 * cite directly instead of the Module Sections they are built from (ADR-0005).
 */
export interface RepoEvidence {
  id: string;
  /** How a citation names it. */
  label: string;
  text: string;
  /** Hash of `text`. */
  hash: string;
  /** Repo-relative file it is read from, and the lines it spans, if it is a file's content. */
  file?: string;
  startLine?: number;
  endLine?: number;
}

/** One concrete item a Claim can cite: a code symbol, or Evidence about the repo as a whole. */
export type Evidence = CodeSymbol | RepoEvidence;

export function isCodeSymbol(evidence: Evidence): evidence is CodeSymbol {
  return "exportedAs" in evidence;
}

/** Sections written after the Module Sections, from them and the repo-wide Evidence (ADR-0005). */
export const TOP_LEVEL_SECTIONS = ["overview", "architecture"] as const;
export type TopLevelSection = (typeof TOP_LEVEL_SECTIONS)[number];

/** What a Section is written about: one Module, or the repo as a whole. */
export type Subject = Module | TopLevelSection;

/** A Target repo as every command that reads its Guide sees it. */
export interface Target {
  config: Config;
  modules: Module[];
  /** Each Module's Section id, which is also its file's path in the Guide, without the extension. */
  sectionIds: Map<Module, string>;
  symbols: CodeSymbol[];
  /** Evidence about the repo as a whole, by id. */
  repoEvidence: Map<string, RepoEvidence>;
  manifest: Manifest;
}

/** Loads the config, resolves the Modules, analyses their code and loads the manifest. */
export async function openTarget(repoDir: string): Promise<Target> {
  const config = await loadConfig(repoDir);
  if (!config) throw new Error(`no ${CONFIG_FILE} here; run scribe init first`);
  const modules = config.modules ?? (await detectModules(repoDir));
  const sectionIds = uniqueSectionIds(modules);
  const { symbols, imports } = await typescriptAnalyser.analyse(repoDir, modules);
  const repoEvidence = await repoEvidenceOf(repoDir, modules, imports);
  const manifest = await loadManifest(repoDir);
  return { config, modules, sectionIds, symbols, repoEvidence, manifest };
}

/** Every Section's subject in the order `generate` writes them: Module Sections first, then the top-level ones (ADR-0005). */
export function subjects(target: Target): Subject[] {
  return [...target.modules, ...TOP_LEVEL_SECTIONS];
}

export function sectionIdOf(target: Target, subject: Subject): string {
  return typeof subject === "string" ? subject : target.sectionIds.get(subject)!;
}

/** Every piece of Evidence a Section could cite, as the Target repo is now. */
export function allEvidence(target: Target): Evidence[] {
  return [...target.symbols, ...target.repoEvidence.values()];
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

/** Ids of the Evidence a Section cites that has changed or no longer exists; the Section is Stale if any. */
export function changedEvidence(record: SectionRecord, evidence: Evidence[]): string[] {
  const hashes = new Map(evidence.map((e) => [e.id, e.hash]));
  return record.evidence.filter(({ id, hash }) => hashes.get(id) !== hash).map(({ id }) => id);
}

/** A Section file's content, or undefined if it doesn't exist. */
export async function readSection(repoDir: string, path: string): Promise<string | undefined> {
  const file = join(repoDir, path);
  return existsSync(file) ? await readFile(file, "utf8") : undefined;
}

const MODULE_SECTIONS = "modules/";

/** Whether a Section is a Module's, rather than a top-level one. */
export function isModuleSection(section: string): boolean {
  return section.startsWith(MODULE_SECTIONS);
}

/** Whether a recorded Section belongs to a Module that no longer exists; top-level Sections never do. */
export function isRemovedModuleSection({ sectionIds }: Target, section: string): boolean {
  return isModuleSection(section) && ![...sectionIds.values()].includes(section);
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

/** The Module list, the import graph between Modules, and the root package.json if there is one. */
async function repoEvidenceOf(repoDir: string, modules: Module[], imports: ModuleImport[]): Promise<Map<string, RepoEvidence>> {
  const items: Omit<RepoEvidence, "hash">[] = [
    {
      id: "graph:modules",
      label: "Modules of the repo",
      text: modules.map((m) => `${m.name} (${m.path})`).join("\n"),
    },
    {
      id: "graph:imports",
      label: "Import graph between Modules",
      text: imports.length > 0 ? imports.map(({ from, to }) => `${from} imports ${to}`).join("\n") : "No Module imports another.",
    },
  ];
  const packageJson = join(repoDir, "package.json");
  if (existsSync(packageJson)) {
    const text = (await readFile(packageJson, "utf8")).replace(/\r\n?/g, "\n");
    items.push({ id: "file:package.json", label: "package.json", text, file: "package.json", startLine: 1, endLine: text.trimEnd().split("\n").length });
  }
  return new Map(items.map((item) => [item.id, { ...item, hash: contentHash(item.text) }]));
}
