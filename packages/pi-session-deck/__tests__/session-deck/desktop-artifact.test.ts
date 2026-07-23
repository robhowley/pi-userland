import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadSessionDeckDesktopArtifact,
  parseSessionDeckDesktopSha256Sidecar,
  resolveSessionDeckDesktopReleaseArtifact,
  type SessionDeckDesktopFetch,
} from '../../extensions/session-deck/desktop/artifact.js';
import {
  getSessionDeckDesktopArtifactName,
  getSessionDeckDesktopReleaseTag,
} from '../../extensions/session-deck/desktop/paths.js';

function okJson(value: unknown): Awaited<ReturnType<SessionDeckDesktopFetch>> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => value,
    text: async () => JSON.stringify(value),
    arrayBuffer: async () => toArrayBuffer(Buffer.from(JSON.stringify(value))),
  };
}

function okText(value: string): Awaited<ReturnType<SessionDeckDesktopFetch>> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => JSON.parse(value) as unknown,
    text: async () => value,
    arrayBuffer: async () => toArrayBuffer(Buffer.from(value)),
  };
}

function okBuffer(value: Buffer): Awaited<ReturnType<SessionDeckDesktopFetch>> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({}),
    text: async () => value.toString('utf8'),
    arrayBuffer: async () => toArrayBuffer(value),
  };
}

function toArrayBuffer(value: Buffer): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

describe('session-deck desktop artifacts', () => {
  it('uses deterministic release tags and macOS asset names', () => {
    expect(getSessionDeckDesktopReleaseTag('0.9.0')).toBe('pi-session-deck-v0.9.0');
    expect(getSessionDeckDesktopArtifactName('0.9.0', { platform: 'darwin', arch: 'arm64' })).toBe(
      'session-deck-desktop-v0.9.0-macos-arm64.zip',
    );
    expect(() =>
      getSessionDeckDesktopArtifactName('0.9.0', { platform: 'linux', arch: 'x64' }),
    ).toThrow('only available for macOS');
  });

  it('resolves matching artifact and checksum release assets', async () => {
    const fetch = vi.fn<SessionDeckDesktopFetch>(async () =>
      okJson({
        assets: [
          {
            name: 'session-deck-desktop-v0.9.0-macos-arm64.zip',
            browser_download_url: 'https://example.test/app.zip',
          },
          {
            name: 'session-deck-desktop-v0.9.0-macos-arm64.zip.sha256',
            browser_download_url: 'https://example.test/app.zip.sha256',
          },
        ],
      }),
    );

    await expect(
      resolveSessionDeckDesktopReleaseArtifact({
        version: '0.9.0',
        platform: 'darwin',
        arch: 'arm64',
        fetch,
      }),
    ).resolves.toEqual({
      releaseTag: 'pi-session-deck-v0.9.0',
      assetName: 'session-deck-desktop-v0.9.0-macos-arm64.zip',
      assetUrl: 'https://example.test/app.zip',
      checksumAssetName: 'session-deck-desktop-v0.9.0-macos-arm64.zip.sha256',
      checksumUrl: 'https://example.test/app.zip.sha256',
    });
  });

  it('downloads and verifies checksum sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-artifact-'));
    const artifact = Buffer.from('zip bytes');
    const sha256 = createHash('sha256').update(artifact).digest('hex');
    const fetch = vi.fn<SessionDeckDesktopFetch>(async (url) => {
      if (url.includes('/releases/tags/')) {
        return okJson({
          assets: [
            {
              name: 'session-deck-desktop-v0.9.0-macos-arm64.zip',
              browser_download_url: 'https://example.test/app.zip',
            },
            {
              name: 'session-deck-desktop-v0.9.0-macos-arm64.zip.sha256',
              browser_download_url: 'https://example.test/app.zip.sha256',
            },
          ],
        });
      }
      if (url.endsWith('.sha256')) {
        return okText(`${sha256}  session-deck-desktop-v0.9.0-macos-arm64.zip\n`);
      }
      return okBuffer(artifact);
    });

    const downloaded = await downloadSessionDeckDesktopArtifact({
      version: '0.9.0',
      platform: 'darwin',
      arch: 'arm64',
      fetch,
      workDir: root,
    });

    expect(downloaded.sha256).toBe(sha256);
    await expect(readFile(downloaded.path, 'utf8')).resolves.toBe('zip bytes');
  });

  it('rejects malformed checksum sidecars', () => {
    expect(() => parseSessionDeckDesktopSha256Sidecar('not-a-sha file.zip', 'file.zip')).toThrow(
      'does not start with a SHA-256 hash',
    );
  });
});
