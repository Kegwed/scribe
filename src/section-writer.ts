import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CodeSymbol, isCode } from "./analyser.ts";
import { citation, citingIds, githubPermalinks, historyCitation, uncommittedWarnings, withoutChurn, withoutCitations, withoutPins, withoutStatement } from "./citations.ts";
import { modelsOf } from "./config.ts";
import { CONVENTIONS, conventionsEvidence, hasConventions } from "./conventions.ts";
import { docsAbout, isDoc } from "./docs.ts";
import { DRIFT_SCHEMA, DRIFT_SYSTEM, driftPrompt, parseDrift, VERIFY_DRIFT_SYSTEM } from "./drift.ts";
import { attachRequest as attachCost, driftSearch, expectedProseChars, type ExpectedRequests, expectedVerification, expectedWrite, sectionCost, type SectionCost, summaryRequest, uncitedVerdict, unwrittenVerdict, verdicts } from "./estimate.ts";
import { type Evidence, inFile, isRepoEvidence } from "./evidence.ts";
import { ASSUMED_SUMMARY, finishFit, type FitPlan, type FittedPrompt, keepCodeRank, parseSummary, planFit, summaryRequests, wholeFit } from "./fit.ts";
import { GETTING_STARTED, unmatchedCommands } from "./getting-started.ts";
import { type ChurnEvidence, isChurnEvidence } from "./git-history.ts";
import { type Discussions, NO_DISCUSSIONS } from "./github.ts";
import { contentHash } from "./hash.ts";
import { ATTACH_SCHEMA, ATTACH_SYSTEM, attachPrompt, humanClaims, parseAttachments } from "./human-claims.ts";
import { decisionRecords, KEY_DECISIONS, KEY_DECISIONS_SYSTEM, VERIFY_DECISIONS_SYSTEM } from "./key-decisions.ts";
import { completeCached, CutOff, isCached, type Llm, type LlmRequest, readCached } from "./llm.ts";
import { type DriftRecord, type DriftReport, saveManifest } from "./manifest.ts";
import type { Module } from "./modules.ts";
import { BOTTOM_UP, bottomUpPrompt, type Claim, CONVENTIONS_SYSTEM, type EvidenceName, GETTING_STARTED_SYSTEM, parseSection, parseVerdict, PIECES, renderModuleEvidence, renderRepo, renderSetup, repairPrompt, revisionPrompt, SECTION_DISCUSSION, SECTION_SYSTEM, sectionPrompt, type SectionResponse, SUMMARISED_NOTE, VERDICT_SCHEMA, VERIFY_CONVENTIONS_SYSTEM, VERIFY_DISCUSSION, VERIFY_DOCS, VERIFY_REPO_SYSTEM, VERIFY_SETUP_SYSTEM, VERIFY_SYSTEM, verifyPrompt, writeRequest } from "./prompts.ts";
import { ARCHITECTURE, OVERVIEW, proposalPath, readSection, sectionPath, type Target } from "./target.ts";

export interface WriteReport {
  /** Claims still unconfirmed after the Section's repair, left out of their Sections (ADR-0001). */
  droppedClaims: { section: string; text: string; reason: string; /** Dropped from the Section's Proposal, not the Section. */ proposal?: true }[];
  /**
   * For each Section or Proposal written, how many Claims were first written,
   * how many of those the verifier confirmed before any repair, and how many
   * were kept once any repair was verified.
   */
  verifiedClaims: { section: string; written: number; confirmed: number; kept: number; /** Counts the Section's Proposal. */ proposal?: true }[];
  /** Sections left untouched, without a Proposal, because a human has edited them (ADR-0002). */
  frozen: string[];
  /**
   * Sections whose Evidence was too large for one writing request, with the ids
   * of the symbols sent as summaries and of the Evidence left out. Claims still
   * cite and are verified against the Evidence itself.
   */
  reduced: { section: string; summarised: string[]; leftOut: string[]; /** Reduced for the Section's Proposal. */ proposal?: true }[];
  /** Problems the maintainer should fix by hand. */
  warnings: string[];
  /** Where existing docs contradict the code, as the manifest records it once the run is done; Scribe leaves the docs as they are. */
  drift: DriftReport[];
}

export function emptyReport(): WriteReport {
  return { droppedClaims: [], verifiedClaims: [], frozen: [], reduced: [], warnings: [], drift: [] };
}

