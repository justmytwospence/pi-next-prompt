# pi-next-prompt

A [pi](https://pi.dev) extension that suggests the prompt you would most likely send next, like
Claude Code's prompt suggestions: after a run, a dim line under the editor shows it, `Tab` (or
`Right`) on an empty editor fills it in (it is not sent), and typing dismisses it.

```
→ Do step 2: add an assert for neg in test.js  Tab to accept
```

It only appears when there is one obvious next step. Most turns show nothing.

## How it works

- **The main model writes the suggestion.** A short prompt section (`next_prompt`, about 150
  tokens, cached with the rest of the system prompt) asks the model to end its final message with
  one line `<next>…</next>` only when exactly one concrete next step is obvious, and to leave it
  out when the task is done, when it needs your input, when several steps are equally likely, or
  after an error. No extra model request; the suggestion costs ~20 output tokens when there is one.
- **The line never stays in context.** `message_end` removes it before the message is stored, so
  the session file and every later request carry the answer without it. While the answer streams,
  the line is visible for a moment before it is removed.
- **Jev vets it.** [Jev](https://docs.typesafe.ai), through Pi's classifier models, is asked whether
  the suggestion is a concrete, non-generic next step that follows from the answer and is not done
  yet; it is shown at probability >= 0.6. If Jev is unavailable (no `TYPESAFE_API_KEY`, timeout),
  the suggestion is shown anyway.
- Shown only after a run that completed (not aborted or failed), and only in interactive sessions:
  print mode and subagents get no instruction. A new prompt, a new run, compaction, or switching
  session clears it.

The line sits below the editor rather than inside it, so it works with any editor component
(pi-vim's included). `Tab`/`Right` are taken only while a suggestion is shown and the editor is
empty; otherwise they reach the editor as usual.

## Commands

- `/next-prompt` or `/next-prompt status`: on or off, and the last suggestion with Jev's verdict.
- `/next-prompt on`, `/next-prompt off`: for this session (off also drops the prompt section).

## Settings

`~/.config/agents/next-prompt.json` (`$XDG_CONFIG_HOME` honored) and `<project>/.agents/next-prompt.json`
are shared with the opencode port; `~/.pi/agent/next-prompt.json` and `<project>/.pi/next-prompt.json`
are pi-only. Read in that order, each merged on top of the last.

```json
{
  "enabled": true,
  "acceptKeys": ["tab", "right"],
  "maxChars": 110,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 1500, "threshold": 0.6 }
}
```

`acceptKeys` are pi-tui key ids (`tab`, `right`, `ctrl+f`, ...). Requires Pi 1.0 or newer.

## Development

```sh
npm run check   # typecheck and unit tests
```
