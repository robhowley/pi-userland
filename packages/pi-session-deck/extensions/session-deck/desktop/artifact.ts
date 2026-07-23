import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashSessionDeckDesktopPath } from './state.js';
import {
  SESSION_DECK_DESKTOP_RELEASE_OWNER,
  SESSION_DECK_DESKTOP_RELEASE_REPO,
  getSessionDeckDesktopArtifactName,
  getSessionDeckDesktopReleaseTag,
} from './paths.js';

export interface SessionDeckDesktopReleaseAsset {
  name: string;
  url: string;
}

export interface SessionDeckDesktopResolvedArtifact {
  releaseTag: string;
  assetName: string;
  assetUrl: string;
  checksumAssetName: string;
  checksumUrl: string;
}

export interface SessionDeckDesktopDownloadedArtifact extends SessionDeckDesktopResolvedArtifact {
  path: string;
  sha256: string;
}

export type SessionDeckDesktopFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export async function resolveSessionDeckDesktopReleaseArtifact(options: {
  version: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetch?: SessionDeckDesktopFetch;
  apiBaseUrl?: string;
}): Promise<SessionDeckDesktopResolvedArtifact> {
  const fetchImpl = getFetch(options.fetch);
  const releaseTag = getSessionDeckDesktopReleaseTag(options.version);
  const assetName = getSessionDeckDesktopArtifactName(options.version, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
  });
  const checksumAssetName = `${assetName}.sha256`;
  const releaseUrl = `${options.apiBaseUrl ?? 'https://api.github.com'}/repos/${SESSION_DECK_DESKTOP_RELEASE_OWNER}/${SESSION_DECK_DESKTOP_RELEASE_REPO}/releases/tags/${encodeURIComponent(releaseTag)}`;
  const response = await fetchImpl(releaseUrl, {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    throw new Error(
      `Could not query GitHub Release ${releaseTag}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const release = await response.json();
  const assets = parseReleaseAssets(release);
  const artifactAsset = assets.find((asset) => asset.name === assetName);
  const checksumAsset = assets.find((asset) => asset.name === checksumAssetName);

  if (artifactAsset === undefined) {
    throw new Error(`GitHub Release ${releaseTag} does not include ${assetName}.`);
  }

  if (checksumAsset === undefined) {
    throw new Error(`GitHub Release ${releaseTag} does not include ${checksumAssetName}.`);
  }

  return {
    releaseTag,
    assetName,
    assetUrl: artifactAsset.url,
    checksumAssetName,
    checksumUrl: checksumAsset.url,
  };
}

export async function downloadSessionDeckDesktopArtifact(options: {
  version: string;
  workDir: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetch?: SessionDeckDesktopFetch;
  apiBaseUrl?: string;
  expectedSha256?: string;
}): Promise<SessionDeckDesktopDownloadedArtifact> {
  const fetchImpl = getFetch(options.fetch);
  const resolved = await resolveSessionDeckDesktopReleaseArtifact({
    version: options.version,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    fetch: fetchImpl,
    ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
  });

  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const checksumResponse = await fetchImpl(resolved.checksumUrl);
  if (!checksumResponse.ok) {
    throw new Error(
      `Could not download checksum ${resolved.checksumAssetName}: HTTP ${checksumResponse.status} ${checksumResponse.statusText}`,
    );
  }
  const sha256 = parseSessionDeckDesktopSha256Sidecar(
    await checksumResponse.text(),
    resolved.assetName,
  );
  if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
    throw new Error(
      `Checksum sidecar for ${resolved.assetName} is ${sha256}, not requested ${options.expectedSha256}.`,
    );
  }

  const artifactResponse = await fetchImpl(resolved.assetUrl);
  if (!artifactResponse.ok) {
    throw new Error(
      `Could not download artifact ${resolved.assetName}: HTTP ${artifactResponse.status} ${artifactResponse.statusText}`,
    );
  }

  const artifactPath = join(options.workDir, resolved.assetName);
  await writeFile(artifactPath, Buffer.from(await artifactResponse.arrayBuffer()), { mode: 0o600 });
  const actualSha256 = await hashSessionDeckDesktopPath(artifactPath);
  if (actualSha256 !== sha256) {
    throw new Error(
      `Checksum mismatch for ${resolved.assetName}: expected ${sha256}, got ${actualSha256}.`,
    );
  }

  return {
    ...resolved,
    path: artifactPath,
    sha256,
  };
}

export function parseSessionDeckDesktopSha256Sidecar(text: string, assetName: string): string {
  const tokens = text
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  const checksum = tokens[0]?.toLowerCase();
  if (checksum === undefined || !/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new Error(`Checksum sidecar for ${assetName} does not start with a SHA-256 hash.`);
  }
  return checksum;
}

function parseReleaseAssets(candidate: unknown): SessionDeckDesktopReleaseAsset[] {
  if (!isRecord(candidate) || !Array.isArray(candidate['assets'])) {
    throw new Error('GitHub Release response has an invalid assets shape.');
  }

  const assets: SessionDeckDesktopReleaseAsset[] = [];
  for (const asset of candidate['assets']) {
    if (!isRecord(asset)) {
      continue;
    }

    const name = asset['name'];
    const url = asset['browser_download_url'];
    if (typeof name === 'string' && typeof url === 'string') {
      assets.push({ name, url });
    }
  }

  return assets;
}

function getFetch(fetchImpl: SessionDeckDesktopFetch | undefined): SessionDeckDesktopFetch {
  if (fetchImpl !== undefined) {
    return fetchImpl;
  }

  if (typeof globalThis.fetch !== 'function') {
    throw new Error('This Node runtime does not provide fetch; cannot download desktop artifacts.');
  }

  return globalThis.fetch as SessionDeckDesktopFetch;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
