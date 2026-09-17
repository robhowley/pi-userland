# session-hygiene

A tiny Pi extension that adds a session-health light to the status bar.

```text
🟢 ctx ok
🟡 ctx watch
🔴 ctx compact
```

Health is based on:

- **Cumulative assistant cost** for the current session branch
- **Current context tokens** from `ctx.getContextUsage()`

The extension also publishes a separate cache chip when token usage data is available:

- **Prompt cache hit rate** as `cache <percent>` from `cacheRead / (input + cacheRead)`

It only updates the status bar. It does **not** prompt, auto-compact, or inject guidance into responses.

## Status Example

```text
~/src/my-project (main)
↑34 ↓18k R868k W175k $1.982 7.4%/1.0M (auto)
🟡 ctx watch
cache 98%
```

## Default Thresholds

| Level     | Cost | Context     |
| --------- | ---- | ----------- |
| 🟡 Yellow | $5   | 100K tokens |
| 🔴 Red    | $15  | 200K tokens |

## Command

### `/session-hygiene`

Opens interactive threshold configuration. You can pick a preset or enter custom values, then the status bar refreshes immediately.

## Configuration

Config lives at `~/.pi/agent/extensions/session-hygiene/config.json`:

```json
{
  "yellow": { "cost": 5, "context": 100000 },
  "red": { "cost": 15, "context": 200000 }
}
```

If the file is missing or invalid, the extension falls back to the Default preset. Successful saves use `0600` permissions.

### Presets

| Preset           | Yellow            | Red               |
| ---------------- | ----------------- | ----------------- |
| **Conservative** | $2 / 60K tokens   | $8 / 120K tokens  |
| **Default**      | $5 / 100K tokens  | $15 / 200K tokens |
| **Relaxed**      | $10 / 150K tokens | $25 / 250K tokens |
| **Custom**       | you decide        | you decide        |

Validation rejects non-positive or non-numeric values, and any config where yellow is not strictly below red.

## When It Updates

- **`session_start`** — reload config, reconstruct assistant cost from branch history, paint the status bar
- **`turn_end`** — add the latest assistant cost and cache stats, refresh the status bar
- **`session_compact`** — reset running cost/cache totals and repaint from current context usage
