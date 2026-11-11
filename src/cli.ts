#!/usr/bin/env node
import { adopt } from "./commands/adopt.ts";
import { generate } from "./commands/generate.ts";
import { init } from "./commands/init.ts";
import { reset } from "./commands/reset.ts";
import { status } from "./commands/status.ts";
import { update } from "./commands/update.ts";
import { CONFIG_FILE } from "./config.ts";
import { createInterface } from "node:readline";
import type { Adapters } from "./adapters.ts";
import { connectGitHub } from "./github.ts";
import { claudeLlm } from "./llm.ts";
import type { DriftReport } from "./manifest.ts";
import type { Confirm, WriteReport } from "./section-writer.ts";
import { isTopLevelSection } from "./target.ts";

const USAGE = "Usage: scribe <command> [--yes]\n\nCommands:\n  init      Detect Modules and write config and manifest\n  generate  Write a cited Section per Module, then Overview and Architecture from them\n  update    Regenerate Stale Sections, write Sections for added Modules and Proposals for Frozen, Stale Sections\n  status    Report Stale, Frozen and missing Sections, added or removed Modules, pending Proposals, Unsupported Claims and Drift between existing docs and the code; exits 1 unless only Frozen Sections, Unsupported Claims or Drift need attention\n  adopt <section>  Take a Frozen Section's text as the new baseline, recording its Evidence and Unsupported Claims\n  reset <section>  Discard a Section's human edits and regenerate it\n\ngenerate and update print a cost estimate and ask before calling the LLM; --yes skips asking.";

/** Prints a run's estimate, then asks to go ahead unless `yes`; no answer, as when stdin closes, declines. */
function confirmer(yes: boolean): Confirm {
  return async ({ sections, tokens, dollars, unpriced }) => {
    const paid = sections.filter((s) => s.tokens > 0);
    const width = Math.max(0, ...paid.map((s) => s.section.length));
    console.log(`Estimated cost: ${usd(dollars)} for ${paid.length} Section${paid.length === 1 ? "" : "s"}, about ${tokens.toLocaleString("en-US")} tokens`);
    for (const s of paid) console.log(`  ${s.section.padEnd(width)}  ${usd(s.dollars)}`);
    const cached = sections.length - paid.length;
    if (cached > 0) console.log(`  plus ${cached} cached Section${cached === 1 ? "" : "s"} at no cost`);
    if (unpriced.length > 0) console.log(`  not counting ${unpriced.join(", ")}, whose price Scribe doesn't know`);
    if (yes) return true;
    const answer = await ask("Continue? [y/N] ");
    return /^y(es)?$/i.test(answer?.trim() ?? "");
  };
}

