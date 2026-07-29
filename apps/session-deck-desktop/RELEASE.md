# Session Deck Desktop release runbook

The release workflow is `.github/workflows/release-please.yml`. It publishes two prebuilt native macOS app ZIPs for `@robhowley/pi-session-deck` before publishing the npm package.

## Native builds

| GitHub runner    | Rust target            | Artifact architecture |
| ---------------- | ---------------------- | --------------------- |
| `macos-15`       | `aarch64-apple-darwin` | `arm64`               |
| `macos-15-intel` | `x86_64-apple-darwin`  | `x64`                 |

Each matrix leg builds only the Tauri `.app` bundle for its explicit target. The builder checks that the app's executable is non-empty, executable, and contains only the expected architecture. It then creates the ZIP with:

```sh
/usr/bin/ditto -c -k --keepParent --sequesterRsrc --zlibCompressionLevel 9 \
  "Session Deck Desktop.app" <artifact>.zip
```

This preserves the bundle structure, resource forks, and executable modes. Do not pass the `.app` directory directly to `actions/upload-artifact`.

## Signing and first launch

Both builds are ad-hoc signed with Tauri's free identity `-`. They are **not Developer ID signed** and **not notarized**. The ad-hoc signature does not verify the publisher, and no Apple credentials are required.

macOS may block the first launch. Users should:

1. Verify the downloaded ZIP against its published `.sha256` sidecar.
2. Extract the ZIP, move **Session Deck Desktop.app** to `/Applications`, and try to open it once.
3. Only if they trust the release, use **System Settings → Privacy & Security → Open Anyway**.
4. Confirm **Open** and authenticate if macOS asks.

Do not remove quarantine attributes or recommend disabling Gatekeeper.

## Four-file release contract

For package version `<V>`, the public `pi-session-deck-v<V>` GitHub release contains exactly:

```text
session-deck-desktop-v<V>-macos-arm64.zip
session-deck-desktop-v<V>-macos-arm64.zip.sha256
session-deck-desktop-v<V>-macos-x64.zip
session-deck-desktop-v<V>-macos-x64.zip.sha256
```

Each sidecar is one lowercase SHA-256 followed by two spaces and the ZIP basename. `/session-deck desktop install` selects the matching ZIP and sidecar for the host architecture.

## Publication order and failure behavior

1. Release Please creates the `pi-session-deck-v<V>` draft and release tag.
2. The arm64 and x64 jobs build and stage one ZIP plus one sidecar each.
3. The fan-in job requires package, tag, and artifact versions to agree. It rejects anything except the exact four expected non-empty regular files and verifies both checksums.
4. The job requires the GitHub release to remain a draft with zero assets.
5. It appends the signing and first-launch notice, uploads four explicit paths without clobbering, and publishes the GitHub release.
6. Only after GitHub publication does `npm publish` run.

A failed native leg prevents publication. A partial draft upload intentionally blocks an automatic retry because the release no longer has zero assets; inspect it rather than replacing uploaded bytes. GitHub and npm publication cannot be one transaction. If GitHub publication succeeds but npm publication fails, fix trusted-publisher access and publish the same package version from the original tag without changing the GitHub assets.

## npm trusted publishing

Configure an npm trusted publisher for `@robhowley/pi-session-deck` with:

- provider: GitHub Actions;
- organization/user: `robhowley`;
- repository: `pi-userland`;
- workflow filename: `release-please.yml`;
- allowed action: `npm publish`;
- no environment restriction.

The publication jobs use Node 22.14+, npm 11.5.1+, npm's registry setup, and `id-token: write`. Do not add a long-lived npm token.

## Local checks

```sh
pnpm exec vitest run \
  apps/session-deck-desktop/__tests__/release-artifacts.test.ts \
  apps/session-deck-desktop/__tests__/release-workflow.test.ts \
  apps/session-deck-desktop/__tests__/tauri-config.test.ts \
  packages/pi-session-deck/__tests__/session-deck/desktop-artifact.test.ts
pnpm --filter ./apps/session-deck-desktop typecheck
pnpm --filter ./apps/session-deck-desktop lint
pnpm --filter ./apps/session-deck-desktop format:check
pnpm --filter @robhowley/pi-session-deck typecheck
```

On an arm64 Mac, smoke-build the local target with:

```sh
pnpm --filter ./apps/session-deck-desktop artifact:macos \
  --version 0.0.0 \
  --target aarch64-apple-darwin \
  --artifact-dir dist/smoke-arm64
```

Extract the ZIP with `ditto`, confirm the executable mode and `lipo -archs` output, and inspect `codesign -dv --verbose=4` for `Signature=adhoc`. CI remains responsible for the equivalent x64 evidence on `macos-15-intel`.
