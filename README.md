# Pi Userland

Personal monorepo for independently publishable [Pi](https://github.com/pixl8/pi) packages.

## Goal

Build `pi-userland` as a personal monorepo for independently publishable Pi packages.
Key constraint: keep packages modular so you can install only the prompt/tool overhead you want in a given Pi config.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| _TBD_ | _TBD_ | _TBD_ |

## Quickstart

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)

### Install dependencies

```bash
pnpm install
```

### Run checks

```bash
pnpm lint
pnpm format:check
pnpm typecheck
```

## Development

### Add a new package

1. Create directory: `packages/<name>/`
2. Copy structure from existing packages (template coming soon)
3. Add to workspace in `pnpm-workspace.yaml` if not auto-detected

### Publish a package

```bash
cd packages/<name>
pnpm publish
```

## License

MIT
