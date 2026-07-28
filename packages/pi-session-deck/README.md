# pi-session-deck

One place to launch, monitor, reopen, and end Pi agents across repos, worktrees, and terminals.

Pi agents are most useful when they can work independently, but that can scatter context across terminal tabs, repos, and worktrees. Session Deck gives them one operational view: see what is running, understand what each agent is doing, and return to the right terminal without hunting for it.

Open Session Deck as a native Pi TUI with `/session-deck`, or keep it visible as an always-on iTerm2 Toolbelt sidebar.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-overview.png" alt="Session Deck iTerm2 Toolbelt showing live Pi agent sessions grouped under pi-userland" width="720">

## What you get

- **Agents organized by repo.** See all of your live sessions in their project context. Collapse repos that do not need attention. Temp child-runtime sessions stay hidden, with active spawned counts shown on their parent detail.
- **Detailed status at a glance.** Names, liveness, current activity, branch and worktree context, PR state, and status chips stay together.
- **A reliable way back.** Focus an active iTerm2 session or reattach to an existing tmux session from the deck.
- **End sessions without losing their history.** Preserve session history when an agent is done.
- **New isolated agents on demand.** Start Pi on a generated Git worktree in detached tmux and let it keep running headlessly.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-repos.png" alt="Session Deck iTerm2 Toolbelt showing Pi agents organized across betterby-bike and pi-userland repos" width="720">

Repo groups make a busy deck readable: expand the work in motion, collapse everything else, and keep each agent's branch, activity, and status close at hand.

## Launch, return, and end sessions

Use `w` in the Pi TUI or **＋ New** in the Toolbelt to start an agent on a new branch. Session Deck gives it an isolated Git worktree and detached tmux session, so it can keep working without occupying a terminal tab.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt.png" alt="Session Deck iTerm2 Toolbelt branch composer for launching a new Pi agent on a worktree" width="720">

When you are ready to return, use `o` or **↗ Open** to focus or reattach to that agent's existing terminal. **↗ Open** always returns to the existing session; it never launches a duplicate.

When an agent is done, end it with `k` in the Pi TUI or **End session** in the Toolbelt.

Ghostty exact focus is supported on macOS with Ghostty 1.3 or newer when Ghostty AppleScript is enabled (`macos-applescript` is not `false`). macOS may ask for Automation permission for the terminal or Node process to control Ghostty; if the prompt appears during first startup and the session is not captured, grant permission and restart that Pi session.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

### Native Pi TUI

Run inside Pi:

```text
/session-deck
```

### iTerm2 Toolbelt

Install the Toolbelt integration:

```text
/session-deck iterm2 install
```

Enable the iTerm2 Python API if prompted, fully quit and reopen iTerm2, then open **Toolbelt → Session Deck**. If the view is missing, stale, or unable to launch/open an agent, run `/session-deck iterm2 doctor`.

The native TUI, text output, and JSON output do not require iTerm2 setup.

## Command reference

| Command                                  | Purpose                                     |
| ---------------------------------------- | ------------------------------------------- |
| `/session-deck`                          | Browse current sessions.                    |
| `/session-deck --all`                    | Include stale, dead, and unknown sessions.  |
| `/session-deck --reap`                   | Clear expired sessions from the deck.       |
| `/session-deck --identity`               | Show full session identity details.         |
| `/session-deck --json --session-id <id>` | Print one visible session record as JSON.   |
| `/session-deck iterm2 install`           | Install the iTerm2 Toolbelt integration.    |
| `/session-deck iterm2 doctor`            | Diagnose Toolbelt setup and runtime issues. |
| `/session-deck iterm2 uninstall`         | Remove the iTerm2 Toolbelt integration.     |

Flags can be combined.

## TUI controls

| Key       | Action                                                      |
| --------- | ----------------------------------------------------------- |
| `↑` / `↓` | Move between sessions.                                      |
| `←` / `→` | Switch repo filters.                                        |
| `enter`   | Toggle session details.                                     |
| `w`       | Launch a Pi agent on a generated worktree in detached tmux. |
| `o`       | Open or focus the selected agent's terminal.                |
| `k`       | End the selected session.                                   |
| `r`       | Refresh.                                                    |
| `q`       | Close Session Deck.                                         |
| `esc`     | Cancel an open prompt, or close Session Deck.               |

## Privacy

Session Deck observes current operational state, not conversation history.

- It does not persist prompts, transcript content, tool arguments, or tool output.
- Status chips contain sanitized visible text only.
- Tool and assistant errors are reduced to compact, safe summaries.
- Public JSON and the Toolbelt view omit raw terminal metadata and tmux attach details.
- Ghostty focus stores only a private terminal UUID in the identity sidecar. Ghostty window/tab IDs, titles, cwd, and commands are not stored in public JSON, Toolbelt requests, or browser records.

## Terminal focus smoke checks

1. In Ghostty on macOS, verify AppleScript returns `{version, id}` for the focused terminal.
2. Plain Ghostty: start Pi, open `/session-deck`, select the session, press `o`, and confirm the existing Ghostty surface focuses.
3. Ghostty + attached tmux: start Pi inside an attached Ghostty tmux pane; `o` should focus the host surface. If that host is gone while tmux is still alive, `o` falls back to the existing tmux attach path.
4. Detached tmux from Session Deck (`w` / Toolbelt New): Open should attach through the existing tmux path and not focus an unrelated Ghostty window.
5. Plain iTerm2 and tmux+iTerm2 should keep their existing focus/attach behavior.
6. `/session-deck --json`, Toolbelt snapshots, and browser records should contain no Ghostty UUIDs or raw terminal metadata.
