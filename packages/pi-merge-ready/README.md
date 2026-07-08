# pi-merge-ready

A [Pi](https://pi.dev/) package for getting pull requests to green: merge-readiness signal, blocker context, and automated agent repair loops.

It adds:

- a current-branch status bar signal
- `/merge-ready` for current-branch or exact-URL status
- `/merge-ready watch` for polling PRs and handing actionable blockers off to the agent for automated repairs.
- a `merge_ready_status({ url? })` agent tool
- a `merge-ready-loop` skill for working the returned blockers

## Installation

```bash
pi install npm:@robhowley/pi-merge-ready
```

## Requirements

- Authenticated GitHub CLI (`gh`).
- `git` and `gh` available in Pi's environment.

The package is fail-closed: if GitHub data is missing, truncated, or ambiguous, it reports `status_ambiguous` instead of claiming the PR is ready.

## What it adds

### Status bar

The Pi status bar shows the current branch PR's top merge-readiness state and PR number.

Examples:

```text
✅ #64 Ready
👀 #64 Review pending
❌ #64 Checks failing
🔄 #64 Out of date
❌ #64 💬 2 unresolved
❔ No PR
```

`✅ #64 Ready` means there is no current merge-readiness review blocker. If GitHub still requires review, Pi shows `👀 #64 Review pending` instead.

Optional unresolved conversations are not blockers, but they can still appear as context:

```text
✅ #64 Mergeable · 💬 2 comments
```

### Slash command

Use `/merge-ready` to inspect the current branch PR:

```bash
/merge-ready
```

Example:

```text
✅ Ready to merge
Target: current branch feat/my-branch (owner/repo)
PR: #64 — Add PR merge-readiness extension
State: ready
Open items: none
```

You can also target an exact GitHub pull request URL:

```bash
/merge-ready --url https://github.com/OWNER/REPO/pull/64
/merge-ready --url https://github.com/OWNER/REPO/pull/64 --json
```

Example blocked/pending output:

```text
⏳ Checks are still running
Target: current branch feat/my-branch (owner/repo)
PR: #64 — Add PR merge-readiness extension
State: pending
Open items:
- Checks are still running
```

Only full HTTPS GitHub PR URLs are accepted.

Detail URLs are supporting links for blocker context, not separate action items.

### Watch mode

Start a watcher with:

```bash
/merge-ready watch
/merge-ready watch --url https://github.com/OWNER/REPO/pull/64
/merge-ready watch --url https://github.com/OWNER/REPO/pull/64 --interval 30
```

`watch` is a long-lived foreground command that polls merge readiness.
In the TUI, press `Ctrl-Shift-S` to stop it. In headless SDK sessions, stop it by aborting or disposing the backing session.

It will:

- keep polling while checks or required review are still pending
- attempt to repair PR blockers for `branch_out_of_date`, `merge_conflicts`, or `ci_failing`
- stop on non-repairable blockers or terminal PR states

Repair model:

- current-branch watch repairs use the ambient checkout after dirty-worktree preflight
- explicit `--url` watch repairs must not mutate the ambient checkout; they use an isolated worktree for the PR head repo/branch
- `--url` accepts only the same exact GitHub PR URL form as `/merge-ready --url`

Watch actionability:

| Status / lifecycle                                                                                                                           | Watch behavior                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch_out_of_date`, `merge_conflicts`, `ci_failing`                                                                                        | Auto-attempt one bounded repair turn. Current-branch watches repair in the ambient checkout after dirty-worktree preflight; explicit `--url` watches repair in an isolated worktree for the PR head repo/branch. |
| `ci_running`, `review_pending`, open PR with no `openItems` (`ready`)                                                                        | Keep polling and wait for GitHub or review state to change.                                                                                                                                                      |
| `changes_requested`, `unresolved_conversations`, `merge_blocked`, `draft`, `status_ambiguous`, `no_pull_request`, closed/merged PR lifecycle | Do not auto-repair; report the blocker or terminal state and stop.                                                                                                                                               |

Watch safety:

- Repeated-blocker guard: after one repair attempt for a blocker, `watch` does not keep retrying it without a fresh status change or explicit restart.
- Dirty-worktree preflight: current-branch `watch` repairs refuse to run when local changes are already present in the ambient checkout.
- Explicit `--url` watch repairs are instructed to use an isolated worktree for the PR head repo/branch and skip ambient dirty-worktree preflight.

### Configuration

Watch behavior can be configured in Pi's `settings.json` (global: `~/.pi/agent/settings.json`, project-local: `.pi/settings.json`).

```json
{
  "pi-merge-ready": {
    "autoCompactRepair": true
  }
}
```

| Option              | Default | Description                                                                                                                                             |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoCompactRepair` | `true`  | Trigger conversation compaction after successful repair loop completion. Compaction runs before the watch continues polling. Set to `false` to disable. |

### Watch UI

Launch the local multi-watch UI with:

```bash
/merge-ready watch-ui
```

Stop the detached watch-ui supervisor with:

```bash
/merge-ready watch-ui stop
```

It starts or reuses a detached localhost supervisor, opens a browser when possible, and always reports a fallback URL. The stop command shuts down that detached supervisor and stops any active watches it owns.

V1 notes:

- watches are URL-targeted headless Pi SDK sessions backed by persisted Pi JSONL sessions
- child watch sessions inherit the launching session's captured Pi runtime snapshot (agentDir, model, thinking level, and resolved auth); launch fails early if that runtime cannot be resolved safely
- the UI polls a token-gated `127.0.0.1` API only; there is no hosted service
- transcript inspection is read-only and uses the stored session file for the selected watch
- supported watch controls are stop, restart, and remove; the UI also shows session id/path metadata for debugging and supportability
- if the supervisor restarts, previously active watches are shown as stale rather than assumed ready

### Agent tool

Agents get a `merge_ready_status` tool:

```ts
merge_ready_status({});
merge_ready_status({ url: 'https://github.com/OWNER/REPO/pull/64' });
```

Rules:

- `state` plus `pr.lifecycle` tells you whether the PR is merge-ready
- `openItems` is the authoritative blocker list
- `openItems[].details[]` and detail URLs are provenance only
- do not pass branch names, PR numbers, repo names, or inferred targets

Example response:

```json
{
  "state": "blocked",
  "target": {
    "mode": "current_branch",
    "owner": "owner",
    "repo": "repo",
    "branch": "feat/my-branch"
  },
  "pr": {
    "lifecycle": "open",
    "number": 64,
    "title": "...",
    "url": "...",
    "headRefName": "feat/my-branch",
    "baseRefName": "main"
  },
  "summary": "Required checks are failing",
  "openItems": [{ "id": "ci_failing", "summary": "Required checks are failing" }],
  "generatedAt": "2026-05-27T00:00:00.000Z"
}
```

`openItems[].details[]` rows are supporting provenance for an open item.

```json
{
  "id": "ci_failing",
  "summary": "Required checks are failing",
  "details": [
    {
      "label": "lint",
      "status": "failing",
      "url": "https://github.com/OWNER/REPO/actions/runs/123/jobs/456"
    }
  ]
}
```

Advanced notes:

- The top-level `pr.url` is already the PR URL; do not treat it as a source link.
- When `target.mode` is `"url"`, `pr.headRepository` is also returned so callers can verify whether the editable head repo matches the targeted PR repo before changing code:

```json
{
  "headRepository": {
    "owner": "fork-owner",
    "repo": "fork-repo"
  }
}
```

- URL-targeted command results do not update the ambient status bar cache; the status bar remains current-branch only.

### Merge-ready loop skill

The package includes a `merge-ready-loop` skill for requests like "make this PR ready to merge".

The skill:

- resolves the current branch or exact PR URL target
- calls `merge_ready_status`
- works only from the returned `openItems`
- makes one small verified fix at a time
- distinguishes "addressed locally" from "confirmed cleared by GitHub"
- for watch-triggered URL repairs, uses the PR head repo/branch in an isolated worktree without mutating the ambient checkout

## Status states

| State     | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `ready`   | An open PR exists and no merge-readiness open items were found. |
| `blocked` | A blocker requires action before merge.                         |
| `pending` | Waiting on checks or required review.                           |
| `unknown` | No PR was found, readiness is ambiguous, or the PR is terminal. |

## Open item ids

| id                         | Meaning                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `no_pull_request`          | No pull request was found for the branch or exact targeted URL. |
| `status_ambiguous`         | Readiness could not be determined safely.                       |
| `merge_conflicts`          | GitHub reports merge conflicts.                                 |
| `branch_out_of_date`       | The branch is behind the base branch.                           |
| `merge_blocked`            | GitHub reports a mergeability blocker.                          |
| `draft`                    | The pull request is still a draft.                              |
| `ci_failing`               | Required checks are failing.                                    |
| `changes_requested`        | A reviewer requested changes.                                   |
| `unresolved_conversations` | Required review conversations remain open.                      |
| `ci_running`               | Required checks are still running.                              |
| `review_pending`           | Required review is still pending.                               |

Unresolved conversations are requirement-aware:

- Required unresolved conversations block merge readiness.
- Optional unresolved conversations remain in `signals`, but not in `openItems`.
- Unknown conversation requirements produce `status_ambiguous`.
- Generic `merge_blocked` is suppressed when a concrete blocker such as failing checks, draft state, required review, or required conversations already explains GitHub's blocked state.
- Closed or merged PRs remain valid targets. They report `pr.lifecycle` plus lifecycle-aware summaries like `PR is closed` or `PR is already merged`.
- URL-targeted command results do not update the ambient status bar cache; the status bar remains current-branch only.

## License

MIT
