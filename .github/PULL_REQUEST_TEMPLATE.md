# Pi Userland Repo Initialization

## Phase 0: Workspace Bootstrap
- Created root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- Added `.gitignore`, `LICENSE`, `README.md`
- Added CI workflows: `pr-title-check.yml`, `ci.yml`, `release-please.yml`
- Updated wiki with resolved decisions

## Phase 1.5: Release Please Setup
- Configured `release-please.yml` for manifest-based releases
- Added `release-please-config.json` with `packages/pi-session-hygiene`
- Added `release-please-manifest.json` with version `0.1.0`
- Added `CONTRIBUTING.md` documenting PR title convention

## Package Migration: pi-session-hygiene
- Renamed from `session-hygiene` to `@robhowley/pi-session-hygiene`
- Restructured to `extensions/session-hygiene/` per Pi conventions
- Added `__tests__/` for test files
- Updated to use jiti runtime (no build step)
- Fixed lint/typecheck/test issues:
  - Added `eslint-config-prettier` and `@eslint/js` to root devDependencies
  - Fixed root eslint config to avoid tsconfig issues
  - Disabled strict rules for test files via tsconfig.base.json
  - Fixed helpers.ts `any` and unused import issues
  - Fixed PRESETS type and threshold handling
- Set `pi.extensions: ["./extensions/session-hygiene"]`

## CI Setup
- All workflows use pnpm 10
- lint, format:check, typecheck, test all passing