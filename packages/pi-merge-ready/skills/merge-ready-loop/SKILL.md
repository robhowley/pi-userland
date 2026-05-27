---
name: merge-ready-loop
description: |
  Use this skill when the user asks to make the current PR merge-ready, clear merge blockers, 
  fix PR status, or resolve items returned by merge_ready_status. Call this skill for requests 
  like "make this PR ready to merge", "fix the merge blockers", "clear PR issues", 
  "resolve merge status problems", or any mention of getting a PR to a mergeable state.
---

# merge-ready-loop

This skill drives a tight loop to clear merge blockers for the current PR.

## When to use

- User asks to "make this PR merge-ready"
- User asks to "fix merge blockers" or "clear PR issues"
- User mentions resolving items from `merge_ready_status`
- User wants to "get this PR ready to merge"

## Rules

1. **Always start with status**: Call `merge_ready_status` before deciding what to do.
2. **Only real blockers**: Treat `openItems` as the only allowed work list. Do not invent blockers or cleanup tasks.
3. **Match request to items**: Match the user's request to one or more `openItems`. If the requested work does not match an `openItem`, say so and stop.
4. **Small fixes**: Fix one small item or tightly related set at a time.
5. **Verify**: Run relevant verification (tests, typecheck, etc.) before claiming progress.
6. **Re-check**: Call `merge_ready_status` again after changes to confirm progress.
7. **Report**: Report the before/after status to the user.
8. **Stop conditions**: Stop if the next step requires a reviewer, external system, credentials, or ambiguous judgment.

## The Loop

```
1. Call merge_ready_status
2. Read state, summary, and openItems
3. Select the smallest actionable item where owner === 'agent'
4. Explain the plan briefly
5. Make a narrow patch
6. Run relevant checks (tests, typecheck, lint)
7. Refresh with merge_ready_status
8. Report what changed
9. If more items remain, continue from step 3
```

## Handling openItems

Each `openItem` has:
- `id`: identifier for the blocker type
- `owner`: who should act ('agent', 'user', 'reviewer', 'ci', 'github', 'wait')
- `actionability`: how actionable this is ('immediate', 'pending', 'blocked', 'waiting')
- `summary`: human-readable description

**Items where owner === 'agent' and actionability === 'immediate'** are your work.

**Items where owner !== 'agent'** are not yours to fix:
- `reviewer`: waiting for human review
- `ci`: waiting for CI system
- `github`: needs GitHub UI action
- `wait`: blocked on external dependency

## Examples

### Example 1: All clear

Status shows:
```json
{
  "state": "ready",
  "summary": "Ready to merge",
  "openItems": []
}
```

Response: "PR is ready to merge. No blockers found."

### Example 2: Failing checks

Status shows:
```json
{
  "state": "blocked",
  "summary": "check-failures",
  "openItems": [
    {
      "id": "checks_failing",
      "owner": "agent",
      "actionability": "immediate",
      "summary": "1 check failing: test"
    }
  ]
}
```

Action:
1. Run tests to see failures
2. Fix the failing test(s)
3. Re-run tests to verify
4. Call `merge_ready_status` to confirm
5. Report: "Fixed failing test in test/file.ts. Status now: blocked → ready"

### Example 3: Waiting on review

Status shows:
```json
{
  "state": "pending",
  "summary": "awaiting-reviews",
  "openItems": [
    {
      "id": "review_pending",
      "owner": "reviewer",
      "actionability": "waiting",
      "summary": "Waiting for review"
    }
  ]
}
```

Response: "PR is waiting for reviewer approval. Nothing to fix locally unless you want me to inspect the diff for issues before review."

### Example 4: Unresolved conversations

Status shows:
```json
{
  "state": "blocked",
  "summary": "unresolved-conversations",
  "openItems": [
    {
      "id": "unresolved_threads",
      "owner": "user",
      "actionability": "waiting",
      "summary": "3 unresolved review threads"
    }
  ]
}
```

If user asked to resolve: "I can help address review comments. However, only you can mark conversations as resolved in GitHub. I can make the code changes if you tell me which comments to address."

If user did not ask: "PR has 3 unresolved review threads on GitHub. These need to be resolved in the GitHub UI."

### Example 5: Merge conflicts

Status shows:
```json
{
  "state": "blocked",
  "summary": "merge-conflicts",
  "openItems": [
    {
      "id": "merge_conflict",
      "owner": "agent",
      "actionability": "immediate",
      "summary": "Branch has merge conflicts with main"
    }
  ]
}
```

Action:
1. Check current branch and base
2. Attempt rebase or merge from base
3. If conflicts: resolve them
4. Complete the rebase/merge
5. Push the resolved branch
6. Re-check status

## Verification commands

Depending on the item, run appropriate verification:

- Code changes: `pnpm test`, `pnpm typecheck`, `pnpm lint`
- Configuration changes: validate with schema or tool
- Merge conflicts: `git status` to confirm clean

Always run verification before claiming an item is resolved.

## Communication style

- Start each iteration with status summary
- Keep fix descriptions terse
- Show before/after states
- Be clear when blocked on external factors
- Stop gracefully whenownership is unclear
