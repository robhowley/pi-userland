import { expect, it, vi } from 'vitest';
import { lookupTasks } from '../extensions/remembrancer/taskwarrior.js';

const uuid = '11111111-1111-4111-8111-111111111111';

it.each([
  { query: {}, args: ['export'] },
  { query: { uuid }, args: [uuid, 'export'] },
  { query: { status: 'pending' as const }, args: ['status:pending', 'export'] },
  { query: { status: 'completed' as const }, args: ['status:completed', 'export'] },
])('uses only fixed read-only export arguments for $query', async ({ query, args }) => {
  const execute = vi.fn().mockResolvedValue(JSON.stringify([{ uuid, status: 'completed' }]));
  expect(await lookupTasks(query, execute)).toEqual({
    tasks: [{ uuid, status: 'completed' }],
    nextOffset: null,
  });
  expect(execute).toHaveBeenCalledExactlyOnceWith(args);
});

it.each([
  { uuid: 'all delete' },
  { status: 'pending or all' },
  { offset: -1 },
  { offset: 0.5 },
  { offset: Number.MAX_SAFE_INTEGER + 1 },
])('rejects filter/command injection and invalid paging: %j', async (query) => {
  const execute = vi.fn();
  await expect(lookupTasks(query as Parameters<typeof lookupTasks>[0], execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it.each(['{}', '[null]', '[{"uuid":"not-a-uuid"}]'])(
  'rejects invalid task export %s',
  async (output) => {
    await expect(lookupTasks({}, vi.fn().mockResolvedValue(output))).rejects.toThrow();
  },
);

it('pages read-only results without interpreting task content as arguments', async () => {
  const tasks = Array.from({ length: 51 }, () => ({
    uuid,
    description: 'all delete; $(touch never)',
  }));
  const execute = vi.fn().mockResolvedValue(JSON.stringify(tasks));
  expect(await lookupTasks({}, execute)).toEqual({ tasks: tasks.slice(0, 50), nextOffset: 50 });
  expect(await lookupTasks({ offset: 50 }, execute)).toEqual({
    tasks: tasks.slice(50),
    nextOffset: null,
  });
  expect(execute.mock.calls).toEqual([[['export']], [['export']]]);
});
