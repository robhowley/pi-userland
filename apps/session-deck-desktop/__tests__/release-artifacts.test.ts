import { describe, expect, it } from 'vitest';
import {
  applyDesktopReleaseVersion,
  macosArtifactStem,
  normalizeArtifactArch,
  normalizeReleaseVersion,
} from '../scripts/build-macos-artifacts.js';
import { formatSha256Line } from '../scripts/checksum-artifacts.js';

describe('release artifacts', () => {
  it('uses deterministic macOS artifact names tied to the pi-session-deck version', () => {
    expect(normalizeReleaseVersion('v0.9.0')).toBe('0.9.0');
    expect(normalizeArtifactArch('aarch64')).toBe('arm64');
    expect(macosArtifactStem('v0.9.0', 'aarch64')).toBe('session-deck-desktop-v0.9.0-macos-arm64');
  });

  it('writes release versions into Tauri and Cargo metadata for release builds', () => {
    const tauriConfig = JSON.stringify(
      {
        productName: 'Session Deck Desktop',
        version: '0.0.0',
        bundle: {
          active: true,
          macOS: {
            minimumSystemVersion: '11.0',
          },
        },
      },
      null,
      2,
    );
    const cargoToml = `[package]
name = "pi-session-deck-desktop"
version = "0.0.0"
description = "Tauri desktop companion for Session Deck"
`;

    const next = applyDesktopReleaseVersion(tauriConfig, cargoToml, '0.9.0');
    const nextTauriConfig = JSON.parse(next.tauriConfigText) as {
      version: string;
      bundle: { macOS: { bundleVersion: string; minimumSystemVersion: string } };
    };

    expect(nextTauriConfig.version).toBe('0.9.0');
    expect(nextTauriConfig.bundle.macOS).toEqual({
      bundleVersion: '0.9.0',
      minimumSystemVersion: '11.0',
    });
    expect(next.cargoTomlText).toContain('version = "0.9.0"');
  });

  it('uses checksum sidecars compatible with shasum -c', () => {
    expect(formatSha256Line('abc123', 'session-deck-desktop-v0.9.0-macos-arm64.zip')).toBe(
      'abc123  session-deck-desktop-v0.9.0-macos-arm64.zip\n',
    );
  });
});
