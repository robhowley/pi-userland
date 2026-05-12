# pi-openrouter

A [Pi](https://pi.dev/) extension for live OpenRouter visibility and environment sync: usage/account TUI overlays, automatic `session_id` tagging, and user-scoped model catalog sync.

## Installation

```shell
pi install npm:@robhowley/pi-openrouter
```

## Requirements

Set one of these environment variables:

- `OPENROUTER_MANAGEMENT_KEY` (preferred), provides full usage data including model breakdowns
- `OPENROUTER_API_KEY`, basic usage data plus user-scoped model sync

```shell
export OPENROUTER_MANAGEMENT_KEY=sk-or-...
```

## Commands

```bash
/openrouter usage                    # usage/spend overlay
/openrouter account                  # credits, key limits, account health
/openrouter session                  # current OpenRouter session_id
/openrouter models-sync              # sync user-scoped OpenRouter models into Pi
/openrouter models-status            # show model sync/cache status
/openrouter models-status --skipped  # show skipped model reasons
```

## Model catalog sync

`pi-openrouter` can sync Pi’s OpenRouter model catalog from your user-scoped OpenRouter model list.

`/openrouter models-sync`

The sync uses OpenRouter’s authenticated user model catalog, so Pi can see the models available to your account instead of only the default provider list.

`/openrouter models-status`

Example status output:

```text
OpenRouter models healthy
363 registered · 2 skipped · cache age: 2m
```

To see why models were skipped:

`/openrouter models-status --skipped`

Skipped models do not make the sync fail; models are skipped when required metadata cannot be safely mapped into Pi’s provider model config. The last successful catalog is cached so Pi can keep using it if a later refresh fails, and the cache persists across sessions. If a session starts with a cached catalog that has not been registered yet, status will show:

```text
OpenRouter models cached
368 models in cache · age: 4m
Run '/openrouter models-sync' to register models
```

## Usage overlay

Type `/openrouter usage` in Pi to open the usage overlay.

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

Type `/openrouter account` in Pi to open the account health overlay.

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

`pi-openrouter` automatically tags OpenRouter requests with a `session_id` derived from the Pi session ID.

View the OpenRouter session tag with:

```bash
/openrouter session

# OpenRouter session_id
pi:[uuid]
```

## License

MIT
