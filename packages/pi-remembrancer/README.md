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

## Optional waiting conditions

To record what a task is waiting on, add the `waitingon` field:

```shell
task config uda.waitingon.type string
```

Skip this setup if you do not need waiting conditions; other task operations work without it.

## What gets reviewed

- Regular reviews cover sessions opened or resumed with Remembrancer enabled. An older session included for the first time this way can bring in its full history; use seed to set a starting point instead.
- Seed also searches Pi's configured session archive, including saved worker sessions. It does not reconstruct which sessions had Remembrancer disabled in the past.
- A shorter seed duration does not narrow existing review coverage. Repeating a seed skips unchanged text that has already been reviewed.
- Only user and assistant text is sent to the model in your reviewing session, not tool outputs, model thinking, or images.
- Reviews run only when you ask. Activity added during a review waits for the next one.
- If a session cannot be read, Remembrancer reports it and leaves it for a later review. Cancelling a review leaves review progress unsaved, but it does not undo task changes already applied.

Review evidence is returned in consecutive groups sharing `file`, `sessionId`, `cwd`, `branchId`, and `reviewedThrough`. Each group holds its `entries` with `entryId`, `role`, `text`, `timestamp`, `editId`, `offset`, and `continues`. Pages repeat their own group metadata, preserve entry order, and split long text across pages without omission. Context responses use the same grouped shape; build a context selection from the group's `sessionId` and `branchId` and the entry's `entryId` and `editId`. Each complete JSON response is limited to 50 KiB UTF-8, including metadata and escaped text. Oversized non-splittable metadata is reported as an error.

## Settings

Remembrancer is enabled by default. To turn off saved-session reviews and stop including newly opened or resumed sessions in future reviews, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "disabled": true } }
```

A trusted project's `.pi/settings.json` takes precedence over the global value. After changing settings, run `/reload` or start a new session. The skill remains available: direct task requests can still change Taskwarrior tasks.
