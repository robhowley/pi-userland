# pi-cmux-junction

Create or reuse a Git worktree and start a fresh Pi session in a new cmux workspace without leaving the current workspace.

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

Junction creates the branch and worktree, or reuses an exact match. It opens a new cmux workspace and leaves the current one focused. The `fork` form waits for Pi to become idle, then starts the new session with the current persisted session history.

Use a valid Git branch name. New branches start from the repository's default branch, with `main`, `master`, and the current `HEAD` as fallbacks.

Branch or path conflicts stop the command without changes.

## Junction lifecycle status

In eligible cmux TUI sessions, Junction publishes its own workspace status under the `pi-junction` key. It reports seven labels:

- `Idle`
- `Thinking`
- `Tool running` or `Tool running: <name>`
- `Needs input`
- `Compacting`
- `Error`
- `Unknown`

Lifecycle status activates only in Pi's TUI mode when `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, and the Pi session ID are all present and nonblank. It stays off when `CI` is nonblank. Set `PI_CMUX_JUNCTION_LIFECYCLE_DISABLED=1` to opt out without disabling `/junction`.

Junction owns only `pi-junction`. It does not inspect, write, clear, suppress, or coordinate with the official cmux `pi` status or hook. Either extension can be installed alone, and both can be installed at once as independent pills.

Lifecycle records only the inherited cmux and Pi IDs, a process/runtime identity, protocol counters and timestamps, one of the seven states, and a bounded safe tool name when available. It does not retain prompts, messages, tool arguments or output, raw errors, cwd, titles, branches, TTY data, terminal content, or the cmux socket password.

cmux status keys have no lease or TTL. If the coordinator and all clients crash together, `pi-junction` can remain until a later Junction session reconciles it, it is manually cleared, or cmux resets the workspace. A cmux outage that outlasts the final bounded clear retries has the same residual limit. UI waits opened through Pi's public `select`, `input`, `editor`, and `confirm` methods are observed; core dialogs, custom components, and dialogs opened before lifecycle setup are not.

## Worktrees

Worktrees live under:

```text
~/.pi/cmux-junction-worktrees/
```

Names include the repository owner, repository, and branch when available:

```text
robhowley-pi-userland-feature-example
```

Set `PI_CMUX_JUNCTION_WORKTREE_ROOT` to an absolute path, `~`, or a path under `~/` to use another root.

The regular form starts a fresh Pi session, including when reusing a worktree. The `fork` form is session-only: it carries persisted session history, not uncommitted files or an exact in-memory tree position, and requires a readable persisted source session. If launch fails, the worktree remains. Junction reports when it is safe to retry. If the outcome is uncertain, check cmux before retrying because a workspace may already exist.

Junction does not delete branches or worktrees.
