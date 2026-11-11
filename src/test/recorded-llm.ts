import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeLlm, type Llm, type LlmRequest, PROMPT_LIMIT, requestKey } from "../llm.ts";

export const CASSETTES = join(dirname(fileURLToPath(import.meta.url)), "cassettes");

/**
 * One recorded response: Claude's text and the id the API gave its message,
 * which shows it came from Claude. A bare string is a response recorded before
 * ids were kept; `legacy-recordings.json` lists the keys allowed one.
 */
export type Recording = { response: string; id: string } | string;

export function readCassette(file: string): Record<string, Recording> {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export interface RecordedLlm extends Llm {
  /** Requests that reached this adapter, which a cache hit never does. */
  calls: LlmRequest[];
}

/**
 * Replays responses recorded in `cassettes/<name>.json`, keyed by request
 * content. With SCRIBE_RECORD=1 it calls Claude for requests it has no
 * recording of, and records them. With SCRIBE_USED_KEYS set to a directory, it
 * notes there every key it was asked for, so `npm run check` can find unused ones.
 */
export function recordedLlm(name: string, { promptLimit = PROMPT_LIMIT }: { promptLimit?: number } = {}): RecordedLlm {
  const file = join(CASSETTES, `${name}.json`);
  const cassette = readCassette(file);
  const calls: LlmRequest[] = [];
  const usedKeys = process.env.SCRIBE_USED_KEYS;

  return {
    calls,
    promptLimit,
    async complete(request) {
      calls.push(request);
      const key = requestKey(request);
      if (usedKeys) appendFileSync(join(usedKeys, `${name}.${process.pid}.keys`), `${key}\n`);
      const recorded = cassette[key];
      if (recorded !== undefined) return typeof recorded === "string" ? recorded : recorded.response;
      if (!process.env.SCRIBE_RECORD) {
        throw new Error(`no recording of ${key} in ${file}; re-record with npm run record -- ${name}\n${request.prompt}`);
      }
      const { text, id } = await claudeLlm().answer(request);
      cassette[key] = { response: text, id };
      mkdirSync(CASSETTES, { recursive: true });
      writeFileSync(file, JSON.stringify(cassette, null, 2) + "\n");
      return text;
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
 * stands in for the writing model's, so small fixtures can exceed it. A search
 * for Drift finds `drift`, by default nothing. Writes of Overview and
 * Architecture answer from `topLevel`, keyed by title, and default to a
 * Section with no Claims, so `sections` never scripts them.
 */
export function scriptedLlm(
  sections: unknown,
  verdicts: Record<string, unknown> = {},
  { promptLimit = PROMPT_LIMIT, summaries = {}, attachments = {}, drift = [], topLevel = {} }: {
    promptLimit?: number;
    summaries?: Record<string, unknown>;
    attachments?: Record<string, string[]>;
    drift?: unknown[];
    topLevel?: Record<string, unknown>;
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
      switch (request.kind) {
        case "write": {
          // Overview and Architecture are asked for by title, the first line of their prompt.
          const title = request.prompt.match(/^Section: (.+)/)?.[1];
          if (title !== undefined) return asResponseText(topLevel[title] ?? { paragraphs: [] });
          return asResponseText(writes[Math.min(written++, writes.length - 1)]);
        }
        case "attach": {
          const claims = [...request.prompt.matchAll(/<claim index="(\d+)">\n(.*)\n<\/claim>/g)];
          return asResponseText({
            attachments: claims.map(([, index, text]) => ({ claim: Number(index), evidence: attachments[text!] ?? [] })),
          });
        }
        case "summary": {
          const id = request.prompt.match(/<symbol id="([^"]*)"/)?.[1] ?? "";
          return asResponseText({ summary: id in summaries ? summaries[id] : `Summary of ${id}.` });
        }
        case "drift":
          return asResponseText({ drift });
        case "verdict": {
          const claim = Object.keys(verdicts).find((key) => request.prompt.includes(key));
          return asResponseText(claim === undefined ? { confirmed: true, reason: "" } : verdicts[claim]);
        }
      }
    },
  };
}

/** Whether a request asks for a Section to be written. */
export function isSectionWrite(request: LlmRequest): boolean {
  return request.kind === "write";
}

function asResponseText(response: unknown): string {
  return typeof response === "string" ? response : JSON.stringify(response);
}
