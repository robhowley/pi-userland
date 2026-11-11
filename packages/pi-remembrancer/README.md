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

## Saved proposals

`/remembrancer proposals` opens local, durable proposals in TUI mode. Startup quietly shows the pending count, such as `3 task proposals · /remembrancer proposals`, without a model call, evidence scan, or Taskwarrior call. This works with automatic capture off; `disabled` prevents the workflow.

- Arrow keys navigate; Page Up/Down scroll every field, annotation and saved quote.
- `Ctrl+A` applies only the displayed item. Enter never applies.
- `e` edits the JSON draft and saves it without changing tasks; `d` dismisses one proposal.
- `s` opens saved source excerpts and locations, then reads only the referenced local files for up to two messages before and after each excerpt on its saved branch. Additional context is bounded by the review display limits per reference and explicitly marked unavailable if the file or reference no longer matches. Saved quotes remain visible even when files disappear. Source is read-only, scrollable with PgUp/PgDn, and never switches sessions or scans the archive. Opening the list or preview does not read source files.
- Closing preserves drafts, decisions and previously applied changes. There is no accept-all.

A changed task or proposal requires approval of a refreshed preview. An interrupted application stays uncertain and is never automatically retried. Reopen it to inspect the actual task; `Ctrl+A` then only verifies and records an already-satisfied result. If it does not match, resolve the task manually. Taskwarrior and local storage cannot commit atomically, and unrelated external task edits can still race the final check.

Manual analysis and automatic capture save proposals and examined coverage together. Finishing analysis does not approve or apply proposals; capture leaves Taskwarrior unchanged until you explicitly apply an item. Direct task requests use their separate flow.

## Automatic capture

Automatic capture is off by default. When enabled, Remembrancer reviews the outgoing saved session on clean quit, `/reload`, starting a new session, resuming another session, or forking. It does not act after each turn. Only saved TUI sessions are supported; unsaved, RPC, JSON, print, headless, and unknown-mode sessions are skipped. TUI mode is not proof that a human authored every message or a check for delegated activity. Settings are re-read at shutdown, so enabling capture before shutdown opts in the already-open session, while disabling it skips capture.

Capture uses only still-unreviewed evidence eligible under that session's existing checkpoint/default rules, including evidence from before opt-in. It preserves existing coverage, does not replay covered evidence, and does not scan the session archive. If no eligible evidence remains, capture makes no reviewer call and leaves the source and coverage unchanged. The temporary reviewer uses the outgoing selected model with the SDK's normal provider and authentication configuration. If that model is unavailable there, capture fails without changing models or saving proposals or coverage.

The five-minute review and cancellation budget starts when shutdown begins; it is not a hard shutdown deadline. Remembrancer stages reviewer output and commits proposals with coverage only after normal reviewer completion, awaited cleanup, and a deadline check. At expiry it requests SDK cancellation and waits for cleanup before shutdown finishes, even if that takes longer than five minutes, potentially indefinitely. Late results are not saved; work is not detached or retried. A detected failure, including an oversized review that cannot fit the model context, reports the session and saves neither proposals nor coverage. Oversized reviews are not summarized, compacted, or partially committed. Use a manual review to catch up, for example `/skill:remembrancer review commitments across my saved sessions`. A crash or forced kill may prevent a notice.

## Optional waiting conditions

To record what a task is waiting on, add the `waitingon` field:

```shell
task config uda.waitingon.type string
```

Skip this setup if you do not need waiting conditions; other task operations work without it.

## What gets reviewed

- Manual cross-session reviews include sessions Remembrancer enrolled when they were opened or resumed. A session included for the first time can bring in its full history; use seed to set a starting point instead.
- A manual seed also searches Pi's configured session archive, including saved worker sessions. Automatic capture never scans that archive. Manual seed does not reconstruct which sessions had Remembrancer disabled in the past.
- A shorter seed duration does not narrow existing review coverage. Repeating a seed skips unchanged text that has already been reviewed.
- Only user and assistant text is sent for analysis, not tool outputs, model thinking, or images.
- Manual reviews run when you ask. Automatic capture runs only at the shutdown boundaries above. Activity beyond a frozen review boundary waits for a later review.
- If a session cannot be read, Remembrancer reports it and leaves it unreviewed. An incomplete manual review cannot finish. Cancelling a review leaves coverage unsaved, but does not undo task changes already applied.

## Settings

Remembrancer is enabled by default. Automatic capture is a separate opt-in and defaults to `false`. To enable it, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "autoCapture": true } }
```

To disable Remembrancer, including automatic capture, set `disabled`:

```json
{ "pi-remembrancer": { "disabled": true } }
```

An effective `disabled: true` overrides `autoCapture`. Values in a trusted project's `.pi/settings.json` override corresponding global settings; untrusted project settings are ignored. Automatic capture re-reads the applicable settings at outgoing shutdown, so `autoCapture` can apply to an already-open session. Startup and manual-review registration retain the existing `/reload` or new-session convention; after changing `disabled`, reload or start a new session. The skill remains available, and direct task requests remain separate from automatic capture.
