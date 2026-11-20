// Preload that records what each Claude Messages response actually used, and the kind of request it
// answered, one JSON line per response, to the file named by USAGE_LOG. Scribe's CLI reports only
// estimates; this is how a live run's real spend is measured. Total it with scripts/spend.mjs.
//
//   USAGE_LOG=run.log node --import ./scripts/usage-log.mjs dist/cli.js generate
import { appendFileSync } from "node:fs";
import { classify } from "./usage.mjs";

const log = process.env.USAGE_LOG;
const original = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const response = await original(input, init);
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  if (!log || !url.includes("/v1/messages")) return response;
  const request = typeof init?.body === "string" ? classify(init.body) : { kind: "unknown" };
  record(response.clone(), request).catch((error) => appendFileSync(log, JSON.stringify({ logError: String(error) }) + "\n"));
  return response;
};

async function record(response, request) {
  const text = await response.text();
  const usage = { status: response.status, ...request, model: undefined, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  // Scribe streams, so usage arrives in server-sent events: message_start carries the input side,
  // message_delta the final counts.
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let event;
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (event.type === "message_start") {
      const u = event.message.usage ?? {};
      usage.model = event.message.model;
      usage.input = u.input_tokens ?? 0;
      usage.cacheRead = u.cache_read_input_tokens ?? 0;
      usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      usage.output = u.output_tokens ?? 0;
    }
    if (event.type === "message_delta" && event.usage) {
      if (event.usage.input_tokens != null) usage.input = event.usage.input_tokens;
      if (event.usage.output_tokens != null) usage.output = event.usage.output_tokens;
    }
    if (event.type === "error") usage.error = event.error;
  }
  if (response.status !== 200) usage.body = text.slice(0, 500);
  appendFileSync(log, JSON.stringify(usage) + "\n");
}
