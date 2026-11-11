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
import * as evidenceModule from '../extensions/remembrancer/evidence.js';
import { REVIEW_RESPONSE_MAX_BYTES } from '../extensions/remembrancer/review-pages.js';
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
const sourceDirs: string[] = [];
afterEach(() => {
  stores.forEach((s) => s.close());
  stores.length = 0;
  sourceDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
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
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-task-proposal-'));
  sourceDirs.push(dir);
  const file = join(dir, 'session.jsonl');
  const sessionId = store.sources().length ? `session-${store.sources().length}` : 'session';
  writeFileSync(
    file,
    [
      { type: 'session', id: sessionId, cwd: '/work' },
      {
        type: 'message',
        id: 'leaf',
        parentId: null,
        timestamp: evidence.timestamp,
        message: { role: 'user', content: evidence.text },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n'),
  );
  store.claimReview();
  const review = store.prepareCapture({ file, sessionId });
  while (review.page()['hasMore']) {
    /* deliver all evidence */
  }
  const proposal = store.finishCapture(review.id, [
    {
      ...draft,
      explanation: 'Promised',
      references: [
        {
          sessionId,
          branchId: 'leaf',
          entryId: 'leaf',
          editId: null,
          offset: 0,
          quote: 'Send comparison',
        },
      ],
    },
  ])[0]!;
  store.releaseReview();
  rmSync(file);
  return proposal;
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
  expect(sourceText(f.proposal)).toContain(f.proposal.sources[0]!.file);
  expect(sourceText(f.proposal)).toContain('Send comparison');
  expect(sourceText(f.proposal)).toContain('Extra file context is unavailable');
});
function sourceFixture(before = 'Earlier context') {
  const f = setup();
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-source-'));
  sourceDirs.push(dir);
  const file = join(dir, 'session.jsonl');
  const records: unknown[] = [{ type: 'session', id: 'session', cwd: '/work' }];
  let parentId: string | null = null;
  for (const [id, text] of [
    ['outside-before', 'Outside preceding window'],
    ['before', before],
    ['reply', 'Supporting reply'],
    ['leaf', evidence.text],
    ['after', 'Following context'],
    ['boundary', 'Saved branch boundary'],
    ['outside-after', 'Outside saved branch'],
  ]) {
    records.push({
      type: 'message',
      id,
      parentId,
      timestamp: evidence.timestamp,
      message: { role: id === 'reply' ? 'assistant' : 'user', content: text },
    });
    parentId = id!;
  }
  records.push(
    {
      type: 'context_edit',
      id: 'new-edit',
      parentId,
      targetId: 'leaf',
      timestamp: evidence.timestamp,
      replacement: { content: 'Newer replacement' },
    },
    {
      type: 'message',
      id: 'other-branch',
      parentId: null,
      message: { role: 'user', content: 'Wrong branch content' },
    },
  );
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));
  Object.assign(f.proposal.sources[0]!, { file, branchId: 'boundary' });
  return { ...f, file };
}
it('Source shows bounded surrounding messages on the saved branch, not a newer edit', () => {
  const f = sourceFixture();
  const text = sourceText(f.proposal);
  for (const value of [
    'Send comparison',
    'Earlier context',
    'Supporting reply',
    'Following context',
    'Saved branch boundary',
    'assistant',
    'Session: "session"',
    'Branch: "boundary"',
    'Entry: "leaf"',
    'Edit: null',
  ])
    expect(text).toContain(value);
  for (const value of [
    'Outside preceding window',
    'Outside saved branch',
    'Wrong branch content',
    'Newer replacement',
    'unavailable',
  ])
    expect(text).not.toContain(value);
  expect(f.execute).not.toHaveBeenCalled();
});
it('Source caps additional context while always retaining the saved exact quote', () => {
  const f = sourceFixture('x'.repeat(100_000));
  const text = sourceText(f.proposal);
  expect(text).toContain('Send comparison');
  expect(text).toContain('Additional context omitted at the display limit');
  expect(Buffer.byteLength(text)).toBeLessThan(REVIEW_RESPONSE_MAX_BYTES + 1024);
});
it.each([
  'missing',
  'corrupt',
  'session',
  'branch',
  'entry',
  'edit',
  'quote',
  'offset',
  'unreadable',
  'limits',
])('Source retains saved quote and identifiers when %s prevents matching context', (failure) => {
  const f = sourceFixture();
  const source = f.proposal.sources[0]!;
  if (failure === 'missing') rmSync(f.file);
  if (failure === 'corrupt') writeFileSync(f.file, '{bad json');
  if (failure === 'session') source.sessionId = 'different';
  if (failure === 'branch') source.branchId = 'other-branch';
  if (failure === 'entry') source.entryId = 'gone';
  if (failure === 'edit') source.branchId = 'new-edit';
  if (failure === 'quote') source.quote = 'Original saved quote';
  if (failure === 'offset') source.offset = 1;
  if (failure === 'unreadable' || failure === 'limits')
    vi.spyOn(evidenceModule, 'readSession').mockImplementation(() => {
      throw new Error(failure);
    });
  const text = sourceText(f.proposal);
  expect(text).toContain(JSON.stringify(source.quote));
  expect(text).toContain(`Session: ${JSON.stringify(source.sessionId)}`);
  expect(text).toContain(`Branch: ${JSON.stringify(source.branchId)}`);
  expect(text).toContain(`Entry: ${JSON.stringify(source.entryId)}`);
  expect(text).toContain('Extra file context is unavailable');
  expect(text).not.toContain('Local context');
  expect(f.execute).not.toHaveBeenCalled();
});
it('Source accepts the exact saved edit but rejects an edit from another branch', () => {
  const f = sourceFixture();
  Object.assign(f.proposal.sources[0]!, {
    branchId: 'new-edit',
    editId: 'new-edit',
    quote: 'Newer replacement',
  });
  expect(sourceText(f.proposal)).toContain('Local context');
  f.proposal.sources[0]!.branchId = 'boundary';
  expect(sourceText(f.proposal)).toContain('Extra file context is unavailable');
});
it('Enter, Source, paging, edit, navigation and closing do not write tasks; draft persists', async () => {
  const f = setup();
  seed(f.store);
  let calls = 0;
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  const switchSession = vi.fn();
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
      expect(readSource).not.toHaveBeenCalled();
      component.handleInput?.('\r');
      expect(readSource).not.toHaveBeenCalled();
      component.handleInput?.('s');
      expect(readSource).toHaveBeenCalledOnce();
      for (const key of ['\u001b[6~', '\u001b[5~', '\u001b[B']) {
        component.handleInput?.(key);
        component.render(80);
        expect(result).toBeUndefined();
      }
      expect(readSource).toHaveBeenCalledOnce();
      for (const key of ['s', 'e']) component.handleInput?.(key);
    } else if (calls === 2) component.handleInput?.('\u001b[B');
    else component.handleInput?.('\u001b');
    return result;
  });
  const ctx = {
    mode: 'tui',
    ui: { custom, editor, notify: vi.fn() },
    switchSession,
  } as unknown as ExtensionContext;
  await openProposals(ctx, f.store, f.execute);
  expect(editor).toHaveBeenCalledOnce();
  expect(readSource).toHaveBeenCalledOnce();
  expect(switchSession).not.toHaveBeenCalled();
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
it('a failed task preview still shows the saved quote without reading source files', async () => {
  const f = setup(update);
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  type Factory = Parameters<ExtensionContext['ui']['custom']>[0];
  const ctx = {
    mode: 'tui',
    ui: {
      custom: async (factory: Factory) => {
        const component = await factory(
          { requestRender() {} } as Parameters<Factory>[0],
          { fg: (_color: string, text: string) => text } as Parameters<Factory>[1],
          getKeybindings() as Parameters<Factory>[2],
          () => {},
        );
        expect(component.render(120).join('\n')).toContain('Send comparison');
        expect(readSource).not.toHaveBeenCalled();
        return 'close';
      },
    },
  } as unknown as ExtensionContext;
  await openProposals(ctx, f.store, async () => {
    throw new Error('Task unavailable');
  });
  expect(readSource).not.toHaveBeenCalled();
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
it('unresolved questions block claims and writes until an edited draft resolves them', async () => {
  const f = setup({ ...update, question: 'Which obligation?' });
  const preview = await previewProposal(f.store, f.proposal.id, f.execute);
  await expect(applyProposal(f.store, preview, () => 'tui', f.execute)).rejects.toThrow(/question/);
  expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
  f.store.editProposal(f.proposal.id, 1, update);
  await expect(applyProposal(f.store, preview, () => 'tui', f.execute)).rejects.toThrow(
    /Preview changed/,
  );
  const fresh = await previewProposal(f.store, f.proposal.id, f.execute);
  expect((await applyProposal(f.store, fresh, () => 'tui', f.execute)).state).toBe('applied');
});

it('persists the claim and approved snapshot before sending literal typed JSON', async () => {
  const f = setup(update);
  const literal = 'rc.hooks=on +tag "quotes" $(touch nope)';
  f.store.editProposal(f.proposal.id, 1, {
    ...update,
    change: {
      ...update.change,
      operation: 'update',
      targetUuid: uuid,
      fields: { description: literal, tags: ['one', 'two'], depends: [uuid] },
      annotations: ['Quote', 'Quote'],
    },
  });
  f.set({ ...record, custom: 'Retain unknown attributes' });
  const execute: TaskExecutor = async (args, input) => {
    if (input) {
      const claimed = f.store.proposal(f.proposal.id)!;
      expect(claimed.state).toBe('applying');
      expect(claimed.claim).toBeTruthy();
      expect(claimed.applicationBefore).toEqual(snapshot(record));
      expect(args).toEqual(['import', '-']);
      expect(JSON.parse(input)).toMatchObject([
        {
          uuid,
          description: literal,
          custom: 'Retain unknown attributes',
          tags: ['one', 'two'],
          depends: [uuid],
          annotations: [{ description: 'Quote' }],
        },
      ]);
      expect(JSON.parse(input)[0].annotations).toHaveLength(1);
    }
    return f.execute(args, input);
  };
  const result = await applyProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, execute),
    () => 'tui',
    execute,
  );
  expect(result.state).toBe('applied');
  expect(result.result?.actual?.['custom']).toBe('Retain unknown attributes');
});

