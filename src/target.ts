import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type CodeSymbol, type ModuleImport, typescriptAnalyser } from "./analyser.ts";
import { CONFIG_FILE, type Config, loadConfig } from "./config.ts";
import { CONVENTIONS, lintConfigEvidence } from "./conventions.ts";
import { type DocEvidence, readDocs } from "./docs.ts";
import { GETTING_STARTED, type SetupEvidence, setupEvidence } from "./getting-started.ts";
import { type ChurnEvidence, churnEvidence } from "./git-history.ts";
import type { FileEvidence, RepoEvidence } from "./evidence.ts";
import { isGitHubEvidence } from "./github.ts";
import { contentHash } from "./hash.ts";
import { KEY_DECISIONS } from "./key-decisions.ts";
import { loadManifest, type Manifest, type SectionRecord } from "./manifest.ts";
import { detectModules, type Module } from "./modules.ts";

export const OVERVIEW = "overview";
export const ARCHITECTURE = "architecture";
/** Written after the Module Sections, from them and the repo-wide Evidence (ADR-0005). */
export const BOTTOM_UP_SECTIONS = [OVERVIEW, ARCHITECTURE];

/** A Target repo as every command that reads its Guide sees it. */
export interface Target {
  config: Config;
  modules: Module[];
  /** Each Module's Section id, which is also its file's path in the Guide, without the extension. */
  sectionIds: Map<Module, string>;
  symbols: CodeSymbol[];
  /** Each Module's churn Evidence, keyed by Module path; empty without git history. */
  churn: Map<string, ChurnEvidence>;
  /** The repo's existing docs, which Sections can cite but Scribe never edits. */
  docs: DocEvidence[];
  /** The scripts, CI steps and doc shell blocks the Getting started Section is written from. */
  setup: SetupEvidence[];
  /** The lint and format config files the Conventions Section is written from, among other Evidence. */
  lintConfig: FileEvidence[];
  /** Evidence about the repo as a whole, by id. */
  repoEvidence: Map<string, RepoEvidence>;
  manifest: Manifest;
}

/** Loads the config, resolves the Modules, analyses their code, setup Evidence and existing docs, and loads the manifest. */
export async function openTarget(repoDir: string): Promise<Target> {
  const config = await loadConfig(repoDir);
  if (!config) throw new Error(`no ${CONFIG_FILE} here; run scribe init first`);
  const modules = config.modules ?? (await detectModules(repoDir));
  const sectionIds = uniqueSectionIds(modules);
  const { symbols, imports } = await typescriptAnalyser.analyse(repoDir, modules);
  const churn = churnEvidence(repoDir, modules);
  const setup = await setupEvidence(repoDir, config.guideDir);
  const docs = await readDocs(repoDir, config.guideDir);
  const lintConfig = await lintConfigEvidence(repoDir, config.guideDir);
  const repoEvidence = await repoEvidenceOf(repoDir, modules, imports);
  const manifest = await loadManifest(repoDir);
  return { config, modules, sectionIds, symbols, churn, setup, docs, lintConfig, repoEvidence, manifest };
}

/**
 * Every Section the Guide should have, in the order they are written: one per
 * Module, Getting started, Conventions, Key decisions, then Overview and
 * Architecture, which are built from the Module Sections (ADR-0005).
 */
export function guideSections({ sectionIds }: Target): string[] {
  return [...sectionIds.values(), GETTING_STARTED, CONVENTIONS, KEY_DECISIONS, ...BOTTOM_UP_SECTIONS];
}

/** Every piece of Evidence a Section could cite that Scribe can see change without the network, as it is now. */
export function allEvidence({ symbols, churn, setup, docs, lintConfig, repoEvidence }: Target): (FileEvidence | ChurnEvidence | RepoEvidence)[] {
  return [...symbols, ...churn.values(), ...setup, ...docs, ...lintConfig, ...repoEvidence.values()];
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
 * checks its Drift again. GitHub Evidence never counts: `status` makes no
 * network calls, so it can't see GitHub change.
 */
export function changedEvidence(record: SectionRecord, evidence: { id: string; hash: string }[]): string[] {
  const hashes = new Map(evidence.map((e) => [e.id, e.hash]));
  const cited = [...record.evidence, ...(record.drift ?? []).flatMap((d) => [...d.docs, ...d.code])];
  return [...new Set(cited.filter(({ id, hash }) => !isGitHubEvidence(id) && hashes.get(id) !== hash).map(({ id }) => id))];
}

/** A Section file's content, or undefined if it doesn't exist; throws, naming it, if it can't be read. */
export async function readSection(repoDir: string, path: string): Promise<string | undefined> {
  const file = join(repoDir, path);
  if (!existsSync(file)) return undefined;
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`can't read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Throws unless `section` is one of the Guide's Sections, such as one whose
 * Module was removed; returns the Module whose Section it is, if any.
 */
export function guideSection(target: Target, section: string): Module | undefined {
  if (!guideSections(target).includes(section)) {
    throw new Error(`no Module has the Section ${section}; the Sections are ${guideSections(target).join(", ")}`);
  }
  return [...target.sectionIds].find(([, id]) => id === section)?.[0];
}

/** Whether a Section cites GitHub Evidence: a Module's Section, whose Module is `module`, or Key decisions. */
export function drawsOnGitHub(section: string, module: Module | undefined): boolean {
  return module !== undefined || section === KEY_DECISIONS;
}

/** Deletes a Section's pending Proposal; returns its repo-relative path, or undefined if there was none. */
export async function clearProposal(repoDir: string, config: Config, section: string): Promise<string | undefined> {
  const path = proposalPath(config, section);
  if (!existsSync(join(repoDir, path))) return undefined;
  await rm(join(repoDir, path));
  return path;
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
      kind: "repo",
      id: "graph:modules",
      label: "Modules of the repo",
      text: modules.map((m) => `${m.name} (${m.path})`).join("\n"),
    },
    {
      kind: "repo",
      id: "graph:imports",
      label: "Import graph between Modules",
      text: imports.length > 0 ? imports.map(({ from, to }) => `${from} imports ${to}`).join("\n") : "No Module imports another.",
    },
  ];
  const packageJson = join(repoDir, "package.json");
  if (existsSync(packageJson)) {
    const text = (await readFile(packageJson, "utf8")).replace(/\r\n?/g, "\n");
    const source = { file: "package.json", startLine: 1, endLine: text.trimEnd().split("\n").length };
    items.push({ kind: "repo", id: "file:package.json", label: "package.json", text, source });
  }
  return new Map(items.map((item) => [item.id, { ...item, hash: contentHash(item.text) }]));
}
