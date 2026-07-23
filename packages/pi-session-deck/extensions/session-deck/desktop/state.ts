import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER,
  SESSION_DECK_DESKTOP_PACKAGE_NAME,
} from './paths.js';

export const SESSION_DECK_DESKTOP_STATE_SCHEMA_VERSION = 1;
export const SESSION_DECK_DESKTOP_PRODUCT = 'session-deck-desktop';

export interface SessionDeckDesktopAppState {
  path: string;
  bundleIdentifier: typeof SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER;
  name: string;
  version: string;
  sha256: string;
}

export type SessionDeckDesktopSourceState =
  | {
      kind: 'local-path';
      path: string;
      sha256: string;
    }
  | {
      kind: 'github-release';
      releaseTag: string;
      assetName: string;
      url: string;
      sha256: string;
    };

export interface SessionDeckDesktopInstallState {
  schemaVersion: typeof SESSION_DECK_DESKTOP_STATE_SCHEMA_VERSION;
  product: typeof SESSION_DECK_DESKTOP_PRODUCT;
  packageName: typeof SESSION_DECK_DESKTOP_PACKAGE_NAME;
  packageVersion: string;
  installedAt: string;
  app: SessionDeckDesktopAppState;
  source: SessionDeckDesktopSourceState;
  runtime: {
    nodeExecutablePath: string;
    packageRoot: string;
    helperPackageVersion: string;
  };
  ownedPaths: string[];
}

export function hashSessionDeckDesktopContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function hashSessionDeckDesktopPath(path: string): Promise<string> {
  const pathStat = await lstat(path);
  if (pathStat.isFile()) {
    return hashSessionDeckDesktopContent(await readFile(path));
  }

  const hash = createHash('sha256');
  await hashDirectoryInto(hash, path, '');
  return hash.digest('hex');
}

