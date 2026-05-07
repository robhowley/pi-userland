# pi-openrouter

A [Pi](https://pi.dev/) extension for OpenRouter usage and session visibility, with an `/openrouter-usage` terminal overlay for spend, caps, burn rate, live tracking, and model breakdowns, plus automatic `session_id` tagging for dashboard grouping.

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

## Session tracking

`pi-openrouter` automatically tags OpenRouter requests with `session_id` field set to the Pi session's ID.

Can view the Pi session ID with

```bash
/session  # [uuid]
```

The session can be tracked in OpenRouter's logs under the following ID:

```bash
/openrouter-session

# OpenRouter session_id
pi:[uuid]
```

This feature allows for session level tracking the OpenRouter → Logs → Sessions page. It does not use Pi session names, local paths, repo names, branches, or other local identifiers.

## License

MIT
