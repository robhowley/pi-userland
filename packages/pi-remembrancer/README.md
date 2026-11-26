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

Save task suggestions when you leave an interactive session. Capture never changes Taskwarrior; you approve suggestions later in [Saved proposals](#saved-proposals).

Capture is off by default. To enable it, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "autoCapture": true } }
```

### Capture controls

With automatic capture enabled, run `/remembrancer capture now` to review this session in the background.

Available even when automatic capture or the extension is disabled:

| Command                                     | Use                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `/remembrancer capture status`              | See job IDs, attempts used/remaining, failures, retry times and blockers.    |
| `/remembrancer capture pause`               | Pause queued reviews and cancel running ones. Cancellation may take time.    |
| `/remembrancer capture resume`              | Resume paused work without resetting attempts or retry delays.               |
| `/remembrancer capture retry <full-job-id>` | Confirm two fresh attempts for one stopped job in Pi's interactive terminal. |

- Turning capture off prevents new jobs. Use **pause** to stop queued or running reviews.
- Pause survives restarts; new evidence may still queue.
- For **retry**, copy the full job ID from status.
- Retry does not unpause capture or skip earlier jobs from that session.

**Attempt limits:**

- Each job gets **two attempts**, up to five minutes each.
- Temporary failures wait at least **60 seconds** before retrying; permanent or unknown failures stop.
- Restarting Pi does not reset used attempts.
- Delayed retries wait until Pi is running.

### What to expect

- **When:** you leave an interactive session.
- **Scope:** unreviewed messages from that session.
- **Model:** your session's selected model.
- **Result:** suggestions waiting in `/remembrancer proposals`.

Check suggestions before approving them; automatic review can miss tasks or suggest duplicates.

Branch aliases and growing draft/task details stay host-side and can be read in bounded pages. Dense messages can return several observation pages before their text range is acknowledged. Discovery pages fit both input and candidate-ID response capacity. Task and saved-proposal discovery includes current fields, effective drafts and saved evidence, not just labels. Large identity values retain exact handles and remain uncertain candidates; plausible or uncertain matches get exact detail, rather than reading every full detail for every obligation.

Automatic capture reads one validated Taskwarrior snapshot per attempt, including completed tasks. This private export is limited to 16 MiB; public task commands retain their 1 MiB output limit. Exceeding either limit fails explicitly rather than silently dropping rows.

Saved applying/uncertain proposals remain verify-only during capture too. Capture cannot revise them or create a replacement pending suggestion. It can acknowledge a no-op only when the live task proves both the saved operation and the new intent are already satisfied; otherwise the whole attempt fails without saving suggestions or coverage, including unrelated findings in that attempt.

All eligible ranges, findings and final dispositions must be processed before the existing atomic save. A failed pass, insufficient model context, cancellation or timeout saves no suggestions or review coverage. The five-minute limit covers the whole attempt, not each call. Splitting does not guarantee that every review can finish within that limit.

## Saved proposals

Review the suggestions saved by automatic capture in Pi's interactive terminal:

```text
/remembrancer proposals
```

At startup, a reminder such as `3 task proposals · /remembrancer proposals` shows how many pending items await review.

The queue opens with all proposals collapsed. Expand one to review the proposed changes, target task, explanation, evidence count, and a shortened supporting quote. Source shows full saved quotes in pages; transcript context is optional.

| Key                 | Action                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ↑ / ↓               | Move focus, collapsing the previous proposal and resetting detail scroll.                                                                          |
| Enter               | Expand or collapse the focused proposal, without changing tasks.                                                                                   |
| Page Up / Page Down | Scroll the review body; controls stay fixed.                                                                                                       |
| `Ctrl+A`            | Collapsed: open review only. Expanded pending: approve and apply. Expanded applying/uncertain: verify only, never replay writes.                   |
| `e`                 | Edit a pending proposal's validated JSON draft. Save refreshes review; cancel keeps the previous draft. The editor owns input until return.        |
| `d`                 | Dismiss only a pending proposal, leaving tasks unchanged. Shown in both collapsed and expanded views when available.                               |
| `s`                 | Open paged Source. ← / → pages quotes; ↑ / ↓ selects references. Saved quotes remain available without transcript context. Return restores review. |
| `i`                 | Inspect the saved proposal and edited draft without changing it.                                                                                   |
| `h`                 | Open read-only History of decided proposals. ↑ / ↓ selects; Enter inspects the saved proposal/result. No replay or undo.                           |
| Esc                 | Leave nested inspection, Source, or History first, then collapse review, then close the collapsed queue.                                           |

Only explicit per-item approval authorizes task writes. There is no read-every-line or scroll-to-end approval gate. Changed previews require renewed approval. Feedback distinguishes applied, already satisfied, dismissed (task unchanged), and unresolved results. Missing targets, errors, and applying/uncertain items remain visible until a decided result is established.

If the terminal is too small to show review content and controls safely, the overlay asks you to resize and prevents application until enough space is restored.

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
