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
```

Junction creates the branch and worktree, or reuses an exact match. It opens a new cmux workspace and leaves the current one focused.

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

Each command starts a fresh Pi session, including when reusing a worktree. If cmux fails after creating the worktree, the worktree remains; run the command again to retry.

Junction does not delete branches or worktrees.
