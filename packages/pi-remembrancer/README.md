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
| “What changed since my last review?”                                              | Review new activity across saved sessions and suggest changes together.    |

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

Select an item to see its proposed changes, current task, explanation, and saved quotes.

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

You can also ask “What changed since my last review?” for a conversational catch-up. It reads all saved proposal pages through the read-only `remembrancer_proposals` tool (`{ offset? }` → `{ proposals, nextOffset }`), even when automatic capture has left no new session evidence. It compares saved drafts, quotes, references, and decisions with new evidence and your actual pending/completed tasks, then presents one deduplicated batch for you to accept, edit, or dismiss before applying and verifying changes. The lookup works outside the terminal queue and with capture off while Remembrancer is enabled.

Saved quotes and references come first; the agent reads referenced source files only if more context is needed, preserving the saved branch/edit identity and reporting missing or stale context. Saved suggestions and historical text are not approval. Chat catch-up does not apply or dismiss entries in the saved queue, even after finishing the review. Resolve those separately with `/remembrancer proposals`; do not reapply a change already made in chat or retry an uncertain write without checking the actual task.

## Track task blockers

To record what a task is waiting on, add the `waitingon` field:

```shell
task config uda.waitingon.type string
```

Skip this setup if you do not need waiting conditions; other task operations work without it.

## Settings

Remembrancer is enabled by default. Turn off remembrancer at any time by adding this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "disabled": true } }
```
