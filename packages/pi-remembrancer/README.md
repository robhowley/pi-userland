# pi-remembrancer

Remembrancer is an agent-powered personal task manager built on Taskwarrior. It reads your saved Pi sessions to find what you said you would do and what you have done since. It checks what is already on your list, then suggests new tasks, progress notes, and completions for you to review in one pass.

> **Remembrancer** _(noun)_ - an officer of the medieval English Exchequer who kept the _memoranda rolls_, a record of debts owed to the Crown and other unfinished business to bring back before the court.

## Install

Requires [Taskwarrior 3](https://taskwarrior.org/download/) (`task` on your `PATH`).

```shell
pi install npm:@robhowley/pi-remembrancer
```

Then run `/reload` or start a new session.

### Set up Taskwarrior

If you do not already use Taskwarrior, install and initialize it. On macOS:

```shell
brew install task
task
```

To track what a task is waiting on, add this optional field:

```shell
task config uda.waitingon.type string
```

The `waitingon` field is optional. Configure it only for operations that record waiting conditions. Ordinary list, add, update, and close operations do not require it.

## Try it

| Say this in Pi                                                                    | What happens                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| “Add ‘run the held-out comparison’ to work.ranking.”                              | Check for a matching task and add the commitment.                          |
| “I’ll send the route after the school confirms pickup. Add that to life.bikebus.” | Add “Send the route” with a waiting condition.                             |
| “The school confirmed pickup. Update my route todo.”                              | Clear the waiting condition; sending the route stays pending.              |
| “Wrap up this session.”                                                           | Suggest new tasks, progress notes, and completions from this conversation. |
| “What changed since my last review?”                                              | Review new activity across saved sessions and suggest changes together.    |

You can also invoke the skill directly:

```text
/skill:remembrancer review commitments across my saved sessions
```

Explicit requests to add or change a task are applied directly after the actual record is checked. Changes inferred from your sessions are suggestions: accept, edit, or dismiss them before anything is written.

Historical review is a full review of eligible enrolled saved sessions. The review tool cannot select a historical slice or finish a partial historical checkpoint. For a narrower need, choose a full review or a current-session scope rather than silently broadening the request.

Your tasks stay in Taskwarrior. Use `task list` or `task completed` any time.

## What gets reviewed

- Only saved sessions opened or resumed with Remembrancer enabled. Resume an older session to include it in your next review.
- Reviews use user and assistant messages, not tool outputs, model thinking, or images. That text is sent to the model in your reviewing session.
- Forked sessions can repeat shared context. A cancelled or interrupted review can also return previously considered candidates. Reconcile branch provenance and applicable dismissals rather than treating recurrence as new authority.
- Reviews happen when you ask, not in the background. Unavailable saved-session ranges remain unreviewed.

## Settings

Remembrancer is enabled by default. To disable extension review and enrollment, add this to the global settings file in Pi's active agent directory, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "disabled": true } }
```

A trusted project's `.pi/settings.json` takes precedence over the global value. After changing settings, run `/reload` or start a new session. This setting disables extension review and enrollment only; it does not unload the separately discoverable skill or prevent Taskwarrior writes.

Only the main user-facing session should write personal Taskwarrior changes. Delegated workers should return evidence and proposed changes to that session. This is a workflow convention, not a hard write restriction enforced by the extension or Taskwarrior. If you launch delegated workers, keep personal task changes in the main user-facing session.
