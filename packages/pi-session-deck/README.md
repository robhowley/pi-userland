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
- Backend chip sidecars plus a manual publisher helper for explicit chip writes.
- `/new` resets activity for the new sessionId while keeping the same runtimeId.
- Compact activity states: `waiting`, `thinking`, `tool-running`, `error`, `unknown`.

## P4 chips — manual publishing only today

`pi-session-deck` keeps the chip backend, but normal sessions do **not** auto-mirror `ctx.ui.setStatus()` output into chip files.

Why: under current public Pi APIs, the only documented way to read extension statuses is through a custom footer callback:

- `ctx.ui.setFooter((tui, theme, footerData) => ...)`
- `footerData.getExtensionStatuses(): ReadonlyMap<string, string>`

`ctx.ui.setFooter(...)` replaces the built-in Pi footer, so using it for "read-only" mirroring regresses core footer behavior. `pi-session-deck` therefore keeps only the explicit chip publishing backend until Pi exposes a passive observer.

### What remains available today

- Chip JSON schema, store paths, and atomic write/clear helpers remain in place.
- The optional low-level publisher helper is the safe current path for explicit chip writes.

### Current chip record shape

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

### Path convention

```text
~/.pi/session-deck/chips/{runtimeId}/{source}.{chipId}.{scope}.json
~/.pi/session-deck/chips/{runtimeId}/.{source}.{chipId}.{scope}.{uuid}.tmp
```

### Limits

- Until Pi exposes a passive observer, normal sessions do not mirror `ctx.ui.setStatus()` output automatically.
- A future safe observer would still only see key + visible text, not source-owned `level`, `ttlMs`, multiple chip IDs, or runtime scope.
- `/session-deck` does not consume chip files yet; this is backend groundwork only.

## Optional low-level publisher helper

A manual publisher helper exists for custom pipelines and is the safe current P4 integration path:

```ts
import {
  publishSessionDeckChip,
  clearSessionDeckChip,
} from '@robhowley/pi-session-deck/extensions/session-deck/chips/publisher.js';
```

It reuses the same validation and atomic write path as the underlying chip writer.

## Privacy limits

- Activity capture is current-state only; there is no transcript/history reconstruction.
- The sidecar does not persist prompt text, transcript snippets, tool args, or tool outputs.
- Tool failures are reduced to compact safe summaries like `tool bash failed`.
- Assistant errors are sanitized/truncated before persistence.
- Chip text must not contain prompts, messages, tool arguments, tool outputs, or secrets.
