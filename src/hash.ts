import { createHash } from "node:crypto";

/** Hash of `text` with line endings normalised, so a checkout's line-ending policy can't change it. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex");
}
