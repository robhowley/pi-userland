# pi-session-deck

A control plane for your Pi agents: live sessions organized by repo, detailed status tracking, terminal multiplexing, and new-agent launches in one place.

Pi agents are most useful when they can work independently, but that can scatter context across terminal tabs, repos, and worktrees. Session Deck gives them one operational view: see what is running, understand what each agent is doing, and return to the right terminal without hunting for it.

Open Session Deck as a native Pi TUI with `/session-deck`, or keep it visible as an always-on iTerm2 Toolbelt sidebar.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-overview.png" alt="Session Deck iTerm2 Toolbelt showing live Pi agent sessions grouped under pi-userland" width="720">

## What you get

- **Agents organized by repo.** See every live session in its project context and collapse repos that do not need attention.
- **Detailed status at a glance.** Names, liveness, current activity, branch and worktree context, PR state, and safe status chips stay together.
- **A reliable way back.** Focus an active iTerm2 session or reattach to an existing tmux session from the deck.
- **New isolated agents on demand.** Start Pi on a generated Git worktree in detached tmux and let it keep running headlessly.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-repos.png" alt="Session Deck iTerm2 Toolbelt showing Pi agents organized across betterby-bike and pi-userland repos" width="720">

Repo groups make a busy deck readable: expand the work in motion, collapse everything else, and keep each agent's branch, activity, and status close at hand.

## Launch and return

Use `w` in the Pi TUI or **＋ New** in the Toolbelt to start an agent on a new branch. Session Deck gives it an isolated Git worktree and detached tmux session, so it can keep working without occupying a terminal tab.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt.png" alt="Session Deck iTerm2 Toolbelt branch composer for launching a new Pi agent on a worktree" width="720">

When you are ready to return, use `o` or **↗ Open** to focus or reattach to that agent's existing terminal. Opening and launching stay separate, so returning to an agent never starts another one.

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
| `r`       | Refresh.                                                    |
| `q`       | Close Session Deck.                                         |
| `esc`     | Cancel the branch prompt, or close Session Deck.            |

## Privacy

Session Deck observes current operational state, not conversation history.

- It does not persist prompts, transcript content, tool arguments, or tool output.
- Status chips contain sanitized visible text only.
- Tool and assistant errors are reduced to compact, safe summaries.
- Public JSON and the Toolbelt view omit raw terminal metadata and tmux attach details.
