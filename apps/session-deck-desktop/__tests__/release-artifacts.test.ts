import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDesktopReleaseVersion,
  artifactArchForTarget,
  assertDeveloperIdSignatureDetails,
  bundleRootForTarget,
  macosArtifactStem,
  missingTrustedReleaseEnvironment,
  normalizeArtifactArch,
  normalizeReleaseVersion,
  parseMacosArtifactArgs,
  preflightTrustedReleaseEnvironment,
  releaseTrustMetadata,
  tauriBuildArgsForOptions,
} from '../scripts/build-macos-artifacts.js';
import {
  formatSha256Line,
  sha256File,
  writeChecksumForFile,
} from '../scripts/checksum-artifacts.js';
import {
  expectedMacosArtifactNames,
  validateCompleteMacosArtifactSet,
} from '../scripts/validate-macos-artifact-set.js';

const temporaryDirectories: string[] = [];
const APPLE_TEAM_ID = 'TEAMID1234';
const APPLE_SIGNING_IDENTITY = `Developer ID Application: Example (${APPLE_TEAM_ID})`;

function codesignDetails(
  authority = APPLE_SIGNING_IDENTITY,
  teamIdentifier = APPLE_TEAM_ID,
): string {
  return [
    'Executable=/Applications/Session Deck Desktop.app/Contents/MacOS/session-deck-desktop',
    `Authority=${authority}`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${teamIdentifier}`,
  ].join('\n');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCompleteArtifactSet(version = '0.9.0'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-deck-release-artifacts-'));
  temporaryDirectories.push(root);
  for (const arch of ['arm64', 'x64'] as const) {
    const stem = macosArtifactStem(version, arch);
    const artifacts = [];
    for (const extension of ['zip', 'dmg']) {
      const path = join(root, `${stem}.${extension}`);
      await writeFile(path, `${arch} ${extension} payload`);
      const fileStats = await stat(path);
      artifacts.push({
        name: `${stem}.${extension}`,
        sha256: await sha256File(path),
        bytes: fileStats.size,
      });
      await writeChecksumForFile(path);
    }
    const metadataPath = join(root, `${stem}.metadata.json`);
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: 'session-deck-desktop',
          packageName: '@robhowley/pi-session-deck',
          version,
          platform: 'macos',
          arch,
          signed: true,
          notarized: true,
          artifacts,
        },
        null,
        2,
      )}\n`,
    );
    await writeChecksumForFile(metadataPath);
  }
  return root;
}

