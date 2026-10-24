# HmmDefender

**Protection against LLM "stuck-loop" degeneration in [OpenCode](https://opencode.ai).**

Detects degenerate repetition in a model's reasoning stream (`hmm, hmm, hmm: hmm, hmm: …`),
interrupts the generation, cleans the conversation history and makes the agent continue
from a concrete next step.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen)
![OpenCode](https://img.shields.io/badge/OpenCode-2.x-black)

> Русская документация: [README.md](README.md)

---

## The problem

Reasoning models occasionally get stuck repeating themselves. The agent burns tokens
until it hits the output limit:

```
hmm, hmm, hmm: hmm, hmm: hmm, hmm: hmm, hmm, hmm: hmm, hmm,
: hmm: hmm: hmm: hmm: hmm: hmm: hmm: hmm: hmm: hmm: hmm: ...
```

This project was born from a real incident in a live OpenCode session: a single assistant
message grew to **1,266,382 characters** of pure `": hmm: hmm: …"`.

Three kinds of degeneration are detected:

| Kind | What repeats | Example |
| --- | --- | --- |
| `filler` | filler words | `hmm: hmm: hmm: …`, `um, uh, um …` |
| `word-period` | a block of words / a whole phrase | the same sentence 3+ times in a row |
| `char-period` | a block of characters, no spaces | `TheTheTheTheThe…` |

## What it does

1. **Watches** the model reasoning stream in real time.
2. **Interrupts** the generation as soon as a loop is found (`session.interrupt`).
3. **Resumes** the work — sends the agent a short nudge ("name ONE concrete next step and do it").
4. **Repairs history** — before the next request the repetitive fragment is cut out of the
   model messages, so the model is not re-infected by its own garbage.
5. **Prevents** — appends a short anti-repetition rule to the system prompt.

Everything is configurable and can be turned off piece by piece.

## Installation

### Requirements

- **OpenCode 2.x** (plugin API V2: `ctx.event.subscribe`, `ctx.session.hook`, `ctx.session.interrupt`).
- **Node.js 22.18+** — only to run the tests. The plugin itself runs inside OpenCode (Bun).
- No build step: OpenCode executes TypeScript directly.

### Option 1. Global (recommended)

OpenCode scans `~/.config/opencode/plugins/` and loads every subdirectory as a plugin.

**Windows (PowerShell):**

```powershell
git clone https://github.com/craftinglivegames/HmmDefender.git `
  "$env:USERPROFILE\.config\opencode\plugins\hmm-defender"
```

**macOS / Linux:**

```bash
git clone https://github.com/craftinglivegames/HmmDefender.git \
  ~/.config/opencode/plugins/hmm-defender
```

Restart OpenCode — that's it.

### Option 2. Project-local

```
<project>/.opencode/plugins/hmm-defender/
├── index.ts
├── detect.ts
└── package.json
```

```bash
mkdir -p .opencode/plugins
git clone https://github.com/craftinglivegames/HmmDefender.git \
  .opencode/plugins/hmm-defender
```

### Option 3. Explicit path in `opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/me/tools/HmmDefender"]
}
```

With inline options:

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/me/tools/HmmDefender",
      "options": { "interrupt": true, "resume": true, "fillerMinHits": 10 }
    }
  ]
}
```

### Verify

Call `hmm_defender_status` in OpenCode. It reports the active settings, counters and the
log path. You can also test the detector directly:

```
hmm_defender_check(text: "hmm, hmm, hmm: hmm, hmm: hmm, hmm: hmm, hmm, hmm: hmm, hmm,")
→ { "loop": true, "kind": "filler", "ratio": 1, "repeats": 12, "period": 1, "cut": 0 }
```

If nothing shows up, check `~/.local/share/opencode/log/opencode.log` for
`loading plugin` / `failed to load plugin`.

If the log says `Cannot find module '@opencode/plugin'`:

```bash
cd ~/.config/opencode/plugins/hmm-defender && npm install @opencode/plugin
```

