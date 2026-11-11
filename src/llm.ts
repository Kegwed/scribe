import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { contentHash } from "./hash.ts";
import { CACHE_DIR } from "./manifest.ts";

/** The model Scribe uses for each kind of request. */
export interface Models {
  write: string;
  summarise: string;
  verify: string;
}

/** Sonnet writes Sections; Haiku does bulk summarisation and verification (ADR-0003). Config can override each. */
export const MODELS: Readonly<Models> = {
  write: "claude-sonnet-5-5",
  summarise: "claude-haiku-5-5",
  verify: "claude-haiku-5-5",
};

/** US dollars per million tokens, from Anthropic's published API prices. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * What a request is expected to cost before it is sent: its input tokens
 * approximated from its length, plus `outputTokens` the caller expects back.
 * Approximate by design, since counting exactly would itself call the API.
 * `dollars` is undefined for a model whose price isn't known.
 */
export function estimateCost(request: LlmRequest, outputTokens: number): { model: string; tokens: number; dollars: number | undefined } {
  const price = PRICES[request.model];
  const input = approximateTokens(request.system + request.prompt + JSON.stringify(request.schema));
  return {
    model: request.model,
    tokens: input + outputTokens,
    dollars: price && (input * price.input + outputTokens * price.output) / 1_000_000,
  };
}

/** A rough token count: about four characters per token for English prose and code. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface LlmRequest {
  /**
   * What the request asks for: a Section `write`, a symbol's `summary`, a
   * verifier's `verdict`, the Evidence to `attach` to a human's Claims, or a
   * `drift` search. Not part of its key: the rest of the request says the same.
   */
  kind: "write" | "summary" | "verdict" | "attach" | "drift";
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

/** Claude's response text, with the id the API gave its message. */
export interface ClaudeAnswer {
  text: string;
  id: string;
}

export function claudeLlm(): Llm & { answer(request: LlmRequest): Promise<ClaudeAnswer> } {
  const client = new Anthropic();
  const answer = async ({ model, system, prompt, schema }: LlmRequest): Promise<ClaudeAnswer> => {
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
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return { text, id: message.id };
  };
  return {
    promptLimit: PROMPT_LIMIT,
    answer,
    async complete(request) {
      return (await answer(request)).text;
    },
  };
}

/** Identifies a request by its content; anything that could change the response is part of it. */
export function requestKey(request: LlmRequest): string {
  return contentHash(JSON.stringify([request.model, request.system, request.prompt, request.schema]));
}

function cacheFile(repoDir: string, request: LlmRequest): string {
  return join(repoDir, CACHE_DIR, `${requestKey(request)}.txt`);
}

/** Whether the Target repo's cache already answers `request`, so asking costs nothing. */
export function isCached(repoDir: string, request: LlmRequest): boolean {
  return existsSync(cacheFile(repoDir, request));
}

/** The cached response to `request`, or undefined; for estimates, which must not wait on the LLM. */
export function readCached(repoDir: string, request: LlmRequest): string | undefined {
  const file = cacheFile(repoDir, request);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
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
  const file = cacheFile(repoDir, request);
  if (existsSync(file)) return parse(await readFile(file, "utf8"));

  const response = await llm.complete(request);
  const parsed = parse(response);
  await mkdir(join(repoDir, CACHE_DIR), { recursive: true });
  await writeFile(file, response);
  return parsed;
}
