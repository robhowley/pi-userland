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

The Pi status bar shows the current PR's top merge-readiness state.

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

Use `/merge-ready` for a human-readable status summary:

```text
✅ Ready to merge
PR: #64 — Add PR merge-readiness extension
Open items: none
```

Use JSON output when you want the exact status object:

```bash
/merge-ready --json
```

### Agent tool

Agents get a `merge_ready_status` tool. The contract is simple: `openItems` is the authoritative list of merge-readiness work.

Example response:

```json
{
  "state": "ready | blocked | pending | unknown",
  "pr": { "number": 64, "title": "...", "url": "..." },
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

Agents should fix or report only the items returned in `openItems`; they should not invent blockers from raw GitHub fields.

### Merge-ready loop skill

The package includes a `merge-ready-loop` skill for requests like "make this PR ready to merge". The skill starts with `merge_ready_status`, chooses the smallest actionable returned item, verifies the change locally, and distinguishes "fixed locally" from "confirmed cleared by GitHub".

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

## License

MIT
