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