export interface SectionWriter {
  /**
   * What `write` (or `propose`, given no `existing`) is expected to cost for a
   * Section: its summaries, Drift search, first write, a verdict per expected
   * Claim, and the repair some failed Claim is likely to call for, with that
   * repair's verdicts. Overview and Architecture are estimated from the Module
   * Sections as they are now, or as long as expected where none is written
   * yet; `moduleSectionsChange` says those will be rewritten first, so their
   * write is not the cached one.
   */
  estimate(section: string, existing: string | undefined, changedEvidence?: string[], moduleSectionsChange?: boolean): SectionCost;
  /**
   * Writes a Section (a Module's, Getting started, Overview or Architecture),
   * each Claim citing the Evidence it rests on and verified against it, and
   * records it in the manifest. Overview and Architecture are written from the
   * Module Sections as they are on disk, but cite only the repo-wide Evidence
   * they draw on directly (ADR-0005). With `changedEvidence`, revises the
   * Section's `existing` text instead, keeping what those changes don't
   * affect. Never checks whether the Section is Frozen.
   */
  write(section: string, existing: string | undefined, changedEvidence?: string[]): Promise<void>;
  /**
   * Writes a Proposal for a Frozen Section: the Section written afresh from
   * its Evidence and verified like any other, beside the Section's file and
   * never recorded in the manifest (ADR-0002). Returns its repo-relative path.
   */
  propose(section: string): Promise<string>;
  /**
   * Records a human's `content` as a Section without changing it: each of its
   * Claims gets the Evidence the verifier confirms backs it, and the rest are
   * recorded as Unsupported Claims, which it returns (ADR-0002).
   */
  adopt(section: string, content: string): Promise<string[]>;
  /**
   * What `adopt` would cost for `content`: finding its Claims' Evidence, one
   * verdict per Claim and the Drift search; cached requests cost nothing. Until
   * the Evidence is found, each verdict is estimated without the Evidence it
   * will carry, so the estimate understates it.
   */
  estimateAdopt(section: string, content: string): SectionCost;
}

/** What a Section is written from, and how its prompts present that Evidence. */
interface Subject {
  title: string;
  /** All of its Evidence, in the order its prompts present it. */
  items: Evidence[];
  evidence: Map<string, Evidence>;
  /** The writing model's system text for a request carrying `sent`, some of it summarised if `summarised`. */
  system(sent: Evidence[], summarised: boolean): string;
  /** The verifier's system text for a Claim citing `cited`. */
  verifySystem(cited: Evidence[]): string;
  /** The prompt that writes the Section afresh from its Evidence, each piece already rendered. */
  frame(rendered: string[]): string;
  render(evidence: Evidence): string;
  /** What its Evidence is called in revision and repair prompts. */
  evidenceName: EvidenceName;
  /** Why a Claim citing none of `evidence` fails. */
  uncited: string;
  /** Why a Claim fails before any model sees it, or undefined; deterministic. */
  check?(claim: Claim): string | undefined;
  /** Whether `sent` is enough to ask for the Section; otherwise it is written bare, without the LLM. */
  worthAsking(sent: Evidence[]): boolean;
  /** A Module's churn Evidence, from which Scribe writes the Section's last Claim itself. */
  churn?: ChurnEvidence;
}

/** Docs alone don't make a Module's Section or Getting started: they are cited only alongside what they describe. */
function notDocsAlone(sent: Evidence[]): boolean {
  return !sent.every(isDoc);
}

/**
 * Writes Sections with `llm`. `discussions` holds the GitHub Evidence each
 * Module Section draws on alongside its code symbols, and that Key decisions
 * draws on alongside the ADRs.
 */
