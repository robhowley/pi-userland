# pi-openrouter

A [Pi](https://pi.dev/) extension for live OpenRouter visibility: TUI overlays for spend, credits, key limits, burn rate, and model usage, plus automatic `session_id` tagging for dashboard grouping.

## Installation

```shell
pi install npm:@robhowley/pi-openrouter
```

## Requirements

Set one of these environment variables:

- `OPENROUTER_MANAGEMENT_KEY` (preferred), provides full usage data including model breakdowns
- `OPENROUTER_API_KEY`, basic usage data only

```shell
export OPENROUTER_MANAGEMENT_KEY=sk-or-...
```

## Usage

Type `/openrouter-usage` in Pi to open the usage overlay.

The overlay shows:
- **Month spend** vs cap with percentage
- **7-day spend** with burn rate projection
- **Today's spend** from live tracked turns while Activity API data catches up
- **Top models** (7d and 30d)
- **Usage by provider** (30d)
- **Daily spend** (30d)

The extension refreshes data in the background every 30 seconds (with exponential backoff on errors).

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-openrouter/img/openrouter-usage-tui.png" alt="OpenRouter Usage Overlay" width="600">

## Account health

Type `/openrouter-account` in Pi to open the account health overlay.

The overlay shows:

- **Credits** balance
- **Total usage** against available credits
- **Status by key**
- **Selected key** details
- **Key spend** vs configured limit
- **Reset cadence**
- **BYOK limit behavior**
- **All visible keys**, when a management key is configured

Select a key from the list to inspect its limit, usage, reset cadence, and BYOK behavior.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-openrouter/img/openrouter-account-tui.png" alt="OpenRouter Account Overlay" width="600">

## Session tracking

`pi-openrouter` automatically tags OpenRouter requests with `session_id` field set to the Pi session's ID.

View the Pi session ID with

```bash
/session  # [uuid]
```

The session can be tracked in OpenRouter's logs under the following ID:

```bash
/openrouter-session

# OpenRouter session_id
pi:[uuid]
```

This enables session-level tracking in the OpenRouter Logs → Sessions page.

## License

MIT
