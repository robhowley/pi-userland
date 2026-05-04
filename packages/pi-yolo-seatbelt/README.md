# yolo-seatbelt

Safety guard for bash commands in Pi agents. Blocks or prompts for dangerous commands like `rm -rf /`, `git reset --hard`, etc.
Permissions for each of the supported commands are fully configurable. Keep your session as loose or strict as desired.

## Installation

```bash
pi install npm:@robhowley/pi-yolo-seatbelt
```

## How It Works

yolo-seatbelt intercepts bash tool calls and evaluates commands against a set of safety rules:

1. **BLOCK** - Immediate rejection (catastrophic patterns like `rm -rf /`)
2. **ASK** - User confirmation (destructive patterns like `git push --force`)
3. **ALLOW** - Command proceeds normally

### Rule Categories

| Category             | Rules                | Description            |
|----------------------|----------------------|------------------------|
| `rm-rf-root`         | `rm -rf /`           | delete entire filesystem |
| `rm-rf-git`          | `rm -rf .git`        | delete repository      |
| `rm-rf-home`         | `rm -rf ~`           | delete home directory  |
| `rm-rf`              | `rm -rf`             | dangerous without path |
| `find-delete`        | `find ... -delete`   | delete via find        |
| `chmod-recursive`    | `chmod -R`           | recursive permissions  |
| `chown-recursive`    | `chown -R`           | recursive ownership    |
| `path-git`           | `.git`               | directory access       |
| `path-env`           | `.env`               | file access            |
| `path-ssh`           | `.ssh`               | directory access       |
| `path-npmrc`         | `.npmrc`             | file access            |
| `path-pypirc`        | `.pypirc`            | file access            |
| `path-netrc`         | `.netrc`             | file access            |
| `path-ssh-key`       |  `.ssh`              | SSH private keys       |
| `path-pem`           | `.pem`               | certificate files |
| `outside-workspace`  | `../`                | Paths outside workspace |
| `sudo`               | | Privilege escalation |
| `git.reset-hard`     | `git reset --hard`  | |
| `git.clean-force`        | `git clean -f/d/x`   | |
| `git.push-force`         | `git push --force`   | |
| `git.rebase-interactive` | `git rebase -i`      | |
| `git.filter-branch`      | `git filter-branch`  | |
| `git.update-ref`         | `git update-ref`     | |
| `git.reflog-expire`      | `git reflog expire`  | |

## Configuration

Create `~/.pi/agent/yolo-seatbelt.json`:

```json
{
  "logLevel": "warn",
  "rules": {
    "git.push-force": "allow",
    "rm-rf-root": "block",
    "outside-workspace": "ask"
  }
}
```

### Config Schema

- `logLevel`: `"none" | "warn" | "debug"` - Log level for debugging
- `rules`: `Record<string, "block" | "ask" | "allow">` - Override rule behavior by rule ID

### Utility

View the active rule set and permissions

```shell
/yolo-seatbelt-rules
```