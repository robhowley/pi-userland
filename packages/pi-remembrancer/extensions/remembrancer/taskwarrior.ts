import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import type { CheckpointStore } from './checkpoints.js';
import {
  validateDraft,
  validateSnapshot,
  type ApplicationResult,
  type Proposal,
  type TaskChange,
  type TaskFields,
  type TaskSnapshot,
} from './proposals.js';

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
export function requireTui(mode: unknown): void {
  if (mode !== 'tui') throw new Error('Task proposals require TUI mode');
}
function fullUuid(value: string): void {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value))
    throw new Error('Expected full task UUID');
}
export function snapshot(record: TaskRecord): TaskSnapshot {
  const fields: TaskFields = {};
  for (const key of [
    'description',
    'project',
    'due',
    'wait',
    'scheduled',
    'priority',
    'waitingon',
    'tags',
    'depends',
  ] as const) {
    if (record[key] !== undefined)
      Object.assign(fields, {
        [key]: record[key] === '' && key !== 'description' ? null : record[key],
      });
  }
  const value = {
    uuid: record['uuid'],
    status: record['status'],
    fields,
    annotations: record['annotations'] ?? [],
  } as TaskSnapshot;
  validateSnapshot(value);
  return value;
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
async function readTask(uuid: string, execute: TaskExecutor): Promise<TaskRecord | null> {
  const { tasks } = await lookupTasks({ uuid }, execute);
  if (tasks.length > 1 || (tasks[0] && tasks[0]['uuid'] !== uuid))
    throw new Error('Task export target mismatch');
  return tasks[0] ?? null;
}
export type TaskPreview = { proposal: Proposal; task: TaskRecord | null };
export async function previewProposal(
  store: CheckpointStore,
  id: string,
  execute: TaskExecutor = executeTask,
): Promise<TaskPreview> {
  const proposal = store.proposal(id);
  if (!proposal) throw new Error('Proposal no longer exists');
  const draft = proposal.draft ?? proposal;
  validateDraft({ change: draft.change, expected: draft.expected, question: draft.question });
  const uuid = draft.change.operation === 'add' ? proposal.claim : draft.change.targetUuid;
  return { proposal, task: uuid ? await readTask(uuid, execute) : null };
}
function fieldValue(value: unknown): unknown {
  return value === undefined || value === '' ? null : value;
}
export function satisfies(
  change: TaskChange,
  task: TaskRecord | null,
  status: unknown = 'pending',
): boolean {
  if (!task) return false;
  if (change.operation === 'complete' ? task['status'] !== 'completed' : task['status'] !== status)
    return false;
  if (
    change.operation !== 'complete' &&
    !Object.entries(change.fields).every(([key, value]) => {
      const actual = task[key];
      if (Array.isArray(value))
        return isDeepStrictEqual(
          [...value].sort(),
          Array.isArray(actual) ? [...actual].sort() : [],
        );
      return isDeepStrictEqual(fieldValue(actual), fieldValue(value));
    })
  )
    return false;
  const annotations = snapshot(task).annotations.map((a) => a.description);
  return change.annotations.every((value) => annotations.includes(value));
}
/** JSON stdin prevents Taskwarrior's argument parser from interpreting user text as commands. */
export async function writeTaskChange(
  mode: () => unknown,
  change: TaskChange,
  current: TaskRecord | null,
  uuid: string,
  execute: TaskExecutor = executeTask,
): Promise<void> {
  requireTui(mode());
  fullUuid(uuid);
  validateDraft({ change, expected: current ? snapshot(current) : null, question: null });
  if (change.operation !== 'add' && change.targetUuid !== uuid)
    throw new Error('Write target mismatch');
  if (change.operation === 'add' && current) throw new Error('Add target already exists');
  const record: TaskRecord = { ...current, uuid, status: current?.['status'] ?? 'pending' };
  delete record['id'];
  delete record['urgency'];
  if (change.operation === 'complete') record['status'] = 'completed';
  else for (const [key, value] of Object.entries(change.fields)) record[key] = value ?? '';
  const annotations = current ? snapshot(current).annotations : [];
  record['annotations'] = [
    ...annotations,
    ...[...new Set(change.annotations)]
      .filter((description) => !annotations.some((a) => a.description === description))
      .map((description) => ({
        entry: new Date()
          .toISOString()
          .replace(/[-:]/gu, '')
          .replace(/\.\d{3}/u, ''),
        description,
      })),
  ];
  requireTui(mode());
  await execute(['import', '-'], JSON.stringify([record]));
}
export async function applyProposal(
  store: CheckpointStore,
  preview: TaskPreview,
  mode: () => unknown,
  execute: TaskExecutor = executeTask,
): Promise<Proposal> {
  requireTui(mode());
  const fresh = await previewProposal(store, preview.proposal.id, execute);
  if (
    fresh.proposal.revision !== preview.proposal.revision ||
    !isDeepStrictEqual(fresh.task, preview.task)
  )
    throw new Error('Preview changed. Review refreshed values and approve again.');
  if (fresh.proposal.state !== 'pending')
    throw new Error('This proposal cannot be replayed. Inspect its outcome.');
  const change = (fresh.proposal.draft ?? fresh.proposal).change;
  if (change.operation !== 'add' && !fresh.task) throw new Error('Target task is missing');
  requireTui(mode());
  const claim = store.claimProposal(
    fresh.proposal.id,
    fresh.proposal.revision,
    fresh.task ? snapshot(fresh.task) : null,
  );
  const uuid = change.operation === 'add' ? claim.claim! : change.targetUuid;
  let result: ApplicationResult;
  const status = fresh.task?.['status'] ?? 'pending';
  if (satisfies(change, fresh.task, status))
    result = {
      state: 'already_satisfied',
      verified: snapshot(fresh.task!),
      error: null,
      actual: fresh.task!,
    };
  else {
    let error: string | null = null;
    try {
      await writeTaskChange(mode, change, fresh.task, uuid, execute);
    } catch (cause) {
      error = String(cause);
    }
    let actual: TaskRecord | null = null;
    let verified: TaskSnapshot | null = null;
    try {
      actual = await readTask(uuid, execute);
      verified = actual ? snapshot(actual) : null;
    } catch (cause) {
      error = [error, `Verification: ${String(cause)}`].filter(Boolean).join('\n');
    }
    result =
      !error && satisfies(change, actual, status)
        ? { state: 'applied', verified: verified!, error: null, actual: actual! }
        : {
            state: 'uncertain',
            verified,
            error: error ?? 'Taskwarrior returned a record that does not satisfy the preview',
            actual,
          };
  }
  // Never turn a persistence failure into another write attempt. The durable claim remains.
  return store.recordProposalResult(claim.id, claim.revision, claim.claim!, result);
}
/** Explicit read-only resolution; never replays an interrupted write. */
export async function resolveProposal(
  store: CheckpointStore,
  preview: TaskPreview,
  mode: () => unknown,
  execute: TaskExecutor = executeTask,
): Promise<Proposal> {
  requireTui(mode());
  const fresh = await previewProposal(store, preview.proposal.id, execute);
  if (
    fresh.proposal.revision !== preview.proposal.revision ||
    !isDeepStrictEqual(fresh.task, preview.task)
  )
    throw new Error('Preview changed. Inspect again.');
  const proposal = fresh.proposal;
  if (!['applying', 'uncertain'].includes(proposal.state) || !proposal.claim)
    throw new Error('No unresolved application');
  if (
    !satisfies(
      (proposal.draft ?? proposal).change,
      fresh.task,
      proposal.applicationBefore?.status ??
        (proposal.draft ?? proposal).expected?.status ??
        'pending',
    )
  )
    throw new Error(
      'Requested result is not present. No retry performed; inspect and resolve the task manually.',
    );
  return store.recordProposalResult(proposal.id, proposal.revision, proposal.claim, {
    state: 'already_satisfied',
    verified: snapshot(fresh.task!),
    actual: fresh.task!,
    error: null,
  });
}
