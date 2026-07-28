import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDesktopReleaseVersion,
  artifactArchForTarget,
  assertAdHocSignature,
  assertExecutableArchitecture,
  bundleRootForTarget,
  macosArtifactStem,
  normalizeArtifactArch,
  normalizeReleaseVersion,
  parseMacosArtifactArgs,
  tauriBuildArgsForOptions,
  writeArtifactChecksum,
} from '../scripts/build-macos-artifacts.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('release artifact builder contract', () => {
  it('derives exact native artifact names and target-specific bundle roots', () => {
    expect(normalizeReleaseVersion('v0.9.0')).toBe('0.9.0');
    expect(normalizeArtifactArch('aarch64')).toBe('arm64');
    expect(artifactArchForTarget('x86_64-apple-darwin')).toBe('x64');
    expect(macosArtifactStem('v0.9.0', 'aarch64')).toBe('session-deck-desktop-v0.9.0-macos-arm64');
    expect(macosArtifactStem('0.9.0', 'x86_64')).toBe('session-deck-desktop-v0.9.0-macos-x64');
    expect(bundleRootForTarget('aarch64-apple-darwin')).toMatch(
      /src-tauri\/target\/aarch64-apple-darwin\/release\/bundle$/u,
    );
    expect(bundleRootForTarget('x86_64-apple-darwin')).toMatch(
      /src-tauri\/target\/x86_64-apple-darwin\/release\/bundle$/u,
    );
  });

  it('requires an explicit supported target and derives its architecture', () => {
    expect(
      parseMacosArtifactArgs([
        '--version',
        '0.9.0',
        '--target',
        'x86_64-apple-darwin',
        '--artifact-dir',
        'dist/test-artifacts',
      ]),
    ).toMatchObject({
      version: '0.9.0',
      arch: 'x64',
      target: 'x86_64-apple-darwin',
    });
    expect(() => parseMacosArtifactArgs(['--version', '0.9.0'])).toThrow('Missing --target');
    expect(() =>
      parseMacosArtifactArgs(['--version', '0.9.0', '--target', 'universal-apple-darwin']),
    ).toThrow('Unsupported macOS release target');
  });

  it.each([
    ['arm64', 'arm64'],
    ['x64', 'x86_64'],
  ] as const)('accepts only one %s executable architecture', (arch, lipoOutput) => {
    expect(() => assertExecutableArchitecture(lipoOutput, arch)).not.toThrow();
    expect(() => assertExecutableArchitecture(`${lipoOutput} x86_64 arm64`, arch)).toThrow(
      'expected only',
    );
  });

  it('requires an ad-hoc signature without an authenticated authority', () => {
    expect(() => assertAdHocSignature('Executable=/tmp/app\nSignature=adhoc')).not.toThrow();
    expect(() => assertAdHocSignature('Signature=adhoc\nAuthority=Example')).toThrow(
      'authenticated signing authority',
    );
    expect(() => assertAdHocSignature('Signature=CMS')).toThrow('ad-hoc signature');
  });

  it('builds only the app for the explicit target and does not disable signing', () => {
    const options = parseMacosArtifactArgs([
      '--version',
      '0.9.0',
      '--target',
      'aarch64-apple-darwin',
    ]);
    expect(tauriBuildArgsForOptions(options)).toEqual([
      'build',
      '--bundles',
      'app',
      '--ci',
      '--target',
      'aarch64-apple-darwin',
    ]);
  });

  it('writes release versions into Tauri and Cargo metadata', () => {
    const tauriConfig = JSON.stringify({
      productName: 'Session Deck Desktop',
      version: '0.0.0',
      bundle: { active: true, macOS: { minimumSystemVersion: '11.0', signingIdentity: '-' } },
    });
    const cargoToml = `[package]\nname = "pi-session-deck-desktop"\nversion = "0.0.0"\n`;

    const next = applyDesktopReleaseVersion(tauriConfig, cargoToml, '0.9.0');
    const nextTauriConfig = JSON.parse(next.tauriConfigText) as {
      version: string;
      bundle: {
        macOS: {
          bundleVersion: string;
          minimumSystemVersion: string;
          signingIdentity: string;
        };
      };
    };
    expect(nextTauriConfig.version).toBe('0.9.0');
    expect(nextTauriConfig.bundle.macOS).toEqual({
      bundleVersion: '0.9.0',
      minimumSystemVersion: '11.0',
      signingIdentity: '-',
    });
    expect(next.cargoTomlText).toContain('version = "0.9.0"');
  });

  it('writes a lowercase SHA-256 sidecar for the ZIP basename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-deck-release-artifacts-'));
    temporaryDirectories.push(root);
    const name = 'session-deck-desktop-v0.9.0-macos-arm64.zip';
    const path = join(root, name);
    const payload = Buffer.from('zip payload');
    await writeFile(path, payload);

    const result = await writeArtifactChecksum(path);
    const expectedHash = createHash('sha256').update(payload).digest('hex');
    expect(result.sha256).toBe(expectedHash);
    await expect(readFile(result.checksumPath, 'utf8')).resolves.toBe(`${expectedHash}  ${name}\n`);
  });
});
