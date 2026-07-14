import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { writeSessionDeckIterm2Manifest, hashSessionDeckIterm2Template } from './manifest.js';
import {
  getDefaultSessionDeckIterm2ScriptsDir,
  getSessionDeckIterm2AutoLaunchDir,
  getSessionDeckIterm2ManifestPath,
  getSessionDeckIterm2PythonBridgePath,
  getSessionDeckIterm2ScriptPath,
  getSessionDeckIterm2StateDir,
  getSessionDeckIterm2WebAssetPaths,
  normalizeSessionDeckIterm2ScriptsDir,
  resolveSessionDeckIterm2RuntimePaths,
  type SessionDeckIterm2RuntimePaths,
} from './paths.js';
import { renderSessionDeckIterm2PythonScript } from './python-template.js';
import type { SessionDeckIterm2CommandResult } from './command.js';

export interface InstallSessionDeckIterm2Options {
  homeDirectory?: string;
  manifestPath?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  runtimePaths?: SessionDeckIterm2RuntimePaths;
  scriptsDir?: string;
}

export async function installSessionDeckIterm2(
  options: InstallSessionDeckIterm2Options = {},
): Promise<SessionDeckIterm2CommandResult> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return {
      level: 'error',
      message: 'iTerm2 Toolbelt install is only supported on macOS.',
    };
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const scriptsDir = normalizeSessionDeckIterm2ScriptsDir(
    options.scriptsDir ?? getDefaultSessionDeckIterm2ScriptsDir(homeDirectory),
  );
  const manifestPath = options.manifestPath ?? getSessionDeckIterm2ManifestPath(homeDirectory);
  const stateDir = dirname(manifestPath) || getSessionDeckIterm2StateDir(homeDirectory);
  const runtimePaths =
    options.runtimePaths ?? (await resolveSessionDeckIterm2RuntimePaths(import.meta.url));

  const missingAsset = await findMissingRuntimeAsset(runtimePaths);
  if (missingAsset !== null) {
    return {
      level: 'error',
      message: `${missingAsset.message}\nRun \`pnpm --dir packages/pi-session-deck run build\` and try again.`,
    };
  }

  const generatedScriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);
  const generatedPythonBridgePath = getSessionDeckIterm2PythonBridgePath(scriptsDir);
  const scriptContent = renderSessionDeckIterm2PythonScript({
    helperScriptPath: runtimePaths.helperScriptPath,
    nodeExecutablePath: runtimePaths.nodeExecutablePath,
    packageVersion: runtimePaths.packageVersion,
    webRootPath: runtimePaths.webRootPath,
  });
  const pythonBridgeContent = await readFile(runtimePaths.pythonBridgeSourcePath, 'utf8');
  const templateHash = hashSessionDeckIterm2Template(scriptContent);
  const pythonBridgeHash = hashSessionDeckIterm2Template(pythonBridgeContent);

  await mkdir(getSessionDeckIterm2AutoLaunchDir(scriptsDir), { recursive: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(generatedScriptPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
  await writeFile(generatedPythonBridgePath, pythonBridgeContent, {
    encoding: 'utf8',
    mode: 0o755,
  });
  await writeSessionDeckIterm2Manifest(manifestPath, {
    schemaVersion: 2,
    packageVersion: runtimePaths.packageVersion,
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
    scriptsDir,
    artifacts: {
      toolbelt: {
        kind: 'autolaunch-script',
        path: generatedScriptPath,
        sha256: templateHash,
        nodeExecutablePath: runtimePaths.nodeExecutablePath,
        helperScriptPath: runtimePaths.helperScriptPath,
        webRootPath: runtimePaths.webRootPath,
      },
      pythonBridge: {
        kind: 'autolaunch-script',
        path: generatedPythonBridgePath,
        sha256: pythonBridgeHash,
        sourcePath: runtimePaths.pythonBridgeSourcePath,
      },
    },
  });

  return {
    level: 'info',
    message: [
      'Installed Session Deck iTerm2 Toolbelt.',
      `Toolbelt script: ${generatedScriptPath}`,
      `Python bridge: ${generatedPythonBridgePath}`,
      `Manifest: ${manifestPath}`,
      'Next: enable iTerm2 Python API if needed, then restart iTerm2 and open Toolbelt → Session Deck.',
    ].join('\n'),
  };
}

async function findMissingRuntimeAsset(
  runtimePaths: SessionDeckIterm2RuntimePaths,
): Promise<{ message: string } | null> {
  if (!(await pathExists(runtimePaths.helperScriptPath))) {
    return {
      message: `Snapshot helper not found: ${runtimePaths.helperScriptPath}`,
    };
  }

  if (!(await pathExists(runtimePaths.webRootPath))) {
    return {
      message: `Web assets not found: ${runtimePaths.webRootPath}`,
    };
  }

  if (!(await pathExists(runtimePaths.pythonBridgeSourcePath))) {
    return {
      message: `iTerm2 Python bridge source not found: ${runtimePaths.pythonBridgeSourcePath}`,
    };
  }

  const webAssets = getSessionDeckIterm2WebAssetPaths(runtimePaths.webRootPath);
  const requiredAssets = [
    { label: 'Web index', path: webAssets.indexPath },
    { label: 'Web app', path: webAssets.appPath },
    { label: 'Web stylesheet', path: webAssets.stylePath },
  ];

  for (const asset of requiredAssets) {
    if (!(await pathExists(asset.path))) {
      return {
        message: `${asset.label} not found: ${asset.path}`,
      };
    }
  }

  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
