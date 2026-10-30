import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Node, Project, type SourceFile, ts } from "ts-morph";
import { contentHash } from "./hash.ts";
import { listProductCode, type Module, moduleOf } from "./modules.ts";

/** A top-level declaration in Product code: the unit code Evidence is anchored to (ADR-0004). */
export interface CodeSymbol {
  /** `<file>#<name>`, stable across moves within the file. */
  id: string;
  name: string;
  /** Repo-relative, forward-slashed path of the declaring file. */
  file: string;
  /** Path of the innermost Module containing the file. */
  module: string;
  /** Names the declaring file exports it under; empty if it isn't exported. */
  exportedAs: string[];
  /** The symbol's own text, line endings normalised. */
  text: string;
  /** Hash of `text`. */
  hash: string;
  /** 1-based lines the symbol spans in the file as it is now. */
  startLine: number;
  endLine: number;
}

export interface Analysis {
  symbols: CodeSymbol[];
  /** Each Module's exported symbols, keyed by Module path. */
  publicSurface: Record<string, CodeSymbol[]>;
  /** Module-to-Module dependencies by Module path, deduplicated and sorted. */
  imports: ModuleImport[];
}

export interface ModuleImport {
  from: string;
  to: string;
}

/** Per-language code analysis (ADR-0004); v1 has only the TypeScript/JavaScript one. */
export interface LanguageAnalyser {
  analyse(repoDir: string, modules: Module[]): Promise<Analysis>;
}

export const typescriptAnalyser: LanguageAnalyser = {
  async analyse(repoDir, modules) {
    const project = new Project({
      compilerOptions: COMPILER_OPTIONS,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    const files = new Map<SourceFile, { file: string; module: Module }>();
    for (const file of listProductCode(repoDir)) {
      const module = moduleOf(file, modules);
      if (module) files.set(project.addSourceFileAtPath(join(repoDir, file)), { file, module });
    }

    const symbols: CodeSymbol[] = [];
    for (const [sourceFile, { file, module }] of files) {
      symbols.push(...symbolsOf(file, module, sourceFile));
    }

    const publicSurface: Record<string, CodeSymbol[]> = {};
    for (const module of modules) publicSurface[module.path] = [];
    for (const symbol of symbols) {
      if (symbol.exportedAs.length > 0) publicSurface[symbol.module]!.push(symbol);
    }

    const resolve = await moduleResolver(repoDir, modules, project, files);
    const targets = new Map<string, Set<string>>();
    for (const [sourceFile, { module }] of files) {
      for (const literal of sourceFile.getImportStringLiterals()) {
        const target = resolve(literal.getLiteralValue(), sourceFile);
        if (!target || target === module) continue;
        targets.set(module.path, (targets.get(module.path) ?? new Set()).add(target.path));
      }
    }
    const imports = [...targets.keys()].sort().flatMap((from) =>
      [...targets.get(from)!].sort().map((to) => ({ from, to })),
    );

    return { symbols, publicSurface, imports };
  },
};

const COMPILER_OPTIONS = {
  allowJs: true,
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
};

/**
 * Finds the Module an import specifier points into. A specifier naming a
 * Module's package (as workspace imports do) points at that Module even when
 * no dependencies are installed; anything else is resolved like a bundler.
 */
async function moduleResolver(
  repoDir: string,
  modules: Module[],
  project: Project,
  files: Map<SourceFile, { module: Module }>,
): Promise<(specifier: string, from: SourceFile) => Module | undefined> {
  const packages = new Map<string, Module>();
  for (const module of modules) {
    const name = await packageName(join(repoDir, module.path));
    if (name) packages.set(name, module);
  }
  const host = project.getModuleResolutionHost();

  return (specifier, from) => {
    const packageMatch = [...packages].find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
    if (packageMatch) return packageMatch[1];

    const { resolvedModule } = ts.resolveModuleName(specifier, from.getFilePath(), COMPILER_OPTIONS, host);
    const target = resolvedModule && project.getSourceFile(resolvedModule.resolvedFileName);
    return target && files.get(target)?.module;
  };
}

async function packageName(dir: string): Promise<string | undefined> {
  try {
    const { name } = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The file's top-level declarations by name. Overloads and merged
 * declarations sharing a name form one symbol.
 */
function symbolsOf(file: string, module: Module, sourceFile: SourceFile): CodeSymbol[] {
  const exportNames = new Map<Node, string[]>();
  for (const [exportName, nodes] of sourceFile.getExportedDeclarations()) {
    for (const node of nodes) exportNames.set(node, [...(exportNames.get(node) ?? []), exportName]);
  }
  const grouped = new Map<string, { texts: string[]; exportedAs: Set<string>; startLine: number; endLine: number }>();
  for (const [name, text, node, statement] of declarationsOf(sourceFile)) {
    const group = grouped.get(name) ?? {
      texts: [],
      exportedAs: new Set(),
      startLine: statement.getStartLineNumber(true),
      endLine: 0,
    };
    group.texts.push(text);
    group.endLine = statement.getEndLineNumber();
    const names = Node.isExportAssignment(node) ? ["default"] : (exportNames.get(node) ?? []);
    for (const exportName of names) group.exportedAs.add(exportName);
    grouped.set(name, group);
  }
  return [...grouped].map(([name, { texts, exportedAs, startLine, endLine }]) => {
    const text = texts.join("\n").replace(/\r\n?/g, "\n");
    return {
      id: `${file}#${name}`,
      name,
      file,
      module: module.path,
      exportedAs: [...exportedAs],
      text,
      hash: contentHash(text),
      startLine,
      endLine,
    };
  });
}

/**
 * [name, text, node, statement] for each top-level declaration; the text
 * includes its doc comment but not other leading comments.
 */
function* declarationsOf(sourceFile: SourceFile): Generator<[string, string, Node, Node]> {
  for (const statement of sourceFile.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      // Each declaration hashes alone, but keeps what it shares with its siblings: `export`, `const`.
      const modifiers = statement.getModifiers().map((m) => `${m.getText()} `).join("");
      const prefix = `${docText(statement)}${modifiers}${statement.getDeclarationKind()} `;
      for (const declaration of statement.getDeclarations()) {
        yield [declaration.getName(), prefix + declaration.getText(), declaration, statement];
      }
    } else if (Node.isExportAssignment(statement)) {
      yield ["default", statement.getText(), statement, statement];
    } else if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement) ||
      Node.isModuleDeclaration(statement)
    ) {
      const name = statement.getName() ?? "default";
      yield [name, docText(statement) + statement.getText(), statement, statement];
    }
  }
}

function docText(node: Node): string {
  return Node.isJSDocable(node) ? node.getJsDocs().map((doc) => `${doc.getText()}\n`).join("") : "";
}
