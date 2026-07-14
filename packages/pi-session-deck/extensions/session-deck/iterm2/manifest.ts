import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

interface SessionDeckIterm2InstallManifestBase {
  packageVersion: string;
  installedAt: string;
  scriptsDir: string;
}

export interface SessionDeckIterm2InstallManifestV1 extends SessionDeckIterm2InstallManifestBase {
  schemaVersion: 1;
  generatedScriptPath: string;
  nodeExecutablePath: string;
  helperScriptPath: string;
  webRootPath: string;
  templateHash: string;
}

export interface SessionDeckIterm2ToolbeltArtifact {
  kind: 'autolaunch-script';
  path: string;
  sha256: string;
  nodeExecutablePath: string;
  helperScriptPath: string;
  webRootPath: string;
}

export interface SessionDeckIterm2PythonBridgeArtifact {
  kind: 'autolaunch-script';
  path: string;
  sha256: string;
  sourcePath: string;
}

export interface SessionDeckIterm2InstallManifestV2 extends SessionDeckIterm2InstallManifestBase {
  schemaVersion: 2;
  artifacts: {
    toolbelt: SessionDeckIterm2ToolbeltArtifact;
    pythonBridge: SessionDeckIterm2PythonBridgeArtifact;
  };
}

export type SessionDeckIterm2InstallManifest =
  | SessionDeckIterm2InstallManifestV1
  | SessionDeckIterm2InstallManifestV2;

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

export function getSessionDeckIterm2ToolbeltArtifact(
  manifest: SessionDeckIterm2InstallManifest,
): SessionDeckIterm2ToolbeltArtifact {
  if (manifest.schemaVersion === 2) {
    return manifest.artifacts.toolbelt;
  }

  return {
    kind: 'autolaunch-script',
    path: manifest.generatedScriptPath,
    sha256: manifest.templateHash,
    nodeExecutablePath: manifest.nodeExecutablePath,
    helperScriptPath: manifest.helperScriptPath,
    webRootPath: manifest.webRootPath,
  };
}

export function getSessionDeckIterm2PythonBridgeArtifact(
  manifest: SessionDeckIterm2InstallManifest,
): SessionDeckIterm2PythonBridgeArtifact | null {
  return manifest.schemaVersion === 2 ? manifest.artifacts.pythonBridge : null;
}

function isManifest(
  candidate: Partial<SessionDeckIterm2InstallManifest>,
): candidate is SessionDeckIterm2InstallManifest {
  return isManifestV1(candidate) || isManifestV2(candidate);
}

function isManifestV1(
  candidate: Partial<SessionDeckIterm2InstallManifest>,
): candidate is SessionDeckIterm2InstallManifestV1 {
  return (
    candidate.schemaVersion === 1 &&
    hasBaseManifestShape(candidate) &&
    typeof candidate.generatedScriptPath === 'string' &&
    typeof candidate.nodeExecutablePath === 'string' &&
    typeof candidate.helperScriptPath === 'string' &&
    typeof candidate.webRootPath === 'string' &&
    typeof candidate.templateHash === 'string'
  );
}

function isManifestV2(
  candidate: Partial<SessionDeckIterm2InstallManifest>,
): candidate is SessionDeckIterm2InstallManifestV2 {
  return (
    candidate.schemaVersion === 2 &&
    hasBaseManifestShape(candidate) &&
    isToolbeltArtifact((candidate as { artifacts?: unknown }).artifacts) &&
    isPythonBridgeArtifact((candidate as { artifacts?: unknown }).artifacts)
  );
}

function hasBaseManifestShape(candidate: Partial<SessionDeckIterm2InstallManifest>): boolean {
  return (
    typeof candidate.packageVersion === 'string' &&
    typeof candidate.installedAt === 'string' &&
    typeof candidate.scriptsDir === 'string'
  );
}

function isToolbeltArtifact(artifacts: unknown): boolean {
  if (typeof artifacts !== 'object' || artifacts === null || !('toolbelt' in artifacts)) {
    return false;
  }

  const artifact = (artifacts as { toolbelt?: Record<string, unknown> }).toolbelt;
  return (
    artifact !== undefined &&
    artifact['kind'] === 'autolaunch-script' &&
    typeof artifact['path'] === 'string' &&
    typeof artifact['sha256'] === 'string' &&
    typeof artifact['nodeExecutablePath'] === 'string' &&
    typeof artifact['helperScriptPath'] === 'string' &&
    typeof artifact['webRootPath'] === 'string'
  );
}

function isPythonBridgeArtifact(artifacts: unknown): boolean {
  if (typeof artifacts !== 'object' || artifacts === null || !('pythonBridge' in artifacts)) {
    return false;
  }

  const artifact = (artifacts as { pythonBridge?: Record<string, unknown> }).pythonBridge;
  return (
    artifact !== undefined &&
    artifact['kind'] === 'autolaunch-script' &&
    typeof artifact['path'] === 'string' &&
    typeof artifact['sha256'] === 'string' &&
    typeof artifact['sourcePath'] === 'string'
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
