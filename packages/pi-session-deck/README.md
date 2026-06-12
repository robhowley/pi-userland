# pi-session-deck

Pi runtime presence foundation: heartbeat-backed presence records with live/stale views, optional --all diagnostics, and --reap cleanup.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

## Commands

- `/session-deck` shows live and stale Pi runtime presence records.
- `/session-deck --all` includes dead and unknown presence records plus read diagnostics.
- `/session-deck --reap` removes presence records older than the 24h reap threshold, reports how many were removed, and shows the refreshed default view.
- `/session-deck --all --reap` combines both modes; flag order does not matter.
