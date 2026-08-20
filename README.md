# Pi Userland

[![CI](https://github.com/robhowley/pi-userland/actions/workflows/ci.yml/badge.svg)](https://github.com/robhowley/pi-userland/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/robhowley/pi-userland.svg)](https://github.com/robhowley/pi-userland/blob/main/LICENSE)
[![site](https://img.shields.io/badge/site-pi--userland.dev-black.svg)](https://pi-userland.dev)
[![npm packages](https://img.shields.io/badge/npm-pi--userland_packages-black.svg)](https://www.npmjs.com/search?page=0&q=keywords%3Api-userland&sortBy=downloads_monthly)

Monorepo of independently publishable Pi packages.

Small, focused packages to augment your Pi environment without adding unnecessary overhead. Private apps and release builders live under `apps/` so `packages/*` remains independently installable.

## Packages

| Package                                                           | Description                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`pi-cmux-junction`](packages/pi-cmux-junction/README.md)         | Fork and run parallel Pi sessions in isolated Git worktrees and cmux workspaces, with fast session jumping and safe teardown.                                                                          |
| [`pi-session-deck`](packages/pi-session-deck/README.md)           | The full Pi session lifecycle in one place: create and organize sessions across repos and worktrees, see what each agent is doing or waiting on, and reopen or end them from a TUI or iTerm2 Toolbelt. |
| [`pi-merge-ready`](packages/pi-merge-ready/README.md)             | See if your pull request is ready, what’s blocking it, and let Pi fix what it can.                                                                                                                     |
| [`pi-openrouter`](packages/pi-openrouter/README.md)               | OpenRouter usage/account overlays, model sync, api key management, and session tagging for Pi.                                                                                                         |
| [`pi-session-hygiene`](packages/pi-session-hygiene/README.md)     | Status bar indicator for session cost, context, and cache rate to track session health                                                                                                                 |
| [`pi-spinner-verbs`](packages/pi-spinner-verbs/README.md)         | Customizes thinking text with themed verbs (e.g., "Paying the iron price...", "With fire and blood...") for sessions with more personality.                                                            |
| [`pi-structured-return`](packages/pi-structured-return/README.md) | Save money by turning noisy CLI output into compact structured results (fewer tokens), full logs preserved.                                                                                            |
| [`pi-yolo-seatbelt`](packages/pi-yolo-seatbelt/README.md)         | Configurable guardrails for destructive commands. Keep the YOLO workflow but avoid bash catastrophe.                                                                                                   |

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

### Add a private app or release builder

```bash
apps/<name>/
```

Private apps can be pnpm workspaces for CI/build coverage, but they are not added to release-please manifests or published to npm.

## Releasing

Packages are versioned and released independently using conventional commits.

## License

MIT
