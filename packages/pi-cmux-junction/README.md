# pi-cmux-junction

Start work on another Git branch in a new cmux workspace without leaving your current Pi session.

## Install

```shell
pi install npm:@robhowley/pi-cmux-junction
```

## Use

From Pi running inside cmux in a Git repository:

```text
/junction --branch feature/example
/junction fork --branch feature/example
```

Junction creates or reuses the branch's worktree, opens it in a new cmux workspace, and keeps your current workspace focused.

`/junction` starts a fresh Pi session. `/junction fork` waits for the current session to become idle, then starts with its saved conversation. It carries the conversation, not uncommitted files.

New branches start from the repository's default branch.

## Detailed agent status

Junction adds a live status pill that follows Pi's lifecycle events. Compared with cmux's standard Pi session hook, it can show `Tool running: subagent` instead of just `Running`, and `Thinking` instead of leaving an earlier error as the current status.

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-cmux-junction/img/status-tool-running-comparison.png" alt="Junction reports Tool running: subagent while the standard cmux status reports Running" width="666">

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-cmux-junction/img/status-thinking-comparison.png" alt="Junction reports Thinking while the standard cmux status still reports an earlier error" width="670">

The pill reports:

- `Idle`
- `Thinking`
- `Tool running` or `Tool running: <name>`
- `Needs input`
- `Compacting`
- `Error`
- `Unknown`

It works alongside cmux's standard Pi status, so you can keep both visible. It does not inspect or retain your conversation or terminal contents.

Detailed status requires Pi 0.84.2 or newer. Set `PI_CMUX_JUNCTION_LIFECYCLE_DISABLED=1` to hide it while keeping `/junction` available.

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

Junction leaves worktrees in place for reuse. It never deletes branches or worktrees.
