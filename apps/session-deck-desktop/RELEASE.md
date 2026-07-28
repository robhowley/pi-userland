# Session Deck Desktop release runbook

This document defines the production release contract for the macOS companion. The workflow is `.github/workflows/release-please.yml`; the artifact builder, signing checks, and complete-set validator are in `scripts/`.

## Architecture

Publish two native builds rather than a universal binary:

| GitHub runner    | Rust target            | Artifact architecture |
| ---------------- | ---------------------- | --------------------- |
| `macos-15`       | `aarch64-apple-darwin` | `arm64`               |
| `macos-15-intel` | `x86_64-apple-darwin`  | `x64`                 |

Each matrix leg installs its explicit Rust target. The trusted builder rejects universal, unsupported, and target/architecture-mismatched output. It reads bundles from `src-tauri/target/<triple>/release/bundle`.

## Trust model

Production uses a Developer ID Application certificate for app and DMG signing, an App Store Connect API key for notarization, stapled tickets on both artifacts, and npm trusted publishing through GitHub Actions OIDC.

`--trusted-release` requires an explicit target and all internal Apple values. It never passes `--no-sign`. Trusted metadata is written only after the architecture, exact signer, Team ID, codesign, Gatekeeper, staple, DMG, and mounted-app checks succeed.

## Required external setup

### Apple Developer

1. Export one Developer ID Application certificate and its private key as a password-protected `.p12`.
2. Create an App Store Connect API key that can submit notarization requests. Record its issuer ID and key ID, and download its `.p8` once.
3. Encode the `.p12` without line wrapping:

   ```sh
   base64 < developer-id-application.p12 | tr -d '\n'
   ```

The imported `.p12` must expose exactly one valid codesigning identity, and that identity must have the form `Developer ID Application: Name (TEAMID)` with a final ten-character uppercase alphanumeric Team ID.

### Repository Actions settings

Store exactly these three ordinary repository Actions secrets:

