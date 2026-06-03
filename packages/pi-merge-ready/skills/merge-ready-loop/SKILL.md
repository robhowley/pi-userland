---
name: merge-ready-loop
description: |
  Use this skill when the user asks to make the current PR merge-ready, clear merge blockers,
  fix PR status, or resolve items returned by merge_ready_status. Call this skill for requests
  like "make this PR ready to merge", "fix the merge blockers", "clear PR issues",
  "resolve merge status problems", or any mention of getting a PR to a mergeable state.
---

# merge-ready-loop

This skill drives a tight loop to clear real merge blockers for the current PR by default, or for an exact GitHub PR URL when the user provides one.

## Current contract

Always treat `merge_ready_status` as the source of truth.

Current response shape:

```json
{
  "state": "ready | blocked | pending | unknown",
  "target": {
    "mode": "current_branch | url"
  },
  "pr": {
    "lifecycle": "open | merged | closed",
    "number": 64,
    "title": "...",
    "url": "...",
    "headRefName": "feat/my-branch",
    "baseRefName": "main"
  } | null,
  "summary": "Ready to merge",
  "openItems": [
    { "id": "merge_conflicts", "summary": "Merge conflicts detected" }
  ],
  "signals": {
    "draft": false,
    "mergeability": "mergeable | conflicting | behind | blocked | unknown",
    "checks": "passing | failing | running | unknown",
    "review": "approved | changes_requested | pending | unknown",
    "unresolvedConversations": true,
    "unresolvedConversationCount": 2,
    "unresolvedConversationRequirement": "required | optional | unknown"
  },
  "generatedAt": "2026-05-27T00:00:00.000Z"
}
```

Important:

- `openItems` is blocker-only. Optional unresolved comments may still appear in `signals`, but not as blocker items.
- `target` tells you whether the status came from the ambient current branch or an explicit PR URL.
- Closed or merged PR URLs are valid targets. Treat `pr.lifecycle !== open` as not ready, even if there are no blocker open items.
- Check-related open items may include `details` rows for non-green checks only; do not invent additional check rows.
- Only `signals.mergeability = mergeable` with a merge-clear PR yields no mergeability blocker. Treat every other mergeability value as not ready.
- `review_pending` is requirement-aware. Do **not** infer pending review from raw review history or a lack of approvals.
- If `review_pending` is absent, do not invent a review blocker.
- If unresolved conversations exist with `unresolvedConversationRequirement = unknown`, expect `status_ambiguous` rather than guessing.

## When to use

- User asks to "make this PR merge-ready"
- User asks to "fix merge blockers" or "clear PR issues"
- User mentions resolving items from `merge_ready_status`
- User wants to "get this PR ready to merge"

## Rules

1. **Always start with status**: call `merge_ready_status` first.
   - Use no params for the ambient current-branch PR.
   - Use `{ url }` only when you have an exact full GitHub PR URL.
   - Do **not** pass branch names, PR numbers, repo names, or guessed targets to `merge_ready_status`.
2. **Only real blockers**: treat `openItems` as the only allowed blocker list.
3. **Do not invent review work**: only treat review as pending when `openItems` contains `review_pending`.
4. **Match request to items**: if the user's requested work does not match an `openItem`, say so and stop.
5. **Verify the edit target before changing code**: if status came from `target.mode = url`, compare the local checkout against `status.target` and `status.pr.headRefName` before editing. If the checkout does not clearly match the target PR repo/branch, stop and ask the user how to proceed.
6. **Small fixes**: fix one small item or tightly related set at a time.
7. **Verify locally**: run the strongest relevant local checks you can reasonably run before claiming an item was addressed.
8. **Separate addressed from cleared**:
   - Addressed: you made the narrow fix, ran reasonable local validation, and pushed or prepared the patch.
   - Cleared: `merge_ready_status` or another authoritative remote signal no longer reports the item.
