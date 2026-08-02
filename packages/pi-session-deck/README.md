# pi-session-deck

**The full Pi session lifecycle in one place.**

Create and organize Pi sessions across repos and worktrees, see what each agent is doing or waiting on, and reopen or end them from a TUI, desktop app, or iTerm2 Toolbelt.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-iterm2-integrated.png" alt="Session Deck running as an iTerm2 Toolbelt beside an active Pi terminal session" width="1200">

Session Deck turns agents scattered across terminals, repos, worktrees, and background tmux sessions into one operational view.

## The session lifecycle

- **Launch isolated agents.** Create a branch, Git worktree, and detached tmux session in one flow. The agent can keep working without occupying a terminal tab.
- **Know what every agent is doing at a glance.** See which agents are working, waiting, or need attention.
- **Keep work in context.** Sessions stay grouped by repo with their branch, worktree, pull request, status chips, and current activity close at hand.
- **Return without hunting.** Focus an existing terminal or reattach to the agent's tmux session directly from the deck.
- **End sessions cleanly.** Stop an agent when its work is done without deleting its session history.

Session Deck gives each activity state its own icon, so the deck remains scannable without relying on color alone.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-activity-states.svg" alt="Session Deck Toolbelt activity icons for idle, thinking, tool-running, needs input, compacting, error, and unknown states" width="720">

Temporary child runtimes stay folded into their parent session, keeping the deck readable while still showing how many spawned agents are active.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-repos.png" alt="Session Deck iTerm2 Toolbelt showing Pi agents organized across betterby-bike and pi-userland repos" width="720">

## One deck, three surfaces

Use Session Deck wherever it fits your workflow:

- **Native Pi TUI** for a fast, keyboard-driven view inside Pi.
- **Desktop app** for a dedicated, always-available session window.
- **iTerm2 Toolbelt** for an operational sidebar beside your terminals.

Each surface shows the same underlying sessions and gives you the same path through their lifecycle: launch, monitor, reopen, restart, and end.

## Projects

Repository grouping is always the default. Projects are optional, user-named groups edited in the desktop app or iTerm2 Toolbelt; the Pi TUI can browse them with `g` but is read-only. Grouping does not change the separate live/default and `--all` record scope.

Membership is manual and exact: one non-null Pi `sessionId` maps to one opaque project ID. Session Deck never infers membership from a repository, cwd, path, branch, worktree, runtime ID, or lineage. Unassigned and null-ID sessions stay under their normal repository fallback. A new session is unassigned unless its exact session ID is assigned through the web UI.

Project data is stored in private files under `~/.pi/session-deck/projects/`: project records in `catalog/` and exact session-ID mappings in `memberships/`. Deleting a project does not delete sessions, history, branches, or worktrees. Its membership files become inert orphans, and affected sessions return to repository fallback; project IDs are not reused.

Projects do not add automatic placement, launch-time project choice, TUI editing, rename, bulk assignment, nesting, custom ordering, sync, import/export, or automatic orphan cleanup.

## Launch, reopen, restart, and end

Use `w` in the Pi TUI or **＋ New** in the Toolbelt to launch Pi on a new branch. Session Deck creates an isolated Git worktree and detached tmux session, allowing the agent to continue headlessly.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt.png" alt="Session Deck iTerm2 Toolbelt branch composer for launching a new Pi agent on a worktree" width="720">

Use `o` or **↗ Open** to return to an agent. Session Deck focuses its existing iTerm2 session when possible or reattaches to its tmux session. It never launches a duplicate.

Use uppercase `R` or **Restart Session** when a Session Deck-managed tmux Pi is unresponsive. Restart resumes the exact session file in the same pane and keeps its Session Deck runtime ID. It may force-kill Pi after two seconds and can lose in-flight work. Legacy, manual, direct-terminal, self-hosting TUI, and sessions with live child processes are not restartable.

Use `k` or **End session** when the agent is done. Its runtime stops, but its session history remains available to Pi. End Session keeps its existing SIGTERM-only behavior.

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

| Key       | Action                                         |
| --------- | ---------------------------------------------- |
| `↑` / `↓` | Move between sessions.                         |
| `←` / `→` | Switch repository or project filters.          |
| `g`       | Switch between Repository and Projects views.  |
| `enter`   | Toggle session details.                        |
| `w`       | Launch from a named filter in Repository view. |
| `o`       | Open or focus the selected agent's terminal.   |
| `R`       | Restart an eligible managed tmux session.      |
| `k`       | End the selected session.                      |
| `r`       | Refresh the deck.                              |
| `q`       | Close Session Deck.                            |
| `esc`     | Cancel an open prompt or close Session Deck.   |

## Privacy

Session Deck observes operational state, not conversation history.

- It does not persist prompts, transcript content, tool arguments, or tool output.
- Status chips contain sanitized visible text only.
- Tool and assistant errors are reduced to compact, safe summaries.
- Managed restart recipes are private user-only files. They contain only the fixed executable/PATH, agent/session directory intent, cwd, exact tmux target, session binding, and process generation needed to restart safely.
- Project directories are user-only (`0700`) and project/membership files are user-only (`0600`). They contain project names, opaque project IDs, and exact session IDs, never conversation content.
- JSON output, restart results, the desktop app, and the Toolbelt omit recipes, session-file paths, commands, PATH, raw terminal metadata, and tmux attachment details.
