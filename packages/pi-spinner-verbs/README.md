# Spinner Verbs

> "Thinking..." is the most boring thing a genius could say.

A [pi](https://pi.dev) extension that customizes the spinner text while the LLM is working. Replace the default spinner verbs with something that has a little more personality.

**Before**: "Thinking...", "Processing...", "Working..." 🥱

**After**: "Paying the iron price...", "With fire and blood..." ⚔️🐉

## Installation

Install directly from npm:

```shell
pi install npm:@robhowley/pi-spinner-verbs
```

That's it. The extension registers automatically and on the next session start will randomly pick a theme for you.

### Switching Themes with `/verbs`

Change your verb list at any time during a session:

```
/verbs game-of-thrones
/verbs doc-emrick
/verbs random
/verbs (default)
```

Run `/verbs` with no argument to get an interactive picker. Use `random` to pick a new random theme, or `(default)` to restore the default spinner.

### Checking Status with `/verb-status`

Check the current session spinner settings at any time:

```
/verb-status
```

### Auto-configure via `settings.json`

Set your preferred theme once and forget about it. Pi checks both project-local (`.pi/settings.json`) and global (`~/.pi/agent/settings.json`) settings on session start.

**Randomly pick a theme each session (default):**

```json
{
  "spinnerVerbs": "random"
}
```

**Use a specific built-in theme by name:**

```json
{
  "spinnerVerbs": "game-of-thrones"
}
```

**Point to your own custom verbs file:**

```json
{
  "spinnerVerbsFile": "~/my-verbs.json"
}
```

The path supports three forms and is resolved relative to the `settings.json` file that contains it — not relative to your working directory:

| Form | Example | Resolved as |
|------|---------|-------------|
| `~/...` | `~/my-verbs.json` | Expanded from your home directory |
| `/absolute/...` | `/etc/my-verbs.json` | Used as-is |
| `relative/...` | `../my-verbs.json` | Relative to the `settings.json` file's directory |

So if your `.pi/settings.json` contains `"spinnerVerbsFile": "../my-verbs.json"`, it resolves to `my-verbs.json` in the project root — not wherever you launched pi from.

Your custom file can be a plain JSON array:

```json
["Brewing coffee...", "Asking the oracle...", "Consulting the void..."]
```

**Priority order**: `--verbs` CLI flag → project `.pi/settings.json` → global `~/.pi/agent/settings.json`

---

## Available Themes

| Theme | Sample                                                        |
|-------|---------------------------------------------------------------|
| `game-of-thrones` | Taking the black..., Winter is coming..., By your leave...    |
| `lord-of-the-rings` | One does not simply..., You shall not pass... So it begins... |
| `action-movie` | Yippee-ki-yay..., I'll be back..., I know kung fu...          |
| `game-show` | Come on down..., Survey says..., Is that your final answer... |
| `harry-potter` | Accio..., Expecto Patronum..., Wingardium Leviosa...      |
| `corporate-jargon` | Double clicking..., Pressure testing..., Closing the loop... |
| `doc-emrick` | Shunting..., Sliding..., Fiddling...                          |
| `momentum` | Making moves..., Spinning up..., Getting traction...          |
| `weird-legalese` | Mutatis mutandis..., Res ipsa loquitur..., Ultra vires...     |

Use `"spinnerVerbs": "random"` to have a theme randomly selected from the list above at each session start.
