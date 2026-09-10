# pi-cmux-junction

Branch into parallel Pi sessions: open Git worktrees in new cmux workspaces, fork conversations, and see what every agent is doing at a glance.

## Install

```shell
pi install npm:@robhowley/pi-cmux-junction
```

## Use

From Pi running inside cmux in a Git repository:

```text
/junction --branch <name> [--tab]
/junction --branch <name> --from <commit-ish> [--tab]
/junction fork --branch <name> [--tab]
/junction fork --branch <name> --from <commit-ish> [--tab]
/junction checkout --branch <local-branch> [--tab]
```

Run `/junction` without arguments or `/junction help` to show this help. `--tab` is optional; omitting it creates a new cmux workspace exactly as before. The current workspace stays focused.

- `/junction --branch <name> [--tab]` — create a new worktree from the default base or reuse a matching worktree; start a fresh Pi session.
- `/junction --branch <name> --from <commit-ish> [--tab]` — create a new worktree from the specified commit-ish (never reuse); start a fresh Pi session.
- `/junction fork --branch <name> [--tab]` — wait for the current persisted session to idle, then create a new worktree from the default base or reuse a matching worktree; fork the conversation.
- `/junction fork --branch <name> --from <commit-ish> [--tab]` — wait for the current persisted session to idle, then create a new worktree from the specified commit-ish (never reuse); fork the conversation.
- `/junction checkout --branch <local-branch> [--tab]` — open an existing local branch in its worktree; start a fresh Pi session.

New sessions open in the same directory in the new worktree. If that directory is unavailable, Junction opens the worktree root and warns you. It uses the same Pi config directory and does not create missing directories or copy uncommitted files.

No-`--from` forms use the repository's default base when creating a worktree and may reuse a matching worktree. Forms with `--from <commit-ish>` always create a new branch worktree from that committed ref and reject existing branch or path collisions.

`checkout` requires the exact name of an existing local branch, uses its current tip, and does not accept `--from`.

### Tab placement

With `--tab`, Junction targets the invoking Pi surface's live cmux workspace and the pane containing that surface. It creates one terminal surface there with focus false and does not issue a later focus command, so it does not steal focus.

A tab launch has two steps: Junction creates the terminal surface, then submits exactly one command containing a self-cleaning launch script. A successful result means cmux accepted that submitted command; it does not mean Pi finished startup.

For `fork`, Junction captures the source session after waiting for it to go idle. The new tab starts a new Pi child session from that capture. The child self-registers from its own CMUX identity; the parent does not register it.

If tab creation or `send` is ambiguous, or `send` fails after creation, the tab may be blank or partially launched. v1 leaves it for inspection and does not auto-close it.

Only failures proven to have made no cmux tab mutation may offer a proof-gated retry. Retained-worktree retries keep `--tab` and follow the existing `--from` rule: an explicit `--from` is dropped on retry, while checkout keeps its existing form. Unknown creation and existing-tab states never retry automatically.

## Detailed agent status

Junction adds detailed and accurate live status updates to get quick insight into what your Pi agents are doing. It distinguishes input waits that need your attention from active work:

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-cmux-junction/img/status-needs-input-comparison.png" alt="Junction reports Needs input while the standard cmux status reports Running" width="670">

It also identifies the active tool instead of reporting only `Running`:

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-cmux-junction/img/status-tool-running-comparison.png" alt="Junction reports Tool running: subagent while the standard cmux status reports Running" width="666">

The pill reports:

- `Idle`
- `Thinking`
- `Tool running` or `Tool running: <name>`
- `Needs input`
- `Compacting`
- `Error`
- `Unknown`

Status pills are enabled by default, but can be disabled in either the global or project `settings.json`:

```json
{ "pi-cmux-junction": { "disableStatus": true } }
```

A project setting overrides the global setting. After editing a settings file directly, run `/reload`; settings from untrusted projects do not apply. Disabling status only hides the pill; `/junction` commands and session restore remain available.

## Session restore

When cmux recreates a terminal after an app relaunch or agent hibernation, Junction can reopen the same persisted Pi conversation in that surface. No Junction setting is required, and restore remains active when the status pill is hidden.

Junction resumes with `pi --session <current-id>` and preserves these startup options:

| Setting              | Options                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Model                | `--model`, `-m`, `--thinking`, `--provider`                                                  |
| Extensions           | `--extension`, `-e`, `--skill`, `--mcp-config`                                               |
| Available tools†     | `--tools`, `-t`, `--exclude-tools`, `-xt`, `--no-tools`, `-nt`, `--no-builtin-tools`, `-nbt` |
| Permissions          | `--permission-mode`, `--trust`, `--sandbox`, `--dangerously-skip-permissions`, `--yolo`      |
| Configuration        | `--session-dir`, `--config`, `--profile`                                                     |
| Prompt configuration | `--system-prompt`, `--append-system-prompt`                                                  |
| Working directory    | `--cwd`, `--dir`                                                                             |
| Output               | `--no-color`                                                                                 |

† Tool-selection options are preserved by Junction but not by cmux's official Pi extension.

Options that take values are kept only when their values are complete. Tool-selection options require separate values, such as `--tools read,bash`; `--tools=read,bash` is not replayed. Junction replaces old session, resume, and fork selectors with the current session ID. It does not replay API keys, user prompts passed through `--prompt` or `--print`, positional input, unknown options, or anything after `--`.

Restore is available only for persisted interactive sessions running inside cmux. Junction does not register it for ephemeral or `--no-session` sessions, non-TUI sessions, missing cmux identity, unsupported cmux versions, or bindings that cmux cannot verify. Registration failures do not interrupt Pi.

cmux still decides whether and when to relaunch the session through its restore, trust, and hibernation settings. Junction clears its old registration when the Pi session quits or changes so cmux does not reopen the wrong conversation.

Restore reopens saved conversation history. It cannot recover an interrupted model turn, unsaved process state, or a terminal that cmux did not persist.

## Worktrees

Worktrees live under:

```text
~/.pi/cmux-junction-worktrees/
```

Their names include the repository owner, repository, and branch when available:

```text
robhowley-pi-userland-feature-example
```

Set `PI_CMUX_JUNCTION_WORKTREE_ROOT` to another location. It accepts an absolute path, `~`, or a path under `~/`.

Junction leaves worktrees in place. It reuses one only when the expected path and branch match; otherwise, it stops without changing existing Git state.
