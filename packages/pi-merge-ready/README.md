# pi-merge-ready

A [Pi](https://pi.dev/) package that shows whether your current PR is ready to merge, why it is blocked, and gives agents the context to fix what remains.

It adds a status bar signal, `/merge-ready`, a `merge_ready_status` agent tool, and a `merge-ready-loop` skill that lets agents work through reported blockers.

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

The Pi status bar shows the current branch PR's top merge-readiness state.

Examples:

```text
✅ Ready
❌ Checks failing
🔄 Out of date
❌ 💬 2 unresolved
❔ No PR
```

Optional unresolved conversations are not blockers, but they can still appear as context:

```text
✅ Mergeable · 💬 2 unresolved
```

### Slash command

Use `/merge-ready` for a human-readable status summary of the current branch PR:

```text
✅ Ready to merge
Target: current branch feat/my-branch (owner/repo)
PR: #64 — Add PR merge-readiness extension
Open items: none
```

You can also target an exact GitHub pull request URL:

```bash
/merge-ready --url https://github.com/OWNER/REPO/pull/64
/merge-ready --url https://github.com/OWNER/REPO/pull/64 --json
```

Only full HTTPS GitHub PR URLs are accepted. Branch names, PR numbers, shorthands, issue URLs, repo URLs, non-GitHub hosts, query strings, fragments, and subpaths are rejected. A trailing slash on `/pull/NUMBER/` is normalized.

### Agent tool

Agents get a `merge_ready_status` tool. The contract is simple: `openItems` is the authoritative list of merge-readiness work.

- `merge_ready_status({})` = current branch PR
- `merge_ready_status({ url })` = that exact GitHub PR URL
- Do not pass branch names, PR numbers, repo names, or inferred targets

Example response:

```json
{
  "state": "ready | blocked | pending | unknown",
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
  "summary": "Ready to merge",
  "openItems": [],
  "signals": {
    "draft": false,
    "mergeability": "mergeable",
    "checks": "passing",
    "review": "approved",
    "unresolvedConversations": false,
    "unresolvedConversationRequirement": "required"
  },
  "generatedAt": "2026-05-27T00:00:00.000Z"
}
```

Check-related `openItems` may include `details` rows for the non-green checks only:

```json
{
  "id": "ci_failing",
  "summary": "Required checks are failing",
  "details": [
    { "label": "linting", "status": "failing" },
    { "label": "PR Title Check", "status": "failing" }
  ]
}
```

Agents should fix or report only the items returned in `openItems`; they should not invent blockers from raw GitHub fields.

When `target.mode` is `"url"`, `pr.headRepository` is also returned so callers can verify whether the editable head repo matches the targeted PR repo before changing code:

```json
{
  "headRepository": {
    "owner": "fork-owner",
    "repo": "fork-repo"
  }
}
```

### Merge-ready loop skill

The package includes a `merge-ready-loop` skill for requests like "make this PR ready to merge". The skill starts with `merge_ready_status`, chooses the smallest actionable returned item, verifies the change locally, and distinguishes "fixed locally" from "confirmed cleared by GitHub". For URL-targeted PRs, it should verify the local checkout against `pr.headRepository` plus `pr.headRefName`; if `pr.headRepository` differs from `target.owner/repo`, treat it as a fork/cross-repo case and stop unless the user authorizes the checkout change.

## Status states

| State     | Meaning                                    |
| --------- | ------------------------------------------ |
| `ready`   | No merge-readiness open items were found.  |
| `blocked` | A blocker requires action before merge.    |
| `pending` | Waiting on checks or required review.      |
| `unknown` | No PR was found or readiness is ambiguous. |

## Open item ids

| id                         | Meaning                                    |
| -------------------------- | ------------------------------------------ |
| `no_pull_request`          | No pull request was found for the branch.  |
| `status_ambiguous`         | Readiness could not be determined safely.  |
| `merge_conflicts`          | GitHub reports merge conflicts.            |
| `branch_out_of_date`       | The branch is behind the base branch.      |
| `merge_blocked`            | GitHub reports a mergeability blocker.     |
| `draft`                    | The pull request is still a draft.         |
| `ci_failing`               | Required checks are failing.               |
| `changes_requested`        | A reviewer requested changes.              |
| `unresolved_conversations` | Required review conversations remain open. |
| `ci_running`               | Required checks are still running.         |
| `review_pending`           | Required review is still pending.          |

Unresolved conversations are requirement-aware:

- Required unresolved conversations block merge readiness.
- Optional unresolved conversations remain in `signals`, but not in `openItems`.
- Unknown conversation requirements produce `status_ambiguous`.
- Generic `merge_blocked` is suppressed when a concrete blocker such as failing checks, draft state, required review, or required conversations already explains GitHub's blocked state.
- Closed or merged PRs remain valid targets. They report `pr.lifecycle` plus lifecycle-aware summaries like `PR is closed` or `PR is already merged`.
- URL-targeted command results do not update the ambient status bar cache; the status bar remains current-branch only.

## License

MIT
