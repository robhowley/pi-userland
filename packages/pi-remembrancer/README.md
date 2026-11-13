# pi-remembrancer

Remembrancer is an agent-powered personal task manager built on Taskwarrior. It reads your saved Pi sessions to find what you said you would do and what you have done since. It checks what is already on your list, then suggests new tasks, progress notes, and completions for you to review in one pass.

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
| “What changed since my last review?”                                              | Review new activity across saved sessions and suggest changes together.    |

The waiting-condition examples require the [optional field below](#optional-waiting-conditions).

You can also invoke the skill directly:

```text
/skill:remembrancer review commitments across my saved sessions
```

## Automatic capture

Save task suggestions when you leave a session, without asking for a review each time. Capture never changes your Taskwarrior tasks; you approve suggestions later in [Saved proposals](#saved-proposals).

Capture is off by default. To enable it, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "autoCapture": true } }
```

### What to expect

- **When:** on clean quit, `/reload`, starting a new session, resuming another session, or forking. Only saved interactive terminal sessions qualify, not unsaved or headless sessions. Capture does not run at startup or after each reply.
- **Scope:** the session you're leaving, not your archive. It skips already-reviewed text; eligible text written before you enabled capture can still be included.
- **Model:** your session's selected model runs a separate review of user/assistant text, relevant tasks, and saved proposals. Transcript tool outputs, thinking, and images are excluded.
- **Result:** proposals and review progress are saved together. Open `/remembrancer proposals` to review them.

### Delays and failures

Capture can delay leaving a session. After five minutes it requests cancellation, but cleanup can take longer or stall. Five minutes is not a guaranteed exit deadline.

Failed, late, or oversized reviews save neither proposals nor review progress. A warning identifies the session when possible; a crash or forced exit may prevent it. Ask for a manual review to catch up on unreviewed activity.

## Saved proposals

Review the suggestions saved by automatic capture in Pi's interactive terminal:

```text
/remembrancer proposals
```

This opens the saved list without calling a model. It works even after you turn capture off. At startup, a reminder such as `3 task proposals · /remembrancer proposals` shows how many pending items await review.

Select an item to see its proposed changes, current task, explanation, and saved quotes. Drafts, dismissals, and application outcomes survive closing and restarting Pi.

| Key                 | Action                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| ↑ / ↓               | Select a proposal from the preview.                                    |
| Page Up / Page Down | Scroll details.                                                        |
| `Ctrl+A`            | Approve and apply the displayed proposal.                              |
| `e`                 | Edit and save a pending proposal's JSON draft, without changing tasks. |
| `d`                 | Dismiss a pending proposal.                                            |
| `s`                 | View surrounding source context.                                       |
| `h`                 | View the saved proposal and revision history.                          |
| Esc                 | Return from Source/History to the preview, then close.                 |

Approval is per item: Enter, editing, navigation, and closing never apply changes. There is no accept-all. Apply, Edit, and Dismiss work from the preview, not Source or History.

Source reads only the referenced local session files and never switches sessions. If a file is missing or changed, the saved quotes remain available.

### When an item cannot be applied

- **A question is unresolved:** edit the JSON draft to resolve it and set `"question": null` before approving.
- **The task or proposal changed:** review the refreshed preview, then press `Ctrl+A` again if it is still correct.
- **A write was interrupted or its outcome is uncertain:** reopen the item and inspect the actual task. `Ctrl+A` only checks whether the result already exists; it does not retry the write. Otherwise, fix the task manually. Unresolved items cannot be edited or dismissed.

### Manual review remains separate

Manual reviews still work with capture on or off, including outside the interactive terminal, from a saved reviewing session. They review unreviewed activity across sessions and wait for your approval without the capture timeout.

Capture and manual review share review progress, not approvals:

- Manual review skips text that capture already reviewed; it does not apply or dismiss the saved proposals.
- Handling a task in conversation can leave its proposal pending. Inspect, edit, or dismiss it separately to avoid duplicate tasks.

## Optional waiting conditions

To record what a task is waiting on, add the `waitingon` field:

```shell
task config uda.waitingon.type string
```

Skip this setup if you do not need waiting conditions; other task operations work without it.

## What gets reviewed

These are the manual-review rules. Opt-in automatic capture adds only the outgoing-session review described above.

- Regular reviews cover sessions opened or resumed with Remembrancer enabled. An older session included for the first time this way can bring in its full history; use seed to set a starting point instead.
- Seed also searches Pi's configured session archive, including saved worker sessions. It does not reconstruct which sessions had Remembrancer disabled in the past.
- A shorter seed duration does not narrow existing review coverage. Repeating a seed skips unchanged text that has already been reviewed.
- From saved transcripts, only user and assistant text is included, not tool outputs, model thinking, or images.
- Manual reviews run only when you ask. Activity added during a review waits for the next one.
- If a session cannot be read, Remembrancer reports it and leaves it for a later review. Cancelling a review leaves review progress unsaved, but it does not undo task changes already applied.

## Settings

Remembrancer is enabled by default. To turn off saved-session reviews and stop including newly opened or resumed sessions in future reviews, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "disabled": true } }
```

A trusted project's `.pi/settings.json` takes precedence over the global value. After changing settings, run `/reload` or start a new session. The skill remains available: direct task requests can still change Taskwarrior tasks.

- `autoCapture` defaults to `false`. Turning it off leaves saved proposals available.
- Capture checks the latest settings when you leave a session, so changing `autoCapture` can affect the session already open.
- A trusted project's settings override each global option separately. Untrusted project settings are ignored.
- `disabled: true` also stops capture and hides the proposal list and reminder, without deleting saved data.
