import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** What a request to Claude carried, as Scribe sent it. */
export interface FakeClaudeRequest {
  system: string;
  prompt: string;
  schema: unknown;
}

export interface FakeClaude {
  /** The base URL to set as `ANTHROPIC_BASE_URL`. */
  url: string;
  /** Every request that reached the endpoint. */
  requests: FakeClaudeRequest[];
  close(): Promise<void>;
}

/**
 * A local endpoint standing in for Claude's Messages API, for tests that run
 * the CLI as a process; `answer` gives each request's JSON response text.
 */
export async function fakeClaude(answer: (request: FakeClaudeRequest) => unknown): Promise<FakeClaude> {
  const requests: FakeClaudeRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const sent = JSON.parse(body);
      const request = { system: sent.system, prompt: sent.messages[0].content, schema: sent.output_config?.format?.schema };
      requests.push(request);
      const text = JSON.stringify(answer(request));
      const events = [
        ["message_start", { type: "message_start", message: { id: `msg_fake_${requests.length}`, type: "message", role: "assistant", model: sent.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ] as const;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
