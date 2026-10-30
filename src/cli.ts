#!/usr/bin/env node
import { generate } from "./commands/generate.ts";
import { init } from "./commands/init.ts";
import { CONFIG_FILE } from "./config.ts";
import { claudeLlm } from "./llm.ts";

const USAGE = "Usage: scribe <command>\n\nCommands:\n  init      Detect Modules and write config and manifest\n  generate  Write a cited Section per Module";

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
      for (const { section, text } of droppedClaims) console.log(`Dropped from ${section}, no valid Evidence: ${text}`);
      console.log("Guide generated.");
      return 0;
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