export function sectionWriter(
  repoDir: string,
  target: Target,
  llm: Llm,
  report: WriteReport,
  discussions: Discussions = NO_DISCUSSIONS,
): SectionWriter {
  const { config, sectionIds, symbols, churn, setup, docs, repoEvidence, manifest } = target;
  const permalinks = githubPermalinks(repoDir);
  const modules = new Map([...sectionIds].map(([module, section]) => [section, module]));
  const models = modelsOf(config);

  /** Each Module Section's prose as it is on disk now, without its citations, which pin to a commit and would churn the request. */
  function moduleSections(): { module: Module; text: string }[] {
    return target.modules.flatMap((module) => {
      const file = join(repoDir, sectionPath(config, sectionIds.get(module)!));
      return existsSync(file) ? [{ module, text: withoutCitations(readFileSync(file, "utf8")) }] : [];
    });
  }

  /** What a Section is written from, but its Evidence by id; a prompt that writes it afresh joins its rendered Evidence unless it says otherwise. */
  type SubjectSpec = Omit<Subject, "evidence" | "frame"> & Partial<Pick<Subject, "frame">>;

  /**
   * Each Module Section as Overview and Architecture will be written from it,
   * for an estimate: as it is on disk, or, not yet written, as long as the
   * prose of the Claims its write is expected to make.
   */
  function expectedModuleSections(): { module: Module; text: string }[] {
    const written = new Map(moduleSections().map((s) => [s.module, s.text]));
    return target.modules.map((module) => {
      const text = written.get(module);
      if (text !== undefined) return { module, text };
      if (!placeholderTexts.has(module)) {
        const section = sectionIds.get(module)!;
        const about = subject(section);
        const { fitted, request } = plannedWrite(section, about, undefined, undefined);
        const chars = about.worthAsking(fitted.sent) ? expectedProseChars(request) : 0;
        // Text, not just its length: Overview's and Architecture's prompts are fitted to the prompt limit around it.
        placeholderTexts.set(module, `# ${about.title}\n\n${"x".repeat(chars)}\n`);
      }
      return { module, text: placeholderTexts.get(module)! };
    });
  }
  /** The text `expectedModuleSections` assumes for each Module Section not yet written, worked out once. */
  const placeholderTexts = new Map<Module, string>();

  function bottomUpSubject(section: string, expected: boolean): SubjectSpec {
    const { title, system, evidence: ids } = BOTTOM_UP[section]!;
    return {
      title,
      items: ids.flatMap((id) => repoEvidence.get(id) ?? []),
      // Repo-wide Evidence is never code, so it is never summarised.
      system: () => system,
      verifySystem: () => VERIFY_REPO_SYSTEM,
      frame: (rendered) => bottomUpPrompt(title, expected ? expectedModuleSections() : moduleSections(), rendered),
      render: renderRepo,
      evidenceName: { one: "Evidence item", many: "Evidence items" },
      uncited: `cites no Evidence ${title} draws on directly`,
      worthAsking: notDocsAlone,
    };
  }

  /** Each top-level Section's Subject, by Section id, `expected` for an estimate; any other Section is a Module's. */
  const topLevel: Record<string, (expected: boolean) => SubjectSpec> = {
    [GETTING_STARTED]: () => ({
      title: "Getting started",
      items: setup,
      // Setup Evidence is never code, so it is never summarised.
      system: () => GETTING_STARTED_SYSTEM,
      verifySystem: () => VERIFY_SETUP_SYSTEM,
      render: renderSetup,
      evidenceName: PIECES,
      uncited: "cites no script, CI step or doc",
      worthAsking: notDocsAlone,
      check({ text }) {
        const unmatched = unmatchedCommands(text, setup);
        if (unmatched.length === 0) return undefined;
        return `names ${unmatched.map((c) => `\`${c}\``).join(", ")}, which no package.json script, CI workflow step or existing doc runs`;
      },
    }),
    [CONVENTIONS]: () => ({
      title: "Conventions",
      items: conventionsEvidence(target),
      worthAsking: hasConventions,
      system: (_, summarised) => (summarised ? `${CONVENTIONS_SYSTEM}\n\n${SUMMARISED_NOTE}` : CONVENTIONS_SYSTEM),
      verifySystem: () => VERIFY_CONVENTIONS_SYSTEM,
      render: renderModuleEvidence,
      evidenceName: PIECES,
      uncited: "cites no lint or format config, code or CONTRIBUTING passage",
    }),
    [KEY_DECISIONS]: () => ({
      title: "Key decisions",
      // The ADRs, then the discussion on the repo's highest-ranked pull requests, as spec #1's Generation order decides.
      items: [...decisionRecords(docs), ...discussions.decisions],
      // Written from the ADRs and pull request threads alone: docs are this Section's own Evidence.
      worthAsking: (sent) => sent.length > 0,
      system: () => KEY_DECISIONS_SYSTEM,
      verifySystem: () => VERIFY_DECISIONS_SYSTEM,
      render: renderModuleEvidence,
      evidenceName: PIECES,
      uncited: "cites no ADR or pull request thread",
    }),
    [OVERVIEW]: (expected) => bottomUpSubject(OVERVIEW, expected),
    [ARCHITECTURE]: (expected) => bottomUpSubject(ARCHITECTURE, expected),
  };

  /** What a Section is written from; `expected` for an estimate, before Module Sections it is built from are written. */
  function subject(section: string, expected = false): Subject {
    const spec = Object.hasOwn(topLevel, section) ? topLevel[section]!(expected) : moduleSubject(section);
    return { frame: (rendered) => rendered.join("\n\n"), ...spec, evidence: new Map(spec.items.map((e) => [e.id, e])) };
  }

  function moduleSubject(section: string): SubjectSpec {
    const module = moduleOf(section);
    // A Module's code symbols, then its GitHub Evidence, then the passages of existing docs about it.
    const discussion = discussions.byModule.get(module.path) ?? [];
    return {
      title: module.name,
      items: [...moduleSymbols(module), ...discussion, ...docsAbout(module, symbols, docs)],
      // Told about GitHub discussion and summaries only when the request carries them, so requests without stay as recorded.
      system: (sent, summarised) => [
        SECTION_SYSTEM,
        ...(sent.some((e) => e.kind === "github") ? [SECTION_DISCUSSION] : []),
        ...(summarised ? [SUMMARISED_NOTE] : []),
      ].join("\n\n"),
      // Told about docs and discussion only when the Claim cites them, so other verdicts stay as recorded.
      verifySystem: (cited) => [
        VERIFY_SYSTEM,
        ...(cited.some(isDoc) ? [VERIFY_DOCS] : []),
        ...(cited.some((e) => e.kind === "github") ? [VERIFY_DISCUSSION] : []),
      ].join("\n\n"),
      frame: (rendered) => sectionPrompt(module, rendered),
      render: renderModuleEvidence,
      evidenceName: { one: "symbol", many: "symbols" },
      uncited: "cites no Evidence from this Module",
      worthAsking: notDocsAlone,
      churn: churn.get(module.path),
    };
  }

  function moduleOf(section: string): Module {
    const module = modules.get(section);
    if (!module) throw new Error(`no Section ${section} in this Guide`);
    return module;
  }

  function moduleSymbols(module: Module): CodeSymbol[] {
    return symbols.filter((s) => s.module === module.path);
  }

  /**
   * The request that searches a Module's docs for Drift, fitted to one request
   * by leaving out its largest code first, with what it left out; undefined if
   * the Section isn't a Module's, or no doc about the Module or none of its code fits.
   */
  function driftRequest(section: string): { request: LlmRequest; leftOut: string[] } | undefined {
    if (!modules.has(section)) return undefined;
    const module = moduleOf(section);
    const about = docsAbout(module, symbols, docs);
    const { prompt, sent, leftOut } = wholeFit(
      [...moduleSymbols(module), ...about],
      renderModuleEvidence,
      (rendered) => driftPrompt(module, rendered),
      llm.promptLimit,
      // Both sides are needed, and a doc passage is usually the smaller.
      (e) => (isDoc(e) ? 2 : isCode(e) && e.exportedAs.length > 0 ? 1 : 0),
    );
    if (!sent.some(isCode) || !sent.some(isDoc)) return undefined;
    return { request: { kind: "drift", model: models.summarise, system: DRIFT_SYSTEM, prompt, schema: DRIFT_SCHEMA }, leftOut };
  }

  /**
   * Where the docs about a Module contradict its code, each contradiction
   * confirmed by the verifier against both sides. Sections no doc concerns
   * cost nothing.
   */
  async function findDrift(section: string): Promise<DriftRecord[]> {
    const search = driftRequest(section);
    if (!search) return [];
    const { request, leftOut } = search;
    if (leftOut.length > 0) report.warnings.push(`The Drift search for ${section} left out ${leftOut.join(", ")} to fit one request.`);
    const { drift: found } = await completeCached(llm, repoDir, request, parseDrift);

    const about = subject(section);
    const { evidence } = about;
    const evidenceIs = (id: string, kind: (e: Evidence) => boolean) => { const e = evidence.get(id); return e !== undefined && kind(e); };
    const sided = found.filter(({ docs, code }) =>
      docs.length > 0 && code.length > 0 && docs.every((id) => evidenceIs(id, isDoc)) && code.every((id) => evidenceIs(id, isCode)));
    const claims = sided.map(({ description, docs, code }) => ({ text: description, evidence: [...docs, ...code] }));
    const failures = await verifySection(llm, models.verify, repoDir, { paragraphs: [{ claims }] }, driftVerifier(about));

    const record = (ids: string[]) => [...new Set(ids)].map((id) => ({ id, hash: evidence.get(id)!.hash }));
    return sided.flatMap(({ description, docs, code }, i) =>
      failures.has(claims[i]!) ? [] : [{ description, docs: record(docs), code: record(code) }]);
  }

  /**
   * The Drift search of `section` for an estimate, with the verdicts on the
   * Drift it may find; nothing once it is cached, or for a Module no doc concerns.
   */
  function expectedDrift(section: string, about: Subject): ExpectedRequests[] {
    const search = driftRequest(section)?.request;
    if (!search || isCached(repoDir, search)) return [];
    const verdict = verdictFor(models.verify, { text: "", evidence: [] }, [], driftVerifier(about));
    return driftSearch(search, unwrittenVerdict(verdict, [...about.evidence.values()].map(about.render)));
  }

  /**
   * How the prompt a Section is first written from fits one request: a revision
   * of `existing` given `changedEvidence`, else written from scratch.
   */
  function planFirstWrite(section: string, about: Subject, existing: string | undefined, changedEvidence: string[] | undefined): FitPlan {
    const record = manifest.sections[section];
    const present = new Set(about.evidence.keys());
    // Scribe writes the churn Claim itself, so the model revises only the Claims it wrote, against their Evidence.
    const build = (rendered: string[]) => changedEvidence && existing !== undefined && record
      ? revisionPrompt(about.frame(rendered), present, {
        // An adopted Section's footnotes are a human's, which name no recorded Evidence.
        current: record.adopted
          ? withoutStatement(withoutCitations(existing), about.churn?.statement)
          : withoutChurn(citingIds(existing, record.evidence.map((e) => e.id))),
        cited: !record.adopted,
        changedEvidence: changedEvidence.filter((id) => !isChurnEvidence(id)),
        unsupported: record.unsupportedClaims ?? [],
        evidenceName: about.evidenceName,
      })
      : about.frame(rendered);
    return planFit(about.items, about.render, build, llm.promptLimit);
  }

  /** The Unsupported Claims a write of `section` keeps word for word: those of its record, if it revises the Section. */
  function keptUnsupported(section: string, existing: string | undefined, changedEvidence: string[] | undefined): Set<string> {
    const record = manifest.sections[section];
    return new Set(changedEvidence && existing !== undefined && record ? record.unsupportedClaims ?? [] : []);
  }

  /**
   * The first write of a Section as an estimate prices it, with the summaries
   * it needs that aren't cached. Until every summary is cached the write's
   * prompt is unknown, so it is estimated with summaries of the assumed length.
   */
  function plannedWrite(section: string, about: Subject, existing: string | undefined, changedEvidence: string[] | undefined) {
    const plan = planFirstWrite(section, about, existing, changedEvidence);
    const summaryCalls = summaryRequests(models.summarise, plan);
    const uncachedSummaries = summaryCalls.filter((request) => !isCached(repoDir, request));
    const fitted = finishFit(plan, uncachedSummaries.length > 0
      ? summaryCalls.map(() => ASSUMED_SUMMARY)
      : summaryCalls.map((request) => parseSummary(readCached(repoDir, request)!)));
    return { fitted, uncachedSummaries, request: writeRequestFor(about, fitted, fitted.prompt) };
  }

  function writeRequestFor(about: Subject, fitted: FittedPrompt, prompt: string): LlmRequest {
    return writeRequest(models.write, about.system(fitted.sent, fitted.summarised.length > 0), prompt);
  }

  /** A Section, verified, with the Evidence it cites; revised from `existing` given `changedEvidence`. */
  async function compose(section: string, existing: string | undefined, changedEvidence: string[] | undefined, proposal?: true) {
    // What the report says of this write: which Section, and whether it is for the Section's Proposal.
    const of = { section, ...(proposal ? { proposal } : {}) };
    const whole = subject(section);
    const plan = planFirstWrite(section, whole, existing, changedEvidence);
    const summaries = await Promise.all(summaryRequests(models.summarise, plan).map((request) =>
      completeCached(llm, repoDir, request, parseSummary)));
    const fitted = finishFit(plan, summaries);
    if (fitted.summarised.length > 0 || fitted.leftOut.length > 0) {
      const { summarised, leftOut } = fitted;
      report.reduced.push({ ...of, summarised, leftOut });
    }
    // Claims may cite only the Evidence the request carried, and are verified against its full text.
    const about: Subject = { ...whole, evidence: new Map(fitted.sent.map((e) => [e.id, e])) };
    const { evidence } = about;

    // A human's Unsupported Claims are kept word for word, uncited: no Evidence backs them, and Scribe never removes them (ADR-0001).
    const unsupported = keptUnsupported(section, existing, changedEvidence);
    const scribes = ({ paragraphs }: SectionResponse): SectionResponse =>
      ({ paragraphs: paragraphs.map(({ claims }) => ({ claims: claims.filter(({ text }) => !unsupported.has(text)) })) });
    const writeSection = (prompt: string) => completeCached(llm, repoDir, writeRequestFor(about, fitted, prompt), parseSection);
    const firstPrompt = fitted.prompt;
    let written: SectionResponse = about.worthAsking(fitted.sent) ? await writeSection(firstPrompt) : { paragraphs: [] };
    let failures = await verifySection(llm, models.verify, repoDir, scribes(written), about);
    const firstWritten = scribes(written).paragraphs.reduce((sum, p) => sum + p.claims.length, 0);
    const counts = { ...of, written: firstWritten, confirmed: firstWritten - failures.size, kept: 0 };
    report.verifiedClaims.push(counts);
    if (failures.size > 0) {
      written = await writeSection(repairPrompt(firstPrompt, written, failures, about.evidenceName));
      failures = await verifySection(llm, models.verify, repoDir, scribes(written), about);
    }
    const { paragraphs } = written;

    const cited = new Map<string, Evidence>();
    const body: string[] = [];
    const placed = new Set<string>();
    for (const { claims } of paragraphs) {
      const sentences: string[] = [];
      for (const claim of claims) {
        const { text, evidence: ids } = claim;
        if (unsupported.has(text)) {
          if (!placed.has(text)) sentences.push(text);
          placed.add(text);
          continue;
        }
        const reason = failures.get(claim);
        if (reason !== undefined) {
          report.droppedClaims.push({ ...of, text, reason });
          continue;
        }
        counts.kept++;
        const known = ids.filter((id) => evidence.has(id));
        for (const id of known) cited.set(id, evidence.get(id)!);
        const numbers = [...cited.keys()];
        sentences.push(text + [...new Set(known)].map((id) => `[^${numbers.indexOf(id) + 1}]`).join(""));
      }
      if (sentences.length > 0) body.push(sentences.join(" "));
    }
    // Those the revision left out go last, before the churn Claim, so none is lost.
    const unplaced = [...unsupported].filter((text) => !placed.has(text));
    if (unplaced.length > 0) body.push(unplaced.join(" "));

    const citedEvidence = [...cited.values()];
    const footnotes = citedEvidence.map((item, i) => `[^${i + 1}]: ${citation(item, permalinks)}`);
    const { churn: churnCited } = about;
    if (churnCited) {
      body.push(`${churnCited.statement}[^${footnotes.length + 1}]`);
      footnotes.push(`[^${footnotes.length + 1}]: ${historyCitation(churnCited, permalinks)}`);
    }
    const content = [`# ${about.title}`, ...body, ...(footnotes.length > 0 ? [footnotes.join("\n")] : [])].join("\n\n") + "\n";
    const evidenceRecords = [...citedEvidence, ...(churnCited ? [churnCited] : [])].map(({ id, hash }) => ({ id, hash }));
    return { content, citedEvidence, evidenceRecords, unsupportedClaims: [...unsupported] };
  }

  /**
   * The ids of the Evidence the verifier finds backs each of a human's Claims,
   * offered as much of the Section's Evidence as fits one request, as a write
   * would leave it out.
   */
  async function attach(section: string, about: Subject, claims: string[]): Promise<string[][]> {
    const { request, leftOut } = attachRequest(about, claims);
    if (leftOut.length > 0) report.warnings.push(`The Evidence offered for ${section}'s Claims left out ${leftOut.join(", ")} to fit one request.`);
    return completeCached(llm, repoDir, request, (response) => parseAttachments(response, claims.length));
  }

  function attachRequest(about: Subject, claims: string[]): { request: LlmRequest; leftOut: string[] } {
    const { prompt, leftOut } = wholeFit(
      about.items,
      about.render,
      (rendered) => attachPrompt(about.frame(rendered), claims),
      llm.promptLimit,
      keepCodeRank,
    );
    return { request: { kind: "attach", model: models.verify, system: ATTACH_SYSTEM, prompt, schema: ATTACH_SCHEMA }, leftOut };
  }

  /** A human's Claims in `content`, less Scribe's churn Claim when they kept it as it is now, which no model checks. */
  function adoptedClaims(about: Subject, content: string): { texts: string[]; churnKept: ChurnEvidence | undefined } {
    const sentences = humanClaims(content);
    const churnKept = about.churn !== undefined && sentences.includes(about.churn.statement) ? about.churn : undefined;
    return { texts: sentences.filter((text) => text !== churnKept?.statement), churnKept };
  }

  /** Writes `content` to `path` unless `previous` differs from it only in where its links pin; returns whether it wrote. */
  async function save(path: string, previous: string | undefined, section: string, content: string, citedEvidence: Evidence[], sameEvidence: boolean) {
    // Unchanged but for where its links pin: the old pins still point at this same text, so rewriting would only churn.
    if (previous !== undefined && withoutPins(previous) === withoutPins(content) && sameEvidence) return false;
    if (permalinks) {
      const files = [...citedEvidence.filter(inFile), ...citedEvidence.filter(isRepoEvidence).flatMap((e) => e.lines ?? [])];
      report.warnings.push(...uncommittedWarnings(repoDir, section, files));
    }
    const file = join(repoDir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return true;
  }

  const writer: SectionWriter = {
    estimate(section, existing, changedEvidence, moduleSectionsChange = false) {
      const about = subject(section, true);
      const { fitted, uncachedSummaries, request } = plannedWrite(section, about, existing, changedEvidence);
      // A Section with no Evidence is written without the LLM; a cached first write means a re-run of work already paid for.
      const written = about.worthAsking(fitted.sent);
      if (uncachedSummaries.length === 0 && (!written || (!moduleSectionsChange && isCached(repoDir, request)))) {
        return { ...sectionCost(section, [], 0), free: written ? "cached" : "no-evidence" };
      }
      const expected: ExpectedRequests[] = [
        ...uncachedSummaries.map(summaryRequest),
        // Only a written Section is searched for Drift; a Proposal never is, so this overstates a Proposal's cost.
        ...(written ? expectedDrift(section, about) : []),
      ];
      if (!written) return sectionCost(section, expected, 0);

      const revises = existing !== undefined && manifest.sections[section] !== undefined;
      const verification = expectedVerification(fitted.sent, revises ? changedEvidence : undefined);
      const verdict = unwrittenVerdict(verdictFor(models.verify, { text: "", evidence: [] }, [], about), fitted.sent.map(about.render));
      const { claims, requests } = expectedWrite(request, verification, verdict);
      return sectionCost(section, [...expected, ...requests], claims);
    },

    estimateAdopt(section, content) {
      const about = subject(section);
      const { texts } = adoptedClaims(about, content);
      const expected: ExpectedRequests[] = [];
      let claims: Claim[] | undefined = texts.map((text) => ({ text, evidence: [] }));
      if (texts.length > 0 && about.evidence.size > 0) {
        const { request } = attachRequest(about, texts);
        const cached = readCached(repoDir, request);
        if (cached === undefined) {
          expected.push(attachCost(request));
          claims = undefined;
        } else {
          const attached = parseAttachments(cached, texts.length);
          claims = texts.map((text, i) => ({ text, evidence: attached[i]! }));
        }
      }
      if (claims) {
        expected.push(...verdicts(claims.flatMap((claim) => {
          const verdict = verdictRequest(models.verify, claim, about);
          return "request" in verdict && !isCached(repoDir, verdict.request) ? [verdict.request] : [];
        })));
      } else {
        // Which Evidence each Claim cites is unknown until it is found, so each verdict is expected to carry as much as a written Claim's.
        const rendered = [...about.evidence.values()].map(about.render);
        expected.push(...texts.map((text) => uncitedVerdict(verdictFor(models.verify, { text, evidence: [] }, [], about), rendered)));
      }
      expected.push(...expectedDrift(section, about));
      return sectionCost(section, expected, texts.length);
    },

    async write(section, existing, changedEvidence) {
      const { content, citedEvidence, evidenceRecords, unsupportedClaims } = await compose(section, existing, changedEvidence);
      const drift = await findDrift(section);
      const path = sectionPath(config, section);
      const previous = manifest.sections[section];
      const sameEvidence = JSON.stringify(previous?.evidence) === JSON.stringify(evidenceRecords);
      const sameDrift = JSON.stringify(previous?.drift ?? []) === JSON.stringify(drift);
      const wrote = await save(path, existing, section, content, citedEvidence, sameEvidence);
      if (!wrote && sameDrift) return;
      manifest.sections[section] = {
        file: path,
        evidence: evidenceRecords,
        // Unwritten, the file keeps its old pins, which is what its hash must match.
        contentHash: contentHash(wrote ? content : existing!),
        ...(unsupportedClaims.length > 0 ? { unsupportedClaims } : {}),
        ...(!wrote && previous?.adopted ? { adopted: true as const } : {}),
        ...(drift.length > 0 ? { drift } : {}),
      };
      // Saved per Section: a file written but unrecorded would read as Frozen on the next run.
      await saveManifest(repoDir, manifest);
    },

    async propose(section) {
      const { content, citedEvidence } = await compose(section, undefined, undefined, true);
      const path = proposalPath(config, section);
      await save(path, await readSection(repoDir, path), section, content, citedEvidence, true);
      return path;
    },

    async adopt(section, content) {
      const about = subject(section);
      const { evidence } = about;
      // A human who kept Scribe's churn Claim as it is now keeps its Evidence: it is true by construction, so no model checks it.
      const { texts, churnKept } = adoptedClaims(about, content);
      const attached = texts.length === 0 || evidence.size === 0
        ? texts.map(() => [])
        : await attach(section, about, texts);
      const claims: Claim[] = texts.map((text, i) => ({ text, evidence: attached[i]! }));
      const failures = await verifySection(llm, models.verify, repoDir, { paragraphs: [{ claims }] }, about);

      const cited = new Map<string, Evidence>();
      for (const claim of claims) {
        if (failures.has(claim)) continue;
        for (const id of claim.evidence) if (evidence.has(id)) cited.set(id, evidence.get(id)!);
      }
      const unsupported = claims.filter((claim) => failures.has(claim)).map(({ text }) => text);
      // Drift lies between the docs and the code, whoever wrote the Section, so an adopted Section still reports it.
      const drift = await findDrift(section);
      manifest.sections[section] = {
        file: sectionPath(config, section),
        evidence: [...cited.values(), ...(churnKept ? [churnKept] : [])].map(({ id, hash }) => ({ id, hash })),
        contentHash: contentHash(content),
        ...(unsupported.length > 0 ? { unsupportedClaims: unsupported } : {}),
        adopted: true,
        ...(drift.length > 0 ? { drift } : {}),
      };
      await saveManifest(repoDir, manifest);
      return unsupported;
    },
  };
  // A cut-off response throws before its Section's file or record is written, so the run fails with nothing of it partial.
  return {
    ...writer,
    write: (section, ...rest) => naming(section, "writing", () => writer.write(section, ...rest)),
    propose: (section) => naming(section, "writing a Proposal for", () => writer.propose(section)),
    adopt: (section, content) => naming(section, "adopting", () => writer.adopt(section, content)),
  };
}

/** Runs `work` on `section`, a response to it cut off twice failing with what was `doing` to which Section. */
async function naming<T>(section: string, doing: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CutOff) throw new Error(`${error.message}, ${doing} Section ${section}`, { cause: error });
    throw error;
  }
}

