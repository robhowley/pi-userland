# pi-session-deck

A terminal-native overview of all your live Pi sessions: status, usage, cwd, branch, model, and last activity in one compact deck.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

## Commands

- `/session-deck` shows live and stale runtimes.
- `/session-deck --all` shows all runtime states plus diagnostics.
- `/session-deck --reap` removes expired presence records, reports what changed, and shows the refreshed view.
