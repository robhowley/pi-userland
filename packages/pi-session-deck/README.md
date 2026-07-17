# pi-session-deck

A control plane for your Pi agents: live sessions organized by repo, detailed status tracking, terminal multiplexing, and new-agent launches in one place.

Session Deck gives each Pi agent a live operating surface across the native Pi TUI and iTerm2 Toolbelt UI. Run it with `/session-deck` inside Pi, or install the iTerm2 Toolbelt view for an always-on sidebar.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-overview.png" alt="Session Deck iTerm2 Toolbelt showing live Pi agent sessions grouped under pi-userland" width="720">

Organize live agents by repository so each repo group carries its session count, quick launch action, and collapsed or expanded state.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt-repos.png" alt="Session Deck iTerm2 Toolbelt showing Pi agents organized across betterby-bike and pi-userland repos" width="720">

Track detailed status at a glance: liveness, current activity, branch context, PR state, safe status chips, and terminal-open affordances stay attached to each agent row.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-session-deck/img/session-deck-toolbelt.png" alt="Session Deck iTerm2 Toolbelt branch composer for launching a new Pi agent on a worktree" width="720">

Launch new agents from **＋ New**. Session Deck creates or reuses a generated Git worktree and starts Pi headlessly in a detached tmux session, so the agent keeps running until you reattach to it.

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
- `/session-deck iterm2 install [--scripts-dir <path>]` — install the single `session_deck.py` AutoLaunch script and install state.
- `/session-deck iterm2 doctor` — verify the installed state, AutoLaunch script, helpers, web assets, local doctor PATH context, and the live effective PATH used by Toolbelt `＋ New` and tmux Open preflight, then print manual recovery hints.
- `/session-deck iterm2 uninstall` — remove the state-owned AutoLaunch script and install state.
- Flags can be combined.

## TUI keys

- `↑/↓` move selection.
- `←/→` switch repo filters in the row above the session list.
- `enter` toggle details.
- `w` prompts for an exact branch name from the active named repo filter, then creates/reuses a generated Git worktree and starts/reuses a detached tmux Pi session there. This is a new Pi session flow; there is no worktree-only mode.
- `o` open the selected terminal target on macOS when captured terminal metadata is available. iTerm2 sessions focus through the installed Session Deck iTerm2 runtime when available; tmux sessions open a new iTerm2 tab that attaches to the existing tmux session. `o` is attach-only: it never creates a worktree, tmux session, or Pi process.
- `r` refresh.
- `q` closes. `esc` closes unless the `w` prompt is open, where `esc` / `ctrl+c` cancel the prompt without closing the browser.

## iTerm2 Toolbelt

`pi-session-deck` can install an iTerm2 Toolbelt view backed by the same public `SessionDeckSnapshot` / `SessionDeckRecord` data that `/session-deck` already uses. Session rows include **↗ Open**, which posts only the row `runtimeId` to focus the captured iTerm2 session or attach to the existing tmux session. Repo groups include **＋ New**, which opens a branch-name composer for a new Pi session on a generated worktree. The composer posts to a narrow localhost action route and uses the shared TypeScript worktree action to create/reuse a generated Git worktree and start `pi` in detached tmux. There is no Toolbelt worktree-only mode.

1. Install the package.
2. Run `/session-deck iterm2 install`.
3. Enable the iTerm2 Python API if prompted.
4. Fully quit iTerm2 and reopen it, then open `Toolbelt → Session Deck`.
5. Run `/session-deck iterm2 doctor` if the Toolbelt does not appear, the snapshot looks stale, or `＋ New` cannot find `tmux`/`pi`.

Notes:

- The main session snapshot remains read-only: refresh, collapsible session-card browsing, and a `Show all` diagnostics toggle. Toolbelt actions use narrow authenticated localhost routes with JSON body caps, helper timeouts, and fixed Node helper argv: `POST /actions/open-terminal` accepts only `{ runtimeId }`, while `POST /actions/create-worktree` owns `＋ New`.
- `＋ New` completes once the worktree is ready and the detached tmux Pi launch succeeds or is reused. Session Deck observes the new runtime passively after launch; success does not wait for an immediate runtime id or visibility in the browser/Toolbelt list.
- The installed `session_deck.py` AutoLaunch script starts one Session Deck iTerm2 process that binds to `127.0.0.1`, reads snapshots through the package-owned helper, runs Open and create-worktree actions through dedicated helpers, and exposes the local Unix socket used by `/session-deck` TUI and Toolbelt Open terminal focus.
- The TypeScript client resolves that socket from the installed state rather than guessing a temporary path.
- `＋ New` resolves symbolic `tmux` and `pi` from the running AutoLaunch process's effective PATH. At runtime Session Deck asks the configured user shell for PATH, falls back to the inherited GUI/AutoLaunch PATH if shell discovery fails, and never hard-codes Homebrew/Nix/asdf/mise directories or persists executable paths in `install.json`.
- `/session-deck iterm2 doctor` shows `local Pi doctor process PATH (context only)` plus the authoritative live effective PATH used by `＋ New` and tmux Open preflight.
- If the live effective PATH is missing `tmux`, `＋ New` and tmux-backed Open cannot verify/attach the existing tmux session. If it is missing `pi`, `＋ New` fails before worktree mutation or detached tmux launch. There is no Toolbelt worktree-only mode.
- After install changes, fully quit and reopen iTerm2. Copying new AutoLaunch files does not update an already-running AutoLaunch process.
- Local repo builds need `pnpm --dir packages/pi-session-deck run build` before install so the snapshot, Open, and create-worktree helpers exist in `dist/`.

## What it provides

- Heartbeat-backed session presence.
- Session names from `/name` or `--name`.
- Current activity such as `idle`, `thinking`, `tool-running`, and `error`.
- Repo, PR, and linked-worktree context in the dashboard.
- Short status chips in `/session-deck`.
- `/new` resets activity for the new session while keeping the same runtime.
- Tmux-aware terminal opening: when Pi is running inside tmux, `o` attaches to the existing tmux session after verifying the pane is live. It never starts Pi and never creates tmux sessions; new branch/worktree launch belongs to `w` / Toolbelt **＋ New**.

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

Fully quit iTerm2 and reopen it, then choose **Scripts → AutoLaunch → `session_deck.py`** from the menu if it is not already running. Copying new AutoLaunch files does not update an already-running AutoLaunch process, so a full quit/reopen is required after install changes. There is no standalone bridge script to start.

Read-only `/session-deck` text and JSON modes do not require iTerm2 setup.

## Privacy limits

- Activity capture is current-state only; there is no transcript/history reconstruction.
- It does not persist prompt text, transcript snippets, tool args, or tool outputs.
- Tool failures are reduced to compact safe summaries like `tool bash failed`.
- Assistant errors are sanitized/truncated before persistence.
- Chip text must not contain prompts, messages, tool arguments, tool outputs, or secrets.
- Public `/session-deck --json` records and Toolbelt snapshots do not include raw terminal metadata, tmux socket paths, pane ids, reveal URLs, or derived attach commands; Toolbelt Open sends only `{ runtimeId }`.