it.each(['wrong record', 'missing result', 'verification error'])(
  'records uncertainty on %s without trusting import success',
  async (failure) => {
    const f = setup(update);
    let written = false;
    const execute: TaskExecutor = async (args, input) => {
      if (input) {
        written = true;
        return '';
      }
      if (written && failure === 'verification error') throw new Error('export unavailable');
      if (written && failure === 'missing result') return '[]';
      return f.execute(args);
    };
    const result = await applyProposal(
      f.store,
      await previewProposal(f.store, f.proposal.id, execute),
      () => 'tui',
      execute,
    );
    expect(result.state).toBe('uncertain');
    expect(result.result?.error).toBeTruthy();
    await expect(
      applyProposal(
        f.store,
        await previewProposal(f.store, f.proposal.id, f.execute),
        () => 'tui',
        f.execute,
      ),
    ).rejects.toThrow(/cannot be replayed/);
    await expect(
      resolveProposal(
        f.store,
        await previewProposal(f.store, f.proposal.id, f.execute),
        () => 'tui',
        f.execute,
      ),
    ).rejects.toThrow(/No retry performed.*manually/);
    expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
  },
);

it('an import error remains uncertain even when export matches, until explicit read-only resolution', async () => {
  const f = setup(update);
  const execute: TaskExecutor = async (args, input) => {
    const output = await f.execute(args, input);
    if (input) throw new Error('lost success acknowledgement');
    return output;
  };
  const uncertain = await applyProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, execute),
    () => 'tui',
    execute,
  );
  expect(uncertain.state).toBe('uncertain');
  expect(uncertain.result?.actual).toMatchObject({ description: 'After' });
  await expect(
    applyProposal(
      f.store,
      await previewProposal(f.store, f.proposal.id, execute),
      () => 'tui',
      execute,
    ),
  ).rejects.toThrow(/cannot be replayed/);
  const result = await resolveProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, execute),
    () => 'tui',
    execute,
  );
  expect(result.state).toBe('already_satisfied');
  expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
});

