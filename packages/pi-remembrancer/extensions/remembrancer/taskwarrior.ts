import { execFile } from 'node:child_process';
export type TaskRecord = Record<string, unknown>;
export type TaskExecutor = (args: readonly string[], input?: string) => Promise<string>;
const options = [
  'rc.confirmation=off',
  'rc.context=',
  'rc.hooks=off',
  'rc.gc=off',
  'rc.json.array=on',
  'rc.verbose=nothing',
];
export const executeTask: TaskExecutor = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'task',
      [...options, ...args],
      { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}\n${stdout}`));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {
      /* execFile callback reports process failure. */
    });
    child.stdin?.end(input);
  });
function fullUuid(value: string): void {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value))
    throw new Error('Expected full task UUID');
}
/** Fixed read-only export, bounded to 1 MiB / 10 seconds by the executor. No filter language. */
export async function lookupTasks(
  query: { uuid?: string; status?: 'pending' | 'completed'; offset?: number } = {},
  execute: TaskExecutor = executeTask,
): Promise<{ tasks: TaskRecord[]; nextOffset: number | null }> {
  if (query.uuid !== undefined) fullUuid(query.uuid);
  if (query.status !== undefined && !['pending', 'completed'].includes(query.status))
    throw new Error('Invalid status');
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
  const args = query.uuid
    ? [query.uuid, 'export']
    : query.status
      ? [`status:${query.status}`, 'export']
      : ['export'];
  const records: unknown = JSON.parse(await execute(args));
  if (!Array.isArray(records)) throw new Error('Invalid Taskwarrior export');
  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      typeof record.uuid !== 'string'
    )
      throw new Error('Invalid Taskwarrior record');
    fullUuid(record.uuid);
  }
  const tasks = records.slice(offset, offset + 50) as TaskRecord[];
  return {
    tasks,
    nextOffset: offset + tasks.length < records.length ? offset + tasks.length : null,
  };
}
