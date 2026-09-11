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

Run `/junction` without arguments or `/junction help` to show this help. Add `--tab` as the final argument to open the new Pi session in the same cmux pane and workspace as the current session; otherwise, Junction opens a new workspace. Both leave your current focus unchanged.

- `/junction --branch <name> [--tab]` — create a new worktree from the default base or reuse a matching worktree; start a fresh Pi session.
- `/junction --branch <name> --from <commit-ish> [--tab]` — create a new worktree from the specified commit-ish (never reuse); start a fresh Pi session.
- `/junction fork --branch <name> [--tab]` — wait for the current persisted session to idle, then create a new worktree from the default base or reuse a matching worktree; fork the conversation.
- `/junction fork --branch <name> --from <commit-ish> [--tab]` — wait for the current persisted session to idle, then create a new worktree from the specified commit-ish (never reuse); fork the conversation.
- `/junction checkout --branch <local-branch> [--tab]` — open an existing local branch in its worktree; start a fresh Pi session.

New sessions open in the same directory in the new worktree. If that directory is unavailable, Junction opens the worktree root and warns you. It uses the same Pi config directory and does not create missing directories or copy uncommitted files.

No-`--from` forms use the repository's default base when creating a worktree and may reuse a matching worktree. Forms with `--from <commit-ish>` always create a new branch worktree from that committed ref and reject existing branch or path collisions.

`checkout` requires the exact name of an existing local branch, uses its current tip, and does not accept `--from`.

When opening a tab, Junction creates it and then asks cmux to start Pi. A success message confirms that cmux accepted the start command, not that Pi has finished starting. If startup is uncertain, Junction leaves the tab and worktree in place for inspection. It retries only when it can prove that no tab was created; the retry keeps `--tab` and drops `--from` because the worktree already exists.

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

A project setting overrides the global setting. After editing a settings file directly, run `/reload`; settings from untrusted projects do not apply. Disabling status only hides the pill; `/junction` commands remain available. Junction does not manage cmux session restore.

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