export async function readSessionDeckDesktopInstallState(
  statePath: string,
): Promise<SessionDeckDesktopInstallState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parseSessionDeckDesktopInstallState(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeSessionDeckDesktopInstallState(
  statePath: string,
  state: SessionDeckDesktopInstallState,
): Promise<void> {
  const stateDir = dirname(statePath);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);

  const tempPath = join(stateDir, `.install.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, serializeSessionDeckDesktopInstallState(state), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, statePath);
    await chmod(statePath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export function serializeSessionDeckDesktopInstallState(
  state: SessionDeckDesktopInstallState,
): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseSessionDeckDesktopInstallState(
  candidate: unknown,
): SessionDeckDesktopInstallState {
  if (!isRecord(candidate)) {
    throw new Error('State has an invalid shape.');
  }

  const packageVersion = candidate['packageVersion'];
  const installedAt = candidate['installedAt'];
  const app = candidate['app'];
  const source = candidate['source'];
  const runtime = candidate['runtime'];
  const ownedPaths = candidate['ownedPaths'];

  if (
    !hasExactKeys(candidate, [
      'schemaVersion',
      'product',
      'packageName',
      'packageVersion',
      'installedAt',
      'app',
      'source',
      'runtime',
      'ownedPaths',
    ]) ||
    candidate['schemaVersion'] !== SESSION_DECK_DESKTOP_STATE_SCHEMA_VERSION ||
    candidate['product'] !== SESSION_DECK_DESKTOP_PRODUCT ||
    candidate['packageName'] !== SESSION_DECK_DESKTOP_PACKAGE_NAME ||
    !isNonEmptyString(packageVersion) ||
    !isNonEmptyString(installedAt) ||
    !isAppState(app) ||
    !isSourceState(source) ||
    !isRuntimeState(runtime) ||
    !isOwnedPaths(ownedPaths)
  ) {
    throw new Error('State has an invalid shape.');
  }

  if (!ownedPaths.includes(app.path)) {
    throw new Error('State does not record the app path as owned.');
  }

  return {
    schemaVersion: SESSION_DECK_DESKTOP_STATE_SCHEMA_VERSION,
    product: SESSION_DECK_DESKTOP_PRODUCT,
    packageName: SESSION_DECK_DESKTOP_PACKAGE_NAME,
    packageVersion,
    installedAt,
    app: {
      path: app.path,
      bundleIdentifier: SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER,
      name: app.name,
      version: app.version,
      sha256: app.sha256,
    },
    source:
      source.kind === 'local-path'
        ? {
            kind: 'local-path',
            path: source.path,
            sha256: source.sha256,
          }
        : {
            kind: 'github-release',
            releaseTag: source.releaseTag,
            assetName: source.assetName,
            url: source.url,
            sha256: source.sha256,
          },
    runtime: {
      nodeExecutablePath: runtime.nodeExecutablePath,
      packageRoot: runtime.packageRoot,
      helperPackageVersion: runtime.helperPackageVersion,
    },
    ownedPaths: [...ownedPaths],
  };
}

async function hashDirectoryInto(
  hash: ReturnType<typeof createHash>,
  path: string,
  relativePath: string,
): Promise<void> {
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink()) {
    throw new Error(`Cannot checksum symlink in Session Deck desktop artifact: ${path}`);
  }

  const normalizedRelativePath = relativePath.split(sep).join('/');
  if (pathStat.isDirectory()) {
    hash.update(`dir\0${normalizedRelativePath}\0`);
    const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      await hashDirectoryInto(hash, join(path, entry.name), join(relativePath, entry.name));
    }
    return;
  }

  if (!pathStat.isFile()) {
    throw new Error(
      `Cannot checksum unsupported file type in Session Deck desktop artifact: ${path}`,
    );
  }

  hash.update(`file\0${normalizedRelativePath}\0${pathStat.size}\0`);
  hash.update(await readFile(path));
}

function isAppState(candidate: unknown): candidate is SessionDeckDesktopAppState {
  return (
    isRecord(candidate) &&
    hasExactKeys(candidate, ['path', 'bundleIdentifier', 'name', 'version', 'sha256']) &&
    isAbsoluteNonEmptyString(candidate['path']) &&
    candidate['bundleIdentifier'] === SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER &&
    isNonEmptyString(candidate['name']) &&
    isNonEmptyString(candidate['version']) &&
    isSha256(candidate['sha256'])
  );
}

function isSourceState(candidate: unknown): candidate is SessionDeckDesktopSourceState {
  if (!isRecord(candidate) || typeof candidate['kind'] !== 'string') {
    return false;
  }

  if (candidate['kind'] === 'local-path') {
    return (
      hasExactKeys(candidate, ['kind', 'path', 'sha256']) &&
      isAbsoluteNonEmptyString(candidate['path']) &&
      isSha256(candidate['sha256'])
    );
  }

  return (
    candidate['kind'] === 'github-release' &&
    hasExactKeys(candidate, ['kind', 'releaseTag', 'assetName', 'url', 'sha256']) &&
    isNonEmptyString(candidate['releaseTag']) &&
    isNonEmptyString(candidate['assetName']) &&
    isNonEmptyString(candidate['url']) &&
    isSha256(candidate['sha256'])
  );
}

function isRuntimeState(
  candidate: unknown,
): candidate is SessionDeckDesktopInstallState['runtime'] {
  return (
    isRecord(candidate) &&
    hasExactKeys(candidate, ['nodeExecutablePath', 'packageRoot', 'helperPackageVersion']) &&
    isAbsoluteNonEmptyString(candidate['nodeExecutablePath']) &&
    isAbsoluteNonEmptyString(candidate['packageRoot']) &&
    isNonEmptyString(candidate['helperPackageVersion'])
  );
}

function isOwnedPaths(candidate: unknown): candidate is string[] {
  return (
    Array.isArray(candidate) && candidate.length > 0 && candidate.every(isAbsoluteNonEmptyString)
  );
}

function isSha256(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/u.test(candidate);
}

function isAbsoluteNonEmptyString(candidate: unknown): candidate is string {
  return isNonEmptyString(candidate) && isAbsolute(candidate);
}

function isNonEmptyString(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.trim().length > 0;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function hasExactKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(candidate);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
