import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface SessionDeckIterm2InstallManifest {
  schemaVersion: 1;
  packageVersion: string;
  installedAt: string;
  scriptsDir: string;
  generatedScriptPath: string;
  nodeExecutablePath: string;
  helperScriptPath: string;
  webRootPath: string;
  templateHash: string;
}

export function hashSessionDeckIterm2Template(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function readSessionDeckIterm2Manifest(
  manifestPath: string,
): Promise<SessionDeckIterm2InstallManifest | null> {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionDeckIterm2InstallManifest>;
    if (!isManifest(parsed)) {
      throw new Error('Manifest has an invalid shape.');
    }
    return parsed;
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeSessionDeckIterm2Manifest(
  manifestPath: string,
  manifest: SessionDeckIterm2InstallManifest,
): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function isManifest(
  candidate: Partial<SessionDeckIterm2InstallManifest>,
): candidate is SessionDeckIterm2InstallManifest {
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.packageVersion === 'string' &&
    typeof candidate.installedAt === 'string' &&
    typeof candidate.scriptsDir === 'string' &&
    typeof candidate.generatedScriptPath === 'string' &&
    typeof candidate.nodeExecutablePath === 'string' &&
    typeof candidate.helperScriptPath === 'string' &&
    typeof candidate.webRootPath === 'string' &&
    typeof candidate.templateHash === 'string'
  );
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
