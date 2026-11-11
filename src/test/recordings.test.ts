import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASSETTES, readCassette } from "./recorded-llm.ts";

// Keys recorded before cassettes kept message ids. The list only shrinks: a full `npm run record` empties it.
const legacy: Record<string, string[]> = JSON.parse(
  readFileSync(new URL("./legacy-recordings.json", import.meta.url), "utf8"),
);

const MESSAGE_ID = /^msg_[A-Za-z0-9]{20,}$/;

describe("recordings", () => {
  for (const file of readdirSync(CASSETTES).filter((name) => name.endsWith(".json"))) {
    const name = file.replace(/\.json$/, "");
    it(`${name} holds only responses recorded from Claude`, () => {
      const allowed = new Set(legacy[name] ?? []);
      const unproven = Object.entries(readCassette(join(CASSETTES, file)))
        .filter(([key, recording]) =>
          typeof recording === "string"
            ? !allowed.has(key)
            : typeof recording.response !== "string" || !MESSAGE_ID.test(recording.id),
        )
        .map(([key]) => key);
      expect(unproven, "entries without a Claude message id; record them with npm run record").toEqual([]);
    });
  }

  it("lists no legacy key that is gone or has since been re-recorded", () => {
    const stale = Object.entries(legacy).flatMap(([name, keys]) => {
      const cassette = readCassette(join(CASSETTES, `${name}.json`));
      return keys.filter((key) => typeof cassette[key] !== "string").map((key) => `${name}/${key}`);
    });
    expect(stale, "remove these from src/test/legacy-recordings.json").toEqual([]);
  });
});
