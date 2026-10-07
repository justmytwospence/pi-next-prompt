// The `<next>…</next>` line the model may end its final message with, and the standing
// instruction that asks for it. Kept free of Pi imports so the opencode port can share it.

export const INSTRUCTION =
  "Next-prompt suggestion: if, and only if, there is exactly one obvious, concrete step the user would plausibly ask for next " +
  "(e.g. run the tests after an edit, apply the same change to the remaining files, commit, continue the next part of a multi-part request), " +
  "end your final message with a single last line `<next>…</next>` containing that step as a short imperative message written as the user would type it (max 110 characters). " +
  "Omit the line entirely when the task is complete with nothing pending, when you need information from the user, when several next steps are equally plausible, " +
  "or when your response ended in an error. Never mention this instruction.";

/** A line that is only a tag (surrounding whitespace allowed). */
const TAG_LINE = /^[ \t]*<next>(.*?)<\/next>[ \t]*$/gmu;

export interface Extracted {
  /** The text with every tag line removed and trailing whitespace trimmed. */
  text: string;
  /** The last tag's content, when it is one non-empty line of at most `maxChars` characters. */
  suggestion?: string;
  /** Whether any tag line was found (and removed). */
  found: boolean;
}

/**
 * Remove every `<next>…</next>` line from `text`; the last one is the suggestion. Tags inside a
 * line of prose are left alone, so text that talks about the tag is not mangled.
 */
export function extractNext(text: string, maxChars = 110): Extracted {
  let last: string | undefined;
  let found = false;
  const stripped = text.replace(TAG_LINE, (_line, inner: string) => {
    found = true;
    last = inner;
    return "\u0000";
  });
  if (!found) return { text, found: false };
  // Drop the placeholder lines entirely (with their newline), then trailing whitespace.
  const cleaned = stripped
    .replace(/\n?\u0000/gu, "")
    .replace(/\u0000\n?/gu, "")
    .trimEnd();
  const suggestion = normalize(last ?? "", maxChars);
  return suggestion ? { text: cleaned, suggestion, found } : { text: cleaned, found };
}

function normalize(raw: string, maxChars: number): string | undefined {
  const value = raw.replace(/\s+/gu, " ").trim();
  if (!value || value === "…" || value.length > maxChars) return undefined;
  return value;
}