9. **Stop conditions**:
   - Successful local completion: the agent-actionable work is addressed, even if remote CI/review/GitHub has not caught up yet. Summarize the work performed and the acceptance criteria used to determine completion.
   - Blocked or external handoff: the next step requires remote CI, a reviewer, GitHub-only action, external credentials, or ambiguous product judgment.

## The loop

```text
1. Call merge_ready_status
2. Read target, state, summary, and openItems
3. Pick the smallest item the agent can legitimately advance. If an item is not worth addressing, say so and skip.
4. Explain the plan briefly
5. Make a narrow patch if code/config changes are warranted
6. Run relevant local checks (tests, typecheck, lint, git status)
7. Push or prepare the patch when the fix needs remote CI/review to validate it
8. Optionally call `merge_ready_status` once as a fresh snapshot, but do not wait indefinitely for remote CI/review/GitHub state to clear
9. Report each item as addressed, cleared, skipped, or waiting on external confirmation
10. If locally actionable items remain, continue
```

## How to interpret openItems

Use `id` plus the user's request. An item can be **addressed locally** before it is **cleared remotely**; only treat it as cleared once `merge_ready_status` or another authoritative remote signal drops it.

| id                         | Meaning                                                                                                      | Default agent behavior                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `no_pull_request`          | No PR found for this branch/repo or exact targeted URL                                                       | Report it; do not invent local fixes                                                                                  |
| `status_ambiguous`         | Discovery/data was ambiguous                                                                                 | Report ambiguity, rerun if helpful, do not guess                                                                      |
| `merge_conflicts`          | GitHub reports conflicts or dirty merge state                                                                | Usually actionable locally: merge/rebase, resolve conflicts, verify, then wait for GitHub to recalculate              |
| `branch_out_of_date`       | Head branch is behind base                                                                                   | Usually actionable locally: rebase/merge base, verify, then wait for GitHub to clear it                               |
| `merge_blocked`            | GitHub reports a non-clear mergeability blocker with no concrete known cause                                 | Treat as not ready; inspect whether it is an unknown hook/ruleset/policy issue, otherwise report GitHub-side blockage |
| `draft`                    | PR is still draft                                                                                            | Report that GitHub/user action is needed                                                                              |
| `ci_failing`               | Required checks are failing                                                                                  | Usually actionable locally: reproduce, fix, run local validation, then hand off to remote CI                          |
| `changes_requested`        | Reviewers requested changes                                                                                  | Fix only if the requested changes are actually available; otherwise ask for review context                            |
| `unresolved_conversations` | Required review threads remain unresolved; `signals.unresolvedConversationCount` may include the known count | Agent may address code if context exists, but only GitHub/user can resolve the conversations                          |
| `ci_running`               | Checks are still running                                                                                     | Wait; do not claim ready                                                                                              |
| `review_pending`           | Required review is still pending                                                                             | Wait for review; optional local preflight only if user asks                                                           |

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
      "summary": "Required checks are failing",
      "details": [
        { "label": "linting", "status": "failing" },
        { "label": "PR Title Check", "status": "failing" }
      ]
    }
  ]
}
```

Action:

1. Reproduce the failure
2. Make the smallest fix
3. Re-run focused local validation
4. Push or prepare the patch
5. If remote CI is still running or stale, report “addressed locally; waiting on CI” rather than waiting indefinitely

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

- code changes: targeted package commands, e.g. unit tests, linting, typechecking
- merge/rebase work: `git status`
- config/tooling changes: the relevant schema or package validation

Always verify before claiming an item is addressed. Claim an item is cleared only when `merge_ready_status` or another authoritative remote signal confirms it. Otherwise, report it as pending external confirmation.

## Communication style

- Start with the current status summary
- Stay tightly scoped to returned `openItems`
- Distinguish “addressed locally” from “cleared by remote status”
- Be explicit when an item needs reviewer or GitHub action
- Stop gracefully when the remaining work is not truly agent-actionable