it('explicit resolution rechecks the displayed record and never retries an interrupted write', async () => {
  const f = setup(update);
  const claim = f.store.claimProposal(f.proposal.id, 1, snapshot(record));
  expect(claim.state).toBe('applying');
  const preview = await previewProposal(f.store, f.proposal.id, f.execute);
  f.set({
    ...record,
    description: 'After',
    project: '',
    annotations: [{ entry: '20260101T000000Z', description: 'Quote' }],
  });
  await expect(resolveProposal(f.store, preview, () => 'tui', f.execute)).rejects.toThrow(
    /Preview changed/,
  );
  const resolved = await resolveProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, f.execute),
    () => 'tui',
    f.execute,
  );
  expect(resolved.state).toBe('already_satisfied');
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
});

it('completes the exact target while retaining existing annotations and attributes', async () => {
  const f = setup({
    change: { operation: 'complete', targetUuid: uuid, annotations: ['Quote'] },
    expected: snapshot(record),
    question: null,
  });
  f.set({
    ...record,
    custom: 'Keep',
    annotations: [{ entry: '20260101T000000Z', description: 'Existing' }],
  });
  const result = await applyProposal(
    f.store,
    await previewProposal(f.store, f.proposal.id, f.execute),
    () => 'tui',
    f.execute,
  );
  expect(result.state).toBe('applied');
  expect(result.result?.actual).toMatchObject({
    uuid,
    status: 'completed',
    custom: 'Keep',
    annotations: [{ description: 'Existing' }, { description: 'Quote' }],
  });
});

