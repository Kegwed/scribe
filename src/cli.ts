#!/usr/bin/env node
import { createInterface } from "node:readline";
import type { Adapters } from "./adapters.ts";
import { connectGitHub, whyGitHubIsOff } from "./github.ts";
import { claudeLlm } from "./llm.ts";
import { main } from "./main.ts";

/** Claude, and GitHub when `origin` is on it and `gh` is signed in; otherwise a warning says why it's off. */
function adapters(dir: string): Adapters {
  const { github, off } = connectGitHub(dir);
  if (off) console.error(`warning: ${whyGitHubIsOff(off)}`);
  return { llm: claudeLlm(), ...(github ? { github } : {}) };
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

main(process.argv.slice(2), { dir: process.cwd(), adapters, ask }).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(`scribe: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
