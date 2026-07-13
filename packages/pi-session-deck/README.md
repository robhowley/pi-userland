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

## iTerm2 setup

After installing the package, run:

```text
/session-deck iterm2 install
```

Restart iTerm2, then choose **Scripts → AutoLaunch → `session_deck_toolbelt.py`** from the menu if it is not already running.

Read-only `/session-deck` text and JSON modes do not require iTerm2 setup.

## Privacy limits

- Activity capture is current-state only; there is no transcript/history reconstruction.
- It does not persist prompt text, transcript snippets, tool args, or tool outputs.
- Tool failures are reduced to compact safe summaries like `tool bash failed`.
- Assistant errors are sanitized/truncated before persistence.
- Chip text must not contain prompts, messages, tool arguments, tool outputs, or secrets.
- Public `/session-deck --json` records do not include raw terminal metadata, tmux socket paths, pane ids, or derived attach commands.