describe('release artifact builder contract', () => {
  it('derives native artifact names and target-specific bundle roots', () => {
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

  it('derives architecture from target and rejects mismatches and unsupported targets', () => {
    expect(
      parseMacosArtifactArgs([
        '--version',
        '0.9.0',
        '--target',
        'x86_64-apple-darwin',
        '--trusted-release',
      ]),
    ).toMatchObject({ arch: 'x64', target: 'x86_64-apple-darwin', trustedRelease: true });
    expect(() =>
      parseMacosArtifactArgs([
        '--version',
        '0.9.0',
        '--target',
        'aarch64-apple-darwin',
        '--arch',
        'x64',
      ]),
    ).toThrow('produces arm64, not requested architecture x64');
    expect(() =>
      parseMacosArtifactArgs(['--version', '0.9.0', '--target', 'universal-apple-darwin']),
    ).toThrow('Unsupported macOS release target');
  });

  it('requires explicit target and complete credentials for trusted releases', () => {
    expect(() => parseMacosArtifactArgs(['--version', '0.9.0', '--trusted-release'])).toThrow(
      'require an explicit --target',
    );
    expect(missingTrustedReleaseEnvironment({})).toEqual([
      'APPLE_SIGNING_IDENTITY',
      'APPLE_TEAM_ID',
      'APPLE_API_ISSUER',
      'APPLE_API_KEY',
      'APPLE_API_KEY_PATH',
    ]);
    expect(
      missingTrustedReleaseEnvironment({
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAMID1234)',
        APPLE_TEAM_ID: 'TEAMID1234',
        APPLE_API_ISSUER: 'issuer',
        APPLE_API_KEY: 'key-id',
        APPLE_API_KEY_PATH: '/temporary/AuthKey.p8',
      }),
    ).toEqual([]);
  });

  it('preflights trusted release credentials without real secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-deck-credentials-'));
    temporaryDirectories.push(root);
    const apiKeyPath = join(root, 'AuthKey_TEST.p8');
    const env = {
      APPLE_SIGNING_IDENTITY,
      APPLE_TEAM_ID,
      APPLE_API_ISSUER: 'issuer',
      APPLE_API_KEY: 'key-id',
      APPLE_API_KEY_PATH: apiKeyPath,
    };
    await writeFile(
      apiKeyPath,
      '-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----\n',
    );
    await expect(preflightTrustedReleaseEnvironment(env)).resolves.toBeUndefined();
    await expect(
      preflightTrustedReleaseEnvironment({ ...env, APPLE_TEAM_ID: 'TEAMID123' }),
    ).rejects.toThrow('exactly 10 uppercase letters or digits');

    await writeFile(apiKeyPath, 'not a private key');
    await expect(preflightTrustedReleaseEnvironment(env)).rejects.toThrow(
      'must reference a non-empty App Store Connect private API key',
    );
  });

  it('accepts only the exact leaf signing identity and TeamIdentifier', () => {
    expect(() =>
      assertDeveloperIdSignatureDetails(codesignDetails(), APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'different authority',
      details: codesignDetails(`Developer ID Application: Other (${APPLE_TEAM_ID})`),
      error: 'leaf authority does not exactly match APPLE_SIGNING_IDENTITY',
    },
    {
      name: 'matching non-leaf authority',
      details: codesignDetails(`Developer ID Application: Other (${APPLE_TEAM_ID})`).replace(
        'Authority=Developer ID Certification Authority',
        `Authority=${APPLE_SIGNING_IDENTITY}`,
      ),
      error: 'leaf authority does not exactly match APPLE_SIGNING_IDENTITY',
    },
    {
      name: 'authority prefix impostor',
      details: codesignDetails(`${APPLE_SIGNING_IDENTITY} impostor`),
      error: 'leaf authority does not exactly match APPLE_SIGNING_IDENTITY',
    },
    {
      name: 'authority suffix impostor',
      details: codesignDetails(`Developer ID Application: Impostor ${APPLE_SIGNING_IDENTITY}`),
      error: 'leaf authority does not exactly match APPLE_SIGNING_IDENTITY',
    },
    {
      name: 'different TeamIdentifier',
      details: codesignDetails(APPLE_SIGNING_IDENTITY, 'OTHER12345'),
      error: 'TeamIdentifier does not exactly match APPLE_TEAM_ID',
    },
    {
      name: 'TeamIdentifier prefix impostor',
      details: codesignDetails(APPLE_SIGNING_IDENTITY, `${APPLE_TEAM_ID}X`),
      error: 'TeamIdentifier does not exactly match APPLE_TEAM_ID',
    },
    {
      name: 'TeamIdentifier suffix impostor',
      details: codesignDetails(APPLE_SIGNING_IDENTITY, `X${APPLE_TEAM_ID}`),
      error: 'TeamIdentifier does not exactly match APPLE_TEAM_ID',
    },
  ])('rejects $name', ({ details, error }) => {
    expect(() =>
      assertDeveloperIdSignatureDetails(details, APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID),
    ).toThrow(error);
  });

  it('signs only explicit trusted builds and marks trust after post-build verification', () => {
    const local = parseMacosArtifactArgs([
      '--version',
      '0.9.0',
      '--target',
      'aarch64-apple-darwin',
    ]);
    const trusted = parseMacosArtifactArgs([
      '--version',
      '0.9.0',
      '--target',
      'aarch64-apple-darwin',
      '--trusted-release',
    ]);
    expect(tauriBuildArgsForOptions(local)).toContain('--no-sign');
    expect(tauriBuildArgsForOptions(trusted)).not.toContain('--no-sign');
    expect(releaseTrustMetadata(false, false)).toEqual({ signed: false, notarized: false });
    expect(() => releaseTrustMetadata(true, false)).toThrow('post-build verification');
    expect(releaseTrustMetadata(true, true)).toEqual({ signed: true, notarized: true });
  });

  it('writes release versions into Tauri and Cargo metadata for release builds', () => {
    const tauriConfig = JSON.stringify({
      productName: 'Session Deck Desktop',
      version: '0.0.0',
      bundle: { active: true, macOS: { minimumSystemVersion: '11.0' } },
    });
    const cargoToml = `[package]\nname = "pi-session-deck-desktop"\nversion = "0.0.0"\n`;

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

describe('complete release artifact validation', () => {
  it('accepts only the complete signed and notarized dual-architecture set', async () => {
    const root = await createCompleteArtifactSet();
    await expect(validateCompleteMacosArtifactSet(root, '0.9.0')).resolves.toEqual(
      expectedMacosArtifactNames('0.9.0'),
    );
  });

  it('rejects missing and unexpected inventory entries', async () => {
    const missingRoot = await createCompleteArtifactSet();
    await rm(join(missingRoot, 'session-deck-desktop-v0.9.0-macos-x64.dmg.sha256'));
    await expect(validateCompleteMacosArtifactSet(missingRoot, '0.9.0')).rejects.toThrow(
      'Missing: session-deck-desktop-v0.9.0-macos-x64.dmg.sha256',
    );

    const unexpectedRoot = await createCompleteArtifactSet();
    await writeFile(join(unexpectedRoot, 'extra.txt'), 'unexpected');
    await expect(validateCompleteMacosArtifactSet(unexpectedRoot, '0.9.0')).rejects.toThrow(
      'Unexpected: extra.txt',
    );
  });

  it('rejects unsigned metadata, stale sidecars, and incorrect metadata sizes', async () => {
    const unsignedRoot = await createCompleteArtifactSet();
    const unsignedMetadata = join(
      unsignedRoot,
      'session-deck-desktop-v0.9.0-macos-arm64.metadata.json',
    );
    const metadata = JSON.parse(await readFile(unsignedMetadata, 'utf8')) as {
      signed: boolean;
    };
    metadata.signed = false;
    await writeFile(unsignedMetadata, `${JSON.stringify(metadata)}\n`);
    await writeChecksumForFile(unsignedMetadata);
    await expect(validateCompleteMacosArtifactSet(unsignedRoot, '0.9.0')).rejects.toThrow(
      'invalid signed',
    );

    const staleRoot = await createCompleteArtifactSet();
    await writeFile(
      join(staleRoot, 'session-deck-desktop-v0.9.0-macos-x64.zip.sha256'),
      `${'0'.repeat(64)}  session-deck-desktop-v0.9.0-macos-x64.zip\n`,
    );
    await expect(validateCompleteMacosArtifactSet(staleRoot, '0.9.0')).rejects.toThrow(
      'Checksum sidecar does not match',
    );

    const sizeRoot = await createCompleteArtifactSet();
    const sizeMetadata = join(sizeRoot, 'session-deck-desktop-v0.9.0-macos-x64.metadata.json');
    const sizeData = JSON.parse(await readFile(sizeMetadata, 'utf8')) as {
      artifacts: Array<{ bytes: number }>;
    };
    sizeData.artifacts[0]!.bytes += 1;
    await writeFile(sizeMetadata, `${JSON.stringify(sizeData)}\n`);
    await writeChecksumForFile(sizeMetadata);
    await expect(validateCompleteMacosArtifactSet(sizeRoot, '0.9.0')).rejects.toThrow(
      'wrong byte size',
    );
  });
});
