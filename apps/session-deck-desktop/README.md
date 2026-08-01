# Session Deck Desktop app

Private Tauri desktop companion for Session Deck. This app lives under `apps/` so the `packages/*` tree remains limited to independently installable Pi packages.

## What it does

- Loads Session Deck snapshots through the installed Node helper.
- Reuses the existing open-terminal and worktree helper CLIs.
- Exposes the shared, generation-safe Restart Session action for eligible Session Deck-managed tmux sessions without sending private launch recipes to the webview.
- Prefers `~/.pi/session-deck/desktop/install.json` for desktop runtime metadata.
- Falls back to `~/.pi/session-deck/iterm2/install.json` only for development/back-compat.
- Rebuilds a safe helper `PATH` for Finder-launched app processes.

## Commands

- `pnpm --filter ./apps/session-deck-desktop sync:web`
- `pnpm --filter ./apps/session-deck-desktop typecheck`
- `pnpm --filter ./apps/session-deck-desktop test`
- `pnpm --filter ./apps/session-deck-desktop build`
- `pnpm --filter ./apps/session-deck-desktop dev:isolated` — build the local helper and launch from temporary checkout-specific metadata without replacing the installed app
- `pnpm --filter ./apps/session-deck-desktop tauri dev`
- `pnpm --filter ./apps/session-deck-desktop artifact:macos --version <version> --target <aarch64-apple-darwin|x86_64-apple-darwin>`

## Release artifacts

`artifact:macos` builds one native Tauri `.app`, verifies that its executable contains only the target architecture, and packages the app with `ditto`. It emits one deterministic `session-deck-desktop-v<version>-macos-<arch>.zip` and its `.sha256` sidecar.

The app is ad-hoc signed with Tauri's `-` identity. It is not Developer ID signed and is not notarized. No Apple credentials are required. macOS may block the first launch; first try to open the app, then, only if you trust the release, use **System Settings → Privacy & Security → Open Anyway**.

See [RELEASE.md](./RELEASE.md) for the dual-architecture release and publication contract.
