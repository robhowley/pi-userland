import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { getSessionDeckIterm2ScriptPath } from './paths.js';

export const SESSION_DECK_ITERM2_STATE_SCHEMA_VERSION = 1;
export const SESSION_DECK_ITERM2_PRODUCT = 'pi-session-deck-iterm2';

export interface SessionDeckIterm2InstallState {
  schemaVersion: typeof SESSION_DECK_ITERM2_STATE_SCHEMA_VERSION;
  product: typeof SESSION_DECK_ITERM2_PRODUCT;
  packageVersion: string;
  installedAt: string;
  scriptsDir: string;
  script: {
    path: string;
    sha256: string;
  };
  runtime: {
    nodeExecutablePath: string;
    snapshotHelperPath: string;
    webRootPath: string;
    bridgeSocketPath: string;
  };
}

export function hashSessionDeckIterm2Content(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function readSessionDeckIterm2InstallState(
  statePath: string,
): Promise<SessionDeckIterm2InstallState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parseSessionDeckIterm2InstallState(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeSessionDeckIterm2InstallState(
  statePath: string,
  state: SessionDeckIterm2InstallState,
): Promise<void> {
  const stateDir = dirname(statePath);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);

  const tempPath = join(stateDir, `.install.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, serializeSessionDeckIterm2InstallState(state), {
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

export function serializeSessionDeckIterm2InstallState(
  state: SessionDeckIterm2InstallState,
): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseSessionDeckIterm2InstallState(
  candidate: unknown,
): SessionDeckIterm2InstallState {
  if (!isRecord(candidate)) {
    throw new Error('State has an invalid shape.');
  }

  const packageVersion = candidate['packageVersion'];
  const installedAt = candidate['installedAt'];
  const scriptsDir = candidate['scriptsDir'];
  const script = candidate['script'];
  const runtime = candidate['runtime'];

  if (
    !hasExactKeys(candidate, [
      'schemaVersion',
      'product',
      'packageVersion',
      'installedAt',
      'scriptsDir',
      'script',
      'runtime',
    ]) ||
    candidate['schemaVersion'] !== SESSION_DECK_ITERM2_STATE_SCHEMA_VERSION ||
    candidate['product'] !== SESSION_DECK_ITERM2_PRODUCT ||
    !isNonEmptyString(packageVersion) ||
    !isNonEmptyString(installedAt) ||
    !isAbsoluteNonEmptyString(scriptsDir) ||
    !isScriptState(script) ||
    !isRuntimeState(runtime)
  ) {
    throw new Error('State has an invalid shape.');
  }

  if (script.path !== getSessionDeckIterm2ScriptPath(scriptsDir)) {
    throw new Error('State has an invalid script path.');
  }

  return {
    schemaVersion: SESSION_DECK_ITERM2_STATE_SCHEMA_VERSION,
    product: SESSION_DECK_ITERM2_PRODUCT,
    packageVersion,
    installedAt,
    scriptsDir,
    script: {
      path: script.path,
      sha256: script.sha256,
    },
    runtime: {
      nodeExecutablePath: runtime.nodeExecutablePath,
      snapshotHelperPath: runtime.snapshotHelperPath,
      webRootPath: runtime.webRootPath,
      bridgeSocketPath: runtime.bridgeSocketPath,
    },
  };
}

function isScriptState(candidate: unknown): candidate is SessionDeckIterm2InstallState['script'] {
  return (
    isRecord(candidate) &&
    hasExactKeys(candidate, ['path', 'sha256']) &&
    isAbsoluteNonEmptyString(candidate['path']) &&
    isSha256(candidate['sha256'])
  );
}

function isRuntimeState(candidate: unknown): candidate is SessionDeckIterm2InstallState['runtime'] {
  return (
    isRecord(candidate) &&
    hasExactKeys(candidate, [
      'nodeExecutablePath',
      'snapshotHelperPath',
      'webRootPath',
      'bridgeSocketPath',
    ]) &&
    isAbsoluteNonEmptyString(candidate['nodeExecutablePath']) &&
    isAbsoluteNonEmptyString(candidate['snapshotHelperPath']) &&
    isAbsoluteNonEmptyString(candidate['webRootPath']) &&
    isAbsoluteNonEmptyString(candidate['bridgeSocketPath'])
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
