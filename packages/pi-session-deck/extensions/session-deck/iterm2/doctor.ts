import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  getSessionDeckIterm2PythonBridgeArtifact,
  getSessionDeckIterm2ToolbeltArtifact,
  readSessionDeckIterm2Manifest,
  hashSessionDeckIterm2Template,
  type SessionDeckIterm2InstallManifest,
} from './manifest.js';
import {
  getDefaultSessionDeckIterm2ScriptsDir,
  getSessionDeckIterm2ManifestPath,
  getSessionDeckIterm2PythonBridgePath,
  getSessionDeckIterm2ScriptPath,
  getSessionDeckIterm2WebAssetPaths,
  normalizeSessionDeckIterm2ScriptsDir,
  resolveSessionDeckIterm2RuntimePaths,
  type SessionDeckIterm2RuntimePaths,
} from './paths.js';
import { renderSessionDeckIterm2PythonScript } from './python-template.js';
import type { SessionDeckIterm2CommandResult } from './command.js';

export interface DoctorSessionDeckIterm2InstallOptions {
  homeDirectory?: string;
  manifestPath?: string;
  platform?: NodeJS.Platform;
  runtimePaths?: SessionDeckIterm2RuntimePaths;
  scriptsDir?: string;
}

export async function doctorSessionDeckIterm2Install(
  options: DoctorSessionDeckIterm2InstallOptions = {},
): Promise<SessionDeckIterm2CommandResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const manifestPath = options.manifestPath ?? getSessionDeckIterm2ManifestPath(homeDirectory);
  let manifest: SessionDeckIterm2InstallManifest | null = null;
  let manifestReadError: string | null = null;
  try {
    manifest = await readSessionDeckIterm2Manifest(manifestPath);
  } catch (error) {
    manifestReadError = getErrorMessage(error);
  }
  const overrideScriptsDir =
    options.scriptsDir === undefined
      ? undefined
      : normalizeSessionDeckIterm2ScriptsDir(options.scriptsDir);
  const scriptsDir =
    overrideScriptsDir ??
    manifest?.scriptsDir ??
    getDefaultSessionDeckIterm2ScriptsDir(homeDirectory);
  const toolbeltArtifact =
    manifest === null ? null : getSessionDeckIterm2ToolbeltArtifact(manifest);
  const pythonBridgeArtifact =
    manifest === null ? null : getSessionDeckIterm2PythonBridgeArtifact(manifest);
  const scriptPath = toolbeltArtifact?.path ?? getSessionDeckIterm2ScriptPath(scriptsDir);
  const pythonBridgePath =
    pythonBridgeArtifact?.path ?? getSessionDeckIterm2PythonBridgePath(scriptsDir);

  const lines = ['Session Deck iTerm2 doctor'];
  const issues: string[] = [];

  const platform = options.platform ?? process.platform;
  lines.push(`- platform: ${platform}`);
  if (platform !== 'darwin') {
    issues.push('iTerm2 Toolbelt support is macOS-only.');
  }

  lines.push(`- scripts dir: ${scriptsDir}`);
  lines.push(
    `- manifest: ${manifestReadError === null ? (manifest === null ? 'missing' : manifestPath) : `invalid (${manifestPath})`}`,
  );
  lines.push(
    `- toolbelt script: ${scriptPath}${(await pathExists(scriptPath)) ? '' : ' (missing)'}`,
  );
  lines.push(
    `- python bridge: ${pythonBridgePath}${(await pathExists(pythonBridgePath)) ? '' : ' (missing)'}`,
  );

  let runtimePaths: SessionDeckIterm2RuntimePaths | null = options.runtimePaths ?? null;
  if (runtimePaths === null) {
    try {
      runtimePaths = await resolveSessionDeckIterm2RuntimePaths(import.meta.url);
    } catch (error) {
      issues.push(`Could not resolve current package runtime paths: ${getErrorMessage(error)}`);
    }
  }

  if (manifestReadError !== null) {
    issues.push(`Install manifest at ${manifestPath} could not be read: ${manifestReadError}`);
    issues.push(
      'Manual recovery required: remove or repair the manifest, verify/remove any Session Deck AutoLaunch script manually, then rerun /session-deck iterm2 install.',
    );
  } else if (manifest === null) {
    issues.push(`Install manifest not found at ${manifestPath}. Run /session-deck iterm2 install.`);
  } else if (overrideScriptsDir !== undefined && overrideScriptsDir !== manifest.scriptsDir) {
    issues.push(
      `Requested scripts dir ${overrideScriptsDir} does not match manifest ownership ${manifest.scriptsDir}.`,
    );
  }

  if (runtimePaths !== null) {
    lines.push(
      `- helper: ${runtimePaths.helperScriptPath}${(await pathExists(runtimePaths.helperScriptPath)) ? '' : ' (missing)'}`,
    );
    lines.push(
      `- web root: ${runtimePaths.webRootPath}${(await pathExists(runtimePaths.webRootPath)) ? '' : ' (missing)'}`,
    );
    lines.push(
      `- python bridge source: ${runtimePaths.pythonBridgeSourcePath}${(await pathExists(runtimePaths.pythonBridgeSourcePath)) ? '' : ' (missing)'}`,
    );

    if (!(await pathExists(runtimePaths.helperScriptPath))) {
      issues.push(`Snapshot helper is missing: ${runtimePaths.helperScriptPath}`);
    }
    if (!(await pathExists(runtimePaths.webRootPath))) {
      issues.push(`Web assets are missing: ${runtimePaths.webRootPath}`);
    } else {
      const webAssets = getSessionDeckIterm2WebAssetPaths(runtimePaths.webRootPath);
      const requiredAssets = [
        { label: 'Web index', path: webAssets.indexPath },
        { label: 'Web app', path: webAssets.appPath },
        { label: 'Web stylesheet', path: webAssets.stylePath },
      ];

      for (const asset of requiredAssets) {
        if (!(await pathExists(asset.path))) {
          issues.push(`${asset.label} is missing: ${asset.path}`);
        }
      }
    }
    if (!(await pathExists(runtimePaths.pythonBridgeSourcePath))) {
      issues.push(`iTerm2 Python bridge source is missing: ${runtimePaths.pythonBridgeSourcePath}`);
    }

    if (manifest !== null) {
      if (manifest.packageVersion !== runtimePaths.packageVersion) {
        issues.push(
          `Installed manifest version ${manifest.packageVersion} does not match current package version ${runtimePaths.packageVersion}. Reinstall recommended.`,
        );
      }
      if (toolbeltArtifact?.helperScriptPath !== runtimePaths.helperScriptPath) {
        issues.push('Snapshot helper path changed since install. Reinstall recommended.');
      }
      if (toolbeltArtifact?.webRootPath !== runtimePaths.webRootPath) {
        issues.push('Web asset path changed since install. Reinstall recommended.');
      }
      if (toolbeltArtifact?.nodeExecutablePath !== runtimePaths.nodeExecutablePath) {
        issues.push('Node executable path changed since install. Reinstall recommended.');
      }

      const renderedScript = renderSessionDeckIterm2PythonScript({
        helperScriptPath: runtimePaths.helperScriptPath,
        nodeExecutablePath: runtimePaths.nodeExecutablePath,
        packageVersion: runtimePaths.packageVersion,
        webRootPath: runtimePaths.webRootPath,
      });
      const expectedHash = hashSessionDeckIterm2Template(renderedScript);
      if (toolbeltArtifact?.sha256 !== expectedHash) {
        issues.push(
          'Generated script template hash is stale for the current package. Reinstall recommended.',
        );
      }

      if (await pathExists(scriptPath)) {
        const installedScript = await readFile(scriptPath, 'utf8');
        if (installedScript !== renderedScript) {
          issues.push(
            'Installed AutoLaunch script differs from the current package template. Reinstall recommended.',
          );
        }
      }

      if (pythonBridgeArtifact === null) {
        issues.push(
          'Install manifest predates iTerm2 Python bridge management. Reinstall recommended.',
        );
      } else {
        if (pythonBridgeArtifact.sourcePath !== runtimePaths.pythonBridgeSourcePath) {
          issues.push(
            'iTerm2 Python bridge source path changed since install. Reinstall recommended.',
          );
        }

        if (await pathExists(runtimePaths.pythonBridgeSourcePath)) {
          const expectedPythonBridge = await readFile(runtimePaths.pythonBridgeSourcePath, 'utf8');
          const expectedPythonBridgeHash = hashSessionDeckIterm2Template(expectedPythonBridge);
          if (pythonBridgeArtifact.sha256 !== expectedPythonBridgeHash) {
            issues.push(
              'Installed iTerm2 Python bridge hash is stale for the current package. Reinstall recommended.',
            );
          }

          if (await pathExists(pythonBridgePath)) {
            const installedPythonBridge = await readFile(pythonBridgePath, 'utf8');
            if (installedPythonBridge !== expectedPythonBridge) {
              issues.push(
                'Installed iTerm2 Python bridge differs from the current package source. Reinstall recommended.',
              );
            }
          }
        }
      }
    }
  }

  if (!(await pathExists(scriptPath)) && manifest !== null) {
    issues.push(`Installed AutoLaunch script is missing: ${scriptPath}`);
  }
  if (pythonBridgeArtifact !== null && !(await pathExists(pythonBridgePath))) {
    issues.push(`Installed iTerm2 Python bridge is missing: ${pythonBridgePath}`);
  }

  lines.push(
    '- manual: enable iTerm2 Python API if needed, then restart iTerm2 after install changes.',
  );

  if (issues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  return {
    level: issues.length === 0 ? 'info' : 'warning',
    message: lines.join('\n'),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
