export const HOT = "This Module is hot: 5 or more commits changed it in the 90 days of git history cited.";
export const STABLE = "This Module is stable: fewer than 5 commits changed it in the 90 days of git history cited.";

/**
 * A Module's Section as Scribe writes it when the Module is stable and its
 * origin isn't on GitHub: `prose` (if any), then the churn Claim, then
 * `footnotes` followed by the one citing the Module's git history.
 */
export function stableSection(heading: string, modulePath: string, prose: string, footnotes: string[] = []): string {
  const n = footnotes.length + 1;
  const blocks = [`# ${heading}`, ...(prose ? [prose] : []), `${STABLE}[^${n}]`, [...footnotes, `[^${n}]: git history of ${modulePath} (90 days)`].join("\n")];
  return blocks.join("\n\n") + "\n";
}
