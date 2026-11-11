#!/usr/bin/env node
import { generate } from "./commands/generate.ts";
import { init } from "./commands/init.ts";
import { status } from "./commands/status.ts";
import { update } from "./commands/update.ts";
import { CONFIG_FILE } from "./config.ts";
import { claudeLlm } from "./llm.ts";

const USAGE = "Usage: scribe <command>\n\nCommands:\n  init      Detect Modules and write config and manifest\n  generate  Write a cited Section per Module\n  update    Regenerate Stale Sections and write Sections for added Modules\n  status    Report Stale, Frozen and missing Sections and added or removed Modules; exits 1 unless only Frozen Sections need attention";

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
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
      const { droppedClaims, frozen, warnings } = await generate(process.cwd(), {}, { llm: claudeLlm() });
      for (const warning of warnings) console.error(`warning: ${warning}`);
      for (const section of frozen) console.log(`Frozen, left as is: ${section}`);
      for (const { section, text, reason } of droppedClaims) console.log(`Dropped from ${section}: ${text} (${reason})`);
      console.log("Guide generated.");
      return 0;
    }
    case "update": {
      const { droppedClaims, frozen, removed, warnings } = await update(process.cwd(), {}, { llm: claudeLlm() });
      for (const warning of warnings) console.error(`warning: ${warning}`);
      for (const section of frozen) console.log(`Frozen, left as is: ${section}`);
      for (const { section, text, reason } of droppedClaims) console.log(`Dropped from ${section}: ${text} (${reason})`);
      for (const { section, file } of removed) console.log(`Module removed: ${section}; delete ${file} if it is no longer wanted.`);
      console.log("Guide updated.");
      return 0;
    }
    case "status": {
      const { sections } = await status(process.cwd());
      const attention = sections.filter((s) => s.added || s.removed || s.missing || s.frozen || s.stale);
      for (const { section, added, removed, missing, frozen, stale, changedEvidence } of attention) {
        const label = added ? "Module added, no Section yet"
          : removed ? "Module removed"
          : missing ? "Missing"
          : frozen && stale ? "Frozen and Stale"
          : frozen ? "Frozen"
          : "Stale";
        const changes = stale && !removed && !missing ? ` (changed: ${changedEvidence.join(", ")})` : "";
        console.log(`${label}: ${section}${changes}`);
      }
      if (attention.length === 0) console.log(`All ${sections.length} Section${sections.length === 1 ? "" : "s"} current.`);
      return sections.some((s) => s.added || s.removed || s.missing || s.stale) ? 1 : 0;
    }
    default:
      console.error(USAGE);
      return command === undefined || command === "--help" ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(`scribe: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
