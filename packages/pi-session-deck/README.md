# pi-session-deck

Pi runtime presence foundation plus session identity/activity sidecars. `/session-deck` now reads the joined snapshot and renders a compact top-pane dashboard with chip previews plus a selected inspector.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

## Commands

- `/session-deck` opens a read-only TUI browser in Pi TUI mode and falls back to the existing compact multi-line text view elsewhere. The TUI list shows up to 12 sessions before paging.
- TUI rows are two-line dashboard rows: line 1 is `icon + activity + (sessionName ?? repoName ?? cwd basename ?? runtimeId) + repo/PR/age/branch`, and line 2 is chip preview only joined with `·` or dim `no chips` when empty.
- The selected TUI inspector stays boxed but compact: title, `cwd`, inline `branch/pr`, inline `presence/activity/heartbeat`, optional blank spacer plus inline `chips: ...`, then `runtime/pid`; `--identity` adds `session: ...` and `--all` adds compact `diagnostics:`.
- TUI browser keys: `↑/↓` move selection, `enter` toggles detail, `r` refreshes, `q`/`esc` closes.
- `/session-deck --all` includes dead and unknown presence records plus read diagnostics.
- `/session-deck --reap` removes presence records older than the 24h reap threshold before the initial view loads.
- `/session-deck --identity` shows extra identity details for each runtime, including the full session id.
- `/session-deck --all --reap --identity` combines all modes; flag order does not matter.

## What it provides

- Heartbeat-backed presence tracking.
- Session identity sidecars at `~/.pi/session-deck/identity/${runtimeId}.json`, including `sessionName` when set via `/name` or `--name`.
- Current activity sidecars at `~/.pi/session-deck/activity/${runtimeId}.json`.
- Chip sidecars at `~/.pi/session-deck/chips/${runtimeId}/${source}.${chipId}.${scope}.json`.
- Joined chip rendering in `/session-deck`, backed by chip sidecars plus a manual publisher helper for explicit chip writes.
- `/new` resets activity for the new sessionId while keeping the same runtimeId.
- Compact activity states: `waiting`, `thinking`, `tool-running`, `error`, `unknown`.

## P4 chips — automatic setStatus mirroring

`pi-session-deck` mirrors `ctx.ui.setStatus()` output into chip JSON sidecars on every session. `/session-deck` reads the joined snapshot and renders visible chip text without exposing raw chip metadata.

### How it works

`pi-session-deck` wraps `ctx.ui.setStatus` during `session_start` to capture each status call. The wrapper:

1. Calls the original `setStatus` first (footer rendering is untouched).
2. Asynchronously writes the sanitized visible text to a chip file.
3. Clears the chip file on `setStatus(key, undefined)` or empty-after-sanitize text.
4. Dedupes repeated writes for the same source + text.

This avoids using `ctx.ui.setFooter()` entirely — the native Pi footer is never replaced.

### Captured fields

| Field       | Source                                                 |
| ----------- | ------------------------------------------------------ |
| `source`    | Status key (must pass slug validation)                 |
| `text`      | Visible status text (ANSI/control stripped)            |
| `updatedAt` | Mirror time (ISO 8601)                                 |
| `runtimeId` | Presence runtime identity                              |
| `sessionId` | Current session (from `sessionManager.getSessionId()`) |

Default fallback values:

- `chipId: 'default'`
- `scope: 'session'`
- `level: 'unknown'`

### Mirroring rules

- Writes or replaces `${source}.default.session.json` on add/change.
- Strips ANSI/control characters, normalizes whitespace, and trims before persistence.
- Treats empty-after-sanitize text as absent (clears the chip).
- Dedupes: repeated identical `source + sanitizedText` does not rewrite.
- Session-scoped chips only render while their saved `sessionId` still matches the runtime's current trusted session; runtime-scoped chips can survive `/new`.
- Session shutdown clears all tracked mirrored chips.
- Repeated `session_start` does not double-wrap.

### Known limits

- If another extension calls `setStatus` during its own very early `session_start` before `pi-session-deck` installs the wrapper, that first value can be missed until the next refresh.
- Shortcut-created fresh UI contexts are not covered by the shared-context patch.
- This mirror captures footer-status text only; structured chip publishing remains the better contract for richer semantics.

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

## Optional low-level publisher helper

A manual publisher helper exists for custom pipelines and richer package-owned data:

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
