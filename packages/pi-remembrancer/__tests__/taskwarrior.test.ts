import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings, type Terminal, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import { openProposals, previewText, sourceText } from '../extensions/remembrancer/proposal-ui.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { captureJob } from './fixtures/capture-job.js';
import type { Evidence } from '../extensions/remembrancer/evidence.js';
import * as evidenceModule from '../extensions/remembrancer/evidence.js';
import {
  REVIEW_RESPONSE_MAX_BYTES,
  serializedResponse,
} from '../extensions/remembrancer/review-pages.js';
import type { Proposal, ProposalDraft } from '../extensions/remembrancer/proposals.js';
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
  saved: { explanation?: string; quote?: string } = {},
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
        message: { role: 'user', content: saved.quote ?? evidence.text },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n'),
  );
  const { owner, attempt, review } = captureJob(store, { file, sessionId });
  while (review.page()['hasMore']) {
    /* deliver all evidence */
  }
  const proposal = store.finishCaptureJob(owner, attempt, [
    {
      ...draft,
      explanation: saved.explanation ?? 'Promised',
      references: [
        {
          sessionId,
          branchId: 'leaf',
          entryId: 'leaf',
          editId: null,
          offset: 0,
          quote: saved.quote ?? 'Send comparison',
        },
      ],
    },
  ])[0]!;
  owner.release();
  rmSync(file);
  return proposal;
}
function durableStore() {
  const dir = mkdtempSync(join(tmpdir(), 'task-proposals-'));
  sourceDirs.push(dir);
  return new CheckpointStore(join(dir, 'index.sqlite'));
}
function setup(draft?: ProposalDraft) {
  const store = durableStore();
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
it('expanded evidence stays bounded with many huge sources while proposed writes remain exact', async () => {
  const f = setup(update);
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  const preview = await previewProposal(f.store, f.proposal.id, f.execute);
  const original = previewText(preview);
  const supportingQuote = 'Supporting passage '.repeat(20_000);
  const laterQuote = 'HIDDEN_LATER_QUOTE'.repeat(20_000);
  const sources = Array.from({ length: 10_000 }, (_, index) => ({
    ...f.proposal.sources[0]!,
    entryId: `entry-${index}`,
    quote: index === 0 ? supportingQuote : laterQuote,
  }));
  const text = previewText({ ...preview, proposal: { ...preview.proposal, sources } });
  expect(text).toContain('Evidence: 10000 saved reference(s)');
  expect(text).toContain('Supporting quote (shortened)');
  expect(text).toContain('…');
  expect(text).not.toContain('HIDDEN_LATER_QUOTE');
  expect(text.length).toBeLessThan(original.length + 500);
  expect(text.split('Evidence:')[0]).toBe(original.split('Evidence:')[0]);
  expect(readSource).not.toHaveBeenCalled();
});

it('saved huge quote fragments reconstruct exact Unicode and controls without the original transcript', () => {
  const f = setup();
  const quote = 'x'.repeat(2047) + '😀' + '中é\n"\\\u0000\u001b\u009b'.repeat(12_000);
  const proposal = {
    ...f.proposal,
    sources: [{ ...f.proposal.sources[0]!, offset: 17, quote }],
  };
  const fragments: string[] = [];
  let end = 0;
  for (let page = 0; end < quote.length; page++) {
    const text = sourceText(proposal, 0, page);
    expect(terminalControls(text)).toEqual([]);
    expect(text).toContain('Extra file context is unavailable');
    expect(text).toContain('Excerpt offset: 17');
    const range = text.match(/quote units (\d+)-(\d+)\//)!;
    expect(Number(range[1])).toBe(end);
    end = Number(range[2]);
    const fragment = JSON.parse(
      text.split('Saved quote fragment (JSON, exact):\n')[1]!.split('\n')[0]!,
    ) as string;
    expect(fragment.length).toBeLessThanOrEqual(2049);
    expect(fragment.charCodeAt(0) >= 0xdc00 && fragment.charCodeAt(0) <= 0xdfff).toBe(false);
    expect(
      fragment.charCodeAt(fragment.length - 1) >= 0xd800 &&
        fragment.charCodeAt(fragment.length - 1) <= 0xdbff,
    ).toBe(false);
    expect(fragment).toBe(quote.slice(Number(range[1]), end));
    fragments.push(fragment);
    expect(text.length).toBeLessThan(15_000);
  }
  expect(fragments.join('')).toBe(quote);
  expect(f.execute).not.toHaveBeenCalled();
});

function sourceFixture(before = 'Earlier context', quote = evidence.text) {
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
    ['leaf', quote],
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
  Object.assign(f.proposal.sources[0]!, { file, branchId: 'boundary', quote });
  return { ...f, file };
}
it('Source shows bounded surrounding messages on the saved branch, not a newer edit', () => {
  const hostile = 'Earlier context\u001b[31m\u009b31m\u009dtitle\u0007\r\t\b';
  const f = sourceFixture(hostile);
  const text = sourceText(f.proposal);
  expect(terminalControls(text)).toEqual([]);
  expect(text).toContain('Earlier context\\u001b[31m\\u009b31m\\u009dtitle\\u0007\\r\\t\\b');
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
it('optional transcript context includes only the displayed fragment of a huge saved quote', () => {
  const quote = 'FIRST_PAGE' + 'x'.repeat(2048 - 'FIRST_PAGE'.length) + 'SECOND_PAGE';
  const f = sourceFixture('Earlier context', quote);
  const reads = vi.spyOn(evidenceModule, 'readSession');
  const text = sourceText(f.proposal, 0, 1);
  expect(text).toContain('SECOND_PAGE');
  expect(text).not.toContain('FIRST_PAGE');
  expect(text).toContain('Earlier context');
  expect(text).toContain('Local context');
  expect(reads).toHaveBeenCalledOnce();
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
it('Enter, Source, paging, edit, navigation and closing never authorize task writes', async () => {
  const f = setup();
  seed(f.store);
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  const editor = vi.fn(async () =>
    JSON.stringify({
      change: { operation: 'add', fields: { description: 'Edited' }, annotations: ['Link'] },
      expected: null,
      question: null,
    }),
  );
  await driveUI(
    f.store,
    f.execute,
    async (screen) => {
      expect(readSource).not.toHaveBeenCalled();
      await screen.press(keys.enter);
      expect(readSource).not.toHaveBeenCalled();
      await screen.press('s');
      expect(readSource).toHaveBeenCalledOnce();
      await screen.press(keys.pageDown);
      await screen.press(keys.pageUp);
      await screen.press(keys.escape);
      await screen.press('e');
      expect(editor).toHaveBeenCalledOnce();
      await screen.press(keys.down);
      await screen.press(keys.enter);
      expect(readSource).toHaveBeenCalledOnce();
    },
    { editor },
  );
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

it('a failed task preview retains saved rationale and quotes without reading sources', async () => {
  const f = setup(update);
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  const execute = vi.fn<TaskExecutor>(async () => {
    throw new Error('Task unavailable');
  });
  await driveUI(f.store, execute, async (screen) => {
    await screen.press(keys.enter);
    const text = await screen.pages();
    for (const value of ['Task unavailable', 'Send comparison', 'Promised'])
      expect(text).toContain(value);
    expect(readSource).not.toHaveBeenCalled();
    await screen.press(keys.apply);
    expect(await screen.pages()).toContain('Task unavailable');
    expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
  });
  expect(execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
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
it.each(['short', 'unicode', 'escaped'])(
  'paginates %s task records within the byte limit without dropping data',
  async (kind) => {
    const description =
      kind === 'short' ? 'Note' : kind === 'unicode' ? '🙂'.repeat(2000) : '"\\\n'.repeat(1500);
    const records = Array.from({ length: 53 }, (_, index) => ({
      ...record,
      uuid: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
      annotations: [{ entry: '20261101T000000Z', description }],
      custom: 'Preserve unknown fields',
    }));
    const execute = vi.fn<TaskExecutor>().mockResolvedValue(JSON.stringify(records));
    const restored: TaskRecord[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await lookupTasks({ status: 'pending', offset }, execute);
      expect(Buffer.byteLength(serializedResponse(page), 'utf8')).toBeLessThanOrEqual(
        REVIEW_RESPONSE_MAX_BYTES,
      );
      expect(page.tasks.length).toBeGreaterThan(0);
      expect(page.tasks.length).toBeLessThanOrEqual(50);
      if (offset === 0) {
        if (kind === 'short') expect(page.tasks).toHaveLength(50);
        else expect(page.tasks.length).toBeLessThan(50);
      }
      restored.push(...page.tasks);
      expect(page.nextOffset).toBe(restored.length < records.length ? restored.length : null);
      offset = page.nextOffset;
    }
    expect(restored).toEqual(records);
    expect(execute).toHaveBeenCalledWith(['status:pending', 'export']);
    expect(await lookupTasks({ offset: records.length }, execute)).toEqual({
      tasks: [],
      nextOffset: null,
    });
  },
);

it('identifies a single task that cannot fit rather than truncating or skipping it', async () => {
  const oversized = {
    ...record,
    uuid: '00000000-0000-0000-0000-000000000002',
    description: 'x'.repeat(REVIEW_RESPONSE_MAX_BYTES),
  };
  const execute = vi.fn<TaskExecutor>().mockResolvedValue(JSON.stringify([record, oversized]));
  expect(await lookupTasks({}, execute)).toEqual({ tasks: [record], nextOffset: 1 });
  await expect(lookupTasks({ offset: 1 }, execute)).rejects.toThrow(
    `Task ${oversized.uuid} cannot fit within the ${REVIEW_RESPONSE_MAX_BYTES}-byte response limit`,
  );
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
    custom: 'Unchanged custom attribute',
    annotations: [{ entry: '20260101T000000Z', description: 'Unchanged annotation' }],
  });
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    const text = (await screen.pages()).replace(/[\s│█]/gu, '');
    for (const line of [
      'Current description: "Actual description"',
      'Project: "Current project" (current)',
      'Saved fallback description (not current): "Before"',
      'Saved fallback project (not current): "work"',
      'waitingon: "Actual prerequisite" -> null',
    ])
      expect(text).toContain(line.replace(/\s/gu, ''));
    for (const omitted of [
      'Unchanged annotation',
      'Unchanged custom attribute',
      '"uuid":',
      '"annotations":',
    ])
      expect(text).not.toContain(omitted.replace(/\s/gu, ''));
  });
});

const keys = {
  enter: '\r',
  escape: '\u001b',
  up: '\u001b[A',
  down: '\u001b[B',
  pageDown: '\u001b[6~',
  pageUp: '\u001b[5~',
  left: '\u001b[D',
  right: '\u001b[C',
  apply: '\u0001',
};
type UIFactory = Parameters<ExtensionContext['ui']['custom']>[0];
type UIComponent = Awaited<ReturnType<UIFactory>>;

// Model custom() ownership, including done -> editor -> a fresh custom instance.
// Use Pi's overlay layout with a no-op terminal, never a Taskwarrior process or personal store.
async function driveUI(
  store: CheckpointStore,
  execute: TaskExecutor,
  actions: (screen: {
    lines(): string[];
    text(): string;
    press(key: string, paint?: boolean): Promise<void>;
    pages(): Promise<string>;
    resize(columns: number, rows: number): void;
    active(): boolean;
    custom: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  options: {
    columns?: number;
    rows?: number;
    editor?: (title: string, initial: string) => Promise<string | undefined>;
  } = {},
) {
  const terminal = {
    columns: options.columns ?? 80,
    rows: options.rows ?? 32,
    write() {},
    hideCursor() {},
  };
  const tui = new TuiMainScreen(terminal as unknown as Terminal);
  vi.spyOn(tui, 'requestRender').mockImplementation(() => {});
  let rendered: string[] = [];
  let active: UIComponent | undefined;
  let finished = false;
  const custom = vi.fn(
    async (factory: UIFactory, _options?: Parameters<ExtensionContext['ui']['custom']>[1]) => {
      let complete!: (value: unknown) => void;
      const result = new Promise((resolve) => {
        complete = resolve;
      });
      active = await factory(
        tui,
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as Parameters<UIFactory>[1],
        getKeybindings() as Parameters<UIFactory>[2],
        (value) => {
          handle.hide();
          active = undefined;
          complete(value);
        },
      );
      const component = active;
      const handle = tui.showOverlay(
        {
          render(width) {
            rendered = component.render(width);
            return rendered;
          },
          invalidate: () => component.invalidate(),
        },
        typeof _options?.overlayOptions === 'function'
          ? _options.overlayOptions()
          : _options?.overlayOptions,
      );
      return result;
    },
  );
  const ctx = {
    mode: 'tui',
    ui: { custom, editor: options.editor ?? vi.fn(async () => undefined), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const running = openProposals(ctx, store, execute).finally(() => {
    finished = true;
  });
  // Attach immediately so a failed asynchronous service does not become unhandled.
  void running.catch(() => {});
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const screen = {
    lines() {
      expect(active, 'an overlay must own input').toBeDefined();
      tui.renderNow();
      return rendered;
    },
    text() {
      return this.lines().join('\n');
    },
    async press(key: string, paint = true) {
      expect(active, 'keys must be delivered only to the active custom component').toBeDefined();
      if (paint) tui.renderNow();
      active!.handleInput?.(key);
      await settle();
      if (active) tui.renderNow();
    },
    async pages() {
      const pages = [this.text()];
      // Stop at the observable lower endpoint, not at a guessed content length.
      for (let page = 0; page < 200; page++) {
        await this.press(keys.pageDown);
        const next = this.text();
        if (next === pages.at(-1)) return pages.join('\n');
        pages.push(next);
      }
      throw new Error('Paging did not reach a stable lower endpoint');
    },
    resize(columns: number, rows: number) {
      Object.assign(terminal, { columns, rows });
      active?.invalidate();
    },
    active: () => active !== undefined,
    custom,
  };
  await settle();
  try {
    await actions(screen);
  } finally {
    // Escape unwinds inspection, Source/History and expansion before closing Inbox.
    for (let level = 0; level < 8 && !finished; level++) {
      if (active) await screen.press(keys.escape);
      else await settle();
    }
    await vi.waitFor(() => expect(finished, 'all custom interactions must close').toBe(true));
    await running;
  }
}

it.each([
  { fields: { project: null }, label: '(no project)', beforeAnchor: true },
  { fields: {}, label: 'work', beforeAnchor: false },
  { fields: { project: 'home' }, label: 'home', beforeAnchor: true },
])('Inbox groups project $label without falling back on explicit null', async (test) => {
  for (const edited of [false, true]) {
    const draft: ProposalDraft = {
      ...update,
      change: { operation: 'update', targetUuid: uuid, fields: test.fields, annotations: [] },
    };
    const f = setup(edited ? update : draft);
    if (edited) f.store.editProposal(f.proposal.id, f.proposal.revision, draft);
    seed(f.store, {
      change: {
        operation: 'add',
        fields: { description: 'Grouping anchor', project: 'review' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    await driveUI(f.store, f.execute, async (screen) => {
      const text = screen.text();
      const updateIndex = text.indexOf(test.label);
      const anchorIndex = text.indexOf('review');
      expect(updateIndex, text).toBeGreaterThanOrEqual(0);
      expect(anchorIndex, text).toBeGreaterThanOrEqual(0);
      expect(updateIndex < anchorIndex).toBe(test.beforeAnchor);
    });
    expect(f.execute).not.toHaveBeenCalled();
  }
});

it('empty Inbox still opens an overlay with History and Close', async () => {
  const store = durableStore();
  stores.push(store);
  const execute = vi.fn<TaskExecutor>();
  await driveUI(store, execute, async (screen) => {
    expect(screen.custom.mock.calls[0]?.[1]).toMatchObject({ overlay: true });
    expect(screen.text()).toMatch(/inbox/i);
    expect(screen.text()).toMatch(/history/i);
    expect(screen.text()).toMatch(/close/i);
    await screen.press('h');
    expect(screen.text()).toMatch(/history/i);
    await screen.press(keys.escape);
    expect(screen.active()).toBe(true);
  });
  expect(execute).not.toHaveBeenCalled();
});

it('one item opens collapsed; collapsed Ctrl+A reviews and only another Ctrl+A authorizes', async () => {
  const f = setup(update);
  await driveUI(f.store, f.execute, async (screen) => {
    expect(screen.custom.mock.calls[0]?.[1]).toMatchObject({ overlay: true });
    expect(f.execute).not.toHaveBeenCalled();
    expect(screen.text()).not.toContain(uuid);
    await screen.press(keys.up);
    await screen.press(keys.down);
    expect(f.execute).not.toHaveBeenCalled();
    await screen.press(keys.apply);
    expect(await screen.pages()).toContain(uuid);
    expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(0);
    // Reopen the review and approve at its top. Scrolling is not authorization.
    await screen.press(keys.escape);
    await screen.press(keys.enter);
    await screen.press(keys.apply);
    expect(f.store.proposal(f.proposal.id)?.state).toBe('applied');
    expect(screen.text()).toMatch(/applied/i);
    expect(screen.text()).toMatch(/history/i);
    expect(screen.text()).toMatch(/close/i);
  });
  expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
});

it('focus collapses the previous review, resets paging, and boundary arrows do nothing', async () => {
  const f = setup({
    ...update,
    change: {
      ...update.change,
      operation: 'update',
      targetUuid: uuid,
      fields: { description: 'First', project: 'a' },
    },
  });
  seed(f.store, {
    ...update,
    change: {
      operation: 'update',
      targetUuid: uuid,
      fields: { description: 'Second', project: 'b' },
      annotations: [],
    },
  });
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    const first = screen.text();
    const reads = f.execute.mock.calls.length;
    await screen.press(keys.up);
    expect(screen.text()).toBe(first);
    expect(f.execute).toHaveBeenCalledTimes(reads);
    await screen.press(keys.pageDown);
    await screen.press(keys.down);
    expect(screen.text()).not.toContain(uuid);
    expect(f.execute).toHaveBeenCalledTimes(reads);
    await screen.press(keys.enter);
    const second = screen.text();
    expect(await screen.pages()).toContain('Second');
    // Return to the top without changing focus, then test the lower boundary.
    for (let n = 0; n < 20; n++) await screen.press(keys.pageUp);
    expect(screen.text()).toBe(second);
    const secondReads = f.execute.mock.calls.length;
    await screen.press(keys.down);
    expect(screen.text()).toBe(second);
    expect(f.execute).toHaveBeenCalledTimes(secondReads);
    await screen.press(keys.up);
    expect(screen.text()).not.toContain(uuid);
    await screen.press(keys.enter);
    expect(screen.text()).toBe(first);
  });
  expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(0);
});

it('Inbox partitions every durable state from decided History and uses two-line collapsed rows', async () => {
  const draft = (state: string): ProposalDraft => ({
    change: {
      operation: 'add',
      fields: { description: 'TITLE_' + state, project: 'work' },
      annotations: [],
    },
    expected: null,
    question: null,
  });
  const f = setup(draft('pending'));
  const pending = f.proposal;
  const applying = f.store.claimProposal(seed(f.store, draft('applying')).id, 1, null);
  const uncertain = f.store.claimProposal(seed(f.store, draft('uncertain')).id, 1, null);
  f.store.recordProposalResult(uncertain.id, uncertain.revision, uncertain.claim!, {
    state: 'uncertain',
    verified: null,
    actual: null,
    error: 'Saved unresolved failure',
  });
  const dismissed = seed(f.store, draft('dismissed'));
  f.store.dismissProposal(dismissed.id, 1);
  for (const state of ['applied', 'already_satisfied'] as const) {
    const claimed = f.store.claimProposal(seed(f.store, draft(state)).id, 1, null);
    f.store.recordProposalResult(claimed.id, claimed.revision, claimed.claim!, {
      state,
      verified: snapshot({ ...record, uuid: claimed.claim! }),
      error: null,
    });
  }
  await driveUI(f.store, f.execute, async (screen) => {
    const lines = screen.lines();
    for (const state of ['pending', 'applying', 'uncertain']) {
      const row = lines.findIndex((line) => line.includes('TITLE_' + state));
      expect(row, lines.join('\n')).toBeGreaterThanOrEqual(0);
      expect(lines[row + 1]).toContain('work');
      expect(lines[row + 1]).toMatch(/add|create/i);
    }
    for (const state of ['dismissed', 'applied', 'already_satisfied'])
      expect(screen.text()).not.toContain('TITLE_' + state);
    await screen.press('h');
    const history = await screen.pages();
    expect(history).toMatch(/decided/i);
    for (const state of ['dismissed', 'applied', 'already_satisfied'])
      expect(history).toContain('TITLE_' + state);
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(pending.state).toBe('pending');
  expect(applying.state).toBe('applying');
});

it('collapsed ordering is project, creation time, then ID, independent of provider order', async () => {
  const f = setup();
  const make = (id: string, project: string, createdAt: string): Proposal => ({
    ...f.proposal,
    id,
    createdAt,
    change: { operation: 'add', fields: { description: 'ROW_' + id, project }, annotations: [] },
  });
  const ordered = [
    make('a', 'alpha', '2026-01-01'),
    make('b', 'alpha', '2026-01-01'),
    make('c', 'alpha', '2026-01-02'),
    make('d', 'beta', '2025-01-01'),
  ];
  vi.spyOn(f.store, 'proposals').mockImplementation((_state, offset = 0, limit = 100) =>
    [...ordered].reverse().slice(offset, offset + limit),
  );
  await driveUI(f.store, f.execute, async (screen) => {
    const text = screen.text();
    const positions = ordered.map((p) => text.indexOf('ROW_' + p.id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (let i = 0; i < 10; i++) await screen.press(keys.down);
    for (let i = 0; i < 10; i++) await screen.press(keys.up);
  });
  expect(f.execute).not.toHaveBeenCalled();
});

it('collapsed navigation reveals the focused row in a queue taller than the overlay', async () => {
  const f = setup(update);
  const proposals: Proposal[] = Array.from({ length: 24 }, (_, index) => ({
    ...f.proposal,
    id: 'queue-' + index.toString().padStart(2, '0'),
    change: {
      operation: 'update',
      targetUuid: uuid,
      fields: {
        description: 'QUEUE_' + index.toString().padStart(2, '0'),
        project: 'work',
      },
      annotations: [],
    },
  }));
  vi.spyOn(f.store, 'proposals').mockImplementation((_state, offset = 0, limit = 100) =>
    proposals.slice(offset, offset + limit),
  );
  await driveUI(
    f.store,
    f.execute,
    async (screen) => {
      for (let index = 0; index < proposals.length; index++) {
        const lines = screen.lines();
        expect(lines.join('\n')).toContain('QUEUE_' + index.toString().padStart(2, '0'));
        expect(lines.length).toBeLessThanOrEqual(22);
        expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
        expect(lines.join('\n')).toMatch(/history/i);
        if (index < proposals.length - 1) await screen.press(keys.down);
      }
      const last = screen.text();
      await screen.press(keys.down);
      expect(screen.text()).toBe(last);
      for (let index = 1; index < proposals.length; index++) await screen.press(keys.up);
      expect(screen.text()).toContain('QUEUE_00');
    },
    { columns: 48, rows: 24 },
  );
  expect(f.execute).not.toHaveBeenCalled();
});

it.each([
  {
    position: 'above viewport',
    columns: 48,
    selectedIndex: 0,
    page: keys.pageDown,
    resize: null,
    reveal: true,
  },
  {
    position: 'below viewport',
    columns: 48,
    selectedIndex: 23,
    page: keys.pageUp,
    resize: null,
    reveal: true,
  },
  {
    position: 'hidden by resize',
    columns: 48,
    selectedIndex: 6,
    page: null,
    resize: { columns: 40, rows: 20 },
    reveal: true,
  },
  {
    position: 'visible after resize',
    columns: 48,
    selectedIndex: 0,
    page: keys.pageDown,
    resize: { columns: 48, rows: 80 },
    reveal: false,
  },
  {
    position: 'visible after widening',
    columns: 40,
    selectedIndex: 6,
    page: keys.pageUp,
    resize: { columns: 100, rows: 24 },
    reveal: false,
  },
])('collapsed d uses current visibility for selection $position', async (test) => {
  const draft = (index: number): ProposalDraft => ({
    ...update,
    change: {
      operation: 'update',
      targetUuid: uuid,
      fields: {
        description: 'Q' + index.toString().padStart(2, '0'),
        project: 'queue-' + index.toString().padStart(2, '0'),
      },
      annotations: [],
    },
  });
  const f = setup(draft(0));
  const proposals = [
    f.proposal,
    ...Array.from({ length: 23 }, (_, index) => seed(f.store, draft(index + 1))),
  ];
  const selected = proposals[test.selectedIndex]!;
  const before = f.store.proposals();
  const title = 'Q' + test.selectedIndex.toString().padStart(2, '0');
  const dismiss = vi.spyOn(f.store, 'dismissProposal');
  await driveUI(
    f.store,
    f.execute,
    async (screen) => {
      for (let index = 0; index < test.selectedIndex; index++) await screen.press(keys.down);
      expect(screen.text()).toContain(title);
      if (test.page) {
        await screen.press(test.page);
        expect(screen.text()).not.toContain(title);
      }
      if (test.resize) screen.resize(test.resize.columns, test.resize.rows);
      expect(f.execute).not.toHaveBeenCalled();

      // A resize may reach input before the next paint.
      await screen.press('d', false);
      if (test.reveal) {
        expect(dismiss, 'first d must only reveal the offscreen selection').not.toHaveBeenCalled();
        expect(f.store.proposals()).toEqual(before);
        const lines = screen.lines();
        const row = lines.findIndex((line) => line.includes(title));
        expect(row).toBeGreaterThanOrEqual(0);
        expect(lines[row + 1]).toMatch(/[█│]│$/u);
        expect(f.store.proposal(selected.id)?.state).toBe('pending');
        expect(f.execute).not.toHaveBeenCalled();

        await screen.press('d');
      }
      expect(dismiss.mock.calls).toEqual([[selected.id, selected.revision]]);
      expect(f.store.proposals('dismissed').map((proposal) => proposal.id)).toEqual([selected.id]);
      expect(f.store.proposals('pending')).toHaveLength(proposals.length - 1);
      expect(f.execute).not.toHaveBeenCalled();
    },
    { columns: test.columns, rows: 24 },
  );
});

it.each(['different item', 'same item, newer expansion'])(
  'ignores an obsolete asynchronous preview for %s',
  async (target) => {
    const f = setup({
      ...update,
      change: {
        operation: 'update',
        targetUuid: uuid,
        fields: { description: 'First', project: 'a' },
        annotations: [],
      },
    });
    seed(f.store, {
      ...update,
      change: {
        operation: 'update',
        targetUuid: uuid,
        fields: { description: 'Second', project: 'b' },
        annotations: [],
      },
    });
    let release!: (value: string) => void;
    const late = new Promise<string>((resolve) => {
      release = resolve;
    });
    const execute = vi
      .fn<TaskExecutor>()
      .mockImplementationOnce(() => late)
      .mockResolvedValue(JSON.stringify([{ ...record, description: 'FRESH_CURRENT_TASK' }]));
    await driveUI(f.store, execute, async (screen) => {
      try {
        await screen.press(keys.enter);
        expect(execute).toHaveBeenCalledOnce();
        if (target === 'different item') await screen.press(keys.down);
        else await screen.press(keys.escape);
        await screen.press(keys.enter);
        expect(await screen.pages()).toContain('FRESH_CURRENT_TASK');
      } finally {
        release(JSON.stringify([{ ...record, description: 'OBSOLETE_CURRENT_TASK' }]));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let i = 0; i < 20; i++) await screen.press(keys.pageUp);
      const current = await screen.pages();
      expect(current).not.toContain('OBSOLETE_CURRENT_TASK');
      expect(current).toContain('FRESH_CURRENT_TASK');
    });
    expect(execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
  },
);

it('saved rationale and exact quotes are reachable before Source, even with missing files', async () => {
  const f = setup(update);
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    const review = await screen.pages();
    expect(review).toContain('Promised');
    expect(review).toContain('Send comparison');
    expect(readSource).not.toHaveBeenCalled();
    await screen.press('s');
    const source = await screen.pages();
    expect(source).toContain('Send comparison');
    expect(source).toMatch(/unavailable/i);
    expect(readSource).toHaveBeenCalledOnce();
  });
});

it.each([false, true])(
  'pending dismissal (expanded=%s) changes no task and selects a collapsed successor',
  async (expanded) => {
    const f = setup({
      change: { operation: 'add', fields: { description: 'First', project: 'a' }, annotations: [] },
      expected: null,
      question: null,
    });
    const next = seed(f.store, {
      change: {
        operation: 'add',
        fields: { description: 'Successor', project: 'b' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    const dismiss = vi.spyOn(f.store, 'dismissProposal');
    await driveUI(f.store, f.execute, async (screen) => {
      if (expanded) {
        screen.resize(80, 24);
        await screen.press(keys.enter);
        const headerRow = screen.lines().findIndex((line) => line.includes('First'));
        const before = screen.text();
        await screen.press(keys.pageDown);
        expect(screen.text()).not.toBe(before);
        expect(screen.lines()[headerRow]).toContain('First');
      }
      expect(screen.text()).toMatch(/d\b[^\n]*dismiss/i);
      await screen.press('d');
      expect(dismiss).toHaveBeenCalledWith(f.proposal.id, f.proposal.revision);
      expect(f.store.proposal(f.proposal.id)?.state).toBe('dismissed');
      expect(screen.text()).toMatch(/dismissed/i);
      expect(screen.text()).toMatch(/unchanged|no task/i);
      expect(f.execute).not.toHaveBeenCalled();
      await screen.press(keys.apply);
      expect(f.store.proposal(next.id)?.state).toBe('pending');
      expect(f.execute).not.toHaveBeenCalled();
      await screen.press(keys.apply);
      expect(f.store.proposal(next.id)?.state).toBe('applied');
      expect(f.store.proposals('pending')).toHaveLength(0);
    });
    expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
  },
);

it.each([1, 2])(
  'dismissal of the final row in a %i-item queue keeps feedback and chooses the preceding row when present',
  async (count) => {
    const f = setup({
      change: {
        operation: 'add',
        fields: { description: 'Predecessor', project: 'a' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    const last =
      count === 2
        ? seed(f.store, {
            change: {
              operation: 'add',
              fields: { description: 'Final item', project: 'b' },
              annotations: [],
            },
            expected: null,
            question: null,
          })
        : f.proposal;
    await driveUI(f.store, f.execute, async (screen) => {
      if (count === 2) await screen.press(keys.down);
      await screen.press('d');
      expect(f.store.proposal(last.id)?.state).toBe('dismissed');
      expect(screen.text()).toMatch(/dismissed/i);
      expect(screen.text()).toMatch(/unchanged|no task/i);
      expect(screen.text()).toMatch(/history/i);
      expect(screen.text()).toMatch(/close/i);
      if (count === 2) {
        await screen.press(keys.apply);
        expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
        expect(f.execute).not.toHaveBeenCalled();
        expect(await screen.pages()).toContain('Predecessor');
      } else {
        await screen.press('h');
        expect(await screen.pages()).toMatch(/dismissed/i);
      }
    });
    expect(f.execute).not.toHaveBeenCalled();
  },
);

it.each(['applying', 'uncertain'] as const)(
  'unresolved %s has no dismissal or editing and Ctrl+A is verification only',
  async (state) => {
    const f = setup();
    const claim = f.store.claimProposal(f.proposal.id, 1, null);
    if (state === 'uncertain')
      f.store.recordProposalResult(claim.id, claim.revision, claim.claim!, {
        state: 'uncertain',
        verified: null,
        actual: null,
        error: 'Still unresolved',
      });
    const dismiss = vi.spyOn(f.store, 'dismissProposal');
    const editor = vi.fn(async () => undefined);
    await driveUI(
      f.store,
      f.execute,
      async (screen) => {
        await screen.press('d');
        await screen.press('e');
        await screen.press(keys.enter);
        expect(screen.text()).toMatch(/verif/i);
        expect(screen.text()).not.toMatch(/d\b[^\n]*dismiss/i);
        await screen.press('d');
        await screen.press('e');
        const beforeVerification = f.store.proposal(f.proposal.id);
        await screen.press(keys.apply);
        expect(await screen.pages()).toMatch(/uncertain|unresolved/i);
        // A failed read-only resolution preserves the existing claim and durable state.
        expect(f.store.proposal(f.proposal.id)?.state).toBe(state);
        expect(f.store.proposal(f.proposal.id)).toEqual(beforeVerification);
        expect(screen.active()).toBe(true);
      },
      { editor },
    );
    expect(editor).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
  },
);

it.each(['completion', 'interrupted update', 'unresolved question'] as const)(
  'review displays the effect of %s',
  async (kind) => {
    const f = setup(
      kind === 'completion'
        ? {
            ...update,
            change: { operation: 'complete', targetUuid: uuid, annotations: [] },
          }
        : { ...update, question: kind === 'unresolved question' ? 'Which delivery date?' : null },
    );
    if (kind === 'interrupted update') {
      f.store.claimProposal(f.proposal.id, 1, snapshot(record));
      f.set({ ...record, status: 'completed' });
    }
    await driveUI(f.store, f.execute, async (screen) => {
      await screen.press(keys.enter);
      const review = (await screen.pages()).replace(/[\s│█]/gu, '');
      expect(review).toContain(
        (kind === 'completion'
          ? 'status: "pending" -> "completed"'
          : kind === 'interrupted update'
            ? 'status: "completed" -> "pending"'
            : 'Apply disabled: "Which delivery date?"'
        ).replace(/\s/gu, ''),
      );
      if (kind === 'unresolved question') {
        await screen.press(keys.apply);
        expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
      }
    });
    expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
  },
);

it('only explicit per-item Ctrl+A applies, never Enter, History, Source or accept-all', async () => {
  const f = setup();
  seed(f.store);
  const reads = vi.spyOn(evidenceModule, 'readSession');
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    await screen.press('a');
    await screen.press('h');
    await screen.press(keys.apply);
    await screen.press(keys.escape);
    await screen.press('i');
    await screen.press(keys.apply);
    await screen.press(keys.enter);
    await screen.press(keys.apply);
    await screen.press(keys.escape);
    await screen.press('s');
    await screen.press(keys.apply);
    await screen.press(keys.enter);
    expect(f.execute).not.toHaveBeenCalled();
    await screen.press(keys.escape);
    await screen.press(keys.apply);
    expect(f.store.proposals('applied')).toHaveLength(1);
    expect(f.store.proposals('pending')).toHaveLength(1);
    expect(screen.text()).not.toContain('Target:');
  });
  expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
  expect(reads).toHaveBeenCalledOnce();
});

it.each(['task', 'draft'])(
  'stale %s approval refreshes the preview and requires another Ctrl+A',
  async (changed) => {
    const f = setup(update);
    await driveUI(f.store, f.execute, async (screen) => {
      await screen.press(keys.enter);
      if (changed === 'task') f.set({ ...record, description: 'Changed outside Pi' });
      else
        f.store.editProposal(f.proposal.id, f.proposal.revision, {
          ...update,
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields: { description: 'Changed outside Pi' },
            annotations: [],
          },
        });
      await screen.press(keys.apply);
      const refreshed = await screen.pages();
      expect(refreshed).toContain('Changed outside Pi');
      expect(refreshed).toMatch(/preview changed|review.*again|renewed|fresh.*approval/i);
      expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
      expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
      await screen.press(keys.apply);
      expect(f.store.proposal(f.proposal.id)?.state).toBe('applied');
    });
    expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(1);
  },
);

it.each(['d', keys.apply].flatMap((action) => [false, true].map((last) => ({ action, last }))))(
  'error reload after $action collapses when the reviewed ID leaves Inbox (last=$last)',
  async ({ action, last }) => {
    const f = setup();
    const next = seed(f.store, {
      change: {
        operation: 'add',
        fields: { description: 'Successor', project: last ? 'a' : 'z' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    await driveUI(f.store, f.execute, async (screen) => {
      if (last) await screen.press(keys.down);
      await screen.press(keys.enter);
      f.store.dismissProposal(f.proposal.id, 1);
      await screen.press(action);
      expect(screen.text()).toContain('Successor');
      expect(screen.text()).toContain('Enter Expand');
      await screen.press(keys.apply);
      expect(f.store.proposal(next.id)?.state).toBe('pending');
      expect(f.execute).not.toHaveBeenCalled();
    });
  },
);

it('preview refresh supplies the latest revision to inspection and the editor', async () => {
  const f = setup();
  const edited: ProposalDraft = {
    change: { operation: 'add', fields: { description: 'External revision' }, annotations: [] },
    expected: null,
    question: null,
  };
  const editor = vi.fn(async (_title: string, initial: string) => {
    expect(JSON.parse(initial)).toEqual(edited);
    return initial;
  });
  await driveUI(
    f.store,
    f.execute,
    async (screen) => {
      f.store.editProposal(f.proposal.id, 1, edited);
      await screen.press(keys.enter);
      expect(await screen.pages()).toContain('External revision');
      await screen.press('i');
      expect((await screen.pages()).replace(/[\s│█]/gu, '')).toContain('"revision":2');
      await screen.press(keys.escape);
      await screen.press('e');
      expect(editor).toHaveBeenCalledOnce();
      expect(f.store.proposal(f.proposal.id)?.draft).toEqual(edited);
      expect(await screen.pages()).toContain('Draft saved.');
    },
    { editor },
  );
  expect(f.execute).not.toHaveBeenCalled();
});

it('preview refresh reorders changed projects while retaining the focused expanded ID', async () => {
  const f = setup();
  const make = (id: string, project: string, createdAt: string): Proposal => ({
    ...f.proposal,
    id,
    createdAt,
    change: { operation: 'add', fields: { description: 'ROW_' + id, project }, annotations: [] },
  });
  const rows = [
    make('a', 'alpha', '2026-01-01'),
    make('b', 'alpha', '2026-01-01'),
    make('c', 'alpha', '2026-01-02'),
    make('d', 'beta', '2025-01-01'),
    make('e', 'zeta', '2026-01-01'),
  ];
  vi.spyOn(f.store, 'proposals').mockImplementation((_state, offset = 0, limit = 100) =>
    [...rows].reverse().slice(offset, offset + limit),
  );
  vi.spyOn(f.store, 'proposal').mockImplementation((id) => rows.find((item) => item.id === id));
  await driveUI(f.store, f.execute, async (screen) => {
    for (let index = 0; index < 4; index++) await screen.press(keys.down);
    rows[4] = make('e', 'alpha', '2026-01-01');
    await screen.press(keys.enter);
    const review = await screen.pages();
    expect(review).toContain('ROW_e');
    expect(review).toContain('Proposal ID: "e"');
    expect(review).toContain('Enter Collapse');
    await screen.press(keys.escape);
    const text = screen.text();
    const order = ['a', 'b', 'e', 'c', 'd'];
    const positions = order.map((id) => text.indexOf('ROW_' + id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).toContain('> "ROW_e"');
    await screen.press(keys.down);
    expect(screen.text()).toContain('> "ROW_c"');
  });
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(['edit', 'claim', 'dismiss'] as const)(
  'editor save conflict refreshes an external %s made while the editor owns input',
  async (change) => {
    const f = setup();
    const successor = seed(f.store, {
      change: {
        operation: 'add',
        fields: { description: 'Successor', project: 'z' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    const draft: ProposalDraft = {
      change: { operation: 'add', fields: { description: 'Latest draft' }, annotations: [] },
      expected: null,
      question: null,
    };
    let complete!: (text: string) => void;
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const editor = vi.fn(async (_title: string, initial: string) =>
      editor.mock.calls.length === 1 ? pending : initial,
    );
    const dismiss = vi.spyOn(f.store, 'dismissProposal');
    await driveUI(
      f.store,
      f.execute,
      async (screen) => {
        await screen.press(keys.enter);
        await screen.press('e');
        try {
          expect(screen.active()).toBe(false);
          expect(editor).toHaveBeenCalledOnce();
          if (change === 'edit') f.store.editProposal(f.proposal.id, 1, draft);
          else if (change === 'claim') f.store.claimProposal(f.proposal.id, 1, null);
          else f.store.dismissProposal(f.proposal.id, 1);
        } finally {
          complete(JSON.stringify(draft));
        }
        await vi.waitFor(() => expect(screen.active()).toBe(true));
        expect(await screen.pages()).toContain('Proposal revision conflict');
        expect(f.store.proposal(f.proposal.id)?.revision).toBe(2);
        expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
        if (change === 'edit') {
          expect(await screen.pages()).toContain('Latest draft');
          await screen.press('e');
          expect(JSON.parse(editor.mock.calls[1]![1])).toEqual(draft);
          expect(f.store.proposal(f.proposal.id)?.revision).toBe(2);
          expect(await screen.pages()).toContain('Draft saved.');
        } else if (change === 'claim') {
          expect(screen.text()).toContain('Verify only (no replay)');
          expect(screen.text()).not.toMatch(/e Edit|d Dismiss/);
          await screen.press('e');
          await screen.press('d');
          expect(editor).toHaveBeenCalledOnce();
          expect(dismiss).not.toHaveBeenCalled();
        } else {
          expect(screen.text()).toContain('> "Successor"');
          expect(screen.text()).toContain('Enter Expand');
          await screen.press(keys.apply);
          expect(f.store.proposal(successor.id)?.state).toBe('pending');
          expect(f.execute).not.toHaveBeenCalled();
        }
      },
      { editor },
    );
    expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
  },
);

it('preview refresh disables edit and dismiss after an external claim', async () => {
  const f = setup();
  const editor = vi.fn(async () => undefined);
  const dismiss = vi.spyOn(f.store, 'dismissProposal');
  await driveUI(
    f.store,
    f.execute,
    async (screen) => {
      f.store.claimProposal(f.proposal.id, 1, null);
      await screen.press(keys.enter);
      expect(screen.text()).toContain('Verify only (no replay)');
      expect(screen.text()).not.toMatch(/e Edit|d Dismiss/);
      await screen.press('e');
      await screen.press('d');
      expect(editor).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
    },
    { editor },
  );
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
});

it('missing target remains in Inbox after deliberate expanded approval', async () => {
  const f = setup(update);
  f.set(null);
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    expect(await screen.pages()).toMatch(/target missing|missing target/i);
    await screen.press(keys.apply);
    expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
    expect(await screen.pages()).toMatch(/missing/i);
    await screen.press(keys.escape);
    expect(screen.text()).toContain('After');
  });
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
});

it('Ctrl+A on an unresolved claim verifies an already-present result without replay', async () => {
  const f = setup();
  const claim = f.store.claimProposal(f.proposal.id, 1, null);
  f.set({
    uuid: claim.claim!,
    status: 'pending',
    description: 'Send comparison',
    project: 'work',
    annotations: [{ entry: '20260101T000000Z', description: 'Saved context' }],
  });
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    await screen.press(keys.apply);
    expect(f.store.proposal(f.proposal.id)?.state).toBe('already_satisfied');
    expect(screen.text()).toMatch(/already.satisfied/i);
    expect(screen.text()).toMatch(/history/i);
  });
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
});

it.each(['dismiss', 'preview freshness', 'partial task write'])(
  'truthful %s failure keeps the Inbox item',
  async (failure) => {
    const f = setup(update);
    const execute = vi.fn<TaskExecutor>(async (args, input) => {
      if (input) throw new Error('INERT_WRITE_FAILURE');
      return f.execute(args);
    });
    await driveUI(f.store, execute, async (screen) => {
      if (failure === 'dismiss') {
        screen.resize(48, 32);
        const feedback =
          'INERT_DISMISS_FAILURE ' +
          'Retained proposal and task unchanged. '.repeat(5) +
          'FEEDBACK_END';
        vi.spyOn(f.store, 'dismissProposal').mockImplementationOnce(() => {
          throw new Error(feedback);
        });
        await screen.press('d');
        const lines = screen.lines();
        expect(lines.length).toBeLessThanOrEqual(30);
        expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
        expect(screen.text()).toContain('Full feedback is in the body.');
        for (const action of [/ctrl\+a/i, /dismiss/i, /history/i, /esc/i])
          expect(screen.text()).toMatch(action);
        const body = lines
          .filter((line) => /[█│]│$/u.test(line))
          .map((line) => line.slice(1, -2))
          .join('')
          .replace(/\s/gu, '');
        expect(body).toContain(
          `Full feedback: ${JSON.stringify('Error: ' + feedback)}`.replace(/\s/gu, ''),
        );
      } else {
        await screen.press(keys.enter);
        if (failure === 'preview freshness')
          execute.mockRejectedValueOnce(new Error('INERT_REFRESH_FAILURE'));
        await screen.press(keys.apply);
        expect(await screen.pages()).toContain(
          failure === 'partial task write' ? 'INERT_WRITE_FAILURE' : 'INERT_REFRESH_FAILURE',
        );
      }
      expect(f.store.proposal(f.proposal.id)?.state).toBe(
        failure === 'partial task write' ? 'uncertain' : 'pending',
      );
      if (failure !== 'dismiss') await screen.press(keys.escape);
      expect(screen.text()).toContain('After');
      expect(screen.text()).not.toMatch(/successfully applied/i);
    });
  },
);

const longNotes = Array.from(
  { length: 4 },
  (_, note) =>
    'NOTE_' +
    note +
    '_START ' +
    Array.from(
      { length: 24 },
      (_, word) => 'n' + note + 'w' + word.toString().padStart(2, '0'),
    ).join(' ') +
    ' NOTE_' +
    note +
    '_FINAL',
);
const longUrl = 'https://example.invalid/' + 'long-path/'.repeat(28) + 'EXACT_URL_FINAL';
const longDraft: ProposalDraft = {
  change: {
    operation: 'update',
    targetUuid: uuid,
    fields: {
      description: '漢字 👩🏽‍💻 ' + longUrl,
      project: null,
      due: '20300201T000000Z',
      wait: null,
      scheduled: '20300102T000000Z',
      priority: 'H',
      waitingon: 'EXACT_PREREQUISITE_FINAL',
      tags: ['漢字', '🚀'],
      depends: [uuid],
    },
    annotations: longNotes,
  },
  expected: snapshot(record),
  question: null,
};

it.each([
  [80, 32],
  [48, 32],
  [80, 24],
])(
  'review at %ix%i bounds every physical line, preserves exact values and keeps actions visible',
  async (columns, rows) => {
    const f = setup(longDraft);
    const exact = previewText(await previewProposal(f.store, f.proposal.id, f.execute));
    for (const value of [
      ...longNotes,
      longUrl,
      '20300201T000000Z',
      '20300102T000000Z',
      'EXACT_PREREQUISITE_FINAL',
      uuid,
    ])
      expect(exact).toContain(value);
    f.execute.mockClear();
    await driveUI(
      f.store,
      f.execute,
      async (screen) => {
        await screen.press(keys.enter);
        const frames: string[][] = [];
        for (let page = 0; page < 100; page++) {
          const lines = screen.lines();
          frames.push(lines);
          expect(lines.length).toBeLessThanOrEqual(rows - 2);
          for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(columns);
          const text = lines.join('\n');
          for (const action of [/ctrl\+a/i, /dismiss/i, /source/i, /history/i, /esc/i])
            expect(text).toMatch(action);
          expect(text).toMatch(/\d+\s*[-–]\s*\d+\s*\/\s*\d+/);
          await screen.press(keys.pageDown);
          if (screen.text() === text) break;
        }
        const renderedRows: string[] = [];
        for (const frame of frames) {
          const start = Number(frame.join('\n').match(/Rows (\d+)-/)?.[1]) - 1;
          frame
            .filter((line) => /[█│]│$/u.test(line))
            .forEach((line, index) => {
              renderedRows[start + index] = line.slice(1, -2);
            });
        }
        const unwrapped = renderedRows.join('').replace(/\s/gu, '');
        for (const [index, note] of longNotes.entries())
          expect(unwrapped).toContain(`${index + 1}.${JSON.stringify(note)}`.replace(/\s/gu, ''));
        if (longDraft.change.operation !== 'complete')
          for (const [field, value] of Object.entries(longDraft.change.fields))
            expect(unwrapped).toContain(
              `${field}: ${JSON.stringify(record[field] ?? null)} -> ${JSON.stringify(value)}`.replace(
                /\s/gu,
                '',
              ),
            );
        expect(frames[0]!.join('\n')).toMatch(/below|more|↓/i);
        expect(screen.text()).toMatch(/end/i);
        expect(frames.flat().some((line) => /[█▓▐▌]/u.test(line))).toBe(true);
        const end = screen.text();
        await screen.press(keys.pageDown);
        expect(screen.text()).toBe(end);
        for (let n = 0; n < 100; n++) await screen.press(keys.pageUp);
        expect(screen.text()).toBe(frames[0]!.join('\n'));
        await screen.press(keys.pageUp);
        expect(screen.text()).toBe(frames[0]!.join('\n'));
      },
      { columns, rows },
    );
    expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(0);
  },
);

it('resize rewraps and clamps a nonzero offset; a tiny terminal blocks apply until restored', async () => {
  const f = setup(longDraft);
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    await screen.pages();
    for (const [columns, rows] of [
      [48, 32],
      [80, 24],
      [80, 32],
    ]) {
      const previousStart = Number(screen.text().match(/Rows (\d+)-/)![1]);
      expect(previousStart).toBeGreaterThan(1);
      screen.resize(columns!, rows!);
      const lines = screen.lines();
      const range = lines.join('\n').match(/Rows (\d+)-(\d+)\/(\d+)/)!;
      const [start, end, total] = range.slice(1).map(Number) as [number, number, number];
      expect(start).toBe(Math.min(previousStart, total - (end - start)));
      expect(lines.length).toBeLessThanOrEqual(rows! - 2);
      expect(lines.every((line) => visibleWidth(line) <= columns!)).toBe(true);
      expect(await screen.pages()).toMatch(/end/i);
    }
    screen.resize(20, 8);
    await screen.press(keys.apply, false);
    expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
    expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(0);
    const tiny = screen.lines();
    expect(tiny.length).toBeLessThanOrEqual(8);
    expect(tiny.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(tiny.join('\n')).toMatch(/resize|larger|small/i);
    await screen.press(keys.apply);
    expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
    expect(f.execute.mock.calls.filter(([, input]) => input)).toHaveLength(0);
    screen.resize(80, 32);
    await screen.press(keys.apply);
    expect(f.store.proposal(f.proposal.id)?.state).toBe('applied');
  });
});

it('Source navigates references and huge quote pages with pinned controls, lazy context and no writes', async () => {
  const f = setup();
  const huge =
    ['FIRST_PAGE', 'SECOND_PAGE', 'THIRD_PAGE']
      .map((label) => label + 'x'.repeat(2048 - label.length))
      .join('') + 'FINAL_PAGE';
  const proposal: Proposal = {
    ...f.proposal,
    sources: Array.from({ length: 120 }, (_, index) => ({
      ...f.proposal.sources[0]!,
      file: `${f.proposal.sources[0]!.file}.${index}`,
      entryId: `entry-${index}`,
      quote: index === 0 ? huge : `REFERENCE_${index + 1}`,
    })),
  };
  vi.spyOn(f.store, 'proposals').mockImplementation((_state, offset = 0, limit = 100) =>
    [proposal].slice(offset, offset + limit),
  );
  vi.spyOn(f.store, 'proposal').mockReturnValue(proposal);
  const reads = vi.spyOn(evidenceModule, 'readSession');
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    await screen.press(keys.pageDown);
    const review = screen.text();
    expect(reads).not.toHaveBeenCalled();
    await screen.press('s');
    expect(reads).toHaveBeenCalledOnce();
    expect(screen.text()).toContain('Evidence 1/120');
    expect(screen.text()).toContain('quote page 1/4');
    const first = await screen.pages();
    expect(first).toContain('FIRST_PAGE');
    expect(first).not.toContain('SECOND_PAGE');
    expect(screen.text()).toContain('Evidence 1/120');
    expect(screen.text()).toContain('Quote page');
    expect(screen.text()).toContain('PgUp/PgDn');
    expect(reads).toHaveBeenCalledOnce();
    for (const [index, label] of ['SECOND_PAGE', 'THIRD_PAGE', 'FINAL_PAGE'].entries()) {
      await screen.press(keys.right);
      expect(screen.text()).toContain(`quote page ${index + 2}/4`);
      expect(await screen.pages()).toContain(label);
    }
    await screen.press(keys.right);
    expect(screen.text()).toContain('Evidence 2/120');
    expect(screen.text()).toContain('quote page 1/1');
    await screen.press(keys.left);
    expect(screen.text()).toContain('Evidence 1/120');
    expect(screen.text()).toContain('quote page 4/4');
    expect(await screen.pages()).toContain('FINAL_PAGE');
    await screen.press(keys.up);
    expect(screen.text()).toContain('quote page 4/4');
    for (let index = 1; index < 120; index++) {
      await screen.press(keys.down);
      expect(screen.text()).toContain(`Evidence ${index + 1}/120`);
    }
    const last = screen.text();
    const count = reads.mock.calls.length;
    await screen.press(keys.down);
    await screen.press(keys.right);
    expect(screen.text()).toBe(last);
    expect(reads).toHaveBeenCalledTimes(count);
    screen.resize(40, 24);
    const narrow = screen.lines();
    expect(narrow.length).toBeLessThanOrEqual(22);
    expect(narrow.every((line) => visibleWidth(line) <= 38)).toBe(true);
    expect(screen.text()).toContain('Evidence 120/120');
    expect(screen.text()).toContain('PgUp/PgDn');
    expect(reads).toHaveBeenCalledTimes(count);
    screen.resize(80, 32);
    for (const key of [keys.apply, keys.enter, 'e', 'd']) await screen.press(key);
    expect(f.execute).not.toHaveBeenCalled();
    await screen.press(keys.escape);
    expect(screen.text()).toBe(review);
  });
  expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
  expect(f.execute).not.toHaveBeenCalled();
});

it('Source return restores the exact review position, and nested Escape does not close Inbox', async () => {
  const f = setup(longDraft);
  const reads = vi.spyOn(evidenceModule, 'readSession');
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    await screen.press(keys.pageDown);
    const before = screen.text();
    await screen.press('s');
    expect(await screen.pages()).toContain('Send comparison');
    await screen.press(keys.escape);
    expect(screen.text()).toBe(before);
    expect(reads).toHaveBeenCalledOnce();
    await screen.press(keys.escape);
    expect(screen.active()).toBe(true);
    expect(screen.text()).not.toContain(uuid);
  });
});

it('current saved proposal and edited draft remain inspectable without revision history or writes', async () => {
  const f = setup();
  f.store.editProposal(f.proposal.id, 1, {
    change: { operation: 'add', fields: { description: 'Edited draft' }, annotations: longNotes },
    expected: null,
    question: null,
  });
  const readSource = vi.spyOn(evidenceModule, 'readSession');
  await driveUI(f.store, f.execute, async (screen) => {
    await screen.press(keys.enter);
    await screen.press(keys.pageDown);
    const review = screen.text();
    await screen.press('i');
    const inspected = await screen.pages();
    for (const value of ['Edited draft', 'Send comparison', 'Promised', '"change"', '"draft"'])
      expect(inspected).toContain(value);
    await screen.press(keys.apply);
    await screen.press('d');
    await screen.press('e');
    await screen.press(keys.escape);
    expect(screen.text()).toBe(review);
    await screen.press('h');
    expect(await screen.pages()).not.toContain('Selected-proposal revisions');
    await screen.press(keys.escape);
    expect(screen.text()).toBe(review);
    expect(screen.active()).toBe(true);
  });
  expect(readSource).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.store.proposal(f.proposal.id)?.state).toBe('pending');
});

it.each(['save', 'cancel'] as const)(
  'editor %s has exclusive input ownership and reopens review without applying',
  async (result) => {
    const hostile = 'SAVED_\u001b[31m\u009b31m\u009dtitle\u0007\r\t\b';
    const draft: ProposalDraft = {
      change: {
        operation: 'add',
        fields: { description: 'Send comparison ' + hostile, project: hostile },
        annotations: [hostile],
      },
      expected: null,
      question: null,
    };
    const savedDraft: ProposalDraft = {
      ...draft,
      change: {
        ...draft.change,
        operation: 'add',
        fields: { description: 'Saved exclusive draft ' + hostile, project: hostile },
      },
    };
    const f = setup(draft);
    let complete!: (value: string | undefined) => void;
    const pending = new Promise<string | undefined>((resolve) => {
      complete = resolve;
    });
    let isActive = () => true;
    const editor = vi.fn(async (_title: string, _initial: string) => {
      expect(isActive(), 'overlay must relinquish ownership before opening the editor').toBe(false);
      return pending;
    });
    await driveUI(
      f.store,
      f.execute,
      async (screen) => {
        isActive = screen.active;
        await screen.press(keys.enter);
        const previous = screen.text();
        const customCount = screen.custom.mock.calls.length;
        try {
          await screen.press('e');
          expect(editor).toHaveBeenCalledOnce();
          const initial = editor.mock.calls[0]![1];
          expect(terminalControls(initial)).toEqual([]);
          expect(initial).toContain('SAVED_\\u001b[31m\\u009b31m\\u009dtitle\\u0007\\r\\t\\b');
          expect(JSON.parse(initial)).toEqual(draft);
          expect(screen.active()).toBe(false);
          expect(screen.custom).toHaveBeenCalledTimes(customCount);
          expect(f.store.proposal(f.proposal.id)?.revision).toBe(1);
          expect(f.execute).not.toHaveBeenCalled();
        } finally {
          const edited = JSON.parse(editor.mock.calls[0]![1]);
          edited.change.fields.description = 'Saved exclusive draft ' + hostile;
          complete(result === 'save' ? JSON.stringify(edited) : undefined);
        }
        await vi.waitFor(() => expect(screen.active()).toBe(true));
        expect(screen.custom.mock.calls.length).toBeGreaterThan(customCount);
        if (result === 'save') {
          expect(await screen.pages()).toContain('Saved exclusive draft');
          expect(f.store.proposal(f.proposal.id)?.revision).toBe(2);
          expect(f.store.proposal(f.proposal.id)?.draft).toEqual(savedDraft);
        } else {
          expect(screen.text()).toBe(previous);
          expect(f.store.proposal(f.proposal.id)?.revision).toBe(1);
        }
      },
      { editor },
    );
    expect(f.execute).not.toHaveBeenCalled();
  },
);

function terminalControls(text: string) {
  // Text may insert its own SGR reset while wrapping. The inert theme emits no colors.
  return Array.from(text.split('\u001b[0m').join(''))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 10) || (code >= 0x7f && code <= 0x9f);
    })
    .map((character) => character.charCodeAt(0));
}

it('all saved strings are terminal-control-safe in review, Source, current proposal, draft and results', async () => {
  const hostile = 'SAVED_\u001b[31m\u009b31m\u009dtitle\u0007\r\t\b';
  const f = setup();
  const original = seed(
    f.store,
    {
      change: {
        operation: 'update',
        targetUuid: uuid,
        fields: { description: hostile, project: hostile, waitingon: hostile, tags: [hostile] },
        annotations: [hostile],
      },
      expected: snapshot({ ...record, description: hostile }),
      question: hostile,
    },
    { explanation: hostile, quote: hostile },
  );
  f.store.editProposal(original.id, 1, {
    change: {
      operation: 'update',
      targetUuid: uuid,
      fields: { description: hostile },
      annotations: [hostile],
    },
    expected: snapshot({ ...record, description: hostile }),
    question: null,
  });
  const claim = f.store.claimProposal(original.id, 2, snapshot(record));
  f.store.recordProposalResult(original.id, claim.revision, claim.claim!, {
    state: 'uncertain',
    verified: snapshot({ ...record, description: hostile }),
    actual: { ...record, custom: hostile, [hostile]: hostile },
    error: hostile,
  });
  f.set({
    ...record,
    description: hostile,
    annotations: [{ entry: '20260101T000000Z', description: hostile }],
  });
  // Keep just the hostile fixture focused. Saved data is read through the same store API.
  const saved = f.store.proposal(original.id)!;
  const hostileSources = (proposal: Proposal) => ({
    ...proposal,
    sources: proposal.sources.map((source) => ({
      ...source,
      role: hostile,
      file: hostile,
      sessionId: hostile,
      branchId: hostile,
      entryId: hostile,
      editId: hostile,
      timestamp: hostile,
      locator: hostile,
    })),
  });
  const proposals: Proposal[] = [hostileSources(saved)];
  vi.spyOn(f.store, 'proposals').mockImplementation((_state, offset = 0, limit = 100) =>
    proposals.slice(offset, offset + limit),
  );
  vi.spyOn(f.store, 'proposal').mockImplementation((id) => proposals.find((p) => p.id === id));
  const safe = (text: string) => {
    expect(terminalControls(text)).toEqual([]);
    expect(text.replace(/\s/g, '')).toContain('\\u001b[31m');
    expect(text.replace(/\s/g, '')).toContain('\\u009b31m');
  };
  safe(previewText(await previewProposal(f.store, original.id, f.execute)));
  safe(sourceText(f.store.proposal(original.id)!));
  await driveUI(f.store, f.execute, async (screen) => {
    safe(screen.text());
    await screen.press(keys.enter);
    safe(await screen.pages());
    await screen.press('s');
    safe(await screen.pages());
    await screen.press(keys.escape);
    await screen.press('i');
    const inspected = await screen.pages();
    safe(inspected);
    expect(inspected).toMatch(/actual|verified/i);
    expect(inspected).toContain('custom');
  });
  expect(f.execute.mock.calls.every(([, input]) => input === undefined)).toBe(true);
});

it.skipIf(!existsSync('/opt/homebrew/bin/task')).each(['due', 'wait', 'scheduled'] as const)(
  'isolated Taskwarrior import/export clears approved %s and preserves unmentioned fields',
  async (date) => {
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
          priority: 'H' as const,
          due: '20300201T000000Z',
          wait: '20300101T000000Z',
          scheduled: '20300102T000000Z',
        },
        annotations: ['Quote "literal"'],
      };
      await writeTaskChange(() => 'tui', add, null, uuid, execute);
      let actual = (await lookupTasks({ uuid }, execute)).tasks[0]!;
      expect(actual['description']).toBe(add.fields.description);
      const before = snapshot(actual);
      const store = durableStore();
      stores.push(store);
      const proposal = seed(store, {
        change: {
          operation: 'update',
          targetUuid: uuid,
          fields: { [date]: null },
          annotations: [],
        },
        expected: before,
        question: null,
      });
      const result = await applyProposal(
        store,
        await previewProposal(store, proposal.id, execute),
        () => 'tui',
        execute,
      );
      expect(result.result?.error).toBeNull();
      expect(result.state).toBe('applied');
      actual = (await lookupTasks({ uuid }, execute)).tasks[0]!;
      expect(actual).not.toHaveProperty(date);
      const retainedFields = { ...before.fields };
      delete retainedFields[date];
      expect(snapshot(actual)).toEqual({ ...before, fields: retainedFields });
      expect(result.result?.verified).toEqual(snapshot(actual));
      expect(result.result?.actual).toEqual(actual);
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
