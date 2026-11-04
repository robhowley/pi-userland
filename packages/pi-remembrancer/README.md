# pi-remembrancer

Remembrancer reviews your saved Pi sessions to find what you said you’d do and what you’ve done since. It checks what’s already in your personal Taskwarrior list and suggests new tasks, progress notes, and completions for you to review together.

## Install

Requires [Taskwarrior 3](https://taskwarrior.org/download/) (`task` on your `PATH`).

```shell
pi install npm:@robhowley/pi-remembrancer
```

Then run `/reload` or start a new session.

### Set up Taskwarrior

If you don't already use Taskwarrior, install and initialize it. On macOS:

```shell
brew install task
task
```

To track what a task is waiting on, add this optional field:

```shell
task config uda.waitingon.type string
```

## Try it

| Say this in Pi                                                                   | What happens                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| “Add ‘run the held-out comparison’ to work.ranking.”                             | Check for a matching task and add the commitment.                          |
| “I’ll send the route once the school confirms pickup. Add that to life.bikebus.” | Add “Send the route” with a waiting condition.                             |
| “The school confirmed pickup. Update my route todo.”                             | Clear the waiting condition; sending the route stays pending.              |
| “Wrap up this session.”                                                          | Suggest new tasks, progress notes, and completions from this conversation. |
| “What changed since my last review?”                                             | Review new activity across saved sessions and suggest changes together.    |

You can also invoke the skill directly:

```text
/skill:remembrancer review commitments across my saved sessions
```

Explicit requests to add or change a task are applied directly. Changes inferred from your sessions are suggestions: accept, edit, or dismiss them before anything is written.

Your tasks stay in Taskwarrior. Use `task list` or `task completed` any time.

## What gets reviewed

- Only saved sessions opened or resumed with Remembrancer enabled. Resume an older session to include it in your next review.
- Reviews use user and assistant messages, not tool outputs, model thinking, or images. That text is sent to the model in your reviewing session.
- Forked sessions can repeat shared context. That is expected, so a commitment or prior dismissal may appear again while branches are reconciled.
- Reviews happen when you ask, not in the background. An interrupted review may show the same suggestions again.

If you launch delegated workers, keep personal task changes in the parent session. Set `PI_REMEMBRANCER_DISABLED=1` in the worker launcher or leave this package out of its profile. Workers with a positive `PI_SUBAGENT_DEPTH` are already excluded.
