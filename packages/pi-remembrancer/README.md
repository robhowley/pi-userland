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

Type slash commands in Pi’s prompt. The duration must be a positive whole number of days in `<Nd>` form, such as `14d` or `30d`.

| Say this in Pi                                                                    | What happens                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/remembrancer seed 14d`                                                          | Review the last 14 days in Pi’s configured session archive.                |
| `/remembrancer seed 30d`                                                          | Review the last 30 days in Pi’s configured session archive.                |
| “Add ‘run the held-out comparison’ to work.ranking.”                              | Check for a matching task and add the commitment.                          |
| “I’ll send the route after the school confirms pickup. Add that to life.bikebus.” | Add “Send the route” with a waiting condition.                             |
| “The school confirmed pickup. Update my route todo.”                              | Clear the waiting condition; sending the route stays pending.              |
| “Wrap up this session.”                                                           | Suggest new tasks, progress notes, and completions from this conversation. |
| “What changed since my last review?”                                              | Review new activity across saved sessions and suggest changes together.    |

You can also invoke the skill directly:

```text
/skill:remembrancer review commitments across my saved sessions
```

Natural-language requests such as “Seed 14d.” still work.

Explicit requests to add or change a task are applied directly after the actual record is checked. Changes inferred from your sessions are suggestions: accept, edit, or dismiss them before anything is written.

Your tasks stay in Taskwarrior. Use `task list` or `task completed` any time.

### Start with recent history

Use `/remembrancer seed 14d` to review the past 14 days of saved conversations in Pi’s configured session archive, including sessions from before you installed Remembrancer. After completing that review, ask “What changed since my last review?” to pick up new activity from those sessions without widening that review window.

Want to go further back? Use `/remembrancer seed 30d`. Remembrancer adds the earlier history to the review window and includes any new activity. Seeding again never shortens the history you track.

Use a positive whole number of days. Saved-session reviews do not support custom date ranges or project-only slices; you can scope a review of the current conversation instead.

## What gets reviewed

- Regular reviews cover sessions opened or resumed with Remembrancer enabled. An older session included for the first time this way can bring in its full history; use seed to set a starting point instead.
- Seed also searches Pi's configured session archive, including saved worker sessions. It does not reconstruct which sessions had Remembrancer disabled in the past.
- Only user and assistant text is sent to the model in your reviewing session, not tool outputs, model thinking, or images.
- Reviews run only when you ask. Activity added during a review waits for the next one.
- If a session cannot be read, Remembrancer reports it and leaves it for a later review. Cancelling a review leaves review progress unsaved, but it does not undo task changes already applied.

## Settings

Remembrancer is enabled by default. To disable extension review and enrollment, add this to the global settings file in Pi's active agent directory, normally `~/.pi/agent/settings.json`:

```json
{ "pi-remembrancer": { "disabled": true } }
```

A trusted project's `.pi/settings.json` takes precedence over the global value. After changing settings, run `/reload` or start a new session. This setting disables extension review and enrollment only; it does not unload the separately discoverable skill or prevent Taskwarrior writes.

If you use delegated workers, keep task changes in your main session and have workers return suggestions only. Remembrancer does not enforce this restriction.
