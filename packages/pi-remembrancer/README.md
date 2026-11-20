# pi-remembrancer

Remembrancer is an agent-powered personal task manager built on Taskwarrior. It reviews user and assistant messages from your saved Pi sessions to find what you said you would do and what you have done since. It checks what is already on your list, then suggests new tasks, progress notes, and completions for you to review in one pass.

> **Remembrancer** _(noun)_ - an officer of the medieval English Exchequer who kept the _memoranda rolls_, a record of debts owed to the Crown and other unfinished business to bring back before the court.

## Install

Requires [Taskwarrior 3](https://taskwarrior.org/download/) (`task` on your `PATH`). If you do not already use it, install and initialize it. On macOS:

```shell
brew install task
task
```

Then install Remembrancer:

```shell
pi install npm:@robhowley/pi-remembrancer
```

Run `/reload` in Pi or start a new session.

## Upgrade warning: HARD CUTOVER

This upgrade changes proposal storage, the `remembrancer_proposals` response shape and capture retry state without legacy compatibility. Do not mix old and upgraded processes.

Before the first upgraded database open:

1. Stop old Pi processes and detached capture workers.
2. Take a SQLite-consistent backup of the checkpoint database (normally `~/.local/state/pi-remembrancer/checkpoints.sqlite3`, or under `$XDG_STATE_HOME`). Use SQLite's backup facility, not a bare copy of an active database.
3. Start only upgraded processes. The first open atomically adds durable capture controls and stops existing unresolved jobs because their historical attempt counts are unknown. Inspect their status and deliberately retry individual jobs if wanted. Completed jobs, proposals, coverage and immutable evidence are preserved; reopening does not reset allowances. Migration failure rolls back its schema, state and version together.

The proposal repair also removes embedded revision snapshots and deduplicates current evidence, preserving current drafts, application state, claims, results and timestamps. Changed proposals advance revision once and invalidate prepared reviews. Failure rolls back the repair and its one-time marker.

The repair shrinks logical proposal payloads, not necessarily the SQLite file. It does not run `VACUUM`, erase deleted bytes, replay uncertain writes, or reset retry state. Resolved-proposal deletion and removal of the temporary History view remain separate work, not an archive feature.

## First review

Optionally, build your initial todo list from your recent Pi sessions:

```text
/remembrancer seed 14d
```

This starts with the past 14 days. Use any positive whole number of days, such as `30d`.

Remembrancer checks your existing tasks and suggests additions, progress notes, and completions. Accept, edit, or dismiss the suggestions before anything is written.

Your tasks stay in Taskwarrior. Use `task list` or `task completed` any time.

## Everyday examples

Explicit requests to add or change a task are applied directly after the actual record is checked. Changes inferred from your sessions need your approval.

| Say this in Pi                                                                    | What happens                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| “Add ‘run the held-out comparison’ to work.ranking.”                              | Check for a matching task and add the commitment.                          |
| “I’ll send the route after the school confirms pickup. Add that to life.bikebus.” | Add “Send the route” with a waiting condition.                             |
| “The school confirmed pickup. Update my route todo.”                              | Clear the waiting condition; sending the route stays pending.              |
| “Wrap up this session.”                                                           | Suggest new tasks, progress notes, and completions from this conversation. |
| “What changed since my last review?”                                              | Review new activity and saved suggestions together.                        |

The waiting-condition examples require the [optional field below](#track-task-blockers).

You can also invoke the skill directly:

```text
/skill:remembrancer review commitments across my saved sessions
```

## Automatic TODO suggestions

Save task suggestions when you leave a session, without asking for a review each time. Capture never changes your Taskwarrior tasks; you approve suggestions later in [Saved proposals](#saved-proposals).

Capture is off by default. To enable it, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "autoCapture": true } }
```

### Capture controls

These commands remain available even with `disabled: true` or automatic capture off:

```text
/remembrancer capture status
/remembrancer capture pause
/remembrancer capture resume
/remembrancer capture retry <full-job-id>
```

- Status lists unresolved jobs with full IDs, current allowance used/remaining (not lifetime history), stopped reasons, retry due times and blocking predecessor IDs.
- Each job gets **two whole-review attempts**, persisted before preparation. Restarts, competing sessions and repeated wakes do not replenish them. Recognized temporary failures wait at least 60 seconds before a later wake; permanent, unknown and exhausted failures stop. Each attempt retains its five-minute deadline.
- Pause persists across restarts and revokes active attempts without refunding their counts. Workers observe cancellation; provider-side cancellation is not instantaneous. New evidence may queue while paused.
- Resume only clears pause and wakes recovery. It does not reset allowances, remove delays, revive revoked attempts or bypass predecessors.
- Retry accepts one exact full job ID, never a prefix or batch. It requires explicit UI confirmation of the displayed reason and current allowance, replacing unused permission with two fresh attempts. Changed or double confirmations fail. Headless retry cannot authorize work. Retry wakes recovery but never unpauses capture or bypasses predecessors.

Recovery uses startup, periodic and command wakes, not a daemon or a sleep-until-due loop. Without a live Pi session, delayed work waits for another wake. Disabling new capture does not stop previously accepted work; use pause for that.

### What to expect

- **When:** your interactive session ends.
- **Scope:** the session you're leaving, but only messages that haven't yet been reviewed.
- **Model:** your session's selected model
- **Result:** proposals and review progress are saved together. Open `/remembrancer proposals` to review them.

## Saved proposals

Review the suggestions saved by automatic capture in Pi's interactive terminal:

```text
/remembrancer proposals
```

At startup, a reminder such as `3 task proposals · /remembrancer proposals` shows how many pending items await review.

The queue opens in one public custom overlay, with all proposals collapsed. Expand one to review exact proposed changes, the actual target task, explanation, evidence count, and a shortened supporting quote. Source shows full saved quotes in pages; transcript context is optional.

| Key                 | Action                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ↑ / ↓               | Move focus, collapsing the previous proposal and resetting detail scroll.                                                                          |
| Enter               | Expand or collapse the focused proposal, without changing tasks.                                                                                   |
| Page Up / Page Down | Scroll the review body; controls stay fixed.                                                                                                       |
| `Ctrl+A`            | Collapsed: open review only. Expanded pending: approve and apply. Expanded applying/uncertain: verify only, never replay writes.                   |
| `e`                 | Edit a pending proposal's validated JSON draft. Save refreshes review; cancel keeps the previous draft. The editor owns input until return.        |
| `d`                 | Dismiss only a pending proposal, leaving tasks unchanged. Shown in both collapsed and expanded views when available.                               |
| `s`                 | Open paged Source. ← / → pages quotes; ↑ / ↓ selects references. Saved quotes remain available without transcript context. Return restores review. |
| `i`                 | Inspect the current saved proposal and edited draft, read-only. No revision snapshots.                                                             |
| `h`                 | Open temporary read-only History of decided proposals. ↑ / ↓ selects; Enter inspects the current saved proposal/result. No replay or undo.         |
| Esc                 | Leave nested inspection, Source, or History first, then collapse review, then close the collapsed queue.                                           |

Only explicit per-item approval authorizes task writes. There is no read-every-line or scroll-to-end approval gate. Changed previews require renewed approval. Feedback distinguishes applied, already satisfied, dismissed (task unchanged), and unresolved results. Missing targets, errors, and applying/uncertain items remain visible until a decided result is established.

If the terminal is too small to show review content and controls safely, the overlay asks you to resize and prevents application until enough space is restored.

### Proposal API reads

`remembrancer_proposals` defaults to a compact, multi-summary list. Follow `nextOffset` as `offset` until `null`. Summaries include revision, state, operation/target, shortened labels and draft/question/evidence indicators, not complete changes or quotes.

Before revising or deciding a candidate, read `action: "detail"` with its `id` and discovered `revision`. Follow `next` until `null`, join `json` fragments by `position`, then parse the joined JSON for the lossless current proposal (including its draft, without sources). Read needed saved quotes separately with `action: "evidence"` and the same ID/revision. Follow `next`, joining quotes by `index` and `quotePosition`; source `offset` remains the original passage offset. Returned cursors use UTF-16 positions. Each complete response is at most 51,200 UTF-8 bytes, even for a huge detail or quote.

Every detail/evidence page checks revision. Manual readers discard partial reads on missing/stale proposals, refresh the list/current detail and seek fresh approval if the write changed. Automatic reviewers abort that attempt without proposals or coverage commits; only the existing controller may prepare a fresh attempt, charged to the same persisted two-attempt allowance.

## Track task blockers

To record what a task is waiting on, add the `waitingon` field:

```shell
task config uda.waitingon.type string
```

Skip this setup if you do not need waiting conditions; other task operations work without it.

## Settings

Manual Remembrancer features are enabled by default; automatic capture remains opt-in. Disable foreground features and new capture jobs in Pi's global settings file, normally `~/.pi/agent/settings.json` (accepted jobs still run within their persisted allowance unless paused):

```json
{ "pi-remembrancer": { "disabled": true } }
```
