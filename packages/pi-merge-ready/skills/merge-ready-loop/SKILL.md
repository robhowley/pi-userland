---
name: merge-ready-loop
description: |
  Use this skill when the user asks to make the current PR merge-ready, clear merge blockers,
  fix PR status, or resolve items returned by merge_ready_status. Call this skill for requests
  like "make this PR ready to merge", "fix the merge blockers", "clear PR issues",
  "resolve merge status problems", or any mention of getting a PR to a mergeable state.
---

# merge-ready-loop

This skill drives a tight loop to clear real merge blockers for the current PR.

## Current contract

Always treat `merge_ready_status` as the source of truth.

Current response shape:

```json
{
  "state": "ready | blocked | pending | unknown",
  "pr": { "number": 64, "title": "...", "url": "..." } | null,
  "summary": "Ready to merge",
  "openItems": [
    { "id": "ci_failing", "summary": "Required checks are failing" }
  ],
  "signals": {
    "draft": false,
    "checks": "passing | failing | running | unknown",
    "review": "approved | changes_requested | pending | unknown",
    "unresolvedConversations": false
  },
  "generatedAt": "2026-05-27T00:00:00.000Z"
}
```

Important:
- `openItems` contains only `{ id, summary }`.
- There is no `owner`, `actionability`, or PR `lifecycle` in the public status.
- `review_pending` is requirement-aware. Do **not** infer pending review from raw review history or a lack of approvals.
- If `review_pending` is absent, do not invent a review blocker.

## When to use

- User asks to "make this PR merge-ready"
- User asks to "fix merge blockers" or "clear PR issues"
- User mentions resolving items from `merge_ready_status`
- User wants to "get this PR ready to merge"

## Rules

1. **Always start with status**: call `merge_ready_status` first.
2. **Only real blockers**: treat `openItems` as the only allowed blocker list.
3. **Do not invent review work**: only treat review as pending when `openItems` contains `review_pending`.
4. **Match request to items**: if the user's requested work does not match an `openItem`, say so and stop.
5. **Small fixes**: fix one small item or tightly related set at a time.
6. **Verify**: run relevant verification before claiming progress.
7. **Re-check**: call `merge_ready_status` again after changes.
8. **Stop conditions**: stop if the next step requires a reviewer, GitHub-only action, external credentials, or ambiguous product judgment.

## The loop

```text
1. Call merge_ready_status
2. Read state, summary, and openItems
3. Pick the smallest item the agent can legitimately advance
4. Explain the plan briefly
5. Make a narrow patch if code/config changes are warranted
6. Run relevant checks (tests, typecheck, lint, git status)
7. Refresh with merge_ready_status
8. Report before/after status
9. If actionable items remain, continue
```

## How to interpret openItems

Use `id` plus the user's request.

| id | Meaning | Default agent behavior |
| --- | --- | --- |
| `no_pull_request` | No PR found for this branch/repo | Report it; do not invent local fixes |
| `status_ambiguous` | Discovery/data was ambiguous | Report ambiguity, rerun if helpful, do not guess |
| `draft` | PR is still draft | Report that GitHub/user action is needed |
| `ci_failing` | Required checks are failing | Usually actionable locally: reproduce, fix, rerun |
| `changes_requested` | Reviewers requested changes | Fix only if the requested changes are actually available; otherwise ask for review context |
| `unresolved_conversations` | Review threads remain unresolved | Agent may address code if context exists, but only GitHub/user can resolve the conversations |
| `ci_running` | Checks are still running | Wait; do not claim ready |
| `review_pending` | Required review is still pending | Wait for review; optional local preflight only if user asks |

## Examples

### Ready

```json
{
  "state": "ready",
  "summary": "Ready to merge",
  "openItems": []
}
```

Response: "PR is ready to merge. No blockers found."

### Failing checks

```json
{
  "state": "blocked",
  "summary": "Required checks are failing",
  "openItems": [
    {
      "id": "ci_failing",
      "summary": "Required checks are failing"
    }
  ]
}
```

Action:
1. Reproduce the failure
2. Make the smallest fix
3. Re-run focused validation
4. Refresh `merge_ready_status`

### Required review pending

```json
{
  "state": "pending",
  "summary": "Waiting for review",
  "openItems": [
    {
      "id": "review_pending",
      "summary": "Waiting for review"
    }
  ]
}
```

Response: "PR is waiting for required review. Nothing to fix locally unless you want a pre-review diff check."

### Unresolved conversations

```json
{
  "state": "blocked",
  "summary": "Unresolved review conversations remain",
  "openItems": [
    {
      "id": "unresolved_conversations",
      "summary": "Unresolved review conversations remain"
    }
  ]
}
```

Response: "There are unresolved review conversations. I can help with code changes if you point me at the comments, but only GitHub/user action can resolve the threads themselves."

### Changes requested

```json
{
  "state": "blocked",
  "summary": "Changes requested by reviewers",
  "openItems": [
    {
      "id": "changes_requested",
      "summary": "Changes requested by reviewers"
    }
  ]
}
```

Response: "Reviewers requested changes. If you want, I can inspect the review feedback and patch the requested fixes, but I should not guess at missing review context."

## Verification

Pick the narrowest useful checks for the item:

- code changes: `pnpm test`, `pnpm typecheck`, `pnpm lint`, targeted package commands
- merge/rebase work: `git status`
- config/tooling changes: the relevant schema or package validation

Always verify before claiming an item is cleared.

## Communication style

- Start with the current status summary
- Stay tightly scoped to returned `openItems`
- Show before/after states when you make changes
- Be explicit when an item needs reviewer or GitHub action
- Stop gracefully when the remaining work is not truly agent-actionable
