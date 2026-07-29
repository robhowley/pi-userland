# pi-session-deck

**The full Pi session lifecycle in one place.**

Create and organize Pi sessions across repos and worktrees, see what each agent is doing or waiting on, and reopen or end them from a TUI, desktop app, or iTerm2 Toolbelt.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-overview.png" alt="Session Deck iTerm2 Toolbelt showing live Pi agent sessions grouped under pi-userland" width="720">

Session Deck turns agents scattered across terminals, repos, worktrees, and background tmux sessions into one operational view.

## The session lifecycle

* **Launch isolated agents.** Create a branch, Git worktree, and detached tmux session in one flow. The agent can keep working without occupying a terminal tab.
* **Know what your agent is doing at a glance.** Distinct activity states show what is working, waiting, or in need of attention.
* **Keep work in context.** Sessions stay grouped by repo with their branch, worktree, pull request, status chips, and current activity close at hand.
* **Return without hunting.** Focus an existing iTerm2 session or reattach to the agent's tmux session directly from the deck.
* **End sessions cleanly.** Stop an agent when its work is done without deleting its session history.

Session Deck gives each activity state its own icon, so the deck remains scannable without relying on color alone.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-activity-states.svg" alt="Session Deck Toolbelt activity icons for idle, thinking, tool-running, needs input, compacting, error, and unknown states" width="720">

Temporary child runtimes stay folded into their parent session, keeping the deck readable while still showing how many spawned agents are active.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-repos.png" alt="Session Deck iTerm2 Toolbelt showing Pi agents organized across betterby-bike and pi-userland repos" width="720">

## One deck, three surfaces

Use Session Deck wherever it fits your workflow:

* **Native Pi TUI** for a fast, keyboard-driven view inside Pi.
* **Desktop app** for a dedicated, always-available session window.
* **iTerm2 Toolbelt** for an operational sidebar beside your terminals.

In iTerm2, Session Deck stays visible beside your terminals, giving you an integrated view of every active agent while you work.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-iterm2-integrated.png" alt="Session Deck running as an iTerm2 Toolbelt beside an active Pi terminal session" width="1200">

Each surface shows the same underlying sessions and gives you the same path through their lifecycle: launch, monitor, reopen, and end.

## Launch, reopen, and end

Use `w` in the Pi TUI or **＋ New** in the Toolbelt to launch Pi on a new branch. Session Deck creates an isolated Git worktree and detached tmux session, allowing the agent to continue headlessly.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt.png" alt="Session Deck iTerm2 Toolbelt branch composer for launching a new Pi agent on a worktree" width="720">

Use `o` or **↗ Open** to return to an agent. Session Deck focuses its existing iTerm2 session when possible or reattaches to its tmux session. It never launches a duplicate.

Use `k` or **End session** when the agent is done. Its runtime stops, but its session history remains available to Pi.

## Installation

```shell
pi install npm:@robhowley/pi-session-deck
```

### Native Pi TUI

Run inside Pi:

```text
/session-deck
```

### Desktop app

Install the Session Deck desktop app:

```text
/session-deck desktop install
```

### iTerm2 Toolbelt

Install Session Deck as an iTerm2 Toolbelt:

```text
/session-deck iterm2 install
```

Enable the iTerm2 Python API if prompted, fully quit and reopen iTerm2, then open **Toolbelt → Session Deck**.

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
| `/session-deck desktop install`          | Install the desktop app.                    |
| `/session-deck desktop doctor`           | Diagnose the desktop app setup and runtime. |
| `/session-deck desktop uninstall`        | Remove the desktop app.                     |

Flags can be combined.

## TUI controls

| Key       | Action                                              |
| --------- | --------------------------------------------------- |
| `↑` / `↓` | Move between sessions.                              |
| `←` / `→` | Switch repo filters.                                |
| `enter`   | Toggle session details.                             |
| `w`       | Launch Pi on a generated worktree in detached tmux. |
| `o`       | Open or focus the selected agent's terminal.        |
| `k`       | End the selected session.                           |
| `r`       | Refresh the deck.                                   |
| `q`       | Close Session Deck.                                 |
| `esc`     | Cancel an open prompt or close Session Deck.        |

## Privacy

Session Deck observes operational state, not conversation history.

* It does not persist prompts, transcript content, tool arguments, or tool output.
* Status chips contain sanitized visible text only.
* Tool and assistant errors are reduced to compact, safe summaries.
* JSON output, the desktop app, and the Toolbelt omit raw terminal metadata and tmux attachment details.
