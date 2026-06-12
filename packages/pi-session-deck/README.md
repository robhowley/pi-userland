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

## CLI startup usage

You can pass the slash command as Pi's initial CLI message:

```bash
pi "/session-deck"
pi "/session-deck --all"
pi "/session-deck --reap"
pi "/session-deck --all --reap"
```

Quote the whole slash command. Otherwise flags like `--all` and `--reap` may be parsed as Pi CLI flags instead of command arguments.

These examples assume `pi-session-deck` is installed and registered in that runtime. If it is not, Pi may treat the string as a normal user prompt instead of intercepting it as an extension command.
