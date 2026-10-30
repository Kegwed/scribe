#!/usr/bin/env node
import { init } from "./commands/init.ts";
import { CONFIG_FILE } from "./config.ts";

const USAGE = "Usage: scribe <command>\n\nCommands:\n  init    Detect Modules and write config and manifest";

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case "init": {
      const { modules, warnings } = await init(process.cwd());
      for (const warning of warnings) console.error(`warning: ${warning}`);
      console.log(`Detected ${modules.length} Module${modules.length === 1 ? "" : "s"}:`);
      const width = Math.max(0, ...modules.map((m) => m.name.length));
      for (const m of modules) console.log(`  ${m.name.padEnd(width)}  ${m.path}`);
      console.log(`\nTo change them, set "modules" in ${CONFIG_FILE}.`);
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
