import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { openProposals, previewText, sourceText } from '../extensions/remembrancer/proposal-ui.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import type { Evidence } from '../extensions/remembrancer/evidence.js';
import type { ProposalDraft } from '../extensions/remembrancer/proposals.js';
import {
  applyProposal,
  lookupTasks,
  previewProposal,
  resolveProposal,
  snapshot,
  writeTaskChange,
  type TaskExecutor,
  type TaskRecord,
} from '../extensions/remembrancer/taskwarrior.js';

const uuid = '00000000-0000-0000-0000-000000000001';
const record: TaskRecord = {
  uuid,
  status: 'pending',
  description: 'Before',
  project: 'work',
  annotations: [],
};
const evidence: Evidence = {
  file: '/missing/session.jsonl',
  sessionId: 'session',
  branchId: 'leaf',
  entryId: 'leaf',
  editId: null,
  role: 'user',
  text: 'Send comparison',
  cwd: '/work',
  timestamp: '2026-01-01',
  reviewedThrough: null,
};
const stores: CheckpointStore[] = [];
afterEach(() => {
  stores.forEach((s) => s.close());
  stores.length = 0;
  vi.restoreAllMocks();
});
function seed(
  store: CheckpointStore,
  draft: ProposalDraft = {
    change: {
      operation: 'add',
      fields: { description: 'Send comparison', project: 'work' },
      annotations: ['Saved context'],
    },
    expected: null,
    question: null,
  },
) {
  const token = store.claimReview();
  store.freezeReview(
    token,
    { sources: [{ file: evidence.file, sessionId: evidence.sessionId }], checkpoints: [] },
    [evidence],
    false,
  );
  store.deliveredReview(token, { index: 1, offset: 0 });
  return store.finish(token, [
    {
      ...draft,
      explanation: 'Promised',
      references: [
        {
          sessionId: 'session',
          branchId: 'leaf',
          entryId: 'leaf',
          editId: null,
          offset: 0,
          quote: 'Send comparison',
        },
      ],
    },
  ])[0]!;
}
function setup(draft?: ProposalDraft) {
  const store = new CheckpointStore(':memory:');
  stores.push(store);
  const proposal = seed(store, draft);
  let actual: TaskRecord | null = draft?.expected ? structuredClone(record) : null;
  const execute = vi.fn<TaskExecutor>(async (args, input) => {
    if (args[0] === 'import') {
      actual = JSON.parse(input!)[0];
      return '';
    }
    return JSON.stringify(actual ? [actual] : []);
  });
  return {
    store,
    proposal,
    execute,
    set: (value: TaskRecord | null) => {
      actual = value;
    },
  };
}
const update: ProposalDraft = {
  change: {
    operation: 'update',
    targetUuid: uuid,
    fields: { description: 'After', project: null },
    annotations: ['Quote'],
  },
  expected: snapshot(record),
  question: null,
};
it.each(['rpc', 'json', 'print', undefined])(
  'independently refuses writes in %s mode before executor',
  async (mode) => {
    const execute = vi.fn<TaskExecutor>();
    await expect(writeTaskChange(() => mode, update.change, record, uuid, execute)).rejects.toThrow(
      /TUI/,
    );
    expect(execute).not.toHaveBeenCalled();
  },
);
it('rechecks mode immediately before the executor boundary', async () => {
  const mode = vi.fn().mockReturnValueOnce('tui').mockReturnValue('rpc');
  const execute = vi.fn<TaskExecutor>();
  await expect(writeTaskChange(mode, update.change, record, uuid, execute)).rejects.toThrow(/TUI/);
  expect(execute).not.toHaveBeenCalled();
});
it('two SQLite connections claim one proposal and retain the approved task snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-two-writers-'));
  const file = join(dir, 'proposals.db');
  const first = new CheckpointStore(file);
  const second = new CheckpointStore(file);
  const proposal = seed(first, update);
  let actual: TaskRecord = structuredClone(record);
  const execute = vi.fn<TaskExecutor>(async (_args, input) => {
    if (input) {
      actual = JSON.parse(input)[0];
      return '';
    }
    return JSON.stringify([actual]);
  });
  try {
    const preview = await previewProposal(first, proposal.id, execute);
    const results = await Promise.allSettled([
      applyProposal(first, preview, () => 'tui', execute),
      applyProposal(second, preview, () => 'tui', execute),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
    expect(second.proposal(proposal.id)?.applicationBefore).toEqual(snapshot(record));
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('writes typed JSON only and verifies full actual record', async () => {
  const f = setup(update);
  const preview = await previewProposal(f.store, f.proposal.id, f.execute);
  const result = await applyProposal(f.store, preview, () => 'tui', f.execute);
  expect(result.state).toBe('applied');
  expect(result.result?.actual).toMatchObject({ description: 'After', project: '' });
  expect(f.execute.mock.calls.filter(([args]) => args[0] === 'import')).toHaveLength(1);
  expect(result.history?.map((p) => p.state)).toEqual(['pending', 'applying']);
});
it('requires fresh approval for changed task or draft', async () => {
  const f = setup(update);
  const preview = await previewProposal(f.store, f.proposal.id, f.execute);
  f.set({ ...record, description: 'Concurrent change' });
  await expect(applyProposal(f.store, preview, () => 'tui', f.execute)).rejects.toThrow(
    /Preview changed/,
  );
  f.set(record);
  f.store.editProposal(f.proposal.id, 1, { ...update, question: 'Which task?' });
  await expect(applyProposal(f.store, preview, () => 'tui', f.execute)).rejects.toThrow(
    /Preview changed/,
  );
  expect(f.execute.mock.calls.every(([args]) => args.at(-1) === 'export')).toBe(true);
});
it('claims concurrently with only one writer', async () => {
  const f = setup();
  const preview = await previewProposal(f.store, f.proposal.id, f.execute);
  const results = await Promise.allSettled([
    applyProposal(f.store, preview, () => 'tui', f.execute),
    applyProposal(f.store, preview, () => 'tui', f.execute),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.execute.mock.calls.filter(([args]) => args[0] === 'import')).toHaveLength(1);
});
it('resolves already satisfied without writing', async () => {
  const f = setup(update);
  f.set({
    ...record,
    description: 'After',
    project: '',
    annotations: [{ entry: '20260101T000000Z', description: 'Quote' }],
  });
  const result = await applyProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, f.execute),
    () => 'tui',
    f.execute,
  );
  expect(result.state).toBe('already_satisfied');
  expect(f.execute.mock.calls.every(([args]) => args.at(-1) === 'export')).toBe(true);
});
it('preserves partial failure and prevents replay', async () => {
  const f = setup(update);
  const execute: TaskExecutor = async (args, input) => {
    if (input) {
      f.set({ ...record, description: 'After' });
      throw new Error('disk failure after partial write');
    }
    return f.execute(args);
  };
  const result = await applyProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, execute),
    () => 'tui',
    execute,
  );
  expect(result.state).toBe('uncertain');
  expect(result.result).toMatchObject({
    error: expect.stringContaining('disk failure'),
    actual: { description: 'After', project: 'work' },
  });
  await expect(
    applyProposal(
      f.store,
      await previewProposal(f.store, f.proposal.id, execute),
      () => 'tui',
      execute,
    ),
  ).rejects.toThrow(/cannot be replayed/);
});
it('successful external write plus failed local outcome retains claim; explicit resolution only reads', async () => {
  const f = setup();
  const persist = vi.spyOn(f.store, 'recordProposalResult').mockImplementationOnce(() => {
    throw new Error('local disk full');
  });
  await expect(
    applyProposal(
      f.store,
      await previewProposal(f.store, f.proposal.id, f.execute),
      () => 'tui',
      f.execute,
    ),
  ).rejects.toThrow(/disk full/);
  expect(f.store.proposal(f.proposal.id)?.state).toBe('applying');
  persist.mockRestore();
  const reopened = await previewProposal(f.store, f.proposal.id, f.execute);
  await expect(applyProposal(f.store, reopened, () => 'tui', f.execute)).rejects.toThrow(
    /cannot be replayed/,
  );
  const result = await resolveProposal(f.store, reopened, () => 'tui', f.execute);
  expect(result.state).toBe('already_satisfied');
  expect(f.execute.mock.calls.filter(([args]) => args[0] === 'import')).toHaveLength(1);
});
it.each(['rpc', 'json', 'print', undefined])(
  'UI refuses %s without task or UI calls',
  async (mode) => {
    const f = setup();
    const custom = vi.fn();
    await expect(
      openProposals({ mode, ui: { custom } } as unknown as ExtensionContext, f.store, f.execute),
    ).rejects.toThrow(/TUI/);
    expect(custom).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it('complete preview and missing-source view preserve all exact values', async () => {
  const f = setup(update);
  const text = previewText(await previewProposal(f.store, f.proposal.id, f.execute));
  for (const value of [
    uuid,
    'Before',
    'After',
    'work',
    'null',
    'Quote',
    'Promised',
    'Send comparison',
  ])
    expect(text).toContain(value);
  expect(sourceText(f.proposal)).toContain('/missing/session.jsonl');
  expect(sourceText(f.proposal)).toContain('Send comparison');
  expect(sourceText(f.proposal)).toContain('Extra file context is unavailable');
});
it('Enter, Source, paging, edit, navigation and closing do not write tasks; draft persists', async () => {
  const f = setup();
  seed(f.store);
  let calls = 0;
  const editor = vi.fn(async () =>
    JSON.stringify({
      change: { operation: 'add', fields: { description: 'Edited' }, annotations: ['Link'] },
      expected: null,
      question: null,
    }),
  );
  type Factory = Parameters<ExtensionContext['ui']['custom']>[0];
  const custom = vi.fn(async (factory: Factory) => {
    let result: unknown;
    const theme = { fg: (_color: string, text: string) => text } as Parameters<Factory>[1];
    const component = await factory(
      { requestRender() {} } as Parameters<Factory>[0],
      theme,
      getKeybindings() as Parameters<Factory>[2],
      (value) => {
        result = value;
      },
    );
    component.render(80);
    if (calls++ === 0) {
      for (const key of ['\r', 's', '\u001b[6~', '\u001b[5~', 's', 'e'])
        component.handleInput?.(key);
    } else if (calls === 2) component.handleInput?.('\u001b[B');
    else component.handleInput?.('\u001b');
    return result;
  });
  const ctx = {
    mode: 'tui',
    ui: { custom, editor, notify: vi.fn() },
  } as unknown as ExtensionContext;
  await openProposals(ctx, f.store, f.execute);
  expect(editor).toHaveBeenCalledOnce();
  expect(
    f.store
      .proposals()
      .some(
        (p) =>
          p.draft?.change.operation === 'add' && p.draft.change.fields.description === 'Edited',
      ),
  ).toBe(true);
  expect(f.execute).not.toHaveBeenCalled();
});
it('retains unexpected actual output when verification cannot validate a snapshot', async () => {
  const f = setup(update);
  const execute: TaskExecutor = async (args, input) => {
    if (input) {
      f.set({ ...record, description: 'After', priority: 'unexpected' });
      return '';
    }
    return f.execute(args);
  };
  const result = await applyProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, execute),
    () => 'tui',
    execute,
  );
  expect(result.result).toMatchObject({
    state: 'uncertain',
    verified: null,
    actual: { priority: 'unexpected' },
    error: expect.stringContaining('Invalid priority'),
  });
});
it('fixed read-only lookup rejects command/filter injection', async () => {
  const execute = vi.fn<TaskExecutor>();
  await expect(lookupTasks({ uuid: 'all delete' }, execute)).rejects.toThrow(/UUID/);
  expect(execute).not.toHaveBeenCalled();
});
it.skipIf(!existsSync('/opt/homebrew/bin/task'))(
  'isolated Taskwarrior import/export handles literals, clearing, arrays and completion',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remembrancer-isolated-task-'));
    const taskrc = join(dir, 'taskrc');
    writeFileSync(
      taskrc,
      `data.location=${join(dir, 'data')}\nconfirmation=off\nhooks=off\ngc=off\n`,
    );
    const execute: TaskExecutor = async (args, input) =>
      execFileSync('/opt/homebrew/bin/task', ['rc.verbose=nothing', 'rc.json.array=on', ...args], {
        cwd: dir,
        env: {
          HOME: dir,
          TASKRC: taskrc,
          TASKDATA: join(dir, 'data'),
          PATH: '/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
        },
        input,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    try {
      const add = {
        operation: 'add' as const,
        fields: {
          description: 'literal rc.hooks=on +tag "quotes" $(touch nope)',
          project: 'work',
          tags: ['one', 'two'],
        },
        annotations: ['Quote "literal"'],
      };
      await writeTaskChange(() => 'tui', add, null, uuid, execute);
      let actual = (await lookupTasks({ uuid }, execute)).tasks[0]!;
      expect(actual['description']).toBe(add.fields.description);
      await writeTaskChange(
        () => 'tui',
        {
          ...update.change,
          operation: 'update',
          targetUuid: uuid,
          fields: { description: 'Updated', project: null, tags: ['three'] },
        },
        actual,
        uuid,
        execute,
      );
      actual = (await lookupTasks({ uuid }, execute)).tasks[0]!;
      expect(actual['description']).toBe('Updated');
      expect(actual['project'] ?? '').toBe('');
      expect(actual['tags']).toEqual(['three']);
      await writeTaskChange(
        () => 'tui',
        { operation: 'complete', targetUuid: uuid, annotations: [] },
        actual,
        uuid,
        execute,
      );
      const completed = (await lookupTasks({ uuid }, execute)).tasks[0]!;
      expect(completed['status']).toBe('completed');
      expect(typeof completed['end']).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
