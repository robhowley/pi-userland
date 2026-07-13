# pi-session-deck

A TUI dashboard for Pi sessions: live windows, worktrees, PRs, activity, and statuses in one place.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

## Commands

- `/session-deck` — browse current sessions. In TUI mode, it opens an interactive browser with a repo filter row above the session list; elsewhere, it prints a compact snapshot.
- `/session-deck --all` — include stale, dead, and unknown sessions, plus diagnostics.
- `/session-deck --reap` — remove expired presence records before showing results.
- `/session-deck --identity` — include full identity details such as the session id.
- `/session-deck --json --session-id <id>` — print one visible `SessionDeckRecord` as pretty JSON and bypass the TUI browser.
- In JSON mode, `--all` widens eligibility to dead/unknown sessions; `--identity` does not change the JSON payload.
- Flags can be combined.

## TUI keys

- `↑/↓` move selection.
- `←/→` switch repo filters in the row above the session list.
- `enter` toggle details.
- `o` open the selected terminal target on macOS when captured terminal metadata is available. iTerm2 sessions use the iTerm2 reveal URL; tmux sessions open a new iTerm2 tab that attaches to the existing tmux session.
- `r` refresh.
- `q` / `esc` close.

## What it provides

- Heartbeat-backed session presence.
- Session names from `/name` or `--name`.
- Current activity such as `idle`, `thinking`, `tool-running`, and `error`.
- Repo, PR, and linked-worktree context in the dashboard.
- Short status chips in `/session-deck`.
- `/new` resets activity for the new session while keeping the same runtime.
- Tmux-aware terminal opening: when Pi is running inside tmux, `o` attaches to the existing tmux session after verifying the pane is live. It never starts Pi and never creates tmux sessions.

## Status chips

`pi-session-deck` can mirror visible `ctx.ui.setStatus()` text into lightweight per-session chips so `/session-deck` can show short status labels.

- Mirrors visible `setStatus()` text automatically.
- Persists sanitized visible text only.
- Never stores prompts, transcript content, tool args, or tool outputs in chips.

## Terminal opening and tmux

Tmux-backed rows use an iTerm2 Python bridge by default. Install the packaged AutoLaunch script by symlinking or copying:

```shell
mkdir -p "$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch"
ln -sf "$(pwd)/extensions/session-deck/iterm2-python-bridge.py" \
  "$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch/pi-session-deck-bridge.py"
```

Restart iTerm2 after installing. The bridge is only needed for tmux-backed rows and only opens a new iTerm2 tab that attaches to an existing tmux session. Configure with:

- `PI_SESSION_DECK_TERMINAL_BRIDGE=auto` (default) — try the Python bridge, then AppleScript fallback if the bridge is unavailable.
- `PI_SESSION_DECK_TERMINAL_BRIDGE=iterm2-python` — require the Python bridge.
- `PI_SESSION_DECK_TERMINAL_BRIDGE=iterm2-applescript` — use AppleScript fallback directly.
- `PI_SESSION_DECK_TERMINAL_BRIDGE=none` — disable tmux terminal opening.
- `PI_SESSION_DECK_ITERM2_BRIDGE_SOCKET=/path/to/socket` — override the bridge socket path.

Read-only `/session-deck` text and JSON modes do not require the bridge.

## Privacy limits

- Activity capture is current-state only; there is no transcript/history reconstruction.
- It does not persist prompt text, transcript snippets, tool args, or tool outputs.
- Tool failures are reduced to compact safe summaries like `tool bash failed`.
- Assistant errors are sanitized/truncated before persistence.
- Chip text must not contain prompts, messages, tool arguments, tool outputs, or secrets.
- Public `/session-deck --json` records do not include raw terminal metadata, tmux socket paths, pane ids, or derived attach commands.
