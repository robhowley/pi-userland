# pi-session-deck

Pi runtime presence foundation + session identity/activity layers: heartbeat-backed presence records, liveness classification, session identity records (sessionId, cwd, worktree, branch, PR URL), and current activity snapshots joined per runtimeId.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

## Commands

- `/session-deck` shows live and stale Pi runtime rows with joined identity + current activity.
- `/session-deck --all` includes dead and unknown presence records plus read diagnostics.
- `/session-deck --reap` removes presence records older than the 24h reap threshold.
- `/session-deck --identity` shows extra identity details for each runtime.
- `/session-deck --all --reap --identity` combines all modes; flag order does not matter.

## What it provides

- Heartbeat-backed presence tracking with live/stale/dead classification.
- Session identity records stored at `~/.pi/session-deck/identity/${runtimeId}.json`.
- Current activity snapshots stored at `~/.pi/session-deck/activity/${runtimeId}.json`.
- Activity refresh driven by direct runtime events (`session_start`, `message_end`, `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`).
- Joined views that merge presence, identity, and current activity per runtimeId.
- `/new` resets activity for the new sessionId while keeping the same runtimeId.
- Compact activity states: `waiting`, `thinking`, `tool-running`, `error`, `unknown`.

## Privacy limits

- Activity capture is current-state only; there is no transcript/history reconstruction.
- The sidecar does not persist prompt text, transcript snippets, tool args, or tool outputs.
- Tool failures are reduced to compact safe summaries like `tool bash failed`.
- Assistant errors are sanitized/truncated before persistence.
