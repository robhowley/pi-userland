# pi-remembrancer

Remembrancer reviews your saved Pi sessions to find what you said you’d do and what you’ve done since. It checks what’s already in your personal Taskwarrior list and suggests new tasks, progress notes, and completions for you to review together.

## Install

Use Pi and Taskwarrior 3 on your `PATH`. Remembrancer uses Node.js 22.13.0 or later because its checkpoint store uses built-in `node:sqlite`.

```shell
pi install npm:@robhowley/pi-remembrancer
```

For a source checkout:

```shell
pi install /absolute/path/to/pi-userland/packages/pi-remembrancer
```

Start a new Pi process, or run `/reload` in an existing session after installing. Keep a local source checkout in place while it is installed from a path.

## Set up Taskwarrior

On macOS, install and initialize Taskwarrior, then define the optional field Remembrancer uses for prerequisites:

```shell
brew install task
task
task config uda.waitingon.type string
```

The `task` CLI remains the source of truth for accepted work. Remembrancer does not replace it with another task store.

## Try it

| Say this in Pi                                                                   | Expected behavior                                                                            |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| “Add ‘run the held-out comparison’ to work.ranking.”                             | Check for a matching task and add the named commitment.                                      |
| “I’ll send the route once the school confirms pickup. Add that to life.bikebus.” | Add “Send the route” with a free-text waiting condition.                                     |
| “The school confirmed pickup. Update my route todo.”                             | Clear `waitingon`; sending the route stays pending.                                          |
| “Wrap up this session.”                                                          | Offer additions, progress notes, waiting conditions, and completions for this conversation.  |
| “What changed since my last review?”                                             | Page through new evidence across enrolled sessions and show one inferred batch for approval. |

For explicit skill invocation, use `/skill:remembrancer review commitments across my saved sessions`. From the terminal, use `task list`, `task project.is:work.ranking list`, or `task completed`.

Direct Taskwarrior requests can be applied immediately when they are explicit. Suggestions inferred from session history are presented for review first. The extension exposes the model tool `remembrancer_review` with `begin`, `next`, `finish`, and `cancel` actions for the cross-session workflow; it does not write Taskwarrior records itself.

## Capture and review

- Starting or resuming a saved Pi session with the extension enabled enrolls that session file. Enrolling an existing file makes its saved branch history available to the first review. Historical files that have never been opened with Remembrancer stay outside the initial review.
- Compaction and shutdown record branch tips. Session replacement, including `/new`, `/resume`, and `/fork`, records the outgoing session before it is replaced. Startup and the beginning of a review look for missed writes in changed enrolled files, including after an abrupt exit.
- A review uses one snapshot. It returns visible user and assistant text with the session file, working directory, timestamp, and entry reference. Tool outputs, model thinking, and images are omitted. The returned evidence is sent to the model selected for the reviewing session as a normal tool result.
- One Pi process can hold a full review at a time. Other sessions continue capturing, and direct Taskwarrior operations remain available. Cancel the review, switch sessions, reload, or exit to release its lock. A crashed process releases its review lock through the operating system.
- Only a completed full batch advances the exact captured tips. Pending items and individual decisions stay in the conversation. On retry, the skill checks Taskwarrior for changes already applied. A prior dismissal can reappear after an interruption.
- Unavailable or malformed ranges produce a warning and remain unreviewed. The review can finish readable ranges that were included in the snapshot.

## Keep personal bookkeeping in the parent session

Saved parent sessions should own personal Taskwarrior bookkeeping. For delegated Pi processes, set `PI_REMEMBRANCER_DISABLED=1` in the worker launcher, or omit this package from the worker profile. A positive `PI_SUBAGENT_DEPTH` also disables the extension. Launchers that run workers inside an existing process should exclude the package for those worker sessions. Files are enrolled because the extension is enabled; forks of human sessions are eligible. Ephemeral `--no-session` runs do not enroll.

## Data, safety, and limits

- Taskwarrior owns accepted work, including `waitingon`. Pi owns the original transcripts.
- Remembrancer stores only enrollment markers, file scan signatures, captured entry IDs, and reviewed flags in `$XDG_STATE_HOME/pi-remembrancer/checkpoints.sqlite3`, defaulting to `~/.local/state/pi-remembrancer/checkpoints.sqlite3`. The sibling `.lock` file is for process locking and carries no task or proposal records. The state directory and database are created with private permissions.
- Session text is historical evidence, not a new instruction. The skill ignores tool calls, system prompts, quoted examples, and old review suggestions in that text, and follows later genuine user corrections when they resolve an earlier statement.
- The extension does not scan every Pi session on disk, monitor external events, resume sessions, or infer work without a review. It only enrolls sessions opened while enabled and only exposes the captured evidence to the reviewing model.
- Cross-session suggestions are not applied unattended. The user reviews, edits, accepts, or dismisses the inferred batch before Taskwarrior writes. Failed writes are reported rather than silently redirected to another store.
- A saved session and the local `task` executable are required for the corresponding workflow. Missing Taskwarrior setup, an unsaved session, a malformed session range, or an unavailable session file cannot be silently repaired by Remembrancer.

## Development

From this package directory:

```shell
pnpm test
pnpm lint
pnpm typecheck
pnpm format:check
```

The extension is loaded directly by Pi. To remove a local installation, use `pi remove` with the same source you installed.

[Pi packages](https://pi.dev/docs/latest/packages) · [Pi session format](https://pi.dev/docs/latest/session-format) · [Taskwarrior custom fields](https://taskwarrior.org/docs/udas/)
