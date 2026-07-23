# Session Deck Desktop app

Private Tauri desktop companion for Session Deck. This app lives under `apps/` so the `packages/*` tree remains limited to independently installable Pi packages.

## What it does

- Loads Session Deck snapshots through the installed Node helper.
- Reuses the existing open-terminal and worktree helper CLIs.
- Prefers `~/.pi/session-deck/desktop/install.json` for desktop runtime metadata.
- Falls back to `~/.pi/session-deck/iterm2/install.json` only for development/back-compat.
- Rebuilds a safe helper `PATH` for Finder-launched app processes.

## Commands

- `pnpm --filter ./apps/session-deck-desktop sync:web`
- `pnpm --filter ./apps/session-deck-desktop typecheck`
- `pnpm --filter ./apps/session-deck-desktop test`
- `pnpm --filter ./apps/session-deck-desktop build`
- `pnpm --filter ./apps/session-deck-desktop tauri dev`
- `pnpm --filter ./apps/session-deck-desktop artifact:macos -- --version <pi-session-deck-version>`

## Notes

`sync:web` copies the canonical `index.html`, `style.css`, and `session-deck-ui.js` assets from `packages/pi-session-deck/extensions/session-deck/iterm2/web/`, then overlays the desktop-specific Tauri bootstrap.

`artifact:macos` builds Tauri `app`/`dmg` bundles, zips the `.app`, writes deterministic `session-deck-desktop-v<version>-macos-<arch>` artifact names, and emits `.sha256` sidecars. It currently builds unsigned artifacts (`--no-sign`) unless `SESSION_DECK_DESKTOP_SIGN=true` is set and signing/notarization is configured in CI.
