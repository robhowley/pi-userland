import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import remembrancer, {
  boundedEvidencePage,
  groupEvidencePage,
  REVIEW_RESPONSE_MAX_BYTES,
} from '../extensions/remembrancer/index.js';
import { REVIEW_LIMITS, type Evidence } from '../extensions/remembrancer/evidence.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

type Handler = (...args: unknown[]) => unknown;
type ResultRenderer = NonNullable<ToolDefinition['renderResult']>;
type ResultRendererOptions = Parameters<ResultRenderer>[1];
type ResultRendererContext = Parameters<ResultRenderer>[3];
type Selected = {
  sessionId: string;
  branchId: string;
  entryId: string;
  editId: string | null;
};
type TestTool = {
  name: string;
  description: string;
  execute: (
    id: string,
    args: {
      action: string;
      proposals?: import('../extensions/remembrancer/proposals.js').ProposalSubmission[];
      batch?: string | undefined;
      seed?: string | undefined;
      selected?: Selected | undefined;
      before?: number | undefined;
      offset?: number | undefined;
    },
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  renderResult?: ToolDefinition['renderResult'];
};
type ResultWarning = {
  message: string;
  sources: string[];
  reason: string;
  kind: 'source-failure' | 'archive-scan' | 'identity-ambiguity' | 'unknown-timestamp';
};
type ResultDetails = {
  action: 'begin' | 'next' | 'context' | 'finish' | 'cancel';
  batch: string;
  seed?: string;
  requestedSince?: string;
  incomplete: boolean;
  warnings: ResultWarning[];
  coverageChanged: boolean;
};
type ToolResponse = { content: [{ type: 'text'; text: string }]; details: ResultDetails };
type ReviewEvidenceEntry = {
  entryId: string;
  role: string;
  text: string;
  timestamp: string;
  editId: string | null;
  offset: number;
  continues: boolean;
};
type ReviewEvidenceGroup = {
  file: string;
  sessionId: string;
  cwd: string;
  branchId: string;
  reviewedThrough: string | null;
  entries: ReviewEvidenceEntry[];
};
type ExpandedReviewEvidence = ReviewEvidenceEntry & Omit<ReviewEvidenceGroup, 'entries'>;
type ReviewResult = {
  batch?: string;
  groups?: ReviewEvidenceGroup[];
  hasMore?: boolean;
  capturedTips?: number;
  finished?: boolean;
  reviewedTips?: number;
  requestedSince?: string;
  status?: string;
  coverageChanged?: boolean;
  incomplete?: boolean;
  warnings?: string[];
  contextOnly?: boolean;
  nextOffset?: number | null;
};

type TestCommand = {
  handler: Handler;
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ value: string; label: string; description?: string }> | null;
};
type FakeExtension = {
  handlers: Map<string, Handler>;
  tools: TestTool[];
  commands: Map<string, TestCommand>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  api: ExtensionAPI;
};

function fakeExtension(): FakeExtension {
  const handlers = new Map<string, Handler>();
  const tools: TestTool[] = [];
  const commands = new Map<string, TestCommand>();
  const sendUserMessage = vi.fn();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: TestCommand) {
      commands.set(name, command);
    },
    registerTool(tool: TestTool) {
      tools.push(tool);
    },
    sendUserMessage,
  } as unknown as ExtensionAPI;
  return { handlers, tools, commands, sendUserMessage, api };
}

function decode(response: unknown): ReviewResult {
  const text = (response as ToolResponse).content[0].text;
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(REVIEW_RESPONSE_MAX_BYTES);
  return JSON.parse(text) as ReviewResult;
}

function pageEntry(overrides: Partial<Evidence> & { offset?: number; continues?: boolean } = {}) {
  return {
    file: '/archive/a.jsonl',
    sessionId: 'session-a',
    entryId: 'entry-a',
    role: 'user',
    text: 'evidence',
    cwd: '/work/a',
    timestamp: '2026-01-01T00:00:00.000Z',
    branchId: 'branch-a',
    reviewedThrough: null,
    editId: null,
    offset: 0,
    continues: false,
    ...overrides,
  };
}

function expandEvidenceGroups(result: ReviewResult): ExpandedReviewEvidence[] {
  return (result.groups ?? []).flatMap(({ entries, ...source }) =>
    entries.map((entry) => ({ ...source, ...entry })),
  );
}

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<ResultRenderer>[2];

it('groups consecutive matching provenance without reordering or deduplicating entries', () => {
  const first = pageEntry({ entryId: 'same', text: 'same' });
  const duplicate = { ...first };
  const middle = pageEntry({
    file: '/archive/b.jsonl',
    sessionId: 'session-b',
    cwd: '/work/b',
    branchId: 'branch-b',
    reviewedThrough: 'checkpoint-b',
    entryId: 'middle',
    role: 'assistant',
    text: 'middle',
    timestamp: '2026-01-02T00:00:00.000Z',
    editId: 'edit-b',
    offset: 7,
    continues: true,
  });
  const groups = groupEvidencePage([first, duplicate, middle, { ...first }]);
  expect(groups).toEqual([
    {
      file: '/archive/a.jsonl',
      sessionId: 'session-a',
      cwd: '/work/a',
      branchId: 'branch-a',
      reviewedThrough: null,
      entries: [
        {
          entryId: 'same',
          role: 'user',
          text: 'same',
          timestamp: '2026-01-01T00:00:00.000Z',
          editId: null,
          offset: 0,
          continues: false,
        },
        {
          entryId: 'same',
          role: 'user',
          text: 'same',
          timestamp: '2026-01-01T00:00:00.000Z',
          editId: null,
          offset: 0,
          continues: false,
        },
      ],
    },
    {
      file: '/archive/b.jsonl',
      sessionId: 'session-b',
      cwd: '/work/b',
      branchId: 'branch-b',
      reviewedThrough: 'checkpoint-b',
      entries: [
        {
          entryId: 'middle',
          role: 'assistant',
          text: 'middle',
          timestamp: '2026-01-02T00:00:00.000Z',
          editId: 'edit-b',
          offset: 7,
          continues: true,
        },
      ],
    },
    {
      file: '/archive/a.jsonl',
      sessionId: 'session-a',
      cwd: '/work/a',
      branchId: 'branch-a',
      reviewedThrough: null,
      entries: [
        {
          entryId: 'same',
          role: 'user',
          text: 'same',
          timestamp: '2026-01-01T00:00:00.000Z',
          editId: null,
          offset: 0,
          continues: false,
        },
      ],
    },
  ]);
});

it('does not skip empty evidence while advancing a page cursor', () => {
  const evidence = [pageEntry({ entryId: 'empty', text: '' }), pageEntry({ entryId: 'later' })];
  const page = boundedEvidencePage(evidence, { index: 0, offset: 0 }, (entries, cursor) => ({
    batch: 'batch',
    groups: groupEvidencePage(entries),
    hasMore: cursor.index < evidence.length,
  }));

  expect(page.cursor).toEqual({ index: 2, offset: 0 });
  expect(page.data['groups']).toMatchObject([
    {
      entries: [
        { entryId: 'empty', text: '' },
        { entryId: 'later', text: 'evidence' },
      ],
    },
  ]);
});

it('returns 200 small entries per page and resumes without losing evidence', () => {
  const evidence = Array.from({ length: 201 }, (_, index) =>
    pageEntry({ entryId: `entry-${index}`, text: `item-${index}` }),
  );
  const build = (
    entries: Parameters<typeof groupEvidencePage>[0],
    cursor: { index: number; offset: number },
  ) => ({
    batch: 'batch',
    groups: groupEvidencePage(entries),
    hasMore: cursor.index < evidence.length,
  });

  const first = boundedEvidencePage(evidence, { index: 0, offset: 0 }, build);
  expect(first.cursor).toEqual({ index: 200, offset: 0 });
  expect(first.data['hasMore']).toBe(true);
  expect(expandEvidenceGroups(first.data as ReviewResult)).toEqual(evidence.slice(0, 200));

  const second = boundedEvidencePage(evidence, first.cursor, build);
  expect(second.cursor).toEqual({ index: 201, offset: 0 });
  expect(second.data['hasMore']).toBe(false);
  expect(expandEvidenceGroups(second.data as ReviewResult)).toEqual(evidence.slice(200));
  for (const page of [first, second]) {
    expect(Buffer.byteLength(JSON.stringify(page.data), 'utf8')).toBeLessThanOrEqual(
      REVIEW_RESPONSE_MAX_BYTES,
    );
  }
});

