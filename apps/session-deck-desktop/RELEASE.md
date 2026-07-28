# Session Deck Desktop release runbook

This document defines the production release contract for the macOS companion. The workflow is `.github/workflows/release-please.yml`; the artifact builder and complete-set validator are in `scripts/`.

## Architecture decision

Publish two native builds rather than a universal binary:

| GitHub runner    | Rust target            | Artifact architecture |
| ---------------- | ---------------------- | --------------------- |
| `macos-15`       | `aarch64-apple-darwin` | `arm64`               |
| `macos-15-intel` | `x86_64-apple-darwin`  | `x64`                 |

Native builds make the executable architecture explicit and preserve the installer lookup contract in `packages/pi-session-deck/extensions/session-deck/desktop/paths.ts`. The trusted builder rejects universal, unsupported, and target/architecture-mismatched builds. Explicit Cargo targets are read from `src-tauri/target/<triple>/release/bundle`.

## Trust model

Production uses:

- a **Developer ID Application** certificate for app and DMG signing;
- an App Store Connect team API key for notarization;
- stapled notarization tickets on the app and DMG;
- a protected GitHub environment named `session-deck-release`;
- npm trusted publishing through GitHub Actions OIDC.

`--trusted-release` is required in CI. It requires an explicit target and every Apple variable below, and it never passes `--no-sign`. Metadata remains `signed: false` and `notarized: false` for local output. Trusted metadata is written only after all macOS verification commands succeed.

## External setup

### Apple Developer

1. Create or select a Developer ID Application certificate for the release team.
2. Export the certificate and private key from Keychain Access as a password-protected `.p12`.
3. Create an App Store Connect API key with access to submit notarization requests. Record its issuer ID and key ID and download its `.p8` once.
4. Confirm the certificate identity exactly with:

   ```sh
   security find-identity -v -p codesigning
   ```

5. Confirm the ten-character Team ID in the Apple Developer account.

Encode the `.p12` without line wrapping before storing it:

```sh
base64 < developer-id-application.p12 | tr -d '\n'
```

### GitHub environment

Create the `session-deck-release` environment in `robhowley/pi-userland`. Restrict deployment to `main`; add required reviewers if desired. Add these **environment secrets**:

| Secret                       | Value                                      |
| ---------------------------- | ------------------------------------------ |
| `APPLE_CERTIFICATE`          | Base64-encoded password-protected `.p12`   |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12`    |
| `APPLE_API_PRIVATE_KEY`      | Complete `.p8` text, including PEM markers |

Add these **environment variables**:

| Variable                 | Value                                                    |
| ------------------------ | -------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY` | Exact `Developer ID Application: Name (TEAMID)` identity |
| `APPLE_TEAM_ID`          | Apple Developer Team ID                                  |
| `APPLE_API_ISSUER`       | App Store Connect API issuer UUID                        |
| `APPLE_API_KEY`          | App Store Connect API key ID                             |

The workflow writes the certificate and `.p8` only under `$RUNNER_TEMP`, imports the certificate into a random-password temporary keychain, and removes the files and keychain in an `always()` step. Never add these values to repository variables, workflow text, artifacts, logs, or metadata.

### npm

Configure an npm trusted publisher for `@robhowley/pi-session-deck`:

- provider: GitHub Actions;
- organization/user: `robhowley`;
- repository: `pi-userland`;
- workflow filename: `release-please.yml`;
- environment: `session-deck-release`.

The final job has `id-token: write` and uses npm 11. Do not add a long-lived npm token as a fallback. Before making the GitHub release public, CI requires the exact npm version to return npm `E404`, builds the package, and runs `npm pack --dry-run`.

### GitHub repository

GitHub Actions must be allowed to create releases and upload Actions artifacts. The workflow uses its scoped `GITHUB_TOKEN`; no personal access token is required. Release Please is configured to create `pi-session-deck` releases as drafts and force tag creation. Other packages keep their existing immediate publication path.

## Release inventory

For package version `<V>`, the public GitHub release must contain exactly these desktop files:

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

Metadata must identify the package version and architecture, report `signed: true` and `notarized: true`, and describe exactly its non-empty ZIP and DMG with their byte sizes and SHA-256 hashes. Every payload and metadata file has an exact `shasum -a 256 -c` compatible sidecar. The validator rejects missing, unexpected, empty, non-regular, stale, duplicated, or inconsistent files.

