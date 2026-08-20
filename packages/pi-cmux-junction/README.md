# pi-cmux-junction

Branch into parallel Pi sessions: open Git worktrees in new cmux workspaces, fork conversations, and see what every agent is doing at a glance.

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

Junction preserves the repository-relative invocation directory when the equivalent destination exists and safely resolves within the worktree. Otherwise, it launches at the worktree root and reports a warning. This rule applies to both fresh and forked sessions. The destination may be tracked, ignored, or untracked; Junction does not create missing directories or copy files.

New sessions use the same effective Pi config directory as the Pi running Junction.

New branches start from the repository's default branch.

## Detailed agent status

Junction adds detailed and accurate live status updates to get quick insight into what your Pi agents are doing. Upgrade from the standard cmux Pi session hook to get better insights.

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

Status pills are enabled by default, but can be disabled in either the global or project `settings.json`:

```json
{ "pi-cmux-junction": { "disableStatus": true } }
```

A project setting overrides the global setting. After editing a settings file directly, run `/reload`; settings from untrusted projects do not apply. Disabling status only hides the pill; `/junction` commands remain available.

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
