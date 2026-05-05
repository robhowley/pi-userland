# pi-openrouter

A [Pi](https://pi.dev/) extension that adds an `/openrouter-usage` command for viewing OpenRouter spend, caps, burn rate, and model breakdowns in a terminal overlay.

## Installation

```shell
pi install npm:@robhowley/pi-openrouter
```

## Requirements

Set one of these environment variables:

- `OPENROUTER_MANAGEMENT_KEY` (preferred) — provides full usage data including model breakdowns
- `OPENROUTER_API_KEY` — basic usage data only

```shell
export OPENROUTER_MANAGEMENT_KEY=sk-or-...
```

## Usage

Type `/openrouter-usage` in Pi to open the usage overlay.

The overlay shows:
- **Month spend** vs cap with percentage
- **7-day spend** with burn rate projection
- **Today's spend**
- **Top models** (7d and 30d)
- **Usage by provider** (30d)
- **Usage by day** (last 7 days)

The extension refreshes data in the background every 30 seconds (with exponential backoff on errors).

Press `q`, `Esc`, or `Ctrl+C` to close the overlay.

## Features

- Ephemeral TUI overlay — doesn't clutter chat history
- Auto-refreshing cache — data stays fresh without repeated API calls
- Graceful degradation — works with API key only (no model breakdowns)

## License

MIT
