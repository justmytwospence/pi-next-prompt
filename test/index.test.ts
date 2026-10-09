import { mkdtempSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import nextPrompt, { DEFAULT_CONFIG, SECTION, ghostLine, processAssistant, vet } from "../src/index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { INSTRUCTION } from "../src/tag.ts";
import { fakeJev, harness } from "./harness.ts";

const TAB = "\t";
const RIGHT = "\x1b[C";

beforeEach(() => {
  // No config files: defaults only.
  const root = mkdtempSync("/tmp/next-prompt-");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
});

function assistant(text: string, extra: any[] = []) {
  return { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text }, ...extra], stopReason: "stop" };
}

async function setup(answer: (q: any, s: any) => any = () => ({ useful: { type: "bool", probability: 0.9 } })) {
  const h = harness();
  nextPrompt(h.pi);
  const jev = fakeJev(answer);
  const ctx = h.ctx({ modelRegistry: jev.registry, cwd: mkdtempSync("/tmp/next-prompt-cwd-") });
  await h.emit("session_start", { type: "session_start" }, ctx);
  /** One run: prompt, assistant messages, settle with `outcome`. */
  const run = async (prompt: string, texts: string[], outcome = "completed") => {
    const options = { sections: {} as Record<string, string> };
    await h.emit("input", { type: "input", text: prompt }, ctx);
    await h.emit("before_agent_start", { type: "before_agent_start", prompt, systemPromptOptions: options }, ctx);
    await h.emit("agent_start", { type: "agent_start" }, ctx);
    const replaced: any[] = [];
    for (const text of texts) {
      const message = assistant(text);
      const result: any = await h.emit("message_end", { type: "message_end", message }, ctx);
      replaced.push(result?.message ?? message);
    }
    await h.emit("agent_before_settle", { type: "agent_before_settle", outcome, entries: [], continue: false }, ctx);
    await h.emit("agent_settled", { type: "agent_settled" }, ctx);
    return { options, replaced };
  };
  return { h, ctx, jev, run, ui: ctx.ui };
}

test("the instruction is added as one prompt section", async () => {
  const { run } = await setup();
  const { options } = await run("fix it", ["Fixed."]);
  expect(options.sections).toEqual({ [SECTION]: INSTRUCTION });
});

test("no UI, no instruction", async () => {
  const h = harness();
  nextPrompt(h.pi);
  const ctx = h.ctx({ hasUI: false });
  await h.emit("session_start", {}, ctx);
  const options = { sections: {} };
  await h.emit("before_agent_start", { prompt: "x", systemPromptOptions: options }, ctx);
  expect(options.sections).toEqual({});
});

test("a tagged answer is stripped, vetted and shown below the editor", async () => {
  const { run, ui, jev } = await setup();
  const { replaced } = await run("rename foo to bar in a.ts", ["Renamed.\n\n<next>Run the tests</next>"]);
  expect(replaced[0].content[1].text).toBe("Renamed.");
  expect(replaced[0].content[0].type).toBe("thinking");
  expect(replaced[0].role).toBe("assistant");
  expect(jev.calls[0]!.state).toEqual({ last_user_prompt: "rename foo to bar in a.ts", assistant_text_tail: "Renamed.", suggestion: "Run the tests" });
  expect(ui.widgets.get("next-prompt").opts).toEqual({ placement: "belowEditor" });
  expect(ui.widgetLines("next-prompt")).toEqual(["→ Run the tests  Tab to accept"]);
});

const CUR = "\x1b[7m \x1b[0m";
const plain = (s: string) => s;

/** A fake editor drawn like pi's: borders around one padded content line with the cursor. */
function fakeEditor(ui: any) {
  return {
    getText: () => ui.editorText,
    render(width: number) {
      const body = ui.editorText === "" ? ` ${CUR}` : ` ${ui.editorText}${CUR}`;
      return ["-".repeat(width), body + " ".repeat(Math.max(0, width - body.length + CUR.length - 1)), "-".repeat(width)];
    },
  };
}

/** Give the harness a TUI whose focused component is `editor`, handed to widget factories as pi does. */
function withTui(ui: any, editor: any) {
  const tui = { terminal: { columns: 40 }, getFocusedComponent: () => editor, renders: 0, requestRender: () => tui.renders++ };
  const setWidget = ui.setWidget;
  ui.theme = { fg: (_c: string, s: string) => s };
  ui.setWidget = (key: string, content: any, opts?: any) => {
    if (typeof content === "function") content(tui, ui.theme);
    setWidget(key, content, opts);
  };
  return tui;
}

test("ghostLine puts the suggestion at the cursor, dim, and keeps the width", () => {
  const line = ` ${CUR}${" ".repeat(38)}`;
  const out = ghostLine(line, "Run it", "Tab to accept", 40, (s) => `<${s}>`, plain)!;
  expect(out).toBe(` \x1b[7mR\x1b[0m<un it>  Tab to accept${" ".repeat(16)}`);
  expect(visibleWidth(ghostLine(` ${CUR}${" ".repeat(8)}`, "A long suggestion", "Tab to accept", 10, plain, plain)!)).toBe(10);
  const hw = ghostLine(` \x1b_pi:c\x07${" ".repeat(39)}`, "Run it", "", 40, (s) => `<${s}>`, plain)!;
  expect(hw).toBe(` \x1b_pi:c\x07<Run it>${" ".repeat(31)}`);
  expect(ghostLine("no cursor here", "x", "", 20, plain, plain)).toBeUndefined();
});

