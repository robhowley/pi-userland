# pi-remembrancer

Remembrancer is an agent-powered personal task manager built on Taskwarrior. It reviews user and assistant messages from your saved Pi sessions to find what you said you would do and what you have done since. It checks what is already on your list, then suggests new tasks, progress notes, and completions for you to review in one pass.

> **Remembrancer** _(noun)_ - an officer of the medieval English Exchequer who kept the _memoranda rolls_, a record of debts owed to the Crown and other unfinished business to bring back before the court.

## Install

Requires Node.js 22.19.0 or newer, a Node-based Pi installation (0.84.4 or newer), and [Taskwarrior 3](https://taskwarrior.org/download/) (`task` on your `PATH`). If you do not already use Taskwarrior, install and initialize it. On macOS:

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

Save task suggestions when you leave a session, without asking for a review each time. Capture never changes your Taskwarrior tasks; you approve suggestions later in [Saved proposals](#saved-proposals).

Capture is off by default. To enable it, add this to Pi's global settings file, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "autoCapture": true } }
```

### What to expect

- **When:** you leave a saved interactive terminal session by quitting, reloading, starting a new session, resuming another, or forking. Unsaved sessions and non-TUI modes do not start capture.
- **Scope:** unreviewed messages across the saved tree of the outgoing session. Capture does not scan your archive or run on active turns.
- **Leaving:** Pi waits to preserve a private session copy and publish the job, not for model work. Copying large sessions can still delay shutdown, especially when filesystem cloning is unavailable.
- **Review:** an on-demand detached process uses the outgoing model, thinking level, project trust and normal Pi credentials. It can continue after Pi exits and incurs normal model costs. It cannot apply tasks.
- **Result:** proposals and review progress are saved together. An open terminal checks for saved changes without starting chat turns; open `/remembrancer proposals` to approve individual items.

Turning `autoCapture` off stops **new jobs only**. Already accepted jobs can finish, retry and save proposals, even if Remembrancer is subsequently disabled. Saved proposals and startup reminders remain available with capture off. Trusted project settings can override global settings when admitting a job.

### Recovery and limits

Accepted evidence is retained until successful or already-covered completion. Failed jobs retain their evidence; retries do not silently advance review progress. Manual reviews keep ownership until you finish or cancel them, so background work may defer or repeat preparation after your changes.

An open interactive Pi checks for accepted work at startup and about once a minute, including with capture off. Later launches also wake the worker. No daemon or supervisor runs while Pi is closed: a failed launch or crashed worker can wait until the next wake. If a crash occurs after results commit but before the notice file is replaced, proposals are saved but the reminder waits for successful recovery.

State lives under `$XDG_STATE_HOME/pi-remembrancer` (normally `~/.local/state/pi-remembrancer`). The `capture-inbox` directory holds retained session copies; `checkpoints.sqlite3.capture.log` records worker failures. Keep unresolved evidence when diagnosing failures. Missing originating credentials/settings, incompatible coverage or ambiguous publication artifacts may require attention rather than repeated retries.

The worker loads the published TypeScript through **jiti from the originating Node-based Pi installation**, using that installation's SDK. There is no separate compiled worker or package build step. Keep that installation and its configuration available for accepted jobs. Standalone/Bun-only hosts are not supported by this launch path.

Asynchronous setup, model and cleanup hangs have a timeout and exit grace period. There is no independently scheduled CPU-stall watchdog, and worker exit does not guarantee termination of every child process.

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

## Track task blockers

To record what a task is waiting on, add the `waitingon` field:

```shell
task config uda.waitingon.type string
```

Skip this setup if you do not need waiting conditions; other task operations work without it.

## Settings

Manual Remembrancer features are enabled by default; automatic capture remains opt-in. Disable foreground features and new capture jobs in Pi's global settings file, normally `~/.pi/agent/settings.json` (accepted jobs still finish or retry):

```json
{ "pi-remembrancer": { "disabled": true } }
```