it('preview shows the actual target and changed project, not the old extraction snapshot', async () => {
  const f = setup({
    ...update,
    change: { operation: 'update', targetUuid: uuid, fields: { waitingon: null }, annotations: [] },
  });
  f.set({
    ...record,
    project: 'Current project',
    description: 'Actual description',
    waitingon: 'Actual prerequisite',
    custom: 'Visible attribute',
  });
  const text = previewText(await previewProposal(f.store, f.proposal.id, f.execute));
  expect(text).toContain('Project: "Current project"');
  expect(text).toContain('Actual description');
  expect(text).toContain('waitingon: "Actual prerequisite" -> null');
  expect(text).toContain('Visible attribute');
});

// Drive the actual component input handler with fake terminal and Taskwarrior effects.
function uiContext(
  actions: (
    component: Awaited<ReturnType<Parameters<ExtensionContext['ui']['custom']>[0]>>,
    index: number,
  ) => void,
  editor = vi.fn(),
) {
  type Factory = Parameters<ExtensionContext['ui']['custom']>[0];
  let index = 0;
  const custom = vi.fn(async (factory: Factory) => {
    let result: unknown;
    const component = await factory(
      { requestRender() {} } as Parameters<Factory>[0],
      { fg: (_color: string, text: string) => text } as Parameters<Factory>[1],
      getKeybindings() as Parameters<Factory>[2],
      (value) => {
        result = value;
      },
    );
    component.render(120);
    actions(component, index++);
    if (result === undefined) throw new Error('Test must deliberately close or navigate the UI');
    return result;
  });
  return { mode: 'tui', ui: { custom, editor, notify: vi.fn() } } as unknown as ExtensionContext;
}

it('only per-item Ctrl+A applies, with no Enter, history, Source or accept-all writes', async () => {
  const f = setup();
  seed(f.store);
  const reads = vi.spyOn(evidenceModule, 'readSession');
  const ctx = uiContext((component, index) => {
    if (index === 0) {
      component.handleInput?.('\r');
      component.handleInput?.('a');
      component.handleInput?.('h');
      expect(component.render(120).join('\n')).toContain('Saved proposal and revision history');
      component.handleInput?.('\u0001');
      expect(f.execute).not.toHaveBeenCalled();
      component.handleInput?.('s');
      component.handleInput?.('\u0001');
      component.handleInput?.('\r');
      expect(f.execute).not.toHaveBeenCalled();
      component.handleInput?.('\u001b');
      component.handleInput?.('\u0001');
    } else component.handleInput?.('\u001b');
  });
  await openProposals(ctx, f.store, f.execute);
  expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
  expect(f.store.proposals('applied')).toHaveLength(1);
  expect(f.store.proposals('pending')).toHaveLength(1);
  expect(reads).toHaveBeenCalledOnce();
});

it('UI stale task approval refreshes the exact preview and requires another Ctrl+A', async () => {
  const f = setup(update);
  const ctx = uiContext((component, index) => {
    if (index === 0) {
      f.set({ ...record, description: 'Changed outside Pi' });
      component.handleInput?.('\u0001');
    } else if (index === 1) {
      // Scroll to the footer-independent full rendered preview across detail pages.
      const pages = [component.render(120).join('\n')];
      component.handleInput?.('\u001b[6~');
      pages.push(component.render(120).join('\n'));
      expect(pages.join('\n')).toContain('Changed outside Pi');
      expect(pages.join('\n')).toContain('Preview changed');
      expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
      component.handleInput?.('\u0001');
    } else component.handleInput?.('\u001b');
  });
  await openProposals(ctx, f.store, f.execute);
  expect(f.store.proposal(f.proposal.id)?.state).toBe('applied');
  expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
});