function usd(dollars: number): string {
  return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`;
}

async function ask(question: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => {
      rl.once("close", () => resolve(undefined));
      rl.question(question, resolve);
    });
  } finally {
    rl.close();
  }
}

function cancelled(): number {
  console.log("Cancelled; no LLM was called and nothing was written.");
  return 1;
}

/** Claude, and GitHub when `origin` is on it and `gh` is signed in. */
function adapters(): Adapters {
  const github = connectGitHub(process.cwd());
  return { llm: claudeLlm(), ...(github ? { github } : {}) };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = rest.filter((arg) => arg.startsWith("-"));
  const [section] = rest.filter((arg) => !arg.startsWith("-"));
  const yes = flags.includes("--yes") || flags.includes("-y");
  if ((command === "adopt" || command === "reset") && section === undefined) {
    console.error(`Usage: scribe ${command} <section>\n\nThe Sections are named as scribe status lists them, such as modules/src-core.`);
    return 1;
  }
  switch (command) {
    case "init": {
      const { modules, publicSurface, warnings } = await init(process.cwd());
      for (const warning of warnings) console.error(`warning: ${warning}`);
      console.log(`Detected ${modules.length} Module${modules.length === 1 ? "" : "s"}:`);
      const width = Math.max(0, ...modules.map((m) => m.name.length));
      for (const m of modules) {
        console.log(`  ${m.name.padEnd(width)}  ${m.path}`);
        const exports = publicSurface[m.path] ?? [];
        console.log(`    exports: ${exports.length > 0 ? exports.join(", ") : "(none)"}`);
      }
      console.log(`\nTo change them, set "modules" in ${CONFIG_FILE}.`);
      return 0;
    }
    case "generate": {
      const { declined, droppedClaims, frozen, reduced, warnings, drift } = await generate(process.cwd(), { confirm: confirmer(yes) }, adapters());
      for (const warning of warnings) console.error(`warning: ${warning}`);
      for (const section of frozen) console.log(`Frozen, left as is: ${section}`);
      if (declined) return cancelled();
      printReduced(reduced);
      for (const { section, text, reason } of droppedClaims) console.log(`Dropped from ${section}: ${text} (${reason})`);
      for (const line of driftLines(drift)) console.log(line);
      console.log("Guide generated.");
      return 0;
    }
    case "update": {
      const { declined, droppedClaims, frozen, proposals, reduced, removed, warnings, drift } = await update(process.cwd(), { confirm: confirmer(yes) }, adapters());
      for (const warning of warnings) console.error(`warning: ${warning}`);
      for (const section of frozen) console.log(`Frozen, left as is: ${section}`);
      if (declined) return cancelled();
      for (const { section, file } of proposals) console.log(`Frozen and Stale, Proposal written: ${section}; merge ${file} into it by hand, then delete it.`);
      printReduced(reduced);
      for (const { section, text, reason, proposal } of droppedClaims) {
        console.log(`Dropped from ${proposal ? `the Proposal for ${section}` : section}: ${text} (${reason})`);
      }
      for (const { section, file } of removed) console.log(`Module removed: ${section}; delete ${file} if it is no longer wanted.`);
      for (const line of driftLines(drift)) console.log(line);
      console.log("Guide updated.");
      return 0;
    }
    case "status": {
      const { sections, proposals, unsupportedClaims, drift } = await status(process.cwd());
      const attention = sections.filter((s) => s.added || s.removed || s.missing || s.frozen || s.stale);
      for (const { section, added, removed, missing, frozen, stale, changedEvidence } of attention) {
        const label = added && isTopLevelSection(section) ? "Not written yet"
          : added ? "Module added, no Section yet"
          : removed ? "Module removed"
          : missing ? "Missing"
          : frozen && stale ? "Frozen and Stale"
          : frozen ? "Frozen"
          : "Stale";
        const changes = stale && !removed && !missing ? ` (changed: ${changedEvidence.join(", ")})` : "";
        console.log(`${label}: ${section}${changes}`);
      }
      for (const { section, file } of proposals) console.log(`Proposal to merge by hand: ${section} (${file})`);
      for (const { section, text } of unsupportedClaims) console.log(`Unsupported Claim in ${section}: ${text}`);
      for (const line of driftLines(drift)) console.log(line);
      if (attention.length === 0 && proposals.length === 0 && unsupportedClaims.length === 0 && drift.length === 0) console.log(`All ${sections.length} Section${sections.length === 1 ? "" : "s"} current.`);
      return proposals.length > 0 || sections.some((s) => s.added || s.removed || s.missing || s.stale) ? 1 : 0;
    }
    case "adopt": {
      const { unsupportedClaims, clearedProposal, warnings } = await adopt(process.cwd(), section!, adapters());
      for (const warning of warnings) console.error(`warning: ${warning}`);
      for (const { text } of unsupportedClaims) console.log(`Unsupported Claim, kept: ${text}`);
      if (clearedProposal) console.log(`Proposal deleted: ${clearedProposal}`);
      console.log(`Adopted ${section}.`);
      return 0;
    }
    case "reset": {
      const { droppedClaims, warnings, clearedProposal } = await reset(process.cwd(), section!, adapters());
      for (const warning of warnings) console.error(`warning: ${warning}`);
      for (const { text, reason } of droppedClaims) console.log(`Dropped from ${section}: ${text} (${reason})`);
      if (clearedProposal) console.log(`Proposal deleted: ${clearedProposal}`);
      console.log(`Reset ${section}.`);
      return 0;
    }
    default:
      console.error(USAGE);
      return command === undefined || command === "--help" ? 0 : 1;
  }
}

/** One line per Drift, naming the Evidence on both sides; the code is treated as correct. */
function driftLines(drift: DriftReport[]): string[] {
  return drift.map(({ section, description, docs, code }) =>
    `Drift: ${description} (docs: ${docs.join(", ")}; code: ${code.join(", ")}; found for ${section})`);
}

function printReduced(reduced: WriteReport["reduced"]) {
  for (const { section, summarised, leftOut, proposal } of reduced) {
    const how = [
      ...(summarised.length > 0 ? [`summarised: ${summarised.join(", ")}`] : []),
      ...(leftOut.length > 0 ? [`left out: ${leftOut.join(", ")}`] : []),
    ].join("; ");
    console.log(`Reduced to fit one writing request: ${proposal ? `the Proposal for ${section}` : section} (${how})`);
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(`scribe: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
