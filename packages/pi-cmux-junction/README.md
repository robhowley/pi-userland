# pi-cmux-junction

Create or reuse a Git worktree and start a fresh Pi session in a new cmux workspace without leaving the current workspace.

## Installation

```shell
pi install npm:@robhowley/pi-cmux-junction
```

## Branch command

```text
/junction --branch feature/example
```

The command accepts exactly one `--branch` value. The branch must pass `git check-ref-format --branch`. The exact branch name is used in Git and as the cmux workspace name; only its worktree path segment is cleaned and lowercased.

Junction resolves the repository from Pi's current working directory. Worktrees are placed under `~/.pi/cmux-junction-worktrees/` by default. Set `PI_CMUX_JUNCTION_WORKTREE_ROOT` to replace that root; blank values use the default. The value may be an absolute path, `~`, or `~/...` (tilde expansion is lexical). Relative paths and `~user` forms are rejected.

The generated path is flat:

```text
<root>/<repo-slug>--<repo-id>-<branch-slug>
```

For example, repository `pi-userland` and exact branch `f/t` use:

```text
~/.pi/cmux-junction-worktrees/pi-userland--<repo-id>-f-t
```

`repo-slug` and `branch-slug` are filesystem labels. `repo-id` is the first 12 lowercase hex characters of SHA-256 over the absolute lexical common Git directory. Branches do not add an ID. Git and cmux always receive the exact trimmed branch name. Different exact branches that clean to the same `branch-slug` target the same path and fail with a path collision; Junction does not add a disambiguating suffix.

The base is pinned to a commit before creation. Junction tries `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`, then `HEAD`. It reuses a worktree only when both its generated flat absolute path and exact branch match. Existing path or branch collisions fail without mutation.

Changing the root does not move, adopt, copy, or delete existing nested, sibling, or other-root worktrees. A same-branch worktree under an old path remains a branch collision; restoring the old root enables exact reuse.

Before changing Git, Junction requires:

- nonblank inherited `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`;
- a successful read-only `cmux capabilities` check;
- `pi` on `PATH`.

After creation or exact reuse, Junction runs the argv equivalent of:

```shell
cmux workspace create \
  --name feature/example \
  --cwd /absolute/path/to/worktree \
  --command 'exec pi' \
  --focus false
```

The new workspace is not focused. No shell interpolation or `--window` routing is used.

If cmux launch fails, the worktree is retained. The error reports its branch and path and suggests retrying `/junction --branch <name>`. A reused worktree still launches a new workspace on every successful command.

## Current limits

This first slice starts a fresh Pi conversation. It does not reuse cmux workspaces, parse workspace IDs, fork conversations, verify Pi after launch, customize the base or path, or clean up worktrees and branches.