/** The verifier's request for a Claim, or why it fails before any model sees it. */
function verdictRequest(model: string, claim: Claim, about: Subject): { request: LlmRequest } | { failed: string } {
  const failed = about.check?.(claim);
  if (failed !== undefined) return { failed };
  const cited = [...new Set(claim.evidence)].flatMap((id) => about.evidence.get(id) ?? []);
  if (cited.length === 0) return { failed: about.uncited };
  return { request: verdictFor(model, claim, cited, about) };
}

/** A Subject whose Claims are Drift, verified against both the docs and the code they cite. */
function driftVerifier(about: Subject): Subject {
  return { ...about, verifySystem: () => VERIFY_DRIFT_SYSTEM };
}

/** The verifier's request for a Claim against `cited`; an estimate builds one before it knows the Claim or its Evidence. */
function verdictFor(model: string, claim: Claim, cited: Evidence[], { verifySystem, render }: Subject): LlmRequest {
  return { kind: "verdict", model, system: verifySystem(cited), prompt: verifyPrompt(claim, cited, render), schema: VERDICT_SCHEMA };
}

/** Why each Claim failed verification; a Claim not listed is confirmed by its cited Evidence. */
async function verifySection(
  llm: Llm,
  model: string,
  repoDir: string,
  { paragraphs }: SectionResponse,
  about: Subject,
): Promise<Map<Claim, string>> {
  const claims = paragraphs.flatMap((p) => p.claims);
  const reasons = await Promise.all(claims.map(async (claim) => {
    const verdict = verdictRequest(model, claim, about);
    if ("failed" in verdict) return verdict.failed;
    const { confirmed, reason } = await completeCached(llm, repoDir, verdict.request, parseVerdict);
    return confirmed ? undefined : reason;
  }));
  // In Claim order, not answer order: the repair prompt lists these, and that prompt is a cache key.
  const failures = new Map<Claim, string>();
  claims.forEach((claim, i) => {
    const reason = reasons[i];
    if (reason !== undefined) failures.set(claim, reason);
  });
  return failures;
}