## Pipeline and failure gates

1. Release Please creates the `pi-session-deck` tag and **draft** GitHub release. The general npm loop skips only `packages/pi-session-deck`; unrelated package behavior is unchanged.
2. Two isolated matrix legs check out the release tag and install only their native Rust target.
3. Each leg checks all credential inputs, imports the certificate and API key, builds app and DMG with `--trusted-release`, and verifies:
   - the main executable contains only its intended `arm64` or `x86_64` architecture;
   - strict deep Developer ID Application signature validity and expected Team ID;
   - Gatekeeper execution/open assessment;
   - app and DMG notarization staples;
   - DMG integrity;
   - a read-only mounted DMG contains the expected app, which passes the same app checks.
4. Each leg uploads a unique internal Actions artifact. Matrix failure prevents the final job.
5. The final job merges both legs and validates the exact 12-file set without Apple secrets.
6. It requires the GitHub release to remain a draft and rejects any preexisting expected asset. Upload does not use `--clobber`.
7. It verifies every uploaded GitHub asset exists once with the local byte size, then publishes the draft.
8. It proves the release is public before running `npm publish` for the exact package version.

The process fails closed on missing credentials, wrong architecture, build/sign/notarization/verification failure, missing DMG, one failed matrix leg, inventory mismatch, preexisting expected asset, unavailable npm preflight, upload mismatch, or a release that is already public.

## Rollback and incident behavior

GitHub release publication and npm publication cannot be one atomic transaction. The ordering prevents an npm version from pointing to an absent or incomplete desktop release:

- **Before the release is public:** leave the draft unpublished. Do not overwrite or delete versioned assets to retry. Fix the cause and cut a patch release.
- **After the release is public but before npm succeeds:** do not replace assets or unpublish the GitHub release. Verify the public inventory, resolve npm trusted-publisher availability, and publish the same package version from the original tag. Record the incident.
- **After npm succeeds:** artifacts and npm versions are immutable. Any defect requires a patch release.

A partial draft upload intentionally blocks reruns through the preexisting-asset check. This trades convenience for proof that CI never silently changes bytes attached to a version.

## Secret-free local checks

These checks do not need Apple credentials:

```sh
pnpm exec vitest run apps/session-deck-desktop/__tests__/release-artifacts.test.ts
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

## First production release checks

Do these before announcing the first release. Run architecture-specific install checks on both Apple silicon and Intel Macs; do not rely only on Rosetta.

1. In Actions, confirm both matrix legs used their documented runner and target and both temporary-key cleanup steps ran.
2. Confirm the release has the exact 12 desktop files and no duplicate names.
3. Download each architecture set into a clean directory and run:

   ```sh
   shasum -a 256 -c session-deck-desktop-v<V>-macos-<arch>.zip.sha256
   shasum -a 256 -c session-deck-desktop-v<V>-macos-<arch>.dmg.sha256
   shasum -a 256 -c session-deck-desktop-v<V>-macos-<arch>.metadata.json.sha256
   hdiutil verify session-deck-desktop-v<V>-macos-<arch>.dmg
   xcrun stapler validate session-deck-desktop-v<V>-macos-<arch>.dmg
   spctl --assess --type open --context context:primary-signature --verbose=4 \
     session-deck-desktop-v<V>-macos-<arch>.dmg
   ```

4. Mount each DMG, inspect the app with `codesign -dv --verbose=4`, and confirm the expected Team ID and Developer ID Application authority.
5. Install the published npm version on a clean Pi setup. For each native architecture, exercise:
   - `/session-deck desktop install` and confirm it selects `macos-arm64` or `macos-x64`;
   - `/session-deck desktop doctor`;
   - `/session-deck desktop open` from Finder and from Pi;
   - app snapshot loading and terminal/worktree actions;
   - `/session-deck desktop uninstall`.
6. Confirm `npm view @robhowley/pi-session-deck@<V> version` returns `<V>` only after the GitHub release is public.

Actual certificate import, Apple notarization, Gatekeeper behavior, GitHub release publication, and npm trusted publishing can only be proven by this credentialed first-release run. Never relax a gate to make that run pass.