### Update / uninstall

```bash
cd ~/.config/opencode/plugins/hmm-defender && git pull
rm -rf ~/.config/opencode/plugins/hmm-defender
```

## Configuration

Settings are read from `config.json` next to the plugin (copy `config.example.json`) and/or
from the `options` object in `opencode.json` (the latter wins).

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `interrupt` | `true` | Abort the generation on a detected loop |
| `resume` | `true` | Ask the model to continue after the abort |
| `prevention` | `true` | Append the anti-repetition rule to the system prompt |
| `pollText` | `false` | Additionally poll the text output every 3 s (slower) |
| `maxRescues` | `3` | Max interventions per session |
| `checkEvery` | `256` | Run a full check every N new characters |
| `log` | `true` | Write a log file |
| `debug` | `false` | Verbose logging |
| `logPath` | `hmm-defender.log` | Log path |
| `resumeDelayMs` | `2500` | Delay before the "continue" nudge |
| `pollIntervalMs` | `3000` | Poll interval for `pollText` |

### Detector thresholds

| Option | Default | Meaning |
| --- | --- | --- |
| `fillerMinHits` | `8` | Filler words in a row required to report a loop |
| `fillerMinRatio` | `0.5` | Filler share among words in the tail |
| `fillerWords` | `hmm, um, uh, …` | Filler word list |
| `wordPeriodMax` | `64` | Max repeated block length in words |
| `wordMinRepeats` | `3` | Repeats required for a word-level loop |
| `wordSimilarity` | `0.8` | Share of matching words in the period |
| `charPeriodMax` | `384` | Max period length in characters |
| `charMinRepeats` | `4` | Repeats required for a char-level loop |
| `charSimilarity` | `0.8` | Share of matching characters in the period |
| `minLoopChars` | `40` | Minimum length of the repeating region |
| `maxScanChars` | `20000` | How many trailing characters to scan |

Tuning: raise `fillerMinHits`/`wordSimilarity` if it fires too often, lower them if it
misses loops. Use `hmm_defender_check` to test thresholds on real text.

## Tools

| Tool | Purpose |
| --- | --- |
| `hmm_defender_check` | Run any text through the detector: `loop`, `kind`, `ratio`, `repeats`, `period`, `cut`. |
| `hmm_defender_status` | Current settings, counters (loops / rescues / repaired blocks), per-session step state, log path. |

## How it works

```
OpenCode V2 event stream
        │  session.reasoning.delta
        ▼
  ┌─────────────┐   loop?    ┌───────────────────────┐
  │  detectLoop │ ─────────► │ ctx.session.interrupt │  generation stopped
  └─────────────┘            └───────────────────────┘
                                        │  +2.5 s
                                        ▼
                            "continue from the next step" nudge
                                        │
                                        ▼
                  context hook: cut the garbage out of history + system rule
```

- Only the trailing 20 000 characters of reasoning are kept in memory.
- Full checks run every `checkEvery` characters (plus a cheap filler heuristic) — low CPU cost.
- Period matching is fuzzy: real loops "wobble" (extra comma, truncated word), so the
  detector compares similarity ratios instead of exact equality.
- History is repaired in the `context` hook — right before the request is sent, without
  touching the stored conversation.
- Duplicate plugin instances (OpenCode creates one per project directory) are deduplicated
  through a shared rescue log.

## Limitations

- OpenCode V2 publishes only **reasoning** deltas in the event stream. A loop in the plain
  text answer is caught on the next request via history repair. Use `pollText: true` for
  near-real-time text monitoring (heavier).
- Interrupting does not undo already executed tools.
- The abort is not instantaneous: the provider may keep streaming briefly.
- OpenCode 1.x is not supported (different plugin API).

## Tests

```bash
node test/detect.test.mjs   # 17 checks, Node 22.18+
npm test
```

Fixtures in `test/fixtures/` are real degenerate fragments captured from live sessions,
plus texts the detector must **not** flag.

## License

[MIT](LICENSE) © craftinglivegames
