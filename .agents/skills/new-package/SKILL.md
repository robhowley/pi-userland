---
name: new-package
description: |
  Create a new Pi package in the pi-userland monorepo using the Pi 1.x hard-cutover
  dependency and Node.js policy. Use this skill whenever the user mentions adding,
  scaffolding, or creating a new package, extension, or module — even if they don't
  explicitly say 'new package.' Also trigger for pi-userland monorepo setup or
  extension boilerplate. Always ask for confirmation before running commands.
---

# Pi userland new package scaffolding

## When to use

- User wants to add a new package to the pi-userland monorepo
- User asks to scaffold a new Pi extension
- User mentions "new package", "add package", or discusses pi-userland/monorepo setup
- User needs boilerplate for a Pi extension

## Before you start

1. Confirm the package name follows the pattern: `pi-*` (lowercase, hyphenated)
2. Identify the **basename** — the package name without the `pi-` prefix. For `pi-session-hygiene`, the basename is `session-hygiene`.

## Quick start

1. Ask for the package name (e.g., `pi-session-hygiene`, `pi-spinner-verbs`)
2. Confirm the name follows pattern: `pi-*` (lowercase, hyphenated)
3. Ask for a package description
4. Create the package directory and files using the commands below

## Package structure

```
packages/<name>/
├── extensions/
│   └── <basename>/
│       └── index.ts      # Extension entry point
├── __tests__/            # Test files
├── package.json
├── README.md
└── tsconfig.json         # Minimalist, relies on base config, no build
```

Where `<basename>` is `<name>` without the `pi-` prefix (e.g., `session-hygiene` for package `pi-session-hygiene`).

## Pi 1.x dependency policy

- Target Node.js `>=22.19.0`.
- Use only `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` imports. This is a hard cutover: do not add legacy namespace imports, compatibility aliases, or fallback imports.
- Pi provides the listed Pi packages and `typebox` at runtime. Declare every host package the extension actually imports in `peerDependencies`, declare no unused host package, and never put a host package in `dependencies`.
- Use `^1.4.0` peer ranges for `@earendil-works/pi-*` packages. Pin the same packages to `1.4.0` in `devDependencies` so local validation uses the cutover baseline.
- If the extension imports `typebox` for schemas or types, add `typebox: "^1.3.27"` to `peerDependencies` and `typebox: "1.3.27"` to `devDependencies`. Import TypeBox from `typebox`, not from `pi-ai`.
- Put other libraries used at runtime in `dependencies`.

## Commands to run

```bash
# Derive basename from package name (strip pi- prefix)
BASENAME="${NAME#pi-}"

# Create directory structure
mkdir -p packages/$NAME/extensions/$BASENAME
mkdir -p packages/$NAME/__tests__
```

## package.json template

```json
{
  "name": "@robhowley/<name>",
  "version": "0.1.0",
  "type": "module",
  "description": "<package_description>",
  "files": [
    "extensions",
    "<optional-subdir>",
    "README.md",
    "../LICENSE"
  ],
  "publishConfig": {
    "access": "public"
  },
  "keywords": ["pi-package", "pi-userland"],
  "pi": {
    "extensions": ["./extensions/<basename>"]
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/robhowley/pi-userland.git",
    "directory": "packages/<name>"
  },
  "homepage": "https://pi-userland.dev",
  "scripts": {
    "lint": "eslint extensions/",
    "format:check": "prettier --check extensions/",
    "format:write": "prettier --write extensions/",
    "typecheck": "tsc --noEmit",
    "test": "vitest run __tests__"
  },
  "license": "MIT",
  "engines": {
    "node": ">=22.19.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^1.4.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@types/node": "^22.15.17"
  }
}
```

## Extension template (extensions/<basename>/index.ts)

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('Extension loaded', 'info');
  });
}
```

## README template

```markdown
# <name>

Brief description of what this package does.

## Requirements

- Pi 1.x and Node.js `>=22.19.0`.

## Installation

```shell
pi install npm:@robhowley/<name>
```
```

## Example workflow

**Input:** "Add a new package called pi-session-hygiene"

**Process:**
1. Package name: `pi-session-hygiene` ✓ (follows `pi-*` pattern)
2. Basename: `session-hygiene`
3. Inspect the extension imports and declare only the host packages it actually uses as peers.
4. Run scaffolding commands with `$NAME=pi-session-hygiene`, `$BASENAME=session-hygiene`

**Resulting structure:**
```
packages/pi-session-hygiene/
├── extensions/
│   └── session-hygiene/
│       └── index.ts
├── __tests__/
├── package.json       # name: @robhowley/pi-session-hygiene
├── README.md
└── tsconfig.json
```

After creating the package:

1. Update `.github/release-please-config.json` to include the new package
2. Update `.github/release-please-manifest.json` with initial version
3. Update repo level `README.md` to list the new package

## Requirements

- Package must be independently publishable
- Narrow scope
- Minimal cross-package dependencies
- Declare actually used Pi host dependencies as peers, with exact `1.4.0` dev pins
- Add the `typebox` peer only when the package imports it for schemas or types, using the `^1.3.27` peer and `1.3.27` dev baseline
- Uses `@robhowley/` npm scope