| Secret                       | Value                                      |
| ---------------------------- | ------------------------------------------ |
| `APPLE_CERTIFICATE`          | Base64-encoded password-protected `.p12`   |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12`    |
| `APPLE_API_PRIVATE_KEY`      | Complete `.p8` text, including PEM markers |

Store exactly these two ordinary repository Actions variables:

| Variable           | Value                             |
| ------------------ | --------------------------------- |
| `APPLE_API_ISSUER` | App Store Connect API issuer UUID |
| `APPLE_API_KEY`    | App Store Connect API key ID      |

No deployment environment is required; removing the GitHub Environment removes its approval and protection boundary. Do not configure signer identity or Team ID as repository settings.

### Derived and internal values

After certificate import, each native job queries only its random-password temporary keychain. The job fails if it finds zero, multiple, malformed, or unrelated codesigning identities. It exports:

- `APPLE_SIGNING_IDENTITY`: the complete derived Developer ID Application identity, for Tauri signing and exact post-build authority checks;
- `APPLE_TEAM_ID`: the final ten-character Team ID derived from that identity, for exact post-build TeamIdentifier checks;
- `APPLE_API_KEY_PATH`: the temporary `.p8` path used for notarization.

The certificate, API key, and temporary keychain stay under `$RUNNER_TEMP`. Cleanup runs under `always()` and removes all three.

### npm trusted publishing

Configure an npm trusted publisher for `@robhowley/pi-session-deck` with:

- provider: GitHub Actions;
- organization/user: `robhowley`;
- repository: `pi-userland`;
- workflow filename: `release-please.yml`;
- Allowed actions: `npm publish`;
- no environment restriction.

Both workflow jobs that can call `npm publish` use Node 22.14 and npm 11, satisfying the current documented trusted-publishing floors of Node 22.14+ and npm 11.5.1+. Keep `id-token: write`; do not add a long-lived npm token fallback.

### GitHub repository

GitHub Actions must be allowed to create releases and upload Actions artifacts. The workflow uses its scoped `GITHUB_TOKEN`; no personal access token is required. Release Please creates `pi-session-deck` releases as drafts and forces tag creation. Other packages retain their existing immediate publication path.

## Optional hardening

Repository rulesets may protect `main` and release tags, require reviewed release PRs, and limit who can change Actions secrets. Action references may also be pinned to commit SHAs. These controls are independent of the five required Apple settings and are not workflow inputs.

## Release inventory

For package version `<V>`, the public GitHub release must contain exactly these 12 desktop files:

```text
session-deck-desktop-v<V>-macos-arm64.zip
session-deck-desktop-v<V>-macos-arm64.zip.sha256
session-deck-desktop-v<V>-macos-arm64.dmg
session-deck-desktop-v<V>-macos-arm64.dmg.sha256
session-deck-desktop-v<V>-macos-arm64.metadata.json
session-deck-desktop-v<V>-macos-arm64.metadata.json.sha256
session-deck-desktop-v<V>-macos-x64.zip
session-deck-desktop-v<V>-macos-x64.zip.sha256
session-deck-desktop-v<V>-macos-x64.dmg
session-deck-desktop-v<V>-macos-x64.dmg.sha256
session-deck-desktop-v<V>-macos-x64.metadata.json
session-deck-desktop-v<V>-macos-x64.metadata.json.sha256
```

Metadata must identify the package version and architecture, report `signed: true` and `notarized: true`, and describe exactly its non-empty ZIP and DMG with byte sizes and SHA-256 hashes. Each payload and metadata file has an exact `shasum -a 256 -c` compatible sidecar. The validator rejects missing, unexpected, empty, non-regular, stale, duplicated, or inconsistent files.

## Pipeline and failure gates

1. Release Please creates the `pi-session-deck` tag and draft GitHub release. The general npm loop skips only `packages/pi-session-deck`.
2. The two native matrix legs check out the release tag and install their explicit Rust targets.
3. Each leg checks the five external inputs, imports signing material, derives the exact signer and Team ID, and builds with `--trusted-release`.
4. Each leg verifies the intended executable architecture, strict deep Developer ID signature and exact TeamIdentifier, Gatekeeper execution/open assessment, app and DMG staples, DMG integrity, and the mounted app.
5. Each leg stages a unique internal Actions artifact. Matrix failure prevents publication.
6. The final job merges both legs and validates the exact 12-file set without Apple secrets.
7. Before upload, it requires the release to remain a draft with zero assets and proves that the npm version is unpublished. It refuses preexisting assets, and upload does not use `--clobber`.
8. It verifies each remote asset appears once with the local byte size, publishes the draft, and verifies `isDraft: false`.
9. Only then does it publish the exact package version to npm.

The process fails closed on missing inputs, identity derivation failure, wrong architecture, signing/notarization/verification failure, a failed matrix leg, inventory mismatch, preexisting assets, unavailable npm preflight, upload mismatch, or a release that does not complete the required draft-to-public transition.

GitHub does not enforce immutable release assets after publication. The draft-state, zero-existing-assets, no-clobber, and remote checks protect only the initial publication; maintainers and other workflows can later replace or delete assets.

GitHub and npm publication are not atomic. If GitHub publication succeeds but npm publication fails, verify the public 12-file inventory, fix trusted-publisher access, and publish the same package version from the original tag. Never replace uploaded bytes. A partial draft upload intentionally blocks an automatic retry; investigate it rather than adding clobber behavior.

## Secret-free local checks

```sh
pnpm exec vitest run apps/session-deck-desktop/__tests__/release-artifacts.test.ts apps/session-deck-desktop/__tests__/release-workflow.test.ts
pnpm --filter ./apps/session-deck-desktop typecheck
pnpm --filter ./apps/session-deck-desktop lint
pnpm --filter ./apps/session-deck-desktop format:check
pnpm exec vitest run packages/pi-session-deck/__tests__/session-deck/desktop-artifact.test.ts
pnpm --filter @robhowley/pi-session-deck typecheck
```

A local unsigned build may omit the DMG and uses `--no-sign`. It must never be uploaded as a production release:

```sh
pnpm --filter ./apps/session-deck-desktop artifact:macos -- \
  --version 0.0.0-local --target "$(rustc -vV | awk '/host:/ {print $2}')"
```

## Credentialed production-path checks

Before announcing the first release, confirm both matrix legs used their documented runner and target and both cleanup steps ran. Download each architecture set into a clean directory and check its sidecars, DMG, staple, Gatekeeper assessment, mounted app, exact Developer ID authority, Team ID, and executable architecture.

On both Apple silicon and Intel Macs, install the published npm version and exercise:

- `/session-deck desktop install`, confirming native `macos-arm64` or `macos-x64` selection;
- `/session-deck desktop doctor`;
- `/session-deck desktop open` from Finder and Pi;
- app snapshot loading and terminal/worktree actions;
- `/session-deck desktop uninstall`.

Confirm `npm view @robhowley/pi-session-deck@<V> version` returns `<V>` only after the GitHub release is public. Certificate import, notarization, Gatekeeper behavior, GitHub publication, and npm OIDC can only be proven by this credentialed run on both native runners. Never relax a gate to make it pass.
