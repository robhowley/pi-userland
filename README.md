# Pi Userland

Monorepo of independently publishable packages for [Pi coding agent](https://pi.dev/).

Small, focused packages to augment your Pi environment without adding unnecessary overhead.

## Packages

| Package | Description |
|--------|------------|
| `pi-session-hygiene` | Status bar indicator for session cost, context, and cache rate to track session health |

## Setup

```bash
pnpm install
```

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm format:check
```

## Development

### Add a package

```bash
packages/<name>/
```

Requirements:
- independently publishable  
- narrow scope  
- minimal cross-package dependencies  

## Releasing

Packages are versioned and released independently using conventional commits.

## License

MIT
