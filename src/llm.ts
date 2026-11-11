import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { contentHash } from "./hash.ts";
import { CACHE_DIR } from "./manifest.ts";

/** Sonnet writes Sections; Haiku does bulk summarisation and verification (ADR-0003). */
export const MODELS = {
  write: "claude-sonnet-5-5",
  summarise: "claude-haiku-5-5",
  verify: "claude-haiku-5-5",
} as const;

export interface LlmRequest {
  model: string;
  system: string;
  prompt: string;
  /** JSON schema the response must conform to. */
  schema: Record<string, unknown>;
}

/** Thin interface over Claude, deliberately not generalised to other providers (ADR-0003). */
export interface Llm {
  /** The response text, which conforms to the request's schema. */
  complete(request: LlmRequest): Promise<string>;
  /** The most characters of prompt one request carries; a larger Module is reduced to fit. */
  promptLimit: number;
}

/**
 * A budget, not a measured boundary: about 100k tokens at the usual estimate of
 * 4 characters a token, leaving the rest of the context window for the system
 * text, a repair's extra text and the response.
 */
export const PROMPT_LIMIT = 400_000;

export function claudeLlm(): Llm {
  const client = new Anthropic();
  return {
    promptLimit: PROMPT_LIMIT,
    async complete({ model, system, prompt, schema }) {
      const message = await client.beta.messages
        .stream({
          model,
          max_tokens: 64000,
          // Refusals on Sonnet re-run server-side; Haiku has no server-side fallback.
          ...(model === MODELS.write
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
          system,
          messages: [{ role: "user", content: prompt }],
          output_config: { format: { type: "json_schema", schema } },
        })
        .finalMessage();
      if (message.stop_reason !== "end_turn") {
        throw new Error(`${model} stopped early: ${message.stop_reason}`);
      }
      return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    },
  };
}

/** Identifies a request by its content; anything that could change the response is part of it. */
export function requestKey(request: LlmRequest): string {
  return contentHash(JSON.stringify([request.model, request.system, request.prompt, request.schema]));
}

/**
 * Answers `request` from the Target repo's cache, or from `llm` on a miss. A
 * response is cached only once `parse` accepts it, so a bad one is never replayed.
 */
export async function completeCached<T>(
  llm: Llm,
  repoDir: string,
  request: LlmRequest,
  parse: (response: string) => T,
): Promise<T> {
  const file = join(repoDir, CACHE_DIR, `${requestKey(request)}.txt`);
  if (existsSync(file)) return parse(await readFile(file, "utf8"));

  const response = await llm.complete(request);
  const parsed = parse(response);
  await mkdir(join(repoDir, CACHE_DIR), { recursive: true });
  await writeFile(file, response);
  return parsed;
}
