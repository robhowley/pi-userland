# pi-merge-ready

A Pi extension that shows whether your current PR is ready to merge, why it is blocked, and gives agents what they need to start fixing it.

## Installation

```bash
pi install npm:@robhowley/pi-merge-ready
```

## `merge_ready_status` contract

The public status shape includes a restrained mergeability signal plus an authoritative blocker list. `openItems` is blocker-only; optional unresolved comments stay in `signals`:

```json
{
  "state": "ready | blocked | pending | unknown",
  "pr": { "number": 64, "title": "...", "url": "..." } | null,
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

Open-item ids currently include:

- `no_pull_request`
- `status_ambiguous`
- `merge_conflicts`
- `branch_out_of_date`
- `merge_blocked`
- `draft`
- `ci_failing`
- `changes_requested`
- `unresolved_conversations`
- `ci_running`
- `review_pending`

Only `MERGEABLE + CLEAN` is merge-clear. Every other mergeability outcome must remain non-ready.

Unresolved review threads behave as follows:

- `count > 0` + `required` → blocker `unresolved_conversations`
- `count > 0` + `optional` → no blocker item; status bar may still show comment follow-up
- `count > 0` + `unknown` → `status_ambiguous`
