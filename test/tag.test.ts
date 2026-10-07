import { expect, test } from "vitest";
import { INSTRUCTION, extractNext } from "../src/tag.ts";

test("a last tag line is removed and becomes the suggestion", () => {
  expect(extractNext("Edited a.ts.\n\n<next>Run the tests</next>")).toEqual({ text: "Edited a.ts.", suggestion: "Run the tests", found: true });
});

test("trailing whitespace and indentation around the tag are tolerated", () => {
  expect(extractNext("Done.\n  <next> Commit the change </next>  \n\n")).toEqual({ text: "Done.", suggestion: "Commit the change", found: true });
});

test("no tag leaves the text untouched", () => {
  const text = "All done, nothing pending.\n";
  expect(extractNext(text)).toEqual({ text, found: false });
});

test("several tag lines are all removed; the last one wins", () => {
  const out = extractNext("A\n<next>first</next>\nB\n<next>second</next>");
  expect(out).toEqual({ text: "A\nB", suggestion: "second", found: true });
});

test("a tag inside prose is not a tag line and stays", () => {
  const text = "The model may end with `<next>…</next>` on its own line.";
  expect(extractNext(text)).toEqual({ text, found: false });
});

test("too long or empty suggestions are stripped but not offered", () => {
  const long = "x".repeat(111);
  expect(extractNext(`Done.\n<next>${long}</next>`)).toEqual({ text: "Done.", found: true });
  expect(extractNext(`Done.\n<next>${"x".repeat(110)}</next>`).suggestion).toHaveLength(110);
  expect(extractNext("Done.\n<next>  </next>")).toEqual({ text: "Done.", found: true });
  expect(extractNext("Done.\n<next>abcdef</next>", 5)).toEqual({ text: "Done.", found: true });
});

test("the instruction is short", () => {
  expect(INSTRUCTION.length).toBeLessThan(800);
  expect(INSTRUCTION).toContain("<next>");
});
