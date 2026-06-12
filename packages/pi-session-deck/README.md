# pi-session-deck

A terminal-native overview of all your live Pi sessions: status, usage, cwd, branch, model, and last activity in one compact deck.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

## Commands

- `/session-deck` shows live and stale Pi sessions.
- `/session-deck --all` includes dead and unknown records plus read diagnostics.
- `/session-deck --reap` removes presence records older than the 24h reap threshold, reports how many were removed, and shows the refreshed default view.
- `/session-deck --all --reap` combines both modes; flag order does not matter.

