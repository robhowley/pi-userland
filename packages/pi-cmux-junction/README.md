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

Junction resolves the repository from Pi's current working directory. It creates a sibling worktree named:

```text
<repo>-wt-<branch-slug>
```

The base is pinned to a commit before creation. Junction tries `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`, then `HEAD`. It reuses a worktree only when both its absolute path and branch match. Existing path or branch collisions fail without mutation.

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
