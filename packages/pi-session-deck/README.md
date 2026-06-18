# pi-session-deck

Pi runtime presence foundation plus session identity/activity sidecars. P4 chips are still **backend-only** today: `pi-session-deck` writes chip JSON sidecars, but `/session-deck` does not read or render them yet.

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

- Heartbeat-backed presence tracking.
- Session identity sidecars at `~/.pi/session-deck/identity/${runtimeId}.json`, including `sessionName` when set via `/name` or `--name`.
- Current activity sidecars at `~/.pi/session-deck/activity/${runtimeId}.json`.
- Chip sidecars at `~/.pi/session-deck/chips/${runtimeId}/${source}.${chipId}.${scope}.json`.
- Zero-touch mirroring of visible `ctx.ui.setStatus()` footer statuses into chip files.
- `/new` resets activity for the new sessionId while keeping the same runtimeId.
- Compact activity states: `waiting`, `thinking`, `tool-running`, `error`, `unknown`.

## P4 chips — zero-touch `setStatus()` mirroring

If another extension already calls `ctx.ui.setStatus(key, text)`, `pi-session-deck` can mirror that visible footer status into a chip JSON file with no source-package changes.

### Mirror source

The mirror reads the documented footer data surface:

- `ctx.ui.setFooter((tui, theme, footerData) => ...)`
- `footerData.getExtensionStatuses(): ReadonlyMap<string, string>`

This means chip mirroring is **TUI/footer-only** in v1. Non-UI runs do not emit mirrored chips.

### Mirrored record mapping

Each visible status becomes one session-scoped chip file:

```ts
interface SessionDeckChipRecord {
  schemaVersion: 1;
  runtimeId: string;
  sessionId: string | null;
  source: string;
  chipId: string;
  scope: 'session' | 'runtime';
  text: string;
  level: 'ok' | 'info' | 'warn' | 'error' | 'unknown';
  updatedAt: string;
  ttlMs?: number;
}
```

Default mirrored fields:

- `source = status key`
- `chipId = "default"`
- `scope = "session"`
- `level = "unknown"`
- `text = sanitized visible status text`
- `updatedAt = observation time`
- `runtimeId` from the shared presence runtime
- `sessionId` from `ctx.sessionManager.getSessionId()`

### Mirroring rules

- Writes or replaces `${source}.default.session.json` on add/change.
- Clears the chip file when the status disappears.
- Strips ANSI/control characters, collapses whitespace, and trims before persistence.
- Treats empty-after-sanitize text as absent.
- Resets mirror snapshot state on each `session_start`.
- Clears tracked mirrored chips on `/new` and `session_shutdown`.
- Fails open: diagnostics only, no throws through render or event paths.

### Path convention

```text
~/.pi/session-deck/chips/{runtimeId}/{source}.{chipId}.{scope}.json
~/.pi/session-deck/chips/{runtimeId}/.{source}.{chipId}.{scope}.{uuid}.tmp
```

### Limits

- The mirror only sees key + visible text, so v1 does **not** recover source-owned `level`, `ttlMs`, multiple chip IDs, or runtime scope.
- Extensions that do not use `ctx.ui.setStatus()` are not mirrored automatically.
- `/session-deck` does not consume chip files yet; this is backend groundwork only.

## Optional low-level publisher helper

A manual publisher helper still exists for custom pipelines, but it is no longer the primary P4 integration story:

```ts
import {
  publishSessionDeckChip,
  clearSessionDeckChip,
} from '@robhowley/pi-session-deck/extensions/session-deck/chips/publisher.js';
```

It reuses the same validation and atomic write path as the mirror.

## Privacy limits

- Activity capture is current-state only; there is no transcript/history reconstruction.
- The sidecar does not persist prompt text, transcript snippets, tool args, or tool outputs.
- Tool failures are reduced to compact safe summaries like `tool bash failed`.
- Assistant errors are sanitized/truncated before persistence.
- Chip text must not contain prompts, messages, tool arguments, tool outputs, or secrets.
