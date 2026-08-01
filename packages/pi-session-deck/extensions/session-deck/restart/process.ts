import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type ReadProcessTable = () => Promise<{
  stdout: string;
  exitCode: number;
}>;

export async function readDescendantPids(
  rootPid: number,
  readProcessTable: ReadProcessTable = defaultReadProcessTable,
): Promise<number[]> {
  const output = await readProcessTable();
  if (output.exitCode !== 0) return [rootPid];
  const children = new Map<number, number[]>();
  for (const line of output.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) continue;
    const list = children.get(Number(match[2])) ?? [];
    list.push(Number(match[1]));
    children.set(Number(match[2]), list);
  }
  const result: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

async function defaultReadProcessTable(): Promise<{ stdout: string; exitCode: number }> {
  try {
    const value = await execFile('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { stdout: value.stdout, exitCode: 0 };
  } catch (error) {
    const child = error as NodeJS.ErrnoException & { stdout?: string };
    return { stdout: child.stdout ?? '', exitCode: 1 };
  }
}
