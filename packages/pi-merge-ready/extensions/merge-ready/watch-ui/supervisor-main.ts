import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getErrorMessage } from '../internal.js';
import { createMergeReadyWatchSessionRunner } from './session-runner.js';
import { createMergeReadyWatchUiSupervisorServer } from './supervisor-server.js';
import {
  MERGE_READY_WATCH_UI_SERVICE,
  ensureMergeReadyWatchUiStateDir,
  ensureMergeReadyWatchUiToken,
  getMergeReadyWatchUiPaths,
  removeMergeReadyWatchSupervisorInfo,
  writeMergeReadyWatchSupervisorInfo,
} from './supervisor-state.js';

export async function runMergeReadyWatchUiSupervisorMain(
  args = process.argv.slice(2),
): Promise<void> {
  const packageRoot = resolveMergeReadyWatchUiPackageRoot();
  const defaultCwd = parseMergeReadyWatchUiDefaultCwdArg(args) ?? process.cwd();
  const agentDir = parseMergeReadyWatchUiAgentDirArg(args) ?? getAgentDir();
  const paths = getMergeReadyWatchUiPaths(agentDir);
  const publicDir = path.join(
    packageRoot,
    'dist',
    'extensions',
    'merge-ready',
    'watch-ui',
    'public',
  );
  const extensionDir = path.join(packageRoot, 'dist', 'extensions', 'merge-ready');
  const extensionEntryPath = path.join(extensionDir, 'index.js');
  const skillPath = path.join(packageRoot, 'skills', 'merge-ready-loop', 'SKILL.md');
  const packageVersion = await readMergeReadyWatchUiPackageVersion(packageRoot);

  await ensureMergeReadyWatchUiStateDir(paths);
  const token = await ensureMergeReadyWatchUiToken(paths);
  const runner = await createMergeReadyWatchSessionRunner({
    defaultCwd,
    extensionDir,
    paths,
    skillPath,
    dependencies: {
      agentDir,
    },
  });
  const server = await createMergeReadyWatchUiSupervisorServer({
    packageVersion,
    publicDir,
    runner,
    token,
  });

  await writeMergeReadyWatchSupervisorInfo(paths, {
    service: MERGE_READY_WATCH_UI_SERVICE,
    pid: process.pid,
    port: server.port,
    startedAt: server.startedAt,
    packageVersion,
    tokenFile: paths.tokenFile,
    defaultCwd,
    extensionDir,
    extensionEntryPath,
  });

  let shuttingDown = false;
  const shutdown = async (reason?: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    if (reason) {
      console.error(reason);
    }

    try {
      await server.close();
    } catch {
      // Best-effort shutdown only.
    }

    try {
      await runner.dispose();
    } catch {
      // Best-effort shutdown only.
    }

    try {
      await removeMergeReadyWatchSupervisorInfo(paths);
    } catch {
      // Best-effort shutdown only.
    }
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  });
  process.once('uncaughtException', (error) => {
    void shutdown(`Merge-ready watch UI supervisor crashed: ${getErrorMessage(error)}`).finally(
      () => {
        process.exit(1);
      },
    );
  });
  process.once('unhandledRejection', (error) => {
    void shutdown(`Merge-ready watch UI supervisor rejected: ${getErrorMessage(error)}`).finally(
      () => {
        process.exit(1);
      },
    );
  });
}

export function resolveMergeReadyWatchUiPackageRoot(fromFileUrl = import.meta.url): string {
  const filePath = fileURLToPath(fromFileUrl);
  return path.resolve(path.dirname(filePath), '../../../../');
}

async function readMergeReadyWatchUiPackageVersion(packageRoot: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    version?: string;
  };

  return packageJson.version ?? '0.0.0';
}

function parseMergeReadyWatchUiDefaultCwdArg(args: string[]): string | undefined {
  return readMergeReadyWatchUiArgValue(args, '--cwd');
}

function parseMergeReadyWatchUiAgentDirArg(args: string[]): string | undefined {
  return readMergeReadyWatchUiArgValue(args, '--agent-dir');
}

function readMergeReadyWatchUiArgValue(
  args: string[],
  flag: '--agent-dir' | '--cwd',
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }

    const value = args[index + 1]?.trim();
    return value && value.length > 0 ? value : undefined;
  }

  return undefined;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  void runMergeReadyWatchUiSupervisorMain().catch((error) => {
    console.error(`Merge-ready watch UI supervisor failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
