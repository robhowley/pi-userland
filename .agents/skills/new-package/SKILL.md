---
name: new-package
description: |
  Create a new Pi package in the pi-userland monorepo. Use this skill whenever the user mentions adding, scaffolding,
  or creating a new package, extension, or module — even if they don't explicitly say 'new package.' Also trigger when
  the user discusses pi-userland, monorepo setup, or needs boilerplate for a Pi extension. Always ask for confirmation
  before running commands.
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
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/<basename>"]
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/robhowley/pi-userland.git",
    "directory": "packages/<name>"
  },
  "homepage": "https://github.com/robhowley/pi-userland/tree/main/packages/<name>",
  "scripts": {
    "lint": "eslint extensions/",
    "format:check": "prettier --check extensions/",
    "format:write": "prettier --write extensions/",
    "typecheck": "tsc --noEmit",
    "test": "vitest run __tests__"
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@types/node": "^22.15.17"
  }
}
```

## Extension template (extensions/<basename>/index.ts)

```typescript
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

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
3. Run scaffolding commands with `$NAME=pi-session-hygiene`, `$BASENAME=session-hygiene`

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
- Uses `@robhowley/` npm scope
