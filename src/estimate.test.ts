import { expect, it } from "vitest";
import { sectionCost } from "./estimate.ts";
import { priceTokens } from "./llm.ts";

it("prices each request with the retry a cut-off response is expected to call for, one in a thousand at its output limit", () => {
  // A summary of 1,000 input tokens and 200 output, on Haiku at $0.10 and $0.50 a million.
  const cost = sectionCost("modules/src-a", [{ kind: "summary", count: 1, cost: priceTokens("claude-haiku-5-5", 1_000, 200) }], 0);

  // 1,200 tokens, and a thousandth of a cut-off: 1,000 input and the summary's 4,000-token limit.
  expect(cost.tokens).toBe(1_205);
  expect(cost.dollars).toBeCloseTo(0.0002021, 10);
  expect(cost.requests).toEqual({ summary: 1 });
});