test("the suggestion is drawn inside the empty editor, not below it", async () => {
  const { run, ui } = await setup();
  const editor = fakeEditor(ui);
  const tui = withTui(ui, editor);
  await run("rename foo", ["Done.\n<next>Run the tests</next>"]);
  expect(ui.widgets.size).toBe(0);
  expect(editor.render(40)[1]).toContain("\x1b[7mR\x1b[0mun the tests  Tab to accept");
  expect(tui.renders).toBeGreaterThan(0);
  ui.press("\t");
  expect(ui.editorText).toBe("Run the tests");
  expect(Object.hasOwn(editor, "render")).toBe(true);
  expect(editor.render(40)[1]).not.toContain("Tab to accept");
});

test("typing hides the ghost text and restores the editor", async () => {
  const { run, ui } = await setup();
  const editor = fakeEditor(ui);
  const original = editor.render;
  withTui(ui, editor);
  await run("rename foo", ["Done.\n<next>Run the tests</next>"]);
  ui.press("x", "x");
  await new Promise((r) => setTimeout(r, 0));
  expect(editor.render).toBe(original);
  expect(editor.render(40)[1]).not.toContain("Run the tests");
});

test("no tag, nothing shown and no Jev call", async () => {
  const { run, ui, jev } = await setup();
  const { replaced } = await run("what is 2+2", ["4"]);
  expect(replaced[0].content[1].text).toBe("4");
  expect(ui.widgets.size).toBe(0);
  expect(jev.calls).toHaveLength(0);
});

test("aborted or failed runs show nothing", async () => {
  for (const outcome of ["aborted", "error"]) {
    const { run, ui } = await setup();
    await run("go", ["Partial.\n<next>Continue</next>"], outcome);
    expect(ui.widgets.size).toBe(0);
  }
});

test("only the last assistant message counts", async () => {
  const { run, ui } = await setup();
  await run("go", ["Looking.\n<next>Stale</next>", "Done, nothing left."]);
  expect(ui.widgets.size).toBe(0);
});

test("Jev below the threshold holds the suggestion back; failure shows it", async () => {
  const low = await setup(() => ({ useful: { type: "bool", probability: 0.3 } }));
  await low.run("go", ["Done.\n<next>Do more</next>"]);
  expect(low.ui.widgets.size).toBe(0);
  const failing = await setup(() => ({ stopReason: "error", errorMessage: "No API key for typesafe", answers: {}, model: "x" }));
  await failing.run("go", ["Done.\n<next>Run the tests</next>"]);
  expect(failing.ui.widgetLines("next-prompt")).toEqual(["→ Run the tests  Tab to accept"]);
});

test("vet with Jev off shows without asking", async () => {
  const verdict = await vet(undefined, { ...DEFAULT_CONFIG.jev, enabled: false }, { suggestion: "x", userPrompt: "", assistantTail: "" });
  expect(verdict.show).toBe(true);
});

test("Tab or Right on an empty editor fills it and hides the line", async () => {
  for (const key of [TAB, RIGHT]) {
    const { run, ui } = await setup();
    await run("go", ["Done.\n<next>Run the tests</next>"]);
    expect(ui.press(key)).toBe(true);
    expect(ui.editorText).toBe("Run the tests");
    expect(ui.widgets.size).toBe(0);
    // A second Tab is the editor's again.
    expect(ui.press(key)).toBe(false);
  }
});

test("typing dismisses; Tab with text in the editor is not ours", async () => {
  const { run, ui } = await setup();
  await run("go", ["Done.\n<next>Run the tests</next>"]);
  expect(ui.press("a", "a")).toBe(false);
  await new Promise((r) => setTimeout(r, 5));
  expect(ui.widgets.size).toBe(0);
  expect(ui.press(TAB)).toBe(false);
  expect(ui.editorText).toBe("a");
});

test("key releases and non-typing keys keep the suggestion", async () => {
  const { run, ui } = await setup();
  await run("go", ["Done.\n<next>Run the tests</next>"]);
  ui.press("\x1b[9;1:3u"); // kitty Tab release
  ui.press("\x1b[A"); // up, editor stays empty
  await new Promise((r) => setTimeout(r, 5));
  expect(ui.widgets.size).toBe(1);
});

test("a new run, compaction and a new session clear it", async () => {
  for (const event of ["agent_start", "session_compact", "session_start", "session_shutdown"]) {
    const { h, run, ui, ctx } = await setup();
    await run("go", ["Done.\n<next>Run the tests</next>"]);
    await h.emit(event, { type: event }, ctx);
    expect(ui.widgets.size).toBe(0);
  }
});

test("/next-prompt off stops the instruction and the line", async () => {
  const { h, run, ui, ctx } = await setup();
  await h.commands.get("next-prompt").handler("off", ctx);
  const { options } = await run("go", ["Done.\n<next>Run the tests</next>"]);
  expect(options.sections).toEqual({});
  expect(ui.widgets.size).toBe(0);
  await h.commands.get("next-prompt").handler("status", ctx);
  expect(ui.notes.at(-1).message).toContain("next-prompt off");
});

test("processAssistant ignores other roles", () => {
  expect(processAssistant({ role: "user", content: "<next>x</next>" }, 110)).toEqual({ suggestion: undefined, replacement: undefined });
});
