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

`/remembrancer proposals` opens the durable local proposal queue in TUI mode. It works with automatic capture off. Startup only reads the local pending count for a reminder such as `3 task proposals · /remembrancer proposals`, with no model call, transcript scan, or Taskwarrior call. An effective `disabled: true` disables the reminder and UI without deleting stored data.

- Inspect the exact proposed changes, actual target task, explanation, saved quotes, and revision history. Arrow keys navigate; Page Up/Down scroll the preview.
- `e` edits and saves a pending proposal's JSON draft without changing tasks; `d` dismisses one pending proposal. `h` toggles saved proposal/history; `s` toggles Source. Esc returns from Source/history to the preview, then closes. Drafts, history, dismissals, and application outcomes survive closing and reopening.
- `s` opens Source, reading only referenced local files for bounded context on the saved branch, up to two messages before and after each excerpt within the display limits. Missing or stale files are marked unavailable; exact saved quotes remain visible. Opening the list or preview never reads source files or scans the archive. Source is read-only and never switches sessions.
- Only deliberate per-item `Ctrl+A` applies the displayed change. Enter, navigation, editing, Source, and closing never apply tasks. There is no accept-all.

Application rechecks the task and proposal against the displayed preview. Changes require approval of a refreshed preview; unresolved questions block application. Remembrancer claims the proposal before writing and verifies the actual Taskwarrior record before recording the outcome.

Taskwarrior and local storage cannot commit atomically. Interrupted or uncertain writes are never replayed automatically. Reopen the item to inspect the actual task; `Ctrl+A` on an unresolved item only verifies and records an already-present result. Otherwise resolve the task manually. Unrelated external task edits can still race the final check.

## Automatic capture

Automatic capture is off by default. To opt in, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "autoCapture": true } }
```

Capture reviews only the outgoing saved TUI session on clean quit, `/reload`, starting a new session, resuming another session, or forking. It does not run at startup or after each turn, scan the archive, or read other enrolled transcripts. Unsaved, RPC, JSON, print, headless, and unknown-mode sessions are skipped. TUI mode does not prove human authorship or identify delegated workers; workers must still return suggestions rather than write personal tasks.

Settings are re-read at outgoing shutdown. Enabling capture before shutdown includes already-written eligible evidence, not just text after opt-in; disabling it skips capture. Existing checkpoints and seed defaults determine eligibility. Covered evidence is not replayed, and no eligible evidence means no reviewer call or capture coverage change. Capture freezes user/assistant text and branch/edit identity; tool outputs, thinking, and images are excluded. Later appends and edits wait for a later review.

A temporary in-memory SDK reviewer uses the outgoing selected model and normal provider/auth configuration, without personal extensions, skills, prompt files, AGENTS files, or the parent transcript. It has scoped evidence/context reads, fixed read-only task lookups, stored-proposal reads, and submission only. There is no model fallback, retry, or compaction. Successful capture saves proposals and examined coverage together, never Taskwarrior changes.

The five-minute automatic review/cancellation budget starts at shutdown entry. It is not a hard shutdown deadline: at expiry Remembrancer requests cancellation and awaits cleanup, even beyond five minutes or indefinitely. Only normally completed results that pass the deadline check after cleanup are saved. Late results, detected failures, and oversized reviews save neither proposals nor coverage; there is no detached work, retry, or partial commit. A detected failure reports the outgoing session ID; a crash or forced kill may prevent a notice. Use a manual review to catch up on unreviewed evidence.

### Manual review remains separate

With capture off or on, manual review still analyzes available evidence, presents suggestions for acceptance, editing, or dismissal, applies and verifies accepted changes, then finishes coverage. It works without a TUI. Unavailable sources remain unreviewed while healthy sources can finish as a partial result. Human approval waits have no five-minute expiry. Direct task requests retain their existing authorization and never advance review coverage.

Manual finish and automatic capture share coverage, not proposal decisions. Pending automatic proposals remain a separate queue after their evidence is covered, including when capture is turned off. Manual review does not silently consume or bulk-apply that queue, and ordinary manual finish never changes its decisions.

Recognition and task/proposal matching depend on model judgment, not perfect obligation identity. Handling a task conversationally can leave a related proposal pending. Inspect, edit, or dismiss it separately; an add proposal whose task was created elsewhere is not guaranteed to detect a semantic duplicate. Cross-path decision synchronization and exactly-once semantic deduplication are not guaranteed. Automated checks do not establish live-provider recognition quality.

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
- Only user and assistant text is sent to the model in your reviewing session, not tool outputs, model thinking, or images.
- Reviews run only when you ask. Activity added during a review waits for the next one.
- If a session cannot be read, Remembrancer reports it and leaves it for a later review. Cancelling a review leaves review progress unsaved, but it does not undo task changes already applied.

## Settings

Remembrancer is enabled by default. To turn off saved-session reviews and stop including newly opened or resumed sessions in future reviews, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "disabled": true } }
```

A trusted project's `.pi/settings.json` takes precedence over the global value. After changing settings, run `/reload` or start a new session. The skill remains available: direct task requests can still change Taskwarrior tasks.

`autoCapture` defaults to `false` independently of the extension's default `disabled: false`. A trusted project's `.pi/settings.json` overrides each corresponding global field independently; untrusted project settings are ignored. Effective `disabled: true` wins over `autoCapture`. Capture re-reads the applicable settings at outgoing shutdown, so changing `autoCapture` can affect an already-open session. The existing reload/new-session convention for manual-review registration and `disabled` remains unchanged. Turning capture off does not hide or discard pending proposals.
