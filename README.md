# Pi Userland

Monorepo of independently publishable Pi packages.

Small, focused packages to augment your Pi environment without adding unnecessary overhead.

## Packages

| Package                                                       | Description |
|---------------------------------------------------------------|------------|
| [`pi-session-hygiene`](packages/pi-session-hygiene/README.md) | Status bar indicator for session cost, context, and cache rate to track session health |
| [`pi-spinner-verbs`](packages/pi-spinner-verbs/README.md)     | Customizes thinking text with themed verbs (e.g., "Paying the iron price...", "With fire and blood...") for sessions with more personality. |
| [`pi-structured-return`](packages/pi-structured-return/README.md) | 

## Install

### An individual package

```shell
pi install npm:@robhowley/[name-of-package]
```

### The full bundle

```shell
pi install git:github.com/robhowley/pi-userland
```

## Development

### Setup

```bash
pnpm install
```

### Checks

```bash
pnpm lint
pnpm typecheck
pnpm format:check
```

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
