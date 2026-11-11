import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeLlm, type Llm, type LlmRequest, PROMPT_LIMIT, requestKey } from "../llm.ts";
import { SUMMARY_SYSTEM } from "../section-writer.ts";

const CASSETTES = join(dirname(fileURLToPath(import.meta.url)), "cassettes");

export interface RecordedLlm extends Llm {
  /** Requests that reached this adapter, which a cache hit never does. */
  calls: LlmRequest[];
}

/**
 * Replays responses recorded in `cassettes/<name>.json`, keyed by request
 * content. With SCRIBE_RECORD=1 it calls Claude for requests it has no
 * recording of, and records them.
 */
export function recordedLlm(name: string, { promptLimit = PROMPT_LIMIT }: { promptLimit?: number } = {}): RecordedLlm {
  const file = join(CASSETTES, `${name}.json`);
  const cassette: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const calls: LlmRequest[] = [];

  return {
    calls,
    promptLimit,
    async complete(request) {
      calls.push(request);
      const key = requestKey(request);
      const recorded = cassette[key];
      if (recorded !== undefined) return recorded;
      if (!process.env.SCRIBE_RECORD) {
        throw new Error(`no recording of ${key} in ${file}; re-record with SCRIBE_RECORD=1\n${request.prompt}`);
      }
      const response = await claudeLlm().complete(request);
      cassette[key] = response;
      mkdirSync(CASSETTES, { recursive: true });
      writeFileSync(file, JSON.stringify(cassette, null, 2) + "\n");
      return response;
    },
  };
}

/**
 * A fake for edge cases a live model won't reliably produce. Writes answer with
 * `sections`: a list is used in turn with its last entry repeating, anything else
 * answers every write. The verifier answers from `verdicts`, keyed by a Claim's
 * text, and confirms any Claim not listed. Asked which Evidence backs an adopted
 * Section's Claims, it answers from `attachments`, keyed by a Claim's text, and
 * attaches no Evidence to any Claim not listed. Requests made together are answered
 * last first, so code that depends on the order answers arrive in fails here.
 * A summary request answers with the summary in `summaries` keyed by the
 * summarised symbol's id, or with a one-line summary naming it. `promptLimit`
 * stands in for the writing model's, so small fixtures can exceed it.
 */
export function scriptedLlm(
  sections: unknown,
  verdicts: Record<string, unknown> = {},
  { promptLimit = PROMPT_LIMIT, summaries = {}, attachments = {} }: {
    promptLimit?: number;
    summaries?: Record<string, unknown>;
    attachments?: Record<string, string[]>;
  } = {},
): RecordedLlm {
  const calls: LlmRequest[] = [];
  const writes = Array.isArray(sections) ? sections : [sections];
  let written = 0;
  const waiting: (() => void)[] = [];
  return {
    calls,
    promptLimit,
    async complete(request) {
      calls.push(request);
      // Spaced apart: answered in the same tick, the cache's file writes shuffled them back into any order.
      await new Promise<void>((answer) => {
        if (waiting.push(answer) === 1) {
          setTimeout(() => waiting.splice(0).reverse().forEach((next, i) => setTimeout(next, i * 50)));
        }
      });
      if (isSectionWrite(request)) return asResponseText(writes[Math.min(written++, writes.length - 1)]);
      if ("attachments" in ((request.schema.properties as object | undefined) ?? {})) {
        const claims = [...request.prompt.matchAll(/<claim index="(\d+)">\n(.*)\n<\/claim>/g)];
        return asResponseText({
          attachments: claims.map(([, index, text]) => ({ claim: Number(index), evidence: attachments[text!] ?? [] })),
        });
      }
      if (request.system === SUMMARY_SYSTEM) {
        const id = request.prompt.match(/<symbol id="([^"]*)"/)?.[1] ?? "";
        return asResponseText({ summary: id in summaries ? summaries[id] : `Summary of ${id}.` });
      }
      const claim = Object.keys(verdicts).find((key) => request.prompt.includes(key));
      return asResponseText(claim === undefined ? { confirmed: true, reason: "" } : verdicts[claim]);
    },
  };
}

/** Whether a request asks for a Section rather than a verdict; told apart by schema, since config can change either's model. */
export function isSectionWrite(request: LlmRequest): boolean {
  return "paragraphs" in ((request.schema.properties as object | undefined) ?? {});
}

function asResponseText(response: unknown): string {
  return typeof response === "string" ? response : JSON.stringify(response);
}