it('splits an exact-cap Unicode prefix and resumes from its UTF-16 offset', () => {
  const evidence = [pageEntry({ text: '🌱x' })];
  let envelope = { padding: '' };
  const build = (
    entries: Parameters<typeof groupEvidencePage>[0],
    cursor: { index: number; offset: number },
  ) => ({
    batch: 'batch',
    groups: groupEvidencePage(entries),
    hasMore: cursor.index < evidence.length,
    ...envelope,
  });
  const responseBytes = (response: unknown) => Buffer.byteLength(JSON.stringify(response), 'utf8');
  const emoji = pageEntry({ text: '🌱', offset: 0, continues: true });
  const complete = pageEntry({ text: '🌱x', offset: 0, continues: false });
  const afterEmoji = { index: 0, offset: 2 };
  const exhausted = { index: 1, offset: 0 };
  const paddingBytes = REVIEW_RESPONSE_MAX_BYTES - responseBytes(build([emoji], afterEmoji));
  envelope = { padding: 'p'.repeat(paddingBytes) };

  expect(paddingBytes).toBeGreaterThan(0);
  expect(responseBytes(build([emoji], afterEmoji))).toBe(REVIEW_RESPONSE_MAX_BYTES);
  expect(responseBytes(build([complete], exhausted))).toBeGreaterThan(REVIEW_RESPONSE_MAX_BYTES);

  const first = boundedEvidencePage(evidence, { index: 0, offset: 0 }, build);
  expect(first.cursor).toEqual(afterEmoji);
  expect(first.data).toMatchObject({
    hasMore: true,
    groups: [{ entries: [{ text: '🌱', offset: 0, continues: true }] }],
  });
  expect(responseBytes(first.data)).toBeLessThanOrEqual(REVIEW_RESPONSE_MAX_BYTES);

  const second = boundedEvidencePage(evidence, first.cursor, build);
  expect(second.cursor).toEqual(exhausted);
  expect(second.data).toMatchObject({
    hasMore: false,
    groups: [{ entries: [{ text: 'x', offset: 2, continues: false }] }],
  });
  expect(responseBytes(second.data)).toBeLessThanOrEqual(REVIEW_RESPONSE_MAX_BYTES);

  const chunks = [
    ...expandEvidenceGroups(first.data as ReviewResult),
    ...expandEvidenceGroups(second.data as ReviewResult),
  ];
  expect(chunks.map(({ text, offset, continues }) => ({ text, offset, continues }))).toEqual([
    { text: '🌱', offset: 0, continues: true },
    { text: 'x', offset: 2, continues: false },
  ]);
  expect(chunks.map(({ text }) => text).join('')).toBe(evidence[0]?.text);
});

it('retains empty text entries in the grouped shape', () => {
  const groups = groupEvidencePage([pageEntry({ entryId: 'empty', text: '' })]);
  expect(groups[0]?.entries).toEqual([
    {
      entryId: 'empty',
      role: 'user',
      text: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      editId: null,
      offset: 0,
      continues: false,
    },
  ]);
});

it.each(['file', 'sessionId', 'cwd', 'branchId', 'reviewedThrough'] as const)(
  'starts a new group when shared %s differs',
  (field) => {
    const first = pageEntry();
    const changed = {
      ...first,
      [field]: field === 'reviewedThrough' ? 'checkpoint' : `${first[field]}-changed`,
    };
    expect(groupEvidencePage([first, changed])).toHaveLength(2);
  },
);

function renderSummary(tool: TestTool, response: unknown, action: ResultDetails['action']): string {
  const renderer = tool.renderResult;
  if (!renderer) throw new Error('Remembrancer renderer was not registered');
  const component = renderer(
    response as Parameters<ResultRenderer>[0],
    { expanded: false, isPartial: false } as ResultRendererOptions,
    identityTheme,
    {
      args: { action },
      toolCallId: 'render-call',
      invalidate: vi.fn(),
      lastComponent: undefined,
      state: {},
      cwd: '/work',
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: true,
      isError: false,
      keyHint: () => 'ctrl+o to expand',
    } as unknown as ResultRendererContext,
  );
  return component
    .render(120)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join('\n');
}

function contextFor(
  cwd: string,
  file?: string,
  archive = file ? dirname(file) : cwd,
  defaultSessionDir = false,
  options: {
    isIdle?: () => boolean;
    notify?: (message: string, type?: 'info' | 'warning' | 'error') => void;
  } = {},
): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    isIdle: options.isIdle ?? (() => true),
    ui: { notify: options.notify ?? (() => {}) },
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => 'session',
      getSessionDir: () => archive,
      usesDefaultSessionDir: () => defaultSessionDir,
    },
  } as unknown as ExtensionContext;
}

async function installedAutocompleteProvider(command: TestCommand, cwd: string) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const tuiEntry = join(
    realpathSync(join(packageRoot, 'node_modules', '@earendil-works', 'pi-tui')),
    'dist',
    'autocomplete.js',
  );
  const { CombinedAutocompleteProvider } = await import(pathToFileURL(tuiEntry).href);
  return new CombinedAutocompleteProvider(
    [{ name: 'remembrancer', getArgumentCompletions: command.getArgumentCompletions }],
    cwd,
  );
}