it('Dismiss changes just the displayed proposal; edit cancellation and history never apply', async () => {
  const f = setup();
  seed(f.store);
  let dismissedId: string | undefined;
  const editor = vi.fn(async () => undefined);
  const ctx = uiContext((component, index) => {
    if (index === 0) component.handleInput?.('e');
    else if (index === 1) {
      component.handleInput?.('h');
      component.handleInput?.('\u0001');
      component.handleInput?.('\u001b');
      component.handleInput?.('d');
    } else {
      dismissedId = f.store.proposals('dismissed')[0]?.id;
      component.handleInput?.('\u001b');
    }
  }, editor);
  await openProposals(ctx, f.store, f.execute);
  expect(editor).toHaveBeenCalledOnce();
  expect(dismissedId).toBeTruthy();
  expect(f.store.proposals('dismissed')).toHaveLength(1);
  expect(f.store.proposals('pending')).toHaveLength(1);
  expect(f.execute).not.toHaveBeenCalled();
});

it('History exposes saved and edited revisions with quotes, without source or task writes', async () => {
  const f = setup();
  f.store.editProposal(f.proposal.id, 1, {
    change: { operation: 'add', fields: { description: 'Edited draft' }, annotations: [] },
    expected: null,
    question: null,
  });
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  const ctx = uiContext((component) => {
    component.handleInput?.('h');
    const pages: string[] = [];
    for (let page = 0; page < 30; page++) {
      pages.push(component.render(100).join('\n'));
      component.handleInput?.('\u001b[6~');
    }
    const text = pages.join('\n');
    expect(text).toContain('Edited draft');
    expect(text).toContain('Send comparison');
    expect(text).toContain('"revision": 1');
    expect(text).toContain('"revision": 2');
    expect(text).toContain('Promised');
    component.handleInput?.('\r');
    component.handleInput?.('\u0001');
    component.handleInput?.('\u001b');
    component.handleInput?.('\u001b');
  });
  await openProposals(ctx, f.store, f.execute);
  expect(readSource).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
});

it('Ctrl+A on an unresolved claim only verifies an already-present task result', async () => {
  const f = setup();
  const claim = f.store.claimProposal(f.proposal.id, 1, null);
  f.set({
    uuid: claim.claim!,
    status: 'pending',
    description: 'Send comparison',
    project: 'work',
    annotations: [{ entry: '20260101T000000Z', description: 'Saved context' }],
  });
  const ctx = uiContext((component, index) => {
    component.handleInput?.(index === 0 ? '\u0001' : '\u001b');
  });
  await openProposals(ctx, f.store, f.execute);
  expect(f.store.proposal(f.proposal.id)?.state).toBe('already_satisfied');
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
});

it('missing target cannot be claimed or applied even after deliberate approval', async () => {
  const f = setup(update);
  f.set(null);
  const preview = await previewProposal(f.store, f.proposal.id, f.execute);
  expect(previewText(preview)).toContain('Apply disabled: target missing');
  await expect(applyProposal(f.store, preview, () => 'tui', f.execute)).rejects.toThrow(/missing/);
  expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
});

it('quotes terminal controls reversibly in previews, Source, History and the draft editor', async () => {
  const f = sourceFixture('Context \u009b31m');
  const hostile = 'Quoted \u001b[31m and \u009b31m';
  f.store.editProposal(f.proposal.id, 1, {
    change: { operation: 'add', fields: { description: hostile }, annotations: [] },
    expected: null,
    question: null,
  });
  const text = previewText(await previewProposal(f.store, f.proposal.id, f.execute));
  expect(text).toContain('\\u001b[31m');
  expect(text).toContain('\\u009b31m');
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\u009b');
  const context = sourceText(f.proposal);
  expect(context).toContain('Context \\u009b31m');
  expect(context).not.toContain('\u009b');
  const editor = vi.fn(async (_title: string, initial: string) => {
    expect(JSON.parse(initial).change.fields.description).toBe(hostile);
    expect(initial).not.toContain('\u009b');
    return undefined;
  });
  const ctx = uiContext((component, index) => {
    if (index === 0) {
      component.handleInput?.('h');
      const history = component.render(120).join('\n');
      expect(history).not.toContain('\u001b');
      expect(history).not.toContain('\u009b');
      component.handleInput?.('\u001b');
      component.handleInput?.('e');
    } else component.handleInput?.('\u001b');
  }, editor);
  await openProposals(ctx, f.store, f.execute);
  expect(editor).toHaveBeenCalledOnce();
  expect(f.execute).not.toHaveBeenCalled();
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
