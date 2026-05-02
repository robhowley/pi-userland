# yolo-seatbelt

A safety guard for Pi's bash tool execution. Blocks or asks before executing dangerous shell commands like `rm -rf /`, `git reset --hard`, or writes to sensitive paths like `.env`.

## Installation

```bash
# Place in your Pi agent extensions directory
mkdir -p ~/.pi/agent/extensions/yolo-seatbelt
cp -r path/to/yolo-seatbelt/* ~/.pi/agent/extensions/yolo-seatbelt/

# Or use the pi-userland package
cd packages/pi-yolo-seatbelt
pnpm install
pnpm build
```

## Configuration

Create `~/.pi/agent/yolo-seatbelt.json` to customize behavior:

```json
{
  "outsideWorkspace": "ask",
  "logLevel": "none"
}
```

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `outsideWorkspace` | `"ask"` \| `"block"` | `"ask"` | Behavior when a command targets a path outside the current working directory |
| `logLevel` | `"none"` \| `"warn"` \| `"debug"` | `"none"` | Log level for ASK/BLOCK decisions |

## Patterns

### BLOCK Patterns (Always Blocked)
| Pattern | Example | Reason |
|---------|---------|--------|
| `rm -rf /` | `rm -rf /` | Absolute root deletion |
| `rm -rf .git` | `rm -rf .git` | Repository corruption |
| `rm -rf ~` | `rm -rf ~` | Home directory deletion |

### ASK Patterns (Confirmation Required)
| Pattern | Example | Reason |
|---------|---------|--------|
| `rm -rf` | `rm -rf .tmp` | Destructive recursive delete |
| `find ... -delete` | `find . -name "*.log" -delete` | Bulk file deletion |
| `chmod -R` | `chmod -R 777 .` | Recursive permission change |
| `chown -R` | `chown -R user:group .` | Recursive ownership change |
| `sudo` | `sudo rm -rf /` | Privilege escalation |
| `git reset --hard` | `git reset --hard HEAD~1` | Git history loss |
| `git clean -[fdx]` | `git clean -fd` | Git working directory cleanup |
| `git push --force` | `git push --force` | Force push |
| `git rebase -i` | `git rebase -i HEAD~3` | Interactive rebase |
| `git filter-branch` | `git filter-branch --tree-filter ...` | History rewrite |
| `git update-ref` | `git update-ref -d HEAD` | Ref manipulation |
| `git reflog expire` | `git reflog expire --expire=now` | Reflog cleanup |

### Protected Paths (Blocked)
| Path | Description |
|------|-------------|
| `.git` | Git repository |
| `.env*` | Environment files |
| `.ssh` | SSH keys and config |
| `.npmrc` | NPM configuration |
| `.pypirc` | PyPI configuration |
| `.netrc` | Network credentials |
| `id_rsa` | RSA private key |
| `id_ed25519` | Ed25519 private key |
| `*.pem` | Certificate keys |

## Usage

The extension automatically intercepts all `bash` tool calls in Pi. No manual intervention needed.

### Expected Behavior

| Command | Decision | User Action |
|---------|----------|-------------|
| `rm -rf .git` | BLOCK | Error shown, command blocked |
| `find . -delete` | ASK | Prompt: "Continue? (y/n)" |
| `pytest` | ALLOW | Executes normally |

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Typecheck
pnpm typecheck
```

## Related

- [Pi SDK](https://github.com/roberthowley/pi) - Extension API documentation