it('finishes manual analysis with durable pending proposals, without task execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-proposals-'));
  const previousState = process.env['XDG_STATE_HOME'];
  const previousAgent = process.env['PI_CODING_AGENT_DIR'];
  process.env['XDG_STATE_HOME'] = dir;
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'promise',
        parentId: null,
        message: { role: 'user', content: 'Send Maya the comparison' },
      }),
      '',
    ].join('\n'),
  );
  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, file);
  try {
    await extension.handlers.get('session_start')!({}, context);
    const tool = extension.tools[0]!;
    const begin = decode(
      await tool.execute('begin', { action: 'begin' }, undefined, undefined, context),
    );
    const item = expandEvidenceGroups(begin)[0]!;
    await expect(
      tool.execute(
        'missing',
        { action: 'finish', batch: begin.batch },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/proposals array/);
    const result = decode(
      await tool.execute(
        'finish',
        {
          action: 'finish',
          batch: begin.batch,
          proposals: [
            {
              change: {
                operation: 'add',
                fields: { description: 'Send comparison' },
                annotations: [],
              },
              expected: null,
              question: null,
              explanation: 'User promise',
              references: [
                {
                  sessionId: item.sessionId,
                  branchId: item.branchId,
                  entryId: item.entryId,
                  editId: item.editId,
                  offset: 0,
                  quote: 'Send Maya',
                },
              ],
            },
          ],
        },
        undefined,
        undefined,
        context,
      ),
    );
    expect(result.finished).toBe(true);
    const store = new CheckpointStore();
    try {
      expect(store.proposals()).toMatchObject([
        { state: 'pending', revision: 1, change: { operation: 'add' } },
      ]);
      expect(store.reviewed()).toHaveLength(1);
    } finally {
      store.close();
    }
    const next = decode(
      await tool.execute('begin', { action: 'begin' }, undefined, undefined, context),
    );
    const lookup = (await tool.execute(
      'lookup',
      { action: 'proposals', batch: next.batch },
      undefined,
      undefined,
      context,
    )) as ToolResponse;
    expect(JSON.parse(lookup.content[0].text).proposals).toHaveLength(1);
    expect(next.groups).toEqual([]);
  } finally {
    await extension.handlers.get('session_shutdown')!({}, context);
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    if (previousAgent === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgent;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('registers the remembrancer lifecycle and review tool after enabled startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-startup-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, contextFor(dir));
    expect(extension.tools).toHaveLength(1);
    expect(extension.tools[0]?.name).toBe('remembrancer_review');
    expect(extension.tools[0]?.description).toContain('remembrancer skill');
  } finally {
    await shutdown({}, contextFor(dir));
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('routes the slash command through the Remembrancer skill and completes its arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-command-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = join(dir, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  mkdirSync(agentDir, { recursive: true });
  const extension = fakeExtension();
  remembrancer(extension.api);
  const command = extension.commands.get('remembrancer');
  if (!command) throw new Error('Remembrancer command was not registered');
  const notify = vi.fn();
  const context = contextFor(dir, undefined, dir, false, { notify });

  try {
    await command.handler('help', context);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage: /remembrancer'), 'info');

    await command.handler('seed 14d', context);
    expect(extension.sendUserMessage).toHaveBeenCalledWith('/skill:remembrancer seed 14d', {
      expandPromptTemplates: true,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    const getArgumentCompletions = command.getArgumentCompletions;
    if (!getArgumentCompletions) throw new Error('Remembrancer completions were not registered');

    expect(getArgumentCompletions('')).toEqual([
      expect.objectContaining({ value: 'seed ', label: 'seed' }),
      expect.objectContaining({ value: 'help', label: 'help' }),
    ]);
    expect(getArgumentCompletions('seed ')).toEqual([
      expect.objectContaining({ value: 'seed 1d', label: '1d' }),
      expect.objectContaining({ value: 'seed 7d', label: '7d' }),
      expect.objectContaining({ value: 'seed 14d', label: '14d' }),
      expect.objectContaining({ value: 'seed 30d', label: '30d' }),
      expect.objectContaining({ value: 'seed 90d', label: '90d' }),
    ]);
    expect(getArgumentCompletions('seed 1')).toEqual([
      expect.objectContaining({ value: 'seed 1d', label: '1d' }),
      expect.objectContaining({ value: 'seed 14d', label: '14d' }),
    ]);
    expect(getArgumentCompletions('seed 14d ')).toBeNull();

    const provider = await installedAutocompleteProvider(command, dir);
    const subcommandLine = '/remembrancer ';
    const subcommandSuggestions = await provider.getSuggestions(
      [subcommandLine],
      0,
      subcommandLine.length,
      { signal: new AbortController().signal },
    );
    if (!subcommandSuggestions) throw new Error('Pi returned no subcommand completions');
    const seed = subcommandSuggestions.items.find(
      (item: { label: string }) => item.label === 'seed',
    );
    if (!seed) throw new Error('Pi returned no seed completion');
    expect(
      provider.applyCompletion(
        [subcommandLine],
        0,
        subcommandLine.length,
        seed,
        subcommandSuggestions.prefix,
      ).lines[0],
    ).toBe('/remembrancer seed ');

    const durationLine = '/remembrancer seed ';
    const durationSuggestions = await provider.getSuggestions(
      [durationLine],
      0,
      durationLine.length,
      { signal: new AbortController().signal },
    );
    if (!durationSuggestions) throw new Error('Pi returned no duration completions');
    const duration = durationSuggestions.items.find(
      (item: { label: string }) => item.label === '14d',
    );
    if (!duration) throw new Error('Pi returned no 14d completion');
    expect(durationSuggestions.prefix).toBe('seed ');
    expect(
      provider.applyCompletion(
        [durationLine],
        0,
        durationLine.length,
        duration,
        durationSuggestions.prefix,
      ).lines[0],
    ).toBe('/remembrancer seed 14d');
  } finally {
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects invalid slash command arguments without starting a model turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-command-invalid-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = join(dir, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  mkdirSync(agentDir, { recursive: true });
  const extension = fakeExtension();
  remembrancer(extension.api);
  const command = extension.commands.get('remembrancer');
  if (!command) throw new Error('Remembrancer command was not registered');
  const notify = vi.fn();
  const context = contextFor(dir, undefined, dir, false, { notify });

  try {
    for (const args of [
      'review 14d',
      'seed',
      'seed 14d extra',
      'seed 0d',
      `seed ${'9'.repeat(400)}d`,
      'help extra',
    ]) {
      await command.handler(args, context);
    }
    expect(extension.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(6);
    for (const call of notify.mock.calls) {
      expect(call[0]).toContain('Usage: /remembrancer');
      expect(call[1]).toBe('error');
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not register or read session history when disabled by settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-disabled-'));
  const agentDir = join(dir, 'agent');
  const stateDir = join(dir, 'state');
  const file = join(dir, 'session.jsonl');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['XDG_STATE_HOME'] = stateDir;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ 'pi-remembrancer': { disabled: true } }),
  );
  writeFileSync(file, 'session history should not be read');

  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    vi.mocked(readFileSync).mockClear();
    await start({}, contextFor(dir, file));
    expect(extension.tools).toEqual([]);
    const command = extension.commands.get('remembrancer');
    if (!command) throw new Error('Remembrancer command was not registered');
    const notify = vi.fn();
    await command.handler('seed 14d', contextFor(dir, file, dirname(file), false, { notify }));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('disabled'), 'warning');
    expect(extension.sendUserMessage).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalledWith(file, 'utf8');
    expect(existsSync(join(stateDir, 'pi-remembrancer', 'checkpoints.sqlite3'))).toBe(false);
  } finally {
    await shutdown({}, contextFor(dir, file));
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects a seed while Pi is busy without sending a user message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-command-busy-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  mkdirSync(join(dir, 'agent'), { recursive: true });
  const extension = fakeExtension();
  remembrancer(extension.api);
  const command = extension.commands.get('remembrancer');
  if (!command) throw new Error('Remembrancer command was not registered');
  const notify = vi.fn();

  try {
    await command.handler(
      'seed 14d',
      contextFor(dir, undefined, dir, false, { isIdle: () => false, notify }),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Pi is busy'), 'warning');
    expect(extension.sendUserMessage).not.toHaveBeenCalled();
  } finally {
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects a seed while a local review is open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-command-open-review-'));
  const stateDir = join(dir, 'state');
  const file = join(dir, 'session.jsonl');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = stateDir;
  mkdirSync(join(dir, 'agent'), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'message',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'review this' },
      }),
      '',
    ].join('\n'),
  );
  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');
  const notify = vi.fn();
  const context = contextFor(dir, file, dir, false, { notify });

  try {
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register the review tool');
    const review = decode(
      await tool.execute('begin', { action: 'begin' }, undefined, undefined, context),
    );
    const command = extension.commands.get('remembrancer');
    if (!command) throw new Error('Remembrancer command was not registered');
    await command.handler('seed 14d', context);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('already open'), 'warning');
    expect(extension.sendUserMessage).not.toHaveBeenCalled();
    await tool.execute(
      'cancel',
      { action: 'cancel', batch: review.batch },
      undefined,
      undefined,
      context,
    );
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('ignores the legacy disable and depth environment variables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-env-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousDisabled = process.env['PI_REMEMBRANCER_DISABLED'];
  const previousDepth = process.env['PI_SUBAGENT_DEPTH'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['PI_REMEMBRANCER_DISABLED'] = '1';
  process.env['PI_SUBAGENT_DEPTH'] = '1';
  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, contextFor(dir));
    expect(extension.tools).toHaveLength(1);
  } finally {
    await shutdown({}, contextFor(dir));
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousDisabled === undefined) delete process.env['PI_REMEMBRANCER_DISABLED'];
    else process.env['PI_REMEMBRANCER_DISABLED'] = previousDisabled;
    if (previousDepth === undefined) delete process.env['PI_SUBAGENT_DEPTH'];
    else process.env['PI_SUBAGENT_DEPTH'] = previousDepth;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('releases an open review across a fresh disabled runtime without advancing checkpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-reload-'));
  const agentDir = join(dir, 'agent');
  const stateDir = join(dir, 'state');
  const settingsFile = join(agentDir, 'settings.json');
  const file = join(dir, 'session.jsonl');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['XDG_STATE_HOME'] = stateDir;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-01-30',
        message: { role: 'user', content: 'Review this session' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'answer',
        parentId: 'root',
        timestamp: '2026-01-30',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one commitment' }] },
      }),
      '',
    ].join('\n'),
  );

  const context = contextFor(dir, file);
  const enabledSettings = JSON.stringify({ 'pi-remembrancer': { disabled: false } });
  const disabledSettings = JSON.stringify({ 'pi-remembrancer': { disabled: true } });
  writeFileSync(settingsFile, enabledSettings);
  const firstRuntime = fakeExtension();
  remembrancer(firstRuntime.api);
  const firstStart = firstRuntime.handlers.get('session_start');
  const firstShutdown = firstRuntime.handlers.get('session_shutdown');
  if (!firstStart || !firstShutdown)
    throw new Error('First runtime did not register its lifecycle');

  let secondShutdown: Handler | undefined;
  let thirdShutdown: Handler | undefined;
  try {
    await firstStart({}, context);
    const firstTool = firstRuntime.tools[0];
    if (!firstTool) throw new Error('First runtime did not register the review tool');
    const firstReview = decode(
      await firstTool.execute('call-1', { action: 'begin' }, undefined, undefined, context),
    );
    expect(firstReview.capturedTips).toBe(1);
    expect(expandEvidenceGroups(firstReview)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: 'answer',
          text: 'one commitment',
          offset: 0,
          continues: false,
        }),
      ]),
    );

    await firstShutdown({}, context);
    writeFileSync(settingsFile, disabledSettings);
    const secondRuntime = fakeExtension();
    remembrancer(secondRuntime.api);
    const secondStart = secondRuntime.handlers.get('session_start');
    secondShutdown = secondRuntime.handlers.get('session_shutdown');
    if (!secondStart || !secondShutdown)
      throw new Error('Second runtime did not register its lifecycle');
    await secondStart({}, context);
    expect(secondRuntime.tools).toEqual([]);
    await secondShutdown({}, context);

    writeFileSync(settingsFile, enabledSettings);
    const thirdRuntime = fakeExtension();
    remembrancer(thirdRuntime.api);
    const thirdStart = thirdRuntime.handlers.get('session_start');
    thirdShutdown = thirdRuntime.handlers.get('session_shutdown');
    if (!thirdStart || !thirdShutdown)
      throw new Error('Third runtime did not register its lifecycle');
    await thirdStart({}, context);
    const thirdTool = thirdRuntime.tools[0];
    if (!thirdTool) throw new Error('Third runtime did not register the review tool');
    const resumedReview = decode(
      await thirdTool.execute('call-2', { action: 'begin' }, undefined, undefined, context),
    );
    expect(resumedReview.capturedTips).toBe(1);
    expect(expandEvidenceGroups(resumedReview)).toEqual(expandEvidenceGroups(firstReview));
    await thirdTool.execute(
      'call-3',
      { action: 'cancel', batch: resumedReview.batch as string },
      undefined,
      undefined,
      context,
    );
  } finally {
    await thirdShutdown?.({}, context);
    await secondShutdown?.({}, context);
    await firstShutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['recordBytes', 'sourceEntries', 'sourceTextBytes', 'sourceBranches'] as const)(
  'preserves persisted coverage on %s failure and retries a repaired source',
  async (limit) => {
    const dir = mkdtempSync(join(tmpdir(), 'remembrancer-source-limit-'));
    const previousState = process.env['XDG_STATE_HOME'];
    const previousAgent = process.env['PI_CODING_AGENT_DIR'];
    process.env['XDG_STATE_HOME'] = join(dir, 'state');
    process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
    const file = join(dir, 'session.jsonl');
    const header = { type: 'session', id: 'session' };
    const message = (id: string, parentId: string | null, content = id) => ({
      type: 'message',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content },
    });
    const save = (...records: unknown[]) =>
      writeFileSync(
        file,
        [header, ...records].map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
    save(message('old', null));
    const extension = fakeExtension();
    remembrancer(extension.api);
    const context = contextFor(dir, file);
    const shutdown = extension.handlers.get('session_shutdown')!;
    const state = () => {
      const store = new CheckpointStore(
        join(dir, 'state', 'pi-remembrancer', 'checkpoints.sqlite3'),
      );
      try {
        return { sources: store.sources(), reviewed: store.reviewed() };
      } finally {
        store.close();
      }
    };
    const original = REVIEW_LIMITS[limit];
    try {
      await extension.handlers.get('session_start')!({}, context);
      const tool = extension.tools[0]!;
      const call = async (action: string, batch?: string, seed?: string) =>
        decode(
          await tool.execute(
            'call',
            { action, ...(action === 'finish' ? { proposals: [] } : {}), batch, seed },
            undefined,
            undefined,
            context,
          ),
        );
      const first = await call('begin');
      await call('finish', first.batch);
      const before = state();
      REVIEW_LIMITS[limit] = {
        recordBytes: 200,
        sourceEntries: 2,
        sourceTextBytes: 10,
        sourceBranches: 1,
      }[limit];
      if (limit === 'sourceBranches')
        save(message('old', null), message('new', 'old'), message('fork', 'old'));
      else if (limit === 'sourceEntries')
        save(message('old', null), message('new', 'old'), message('third', 'new'));
      else save(message('old', null), message('new', 'old', 'x'.repeat(300)));
      const failed = await call('begin', undefined, '14d');
      expect(expandEvidenceGroups(failed)).toEqual([]);
      expect(failed.incomplete).toBe(true);
      expect(failed.warnings?.join()).toMatch(/limit exceeded/);
      await expect(call('finish', failed.batch)).rejects.toThrow(/incomplete/);
      await call('cancel', failed.batch);
      expect(state()).toEqual(before);
      save(message('old', null), message('new', 'old'));
      const retry = await call('begin');
      expect(expandEvidenceGroups(retry).map((entry) => entry.entryId)).toEqual(['new']);
      await call('finish', retry.batch);
      expect(state().reviewed.map((tip) => tip.entryId)).toEqual(['old', 'new']);
    } finally {
      REVIEW_LIMITS[limit] = original;
      await shutdown({}, context);
      if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = previousState;
      if (previousAgent === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgent;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each(['discovery', 'prepare', 'source'] as const)(
  'aborts %s exhaustion without state changes and releases the lock for retry',
  async (phase) => {
    const dir = mkdtempSync(join(tmpdir(), 'remembrancer-abort-'));
    const previousState = process.env['XDG_STATE_HOME'];
    const previousAgent = process.env['PI_CODING_AGENT_DIR'];
    process.env['XDG_STATE_HOME'] = join(dir, 'state');
    process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
    const file = join(dir, 'session.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 'session' }),
        JSON.stringify({
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'complete evidence' },
        }),
        '',
      ].join('\n'),
    );
    const extension = fakeExtension();
    remembrancer(extension.api);
    const context = contextFor(dir, file);
    const start = extension.handlers.get('session_start')!;
    const shutdown = extension.handlers.get('session_shutdown')!;
    const state = () => {
      const store = new CheckpointStore(
        join(dir, 'state', 'pi-remembrancer', 'checkpoints.sqlite3'),
      );
      try {
        return { sources: store.sources(), reviewed: store.reviewed() };
      } finally {
        store.close();
      }
    };
    const limit =
      phase === 'discovery'
        ? 'totalEntries'
        : phase === 'prepare'
          ? 'totalBranchEntries'
          : 'sources';
    const original = REVIEW_LIMITS[limit];
    try {
      await start({}, context);
      const before = state();
      const tool = extension.tools[0]!;
      REVIEW_LIMITS[limit] = 0;
      await expect(
        tool.execute('abort', { action: 'begin', seed: '14d' }, undefined, undefined, context),
      ).rejects.toThrow(/Aggregate review/);
      expect(state()).toEqual(before);
      REVIEW_LIMITS[limit] = original;
      const retry = decode(
        await tool.execute(
          'retry',
          { action: 'begin', seed: '14d' },
          undefined,
          undefined,
          context,
        ),
      );
      expect(expandEvidenceGroups(retry).map((entry) => entry.text)).toEqual(['complete evidence']);
      await tool.execute(
        'finish',
        { action: 'finish', proposals: [], batch: retry.batch },
        undefined,
        undefined,
        context,
      );
      expect(state().reviewed.map((tip) => tip.entryId)).toEqual(['root']);
    } finally {
      REVIEW_LIMITS[limit] = original;
      await shutdown({}, context);
      if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = previousState;
      if (previousAgent === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgent;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('pages faithfully, cancels without consuming, persists finish and isolates later appends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = join(dir, 'state');
  const file = join(dir, 'session.jsonl');
  const longText = '🌱漢字'.repeat(6_020);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-01-30',
        message: { role: 'user', content: 'Review this session' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'answer',
        parentId: 'root',
        timestamp: '2026-01-30',
        message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
      }),
      '',
    ].join('\n'),
  );

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, file);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its runtime contract');

  try {
    writeFileSync(join(dir, 'unenrolled.jsonl'), 'invalid history, not eligible');
    vi.mocked(readFileSync).mockClear();
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register its review tool');
    expect(readFileSync).not.toHaveBeenCalled();
    const firstPage = decode(
      await tool.execute('call-1', { action: 'begin' }, undefined, undefined, context),
    );
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, '{rewritten after begin\n');
    expect(firstPage.capturedTips).toBe(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.groups).toEqual(expect.any(Array));

    const batch = firstPage.batch;
    expect(typeof batch).toBe('string');
    await expect(
      tool.execute(
        'call-2',
        { action: 'finish', proposals: [], batch: batch as string },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/Read all evidence pages/);

    const secondPage = decode(
      await tool.execute(
        'call-3',
        { action: 'next', batch: batch as string },
        undefined,
        undefined,
        context,
      ),
    );
    expect(secondPage.hasMore).toBe(false);
    const firstPageEntries = expandEvidenceGroups(firstPage);
    const secondPageEntries = expandEvidenceGroups(secondPage);
    expect(firstPageEntries[0]).toMatchObject({
      file,
      sessionId: 'session',
      cwd: dir,
      branchId: 'answer',
      reviewedThrough: null,
    });
    expect(secondPage.groups?.[0]).toEqual(
      expect.objectContaining({
        file,
        sessionId: 'session',
        cwd: dir,
        branchId: 'answer',
        reviewedThrough: null,
      }),
    );
    const chunks = [...firstPageEntries, ...secondPageEntries].filter(
      (entry) => entry.entryId === 'answer',
    );
    expect(chunks.map((entry) => entry.text).join('')).toBe(longText);
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks[1]?.offset).toBe(chunks[0]!.text.length);
    expect(chunks.map((entry) => entry.continues)).toEqual([true, false]);
    writeFileSync(file, original);
    appendFileSync(
      file,
      JSON.stringify({
        type: 'message',
        id: 'later',
        parentId: 'answer',
        message: { role: 'user', content: 'later' },
      }) + '\n',
    );

    const finished = decode(
      await tool.execute(
        'call-4',
        { action: 'finish', proposals: [], batch: batch as string },
        undefined,
        undefined,
        context,
      ),
    );
    expect(finished).toEqual({ finished: true, reviewedTips: 1 });
    await shutdown({}, context);
    await start({}, context);
    const call = async (action: string, token?: string) =>
      decode(
        await tool.execute(
          'call',
          {
            action,
            ...(action === 'finish' ? { proposals: [] } : {}),
            ...(token === undefined ? {} : { batch: token }),
          },
          undefined,
          undefined,
          context,
        ),
      );
    const later = await call('begin');
    expect(expandEvidenceGroups(later).map((entry) => entry.text)).toEqual(['later']);
    await expect(call('next', 'wrong-token')).rejects.toThrow(/matching open review/);
    await expect(call('begin')).rejects.toThrow(/already open/);
    await call('cancel', later.batch);
    await shutdown({}, context);
    await start({}, context);
    const retry = await call('begin');
    expect(retry.groups).toEqual(later.groups);
    await call('finish', retry.batch);
    const empty = await call('begin');
    expect(empty.groups).toEqual([]);
    expect(empty.capturedTips).toBe(0);
    await call('cancel', empty.batch);
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  ['escaped controls', '\u0000'.repeat(12_000)],
  ['a surrogate pair at the character limit', `${'a'.repeat(47_999)}🌱tail`],
] as const)('bounds complete JSON pages and reconstructs %s text exactly', async (kind, text) => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-response-size-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = join(dir, 'state');
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'evidence',
        parentId: null,
        timestamp: '2026-01-30T00:00:00.000Z',
        message: { role: 'user', content: text },
      }),
      '',
    ].join('\n'),
  );

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, file);
  const start = extension.handlers.get('session_start')!;
  const shutdown = extension.handlers.get('session_shutdown')!;
  try {
    await start({}, context);
    const tool = extension.tools[0]!;
    const first = decode(
      await tool.execute('size-begin', { action: 'begin' }, undefined, undefined, context),
    );
    const pages = [first];
    let current = first;
    while (current.hasMore) {
      if (pages.length >= 10) throw new Error('Response pagination did not finish');
      current = decode(
        await tool.execute(
          'size-next',
          { action: 'next', batch: first.batch },
          undefined,
          undefined,
          context,
        ),
      );
      pages.push(current);
    }

    for (const response of pages) {
      expect(response).not.toHaveProperty('entries');
      expect(response.groups).toHaveLength(1);
      expect(response.groups?.[0]).toMatchObject({
        file,
        sessionId: 'session',
        cwd: dir,
        branchId: 'evidence',
        reviewedThrough: null,
      });
    }
    const entries = pages.flatMap(expandEvidenceGroups);
    expect(entries.map((entry) => entry.text).join('')).toBe(text);
    let offset = 0;
    for (const entry of entries) {
      expect(entry.offset).toBe(offset);
      offset += entry.text.length;
      expect(entry.continues).toBe(offset < text.length);
    }
    expect(entries.at(-1)?.continues).toBe(false);

    if (kind === 'a surrogate pair at the character limit') {
      expect(entries[0]?.text.length).toBe(47_999);
      expect(entries[0]!.text.charCodeAt(entries[0]!.text.length - 1)).not.toBeGreaterThanOrEqual(
        0xd800,
      );
      expect(entries[1]?.text.startsWith('🌱')).toBe(true);
      expect(entries[1]!.text.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    } else {
      expect(entries[0]?.text.length).toBeLessThan(text.length);
    }

    decode(
      await tool.execute(
        'size-cancel',
        { action: 'cancel', batch: first.batch },
        undefined,
        undefined,
        context,
      ),
    );
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fails oversized group metadata and begin envelopes without changing checkpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-response-metadata-'));
  const state = join(dir, 'state');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = state;
  const file = join(dir, 'session.jsonl');
  const writeSession = (cwd: string, unknownTimestamps: boolean) => {
    const rows: unknown[] = [{ type: 'session', id: 'session', cwd }];
    let parentId: string | null = null;
    const count = unknownTimestamps ? 600 : 1;
    for (let index = 0; index < count; index++) {
      const row: Record<string, unknown> = {
        type: 'message',
        id: `entry-${String(index).padStart(4, '0')}`,
        parentId,
        message: { role: 'user', content: `evidence-${index}` },
      };
      if (!unknownTimestamps) row['timestamp'] = '2026-01-30T00:00:00.000Z';
      rows.push(row);
      parentId = row['id'] as string;
    }
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  };
  const context = contextFor(dir, file);
  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start')!;
  const shutdown = extension.handlers.get('session_shutdown')!;
  const checkpointPath = join(state, 'pi-remembrancer', 'checkpoints.sqlite3');
  const persisted = () => {
    const store = new CheckpointStore(checkpointPath);
    try {
      return { sources: store.sources(), reviewed: store.reviewed() };
    } finally {
      store.close();
    }
  };

  try {
    writeSession('\u0000'.repeat(9_000), false);
    await start({}, context);
    const tool = extension.tools[0]!;
    const before = persisted();
    await expect(
      tool.execute('large-group-metadata', { action: 'begin' }, undefined, undefined, context),
    ).rejects.toThrow(/complete evidence entry.*UTF-8 limit/);
    expect(persisted()).toEqual(before);

    writeSession(dir, true);
    await expect(
      tool.execute('large-begin-envelope', { action: 'begin' }, undefined, undefined, context),
    ).rejects.toThrow(/complete evidence entry.*UTF-8 limit/);
    expect(persisted()).toEqual(before);

    writeSession(dir, false);
    const begin = decode(
      await tool.execute('metadata-retry', { action: 'begin' }, undefined, undefined, context),
    );
    expect(begin.groups?.[0]?.entries).toHaveLength(1);
    expect(persisted()).toEqual(before);
    decode(
      await tool.execute(
        'metadata-cancel',
        { action: 'cancel', batch: begin.batch },
        undefined,
        undefined,
        context,
      ),
    );
    expect(persisted()).toEqual(before);
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps structured warnings in frozen details across every successful action without changing model JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-details-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = join(dir, 'state');
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: 'not-a-date',
        message: { role: 'user', content: 'prior context' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'selected',
        parentId: 'root',
        timestamp: '2026-01-30T00:00:00.000Z',
        message: { role: 'user', content: 'x'.repeat(48_050) },
      }),
      '',
    ].join('\n'),
  );

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, file);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  const warning: ResultWarning = {
    message: `${file}: selection timestamp unknown for root`,
    sources: [file],
    reason: 'selection timestamp unknown for root',
    kind: 'unknown-timestamp',
  };
  const detailsOf = (response: unknown) => (response as ToolResponse).details;
  try {
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register its review tool');

    const beginResponse = await tool.execute(
      'details-begin',
      { action: 'begin' },
      undefined,
      undefined,
      context,
    );
    const begin = decode(beginResponse);
    expect(begin).toMatchObject({
      status: 'review',
      incomplete: false,
      warnings: [warning.message],
      coverageChanged: true,
      capturedTips: 1,
      hasMore: true,
    });
    expect((beginResponse as ToolResponse).content[0].text).not.toContain('unknown-timestamp');
    expect(detailsOf(beginResponse)).toEqual({
      action: 'begin',
      batch: begin.batch,
      incomplete: false,
      warnings: [warning],
      coverageChanged: true,
    });

    const nextResponse = await tool.execute(
      'details-next',
      { action: 'next', batch: begin.batch },
      undefined,
      undefined,
      context,
    );
    const next = decode(nextResponse);
    expect(next).toMatchObject({ batch: begin.batch, hasMore: false });
    expect(detailsOf(nextResponse)).toEqual({
      action: 'next',
      batch: begin.batch,
      incomplete: false,
      warnings: [warning],
      coverageChanged: true,
    });

    const selected = {
      sessionId: 'session',
      branchId: 'selected',
      entryId: 'selected',
      editId: null,
    };
    const contextResponse = await tool.execute(
      'details-context',
      { action: 'context', batch: begin.batch, selected },
      undefined,
      undefined,
      context,
    );
    const contextResult = decode(contextResponse);
    expect(contextResult).toMatchObject({
      batch: begin.batch,
      contextOnly: true,
      groups: [
        {
          sessionId: 'session',
          branchId: 'selected',
          entries: [{ entryId: 'root', text: 'prior context' }],
        },
      ],
    });
    expect(detailsOf(contextResponse)).toEqual({
      action: 'context',
      batch: begin.batch,
      incomplete: false,
      warnings: [warning],
      coverageChanged: true,
    });

    const finishResponse = await tool.execute(
      'details-finish',
      { action: 'finish', proposals: [], batch: begin.batch },
      undefined,
      undefined,
      context,
    );
    expect(decode(finishResponse)).toEqual({ finished: true, reviewedTips: 1 });
    expect((finishResponse as ToolResponse).content[0].text).toBe(
      '{"finished":true,"reviewedTips":1}',
    );
    expect(detailsOf(finishResponse)).toEqual({
      action: 'finish',
      batch: begin.batch,
      incomplete: false,
      warnings: [warning],
      coverageChanged: true,
    });

    const secondResponse = await tool.execute(
      'details-informational-finish-begin',
      { action: 'begin' },
      undefined,
      undefined,
      context,
    );
    const second = decode(secondResponse);
    expect(second).toMatchObject({ status: 'already-covered', warnings: [warning.message] });
    const secondFinishResponse = await tool.execute(
      'details-informational-finish',
      { action: 'finish', proposals: [], batch: second.batch },
      undefined,
      undefined,
      context,
    );
    expect(decode(secondFinishResponse)).toEqual({ finished: true, reviewedTips: 0 });
    expect(detailsOf(secondFinishResponse)).toEqual({
      action: 'finish',
      batch: second.batch,
      incomplete: false,
      warnings: [warning],
      coverageChanged: false,
    });

    const thirdResponse = await tool.execute(
      'details-cancel-begin',
      { action: 'begin' },
      undefined,
      undefined,
      context,
    );
    const third = decode(thirdResponse);
    expect(third).toMatchObject({ status: 'already-covered', warnings: [warning.message] });
    const cancelResponse = await tool.execute(
      'details-cancel',
      { action: 'cancel', batch: third.batch },
      undefined,
      undefined,
      context,
    );
    expect(decode(cancelResponse)).toEqual({ cancelled: true });
    expect((cancelResponse as ToolResponse).content[0].text).toBe('{"cancelled":true}');
    expect(detailsOf(cancelResponse)).toEqual({
      action: 'cancel',
      batch: third.batch,
      incomplete: false,
      warnings: [warning],
      coverageChanged: false,
    });
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('renders registered execute results with coverage and branch-tip states', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-render-integration-'));
  const archive = join(dir, 'archive');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  mkdirSync(archive, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = join(dir, 'state');
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const writeSession = (file: string, id: string, messageId: string, text: string) =>
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id, cwd: dir }),
        JSON.stringify({
          type: 'message',
          id: messageId,
          parentId: null,
          timestamp: recent,
          message: { role: 'user', content: text },
        }),
        '',
      ].join('\n'),
    );
  const writeEmptySession = (file: string, id: string) =>
    writeFileSync(file, [JSON.stringify({ type: 'session', id, cwd: dir }), ''].join('\n'));
  const current = join(archive, 'ordinary.jsonl');
  writeSession(current, 'session', 'ordinary', 'ordinary evidence');

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, current, archive);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its runtime contract');

  try {
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register the review tool');

    const ordinaryBeginResponse = await tool.execute(
      'render-ordinary-begin',
      { action: 'begin' },
      undefined,
      undefined,
      context,
    );
    const ordinaryBegin = decode(ordinaryBeginResponse);
    const ordinaryFinishResponse = await tool.execute(
      'render-ordinary-finish',
      { action: 'finish', proposals: [], batch: ordinaryBegin.batch },
      undefined,
      undefined,
      context,
    );
    expect(decode(ordinaryFinishResponse)).toEqual({ finished: true, reviewedTips: 1 });
    expect((ordinaryFinishResponse as ToolResponse).details.coverageChanged).toBe(true);
    expect(renderSummary(tool, ordinaryFinishResponse, 'finish')).toContain(
      'Finished · 1 branch tip recorded',
    );

    const alreadyCoveredBeginResponse = await tool.execute(
      'render-already-covered-begin',
      { action: 'begin' },
      undefined,
      undefined,
      context,
    );
    const alreadyCoveredBegin = decode(alreadyCoveredBeginResponse);
    const alreadyCoveredFinishResponse = await tool.execute(
      'render-already-covered-finish',
      { action: 'finish', proposals: [], batch: alreadyCoveredBegin.batch },
      undefined,
      undefined,
      context,
    );
    expect(decode(alreadyCoveredFinishResponse)).toEqual({ finished: true, reviewedTips: 0 });
    expect((alreadyCoveredFinishResponse as ToolResponse).details.coverageChanged).toBe(false);
    const alreadyCoveredSummary = renderSummary(tool, alreadyCoveredFinishResponse, 'finish');
    expect(alreadyCoveredSummary).toContain('Finished · no coverage changes');
    expect(alreadyCoveredSummary).not.toContain('Finished · 0 branch tips');

    writeEmptySession(join(archive, 'empty.jsonl'), 'empty');
    const zeroTipBeginResponse = await tool.execute(
      'render-zero-tip-seed-begin',
      { action: 'begin', seed: '14d' },
      undefined,
      undefined,
      context,
    );
    const zeroTipBegin = decode(zeroTipBeginResponse);
    expect(zeroTipBegin.groups).toEqual([]);
    const zeroTipFinishResponse = await tool.execute(
      'render-zero-tip-seed-finish',
      { action: 'finish', proposals: [], batch: zeroTipBegin.batch },
      undefined,
      undefined,
      context,
    );
    expect(decode(zeroTipFinishResponse)).toMatchObject({
      finished: true,
      reviewedTips: 0,
      status: 'coverage-finished',
      coverageChanged: true,
    });
    expect((zeroTipFinishResponse as ToolResponse).details.coverageChanged).toBe(true);
    expect(renderSummary(tool, zeroTipFinishResponse, 'finish')).toContain(
      'Finished · coverage saved · 0 branch tips',
    );

    writeSession(join(archive, 'seeded.jsonl'), 'seeded', 'seeded-message', 'seeded evidence');
    const seededBeginResponse = await tool.execute(
      'render-seeded-begin',
      { action: 'begin', seed: '14d' },
      undefined,
      undefined,
      context,
    );
    const seededBegin = decode(seededBeginResponse);
    expect(expandEvidenceGroups(seededBegin).map((entry) => entry.text)).toEqual([
      'seeded evidence',
    ]);
    const seededFinishResponse = await tool.execute(
      'render-seeded-finish',
      { action: 'finish', proposals: [], batch: seededBegin.batch },
      undefined,
      undefined,
      context,
    );
    expect(decode(seededFinishResponse)).toMatchObject({
      finished: true,
      reviewedTips: 1,
      status: 'coverage-finished',
      coverageChanged: true,
    });
    expect(renderSummary(tool, seededFinishResponse, 'finish')).toContain(
      'Finished · coverage saved · 1 branch tip',
    );

    writeSession(join(archive, 'partial.jsonl'), 'partial', 'partial-message', 'partial evidence');
    writeFileSync(join(archive, 'broken.jsonl'), '{broken\n');
    const partialBeginResponse = await tool.execute(
      'render-partial-begin',
      { action: 'begin', seed: '14d' },
      undefined,
      undefined,
      context,
    );
    const partialBegin = decode(partialBeginResponse);
    expect(partialBegin.incomplete).toBe(true);
    await expect(
      tool.execute(
        'render-partial-finish',
        { action: 'finish', proposals: [], batch: partialBegin.batch },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/incomplete/);
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not enroll a newly referenced current source after ordinary preparation fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-enrollment-failure-'));
  const state = join(dir, 'state');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = state;
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '{broken\n');

  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');
  const startupContext = contextFor(dir);
  const reviewContext = contextFor(dir, file, dir);
  const checkpointPath = join(state, 'pi-remembrancer', 'checkpoints.sqlite3');
  const persisted = () => {
    const store = new CheckpointStore(checkpointPath);
    try {
      return { sources: store.sources(), reviewed: store.reviewed() };
    } finally {
      store.close();
    }
  };
  const repair = () =>
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
        JSON.stringify({
          type: 'message',
          id: 'repaired',
          parentId: null,
          timestamp: '2026-01-30T00:00:00.000Z',
          message: { role: 'user', content: 'repaired evidence' },
        }),
        '',
      ].join('\n'),
    );

  try {
    await start({}, startupContext);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register the review tool');
    const call = async (action: string, batch?: string) =>
      decode(
        await tool.execute(
          'enrollment-failure',
          { action, ...(action === 'finish' ? { proposals: [] } : {}), batch },
          undefined,
          undefined,
          reviewContext,
        ),
      );

    const failed = await call('begin');
    expect(failed.groups).toEqual([]);
    expect(failed.incomplete).toBe(true);
    await expect(call('finish', failed.batch)).rejects.toThrow(/incomplete/);
    await call('cancel', failed.batch);
    expect(persisted()).toEqual({ sources: [], reviewed: [] });

    repair();
    const retry = await call('begin');
    expect(expandEvidenceGroups(retry).map((entry) => entry.text)).toEqual(['repaired evidence']);
    await call('finish', retry.batch);
    expect(persisted()).toEqual({
      sources: [{ sessionId: 'session', file, seedSince: null }],
      reviewed: [{ sessionId: 'session', file, entryId: 'repaired', since: null }],
    });
  } finally {
    await shutdown({}, reviewContext);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('seeds every default Pi archive bucket, stages new sources, and keeps ordinary review enrollment-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-seed-'));
  const archiveRoot = join(dir, 'configured-sessions');
  const archive = join(archiveRoot, '--current--');
  const otherArchive = join(archiveRoot, '--other--');
  const state = join(dir, 'state');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  mkdirSync(archive, { recursive: true });
  mkdirSync(otherArchive, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = state;
  const recent = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const writeSession = (file: string, id: string, messageId: string, text: string) =>
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id, cwd: dir }),
        JSON.stringify({
          type: 'message',
          id: messageId,
          parentId: null,
          timestamp: recent,
          message: { role: 'user', content: text },
        }),
        '',
      ].join('\n'),
    );
  const current = join(archive, 'current.jsonl');
  const worker = join(otherArchive, 'worker.jsonl');
  writeSession(current, 'session', 'current', 'current commitment');
  writeSession(worker, 'worker', 'worker-message', 'worker commitment');

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, current, archive, true);
  const checkpointPath = join(state, 'pi-remembrancer', 'checkpoints.sqlite3');
  const persisted = () => {
    const store = new CheckpointStore(checkpointPath);
    try {
      return { sources: store.sources(), reviewed: store.reviewed() };
    } finally {
      store.close();
    }
  };
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register the review tool');
    const legacyContext = contextFor(dir, current, archive, true);
    Reflect.deleteProperty(legacyContext.sessionManager, 'usesDefaultSessionDir');
    const beforeRejectedSeed = persisted();
    vi.mocked(readFileSync).mockClear();
    await expect(
      tool.execute(
        'legacy-seed',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        legacyContext,
      ),
    ).rejects.toThrow('Upgrade Pi to use Remembrancer seed');
    expect(readFileSync).not.toHaveBeenCalledWith(current, 'utf8');
    expect(readFileSync).not.toHaveBeenCalledWith(worker, 'utf8');
    expect(persisted()).toEqual(beforeRejectedSeed);

    const ordinary = decode(
      await tool.execute('ordinary', { action: 'begin' }, undefined, undefined, legacyContext),
    );
    expect(expandEvidenceGroups(ordinary).map((entry) => entry.text)).toEqual([
      'current commitment',
    ]);
    await tool.execute(
      'ordinary-cancel',
      { action: 'cancel', batch: ordinary.batch },
      undefined,
      undefined,
      context,
    );

    const cancelledSeed = decode(
      await tool.execute(
        'cancelled-seed',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(expandEvidenceGroups(cancelledSeed).map((entry) => entry.text)).toEqual([
      'current commitment',
      'worker commitment',
    ]);
    await tool.execute(
      'cancel-seed',
      { action: 'cancel', batch: cancelledSeed.batch },
      undefined,
      undefined,
      context,
    );
    const ordinaryAfterCancel = decode(
      await tool.execute(
        'ordinary-after-cancel',
        { action: 'begin' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(expandEvidenceGroups(ordinaryAfterCancel).map((entry) => entry.text)).toEqual([
      'current commitment',
    ]);
    await tool.execute(
      'cancel-ordinary-after-cancel',
      { action: 'cancel', batch: ordinaryAfterCancel.batch },
      undefined,
      undefined,
      context,
    );

    const seedResponse = await tool.execute(
      'seed',
      { action: 'begin', seed: '14d' },
      undefined,
      undefined,
      context,
    );
    const seed = decode(seedResponse);
    expect(seed.requestedSince).toBeTruthy();
    expect((seedResponse as ToolResponse).details).toMatchObject({
      action: 'begin',
      batch: seed.batch,
      seed: '14d',
      requestedSince: seed.requestedSince,
      incomplete: false,
      warnings: [],
    });
    expect(expandEvidenceGroups(seed).map((entry) => entry.text)).toEqual([
      'current commitment',
      'worker commitment',
    ]);
    expect(
      expandEvidenceGroups(seed).map((entry) => [
        entry.sessionId,
        entry.branchId,
        entry.entryId,
        entry.editId,
      ]),
    ).toEqual([
      ['session', 'current', 'current', null],
      ['worker', 'worker-message', 'worker-message', null],
    ]);
    const finished = decode(
      await tool.execute(
        'seed-finish',
        { action: 'finish', proposals: [], batch: seed.batch },
        undefined,
        undefined,
        context,
      ),
    );
    expect(finished).toMatchObject({
      finished: true,
      reviewedTips: 2,
      status: 'coverage-finished',
      coverageChanged: true,
      requestedSince: seed.requestedSince,
    });
    expect(persisted()).toEqual({
      sources: [
        { sessionId: 'session', file: current, seedSince: seed.requestedSince },
        { sessionId: 'worker', file: worker, seedSince: seed.requestedSince },
      ],
      reviewed: [
        { sessionId: 'session', file: current, entryId: 'current', since: seed.requestedSince },
        {
          sessionId: 'worker',
          file: worker,
          entryId: 'worker-message',
          since: seed.requestedSince,
        },
      ],
    });

    const persistedBeforeEmpty = persisted();
    const emptyExpansion = decode(
      await tool.execute(
        'empty-expansion',
        { action: 'begin', seed: '30d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(emptyExpansion.groups).toEqual([]);
    expect(emptyExpansion.status).toBe('coverage-pending');
    await tool.execute(
      'empty-expansion-cancel',
      { action: 'cancel', batch: emptyExpansion.batch },
      undefined,
      undefined,
      context,
    );
    expect(persisted()).toEqual(persistedBeforeEmpty);
    const retriedEmptyExpansion = decode(
      await tool.execute(
        'empty-expansion-retry',
        { action: 'begin', seed: '30d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(retriedEmptyExpansion.groups).toEqual([]);
    expect(retriedEmptyExpansion.status).toBe('coverage-pending');
    const expanded = decode(
      await tool.execute(
        'empty-expansion-finish',
        { action: 'finish', proposals: [], batch: retriedEmptyExpansion.batch },
        undefined,
        undefined,
        context,
      ),
    );
    expect(expanded).toMatchObject({
      finished: true,
      reviewedTips: 2,
      status: 'coverage-finished',
      coverageChanged: true,
      requestedSince: retriedEmptyExpansion.requestedSince,
    });
    expect(persisted()).toEqual({
      sources: [
        { sessionId: 'session', file: current, seedSince: retriedEmptyExpansion.requestedSince },
        { sessionId: 'worker', file: worker, seedSince: retriedEmptyExpansion.requestedSince },
      ],
      reviewed: [
        {
          sessionId: 'session',
          file: current,
          entryId: 'current',
          since: retriedEmptyExpansion.requestedSince,
        },
        {
          sessionId: 'worker',
          file: worker,
          entryId: 'worker-message',
          since: retriedEmptyExpansion.requestedSince,
        },
      ],
    });
    writeSession(join(archive, 'late.jsonl'), 'late', 'late-message', 'late commitment');

    await shutdown({}, context);
    await start({}, context);
    const retryTool = extension.tools[extension.tools.length - 1]!;
    const next = decode(
      await retryTool.execute(
        'next-seed',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(expandEvidenceGroups(next).map((entry) => entry.text)).toEqual(['late commitment']);
    expect(next.status).toBe('review');
    await retryTool.execute(
      'next-finish',
      { action: 'finish', proposals: [], batch: next.batch },
      undefined,
      undefined,
      context,
    );
    const empty = decode(
      await retryTool.execute(
        'empty-seed',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(empty.groups).toEqual([]);
    expect(empty.status).toBe('already-covered');
    await retryTool.execute(
      'empty-cancel',
      { action: 'cancel', batch: empty.batch },
      undefined,
      undefined,
      context,
    );
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses incomplete identity scope and leaves all coverage unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-identity-'));
  const archive = join(dir, 'archive');
  const state = join(dir, 'state');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  mkdirSync(archive, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = state;
  const recent = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const writeSession = (file: string, id: string, messageId: string, text: string) =>
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id, cwd: dir }),
        JSON.stringify({
          type: 'message',
          id: messageId,
          parentId: null,
          timestamp: recent,
          message: { role: 'user', content: text },
        }),
        '',
      ].join('\n'),
    );
  const enrolled = join(archive, 'enrolled.jsonl');
  const healthy = join(archive, 'healthy.jsonl');
  const blank = join(archive, 'blank.jsonl');
  writeSession(enrolled, 'session', 'enrolled', 'enrolled commitment');
  writeSession(healthy, 'healthy', 'healthy-message', 'healthy commitment');
  writeFileSync(
    blank,
    [
      JSON.stringify({ type: 'session', id: '', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'blank-message',
        parentId: null,
        timestamp: recent,
        message: { role: 'user', content: 'must not select' },
      }),
      '',
    ].join('\n'),
  );

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, enrolled, archive);
  const checkpointPath = join(state, 'pi-remembrancer', 'checkpoints.sqlite3');
  const persisted = () => {
    const store = new CheckpointStore(checkpointPath);
    try {
      return { sources: store.sources(), reviewed: store.reviewed() };
    } finally {
      store.close();
    }
  };
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, context);
    const firstTool = extension.tools[0];
    if (!firstTool) throw new Error('Extension did not register the review tool');
    const first = decode(
      await firstTool.execute(
        'identity-first',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(
      expandEvidenceGroups(first).map((entry) => [
        entry.sessionId,
        entry.branchId,
        entry.entryId,
        entry.editId,
      ]),
    ).toEqual([
      ['session', 'enrolled', 'enrolled', null],
      ['healthy', 'healthy-message', 'healthy-message', null],
    ]);
    expect(first.incomplete).toBe(true);
    await expect(
      firstTool.execute(
        'identity-first-finish',
        { action: 'finish', proposals: [], batch: first.batch },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/incomplete/);
    const firstState = persisted();
    expect(firstState).toEqual({
      sources: [{ sessionId: 'session', file: enrolled, seedSince: null }],
      reviewed: [],
    });

    writeSession(join(archive, 'duplicate.jsonl'), 'session', 'duplicate', 'ambiguous copy');
    await shutdown({}, context);
    await start({}, context);
    const secondTool = extension.tools[extension.tools.length - 1]!;
    const second = decode(
      await secondTool.execute(
        'identity-second',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(expandEvidenceGroups(second).map((entry) => entry.sessionId)).toEqual(['healthy']);
    expect(second.incomplete).toBe(true);
    expect(second.status).toBe('incomplete');
    await expect(
      secondTool.execute(
        'identity-second-finish',
        { action: 'finish', proposals: [], batch: second.batch },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/incomplete/);
    expect(persisted()).toEqual(firstState);
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses healthy seed coverage when archive discovery is incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-partial-'));
  const archive = join(dir, 'archive');
  const state = join(dir, 'state');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  mkdirSync(archive, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = state;
  const recent = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const healthy = join(archive, 'healthy.jsonl');
  writeFileSync(
    healthy,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'healthy-message',
        parentId: null,
        timestamp: recent,
        message: { role: 'user', content: 'healthy commitment' },
      }),
      '',
    ].join('\n'),
  );
  writeFileSync(join(archive, 'broken.jsonl'), '{broken\n');

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, healthy, archive);
  const checkpointPath = join(state, 'pi-remembrancer', 'checkpoints.sqlite3');
  const persisted = () => {
    const store = new CheckpointStore(checkpointPath);
    try {
      return { sources: store.sources(), reviewed: store.reviewed() };
    } finally {
      store.close();
    }
  };
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register the review tool');
    const review = decode(
      await tool.execute(
        'partial',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        context,
      ),
    );
    expect(expandEvidenceGroups(review).map((entry) => entry.text)).toEqual(['healthy commitment']);
    expect(review.incomplete).toBe(true);
    expect(review.status).toBe('incomplete');
    await expect(
      tool.execute(
        'partial-finish',
        { action: 'finish', proposals: [], batch: review.batch },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/incomplete/);
    expect(review.warnings?.join('\\n')).toMatch(/broken/);
    expect(persisted()).toEqual({
      sources: [{ sessionId: 'session', file: healthy, seedSince: null }],
      reviewed: [],
    });
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('returns frozen selected context on demand without advancing pages or reading later edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-context-'));
  const archive = join(dir, 'archive');
  const state = join(dir, 'state');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  mkdirSync(archive, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = state;
  const file = join(archive, 'session.jsonl');
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const oldContext = `${'x'.repeat(47_999)}🌱${'x'.repeat(49)}`;
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'old',
        parentId: null,
        timestamp: old,
        message: { role: 'user', content: oldContext },
      }),
      JSON.stringify({
        type: 'message',
        id: 'selected',
        parentId: 'old',
        timestamp: recent,
        message: { role: 'user', content: 'selected commitment' },
      }),
      '',
    ].join('\n'),
  );

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, file, archive);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register the review tool');
    const review = decode(
      await tool.execute('begin', { action: 'begin', seed: '14d' }, undefined, undefined, context),
    );
    expect(expandEvidenceGroups(review).map((entry) => entry.text)).toEqual([
      'selected commitment',
    ]);
    const selectedEvidence = expandEvidenceGroups(review)[0]!;
    const selected = {
      sessionId: selectedEvidence.sessionId,
      branchId: selectedEvidence.branchId,
      entryId: selectedEvidence.entryId,
      editId: selectedEvidence.editId,
    };
    const contextCall = async (offset?: number, before?: number) =>
      decode(
        await tool.execute(
          'context',
          {
            action: 'context',
            batch: review.batch,
            selected,
            ...(offset === undefined ? {} : { offset }),
            ...(before === undefined ? {} : { before }),
          },
          undefined,
          undefined,
          context,
        ),
      );
    await expect(contextCall(undefined, 0)).rejects.toThrow(/from 1 to 40/);
    await expect(contextCall(undefined, 41)).rejects.toThrow(/from 1 to 40/);
    await expect(
      tool.execute(
        'wrong-selected',
        {
          action: 'context',
          batch: review.batch,
          selected: { ...selected, entryId: 'not-selected' },
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/not in this review batch/);
    await expect(
      tool.execute(
        'wrong-action',
        { action: 'next', batch: review.batch, selected },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/Context arguments require/);
    const first = await contextCall();
    expect(first.contextOnly).toBe(true);
    expect(first.groups?.[0]).toMatchObject({
      file,
      sessionId: 'session',
      cwd: dir,
      branchId: 'selected',
      reviewedThrough: null,
    });
    expect(expandEvidenceGroups(first)[0]?.text.length).toBe(47_999);
    expect(first.nextOffset).toBe(47_999);
    await expect(contextCall(48_000)).rejects.toThrow(/splits a surrogate pair/);
    const tail = await contextCall(first.nextOffset as number);
    expect(
      expandEvidenceGroups(tail)
        .map((entry) => entry.text)
        .join(''),
    ).toBe(oldContext.slice(47_999));
    expect(tail.nextOffset).toBeNull();
    await expect(contextCall(oldContext.length + 1)).rejects.toThrow(/beyond/);

    appendFileSync(
      file,
      JSON.stringify({
        type: 'context_edit',
        id: 'later-edit',
        parentId: 'selected',
        targetId: 'old',
        replacement: { content: 'changed later' },
      }) + '\n',
    );
    const repeated = await contextCall();
    expect(repeated.groups).toEqual(first.groups);
    await tool.execute(
      'finish',
      { action: 'finish', proposals: [], batch: review.batch },
      undefined,
      undefined,
      context,
    );
    await expect(contextCall()).rejects.toThrow(/matching open review/);
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('bounds context by frozen visible identity and preserves page and write lifecycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-context-safety-'));
  const archive = join(dir, 'archive');
  const state = join(dir, 'state');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  mkdirSync(archive, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['XDG_STATE_HOME'] = state;
  const file = join(archive, 'session.jsonl');
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const records: unknown[] = [{ type: 'session', id: 'session', cwd: dir }];
  let parentId: string | null = null;
  for (let index = 0; index < 42; index++) {
    const id = `context-${index}`;
    records.push({
      type: 'message',
      id,
      parentId,
      timestamp: old,
      message: { role: 'user', content: id },
    });
    parentId = id;
    if (index === 5) {
      records.push({
        type: 'message',
        id: 'hidden',
        parentId,
        timestamp: old,
        message: { role: 'toolResult', content: 'hidden context' },
      });
      parentId = 'hidden';
    }
    if (index === 10) {
      records.push({
        type: 'context_edit',
        id: 'redact',
        parentId,
        timestamp: old,
        targetId: 'context-2',
        replacement: null,
      });
      parentId = 'redact';
    }
  }
  records.push(
    {
      type: 'message',
      id: 'selected-long',
      parentId,
      timestamp: recent,
      message: { role: 'user', content: 'x'.repeat(48_050) },
    },
    {
      type: 'message',
      id: 'selected-second',
      parentId: 'selected-long',
      timestamp: recent,
      message: { role: 'user', content: 'selected second commitment' },
    },
  );
  const fixture = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  writeFileSync(file, fixture);

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = contextFor(dir, file, archive);
  const checkpointPath = join(state, 'pi-remembrancer', 'checkpoints.sqlite3');
  const persisted = () => {
    const store = new CheckpointStore(checkpointPath);
    try {
      return { sources: store.sources(), reviewed: store.reviewed() };
    } finally {
      store.close();
    }
  };
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  const selected: Selected = {
    sessionId: 'session',
    branchId: 'selected-second',
    entryId: 'selected-long',
    editId: null,
  };
  let tool: TestTool | undefined;
  let review: ReviewResult | undefined;
  const begin = async () => {
    tool = extension.tools[extension.tools.length - 1];
    if (!tool) throw new Error('Extension did not register the review tool');
    review = decode(
      await tool.execute(
        'context-safety-begin',
        { action: 'begin', seed: '14d' },
        undefined,
        undefined,
        context,
      ),
    );
    return review;
  };
  const contextCall = async (
    options: {
      selected?: typeof selected;
      batch?: string;
      before?: number;
      offset?: number;
    } = {},
  ) => {
    if (!tool || !review?.batch) throw new Error('No test review is open');
    return decode(
      await tool.execute(
        'context-safety-context',
        {
          action: 'context',
          batch: options.batch ?? review.batch,
          selected: options.selected ?? selected,
          ...(options.before === undefined ? {} : { before: options.before }),
          ...(options.offset === undefined ? {} : { offset: options.offset }),
        },
        undefined,
        undefined,
        context,
      ),
    );
  };

  try {
    await start({}, context);
    const first = await begin();
    expect(expandEvidenceGroups(first)[0]).toMatchObject({
      sessionId: 'session',
      branchId: 'selected-second',
      entryId: 'selected-long',
      editId: null,
      offset: 0,
      continues: true,
    });
    const beforeContext = persisted();
    const visibleContext = await contextCall({ before: 40 });
    expect(visibleContext.contextOnly).toBe(true);
    const visibleContextEntries = expandEvidenceGroups(visibleContext);
    expect(visibleContextEntries).toHaveLength(40);
    expect(visibleContextEntries.map((entry) => entry.text)).not.toContain('hidden context');
    expect(visibleContextEntries.map((entry) => entry.text)).not.toContain('context-2');
    expect(visibleContextEntries[0]?.text).toBe('context-1');
    expect(visibleContextEntries.at(-1)?.text).toBe('context-41');
    expect(persisted()).toEqual(beforeContext);

    await expect(
      contextCall({ selected: { ...selected, sessionId: 'other-session' } }),
    ).rejects.toThrow(/not in this review batch/);
    await expect(
      contextCall({ selected: { ...selected, branchId: 'other-branch' } }),
    ).rejects.toThrow(/not in this review batch/);
    await expect(
      contextCall({ selected: { ...selected, entryId: 'not-selected' } }),
    ).rejects.toThrow(/not in this review batch/);
    await expect(contextCall({ selected: { ...selected, editId: 'wrong-edit' } })).rejects.toThrow(
      /not in this review batch/,
    );
    await expect(contextCall({ batch: 'stale-token' })).rejects.toThrow(/matching open review/);
    await expect(contextCall({ offset: -1 })).rejects.toThrow(/nonnegative integer/);
    await expect(
      tool!.execute(
        'context-safety-finish-too-soon',
        { action: 'finish', proposals: [], batch: first.batch },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/Read all evidence pages/);

    writeFileSync(file, 'replacement after begin');
    expect(await contextCall({ before: 40 })).toEqual(visibleContext);
    rmSync(file);
    expect(await contextCall({ before: 40 })).toEqual(visibleContext);
    writeFileSync(file, fixture);
    await tool!.execute(
      'context-safety-cancel',
      { action: 'cancel', batch: first.batch },
      undefined,
      undefined,
      context,
    );
    await expect(contextCall()).rejects.toThrow(/matching open review/);

    await shutdown({}, context);
    await expect(contextCall()).rejects.toThrow(/matching open review/);
    await start({}, context);
    const second = await begin();
    await contextCall({ before: 1 });
    await shutdown({}, context);
    await expect(contextCall()).rejects.toThrow(/matching open review/);

    await start({}, context);
    const third = await begin();
    const next = decode(
      await tool!.execute(
        'context-safety-next',
        { action: 'next', batch: third.batch },
        undefined,
        undefined,
        context,
      ),
    );
    expect(next.hasMore).toBe(false);
    expect(expandEvidenceGroups(next).map((entry) => entry.entryId)).toContain('selected-second');
    const finished = decode(
      await tool!.execute(
        'context-safety-finish',
        { action: 'finish', proposals: [], batch: third.batch },
        undefined,
        undefined,
        context,
      ),
    );
    expect(finished).toMatchObject({
      finished: true,
      reviewedTips: 1,
      status: 'coverage-finished',
      coverageChanged: true,
    });
    expect(persisted()).toEqual({
      sources: [{ sessionId: 'session', file, seedSince: third.requestedSince }],
      reviewed: [
        {
          sessionId: 'session',
          file,
          entryId: 'selected-second',
          since: third.requestedSince,
        },
      ],
    });
    expect(second.groups).toEqual(third.groups);
  } finally {
    await shutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});
