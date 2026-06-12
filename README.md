# Pi Userland

[![CI](https://github.com/robhowley/pi-userland/actions/workflows/ci.yml/badge.svg)](https://github.com/robhowley/pi-userland/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/robhowley/pi-userland.svg)](https://github.com/robhowley/pi-userland/blob/main/LICENSE)
[![site](https://img.shields.io/badge/site-pi--userland.dev-black.svg)](https://pi-userland.dev)
[![npm packages](https://img.shields.io/badge/npm-pi--userland_packages-black.svg)](https://www.npmjs.com/search?page=0&q=keywords%3Api-userland&sortBy=downloads_monthly)

Monorepo of independently publishable Pi packages.

Small, focused packages to augment your Pi environment without adding unnecessary overhead.

## Packages

| Package                                                           | Description                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`pi-merge-ready`](packages/pi-merge-ready/README.md)             | PR merge-readiness for Pi: status bar and slash-command status, exact PR URL targeting, blocker context, and agent repair loops.             |
| [`pi-openrouter`](packages/pi-openrouter/README.md)               | OpenRouter usage/account overlays, model sync, api key management, and session tagging for Pi.                                                                  |
| [`pi-session-deck`](packages/pi-session-deck/README.md)         | Terminal-native overview of all your live Pi sessions: status, usage, cwd, branch, model, and last activity in one compact deck. |
| [`pi-session-hygiene`](packages/pi-session-hygiene/README.md)     | Status bar indicator for session cost, context, and cache rate to track session health                                                      |
| [`pi-spinner-verbs`](packages/pi-spinner-verbs/README.md)         | Customizes thinking text with themed verbs (e.g., "Paying the iron price...", "With fire and blood...") for sessions with more personality. |
| [`pi-structured-return`](packages/pi-structured-return/README.md) | Save money by turning noisy CLI output into compact structured results (fewer tokens), full logs preserved.                                 |
| [`pi-yolo-seatbelt`](packages/pi-yolo-seatbelt/README.md)         | Configurable guardrails for destructive commands. Keep the YOLO workflow but avoid bash catastrophe.                                        |

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
