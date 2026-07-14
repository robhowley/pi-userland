import { pathToFileURL } from 'node:url';
import { readSessionDeckSnapshot } from '../reader.js';

export interface RunSessionDeckSnapshotCliOptions {
  readSnapshot?: typeof readSessionDeckSnapshot;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

export async function runSessionDeckSnapshotCli(
  options: RunSessionDeckSnapshotCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const readSnapshot = options.readSnapshot ?? readSessionDeckSnapshot;

  try {
    const snapshot = await readSnapshot();
    stdout.write(`${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Session Deck snapshot helper failed: ${getErrorMessage(error)}\n`);
    return 1;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const exitCode = await runSessionDeckSnapshotCli();
  process.exitCode = exitCode;
}

function isDirectExecution(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  return importMetaUrl === pathToFileURL(argvPath).href;
}
