# pi-session-deck

Pi runtime presence foundation + session identity layer: heartbeat-backed presence records, liveness classification, session identity records (sessionId, cwd, worktree, branch, PR URL), Git/PR resolution, and joined session views.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

## Commands

- `/session-deck` shows live and stale Pi runtime presence records with joined identity fields.
- `/session-deck --all` includes dead and unknown presence records plus read diagnostics.
- `/session-deck --reap` removes presence records older than the 24h reap threshold.
- `/session-deck --identity` shows identity records for each runtime.
- `/session-deck --all --reap --identity` combines all modes; flag order does not matter.

## What it provides

- Heartbeat-backed presence tracking with live/stale/dead classification.
- Session identity records stored at `~/.pi/session-deck/identity/${runtimeId}.json`.
- Git worktree/branch/remote resolution and PR URL lookup (gh CLI + remote fallback).
- Identity refresh on `session_start` and `/new` events (45s periodic refresh).
- Joined views that merge presence and identity data per runtimeId.
- Identity freshness classification (fresh ≤2m, stale ≤30m, very_stale).
