import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeLlm, type LlmRequest } from "./llm.ts";
import { CUT_OFF, type FakeClaude, fakeClaude } from "./test/fake-claude.ts";

describe("claudeLlm", () => {
  const saved = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
  let claude: FakeClaude | undefined;
  /** Points Claude's client at a fake answering with `answer`. */
  async function against(answer: Parameters<typeof fakeClaude>[0]): Promise<FakeClaude> {
    claude = await fakeClaude(answer);
    process.env.ANTHROPIC_BASE_URL = claude.url;
    return claude;
  }
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-dummy";
  });
  afterEach(async () => {
    await claude?.close();
    claude = undefined;
    for (const [name, value] of [["ANTHROPIC_BASE_URL", saved.url], ["ANTHROPIC_API_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const request = (kind: LlmRequest["kind"]): LlmRequest =>
    ({ kind, model: "claude-haiku-5-5", system: "Answer.", prompt: `A ${kind}.`, schema: { type: "object" } });

  it("sends each kind of request with an output limit of its own", async () => {
    const fake = await against(() => ({ ok: true }));
    const llm = claudeLlm();

    const sent: Record<string, number> = {};
    for (const kind of ["summary", "verdict", "drift", "attach", "write"] as const) {
      await llm.complete(request(kind));
      sent[kind] = fake.requests.at(-1)!.maxTokens;
    }

    expect(sent).toEqual({ summary: 4_000, verdict: 4_000, drift: 32_000, attach: 32_000, write: 32_000 });
  });

  it("asks again once when a response is cut off at its output limit, and answers with the retry", async () => {
    let calls = 0;
    const fake = await against(() => (calls++ === 0 ? CUT_OFF : { summary: "Adds." }));

    const text = await claudeLlm().complete(request("summary"));

    expect(JSON.parse(text)).toEqual({ summary: "Adds." });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.prompt).toBe(fake.requests[0]!.prompt);
  });

  it("fails, naming the request kind, when the retry is cut off too", async () => {
    const fake = await against(() => CUT_OFF);

    await expect(claudeLlm().complete(request("verdict"))).rejects.toThrow(/verdict .*cut off at its 4,000-token output limit twice/);
    expect(fake.requests).toHaveLength(2);
  });
});
