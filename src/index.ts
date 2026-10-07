// pi-next-prompt: after a run, suggests the prompt you would most likely send next, the way Claude
// Code does: a dim line under the editor, Tab (or Right) on an empty editor fills it in, typing
// dismisses it. The main model writes the suggestion itself, in a last `<next>…</next>` line it
// adds only when one next step is obvious (a short standing prompt section asks for it). The line
// is stripped before the message is stored, so it never reaches the transcript or later context;
// Jev vets it before it is shown and fails open.
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type KeyId, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import { type ClassifierQuestion, type JevConfig, askJev, bool } from "./jev.ts";
import { INSTRUCTION, extractNext } from "./tag.ts";
import { clip, clipTail, messageText } from "./transcript.ts";

export interface NextPromptConfig extends Record<string, unknown> {
  enabled: boolean;
  acceptKeys: string[];
  maxChars: number;
  jev: JevConfig & { threshold: number };
}

export const DEFAULT_CONFIG: NextPromptConfig = {
  enabled: true,
  acceptKeys: ["tab", "right"],
  maxChars: 110,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_500, threshold: 0.6 },
};

export const SECTION = "next_prompt";
const WIDGET_KEY = "next-prompt";

export const QUESTIONS: Record<string, ClassifierQuestion> = {
  useful: {
    type: "bool",
    instructions:
      "A coding agent finished answering `last_user_prompt` with a response ending in `assistant_text_tail`, and proposes `suggestion` as the user's next message. " +
      "Is the suggestion a concrete, non-generic next step that follows from the response, is not already done, and the user would plausibly send next?",
    criteria: {
      true: "A specific, useful next step the user would likely send",
      false: "Generic, already done, unrelated, or a guess among several options",
    },
  },
};

interface Pending {
  suggestion: string;
  userPrompt: string;
  assistantTail: string;
}

export interface Verdict {
  show: boolean;
  reason: string;
}

/** Jev's vote on a suggestion. Shown when Jev is off or unavailable: the model already abstains on its own. */
export async function vet(registry: unknown, config: NextPromptConfig["jev"], pending: Pending): Promise<Verdict> {
  if (!config.enabled) return { show: true, reason: "Jev off" };
  const outcome = await askJev(
    registry,
    config,
    {
      last_user_prompt: clip(pending.userPrompt, 1_500),
      assistant_text_tail: clipTail(pending.assistantTail, 2_000),
      suggestion: pending.suggestion,
    },
    QUESTIONS,
  );
  if (!outcome.ok) return { show: true, reason: `Jev unavailable (${outcome.reason}), shown anyway` };
  const p = bool(outcome.answers, "useful");
  if (p === undefined) return { show: true, reason: "Jev gave no answer, shown anyway" };
  return { show: p >= config.threshold, reason: `Jev ${p.toFixed(2)} ${p >= config.threshold ? ">=" : "<"} ${config.threshold}` };
}

type Block = { type?: string; text?: string };

/** Strip the tag lines from an assistant message. Returns the replacement (if changed) and the suggestion. */
export function processAssistant(message: { role?: string; content?: unknown }, maxChars: number) {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return { suggestion: undefined, replacement: undefined };
  let suggestion: string | undefined;
  let changed = false;
  const content = (message.content as Block[]).map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const out = extractNext(block.text, maxChars);
    if (!out.found) return block;
    changed = true;
    suggestion = out.suggestion;
    return { ...block, text: out.text };
  });
  return { suggestion, replacement: changed ? { ...message, content } : undefined };
}

export default function nextPrompt(pi: ExtensionAPI) {
  let config: NextPromptConfig = DEFAULT_CONFIG;
  let sessionOn = true;
  let ui: ExtensionUIContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let userPrompt = "";
  let pending: Pending | undefined;
  let outcome: string | undefined;
  let shown: string | undefined;
  let generation = 0;
  let lastVerdict = "";

  const active = () => sessionOn && config.enabled;

  const hide = () => {
    if (shown === undefined) return;
    shown = undefined;
    ui?.setWidget(WIDGET_KEY, undefined);
  };

  const reset = () => {
    generation++;
    pending = undefined;
    outcome = undefined;
    hide();
  };

  const show = (text: string) => {
    if (!ui) return;
    shown = text;
    const hint = `${keyLabel(config.acceptKeys[0] ?? "tab")} to accept`;
    ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width: number) => [truncateToWidth(`${theme.fg("dim", `→ ${text}`)}  ${theme.fg("muted", hint)}`, width)],
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    );
  };

  const onKey = (data: string) => {
    if (shown === undefined || !ui || isKeyRelease(data)) return undefined;
    const accept = config.acceptKeys.some((key) => matchesKey(data, key as KeyId));
    if (accept && ui.getEditorText() === "") {
      const text = shown;
      hide();
      ui.setEditorText(text);
      return { consume: true };
    }
    // Typing dismisses: once the key has reached the editor, hide if it left text there.
    setTimeout(() => {
      if (shown !== undefined && ui && ui.getEditorText() !== "") hide();
    }, 0);
    return undefined;
  };

  const attach = (ctx: ExtensionContext) => {
    unsubscribe?.();
    unsubscribe = undefined;
    ui = ctx.hasUI ? ctx.ui : undefined;
    if (ui) unsubscribe = ui.onTerminalInput(onKey);
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("next-prompt", DEFAULT_CONFIG, ctx.cwd);
    reset();
    attach(ctx);
  });

  pi.on("session_shutdown", () => {
    reset();
    unsubscribe?.();
    unsubscribe = undefined;
    ui = undefined;
  });

  pi.on("session_compact", () => reset());
  pi.on("input", () => {
    hide();
    return undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    config = loadConfig("next-prompt", DEFAULT_CONFIG, ctx.cwd);
    userPrompt = event.prompt;
    // Only interactive sessions get the instruction: print mode and subagents have nowhere to show it.
    if (!active() || !ctx.hasUI) return undefined;
    event.systemPromptOptions.sections[SECTION] = INSTRUCTION;
    return undefined;
  });

  pi.on("agent_start", () => reset());

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant") return undefined;
    const { suggestion, replacement } = processAssistant(message, config.maxChars);
    // The latest assistant message decides: a tag before a tool call is superseded by the final answer.
    pending = suggestion
      ? { suggestion, userPrompt, assistantTail: messageText((replacement ?? message).content) }
      : undefined;
    return replacement ? { message: replacement as typeof event.message } : undefined;
  });

  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
    return undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const candidate = pending;
    pending = undefined;
    if (!candidate || outcome !== "completed" || !active() || !ui) return;
    const mine = ++generation;
    const verdict = await vet(ctx.modelRegistry, config.jev, candidate);
    lastVerdict = `"${candidate.suggestion}": ${verdict.show ? "shown" : "held back"} (${verdict.reason})`;
    if (mine !== generation || !verdict.show || ui.getEditorText() !== "") return;
    show(candidate.suggestion);
  });

  pi.registerCommand("next-prompt", {
    description: "next-prompt: status, on, or off (this session)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        sessionOn = arg === "on";
        if (!sessionOn) reset();
        ctx.ui.notify(`next-prompt ${arg} for this session`, "info");
        return;
      }
      ctx.ui.notify(
        `next-prompt ${active() ? "on" : "off"}${shown ? `, showing "${shown}"` : ""}. Last suggestion: ${lastVerdict || "none yet"}.`,
        "info",
      );
    },
  });
}

function keyLabel(key: string) {
  return key
    .split("+")
    .map((part) => (part.length === 1 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("+");
}
