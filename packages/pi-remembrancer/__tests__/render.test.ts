import type { Component } from '@earendil-works/pi-tui';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import remembrancer from '../extensions/remembrancer/index.js';
import type { ReviewResultDetails } from '../extensions/remembrancer/render.js';

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<NonNullable<ToolDefinition['renderResult']>>[2];

type RegisteredTool = ToolDefinition;
type RenderResult = Parameters<NonNullable<RegisteredTool['renderResult']>>[0];
type RenderOptions = Parameters<NonNullable<RegisteredTool['renderResult']>>[1];
type RenderContext = Parameters<NonNullable<RegisteredTool['renderResult']>>[3];
type TestRenderContext = Partial<RenderContext> & {
  keyHint?: (keybinding: string, description: string) => string;
};

type Payload = Record<string, unknown>;

type Warning = ReviewResultDetails['warnings'][number];

const sourcePath = '/Users/rob/.pi/sessions/2026-11-05_session.jsonl';

function details(
  action: ReviewResultDetails['action'],
  overrides: Partial<ReviewResultDetails> = {},
): ReviewResultDetails {
  return {
    action,
    batch: 'batch-token',
    incomplete: false,
    warnings: [],
    coverageChanged: false,
    ...overrides,
  };
}

function warning(kind: Warning['kind'], overrides: Partial<Warning> = {}): Warning {
  return {
    message: `${sourcePath}: warning`,
    sources: [sourcePath],
    reason: 'warning reason',
    kind,
    ...overrides,
  };
}

function evidenceGroup(
  entries: readonly unknown[],
  source: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    file: '/archive/session.jsonl',
    sessionId: 'session',
    cwd: '/work',
    branchId: 'branch',
    reviewedThrough: null,
    ...source,
    entries,
  };
}

function evidenceGroups(entries: readonly unknown[]): Record<string, unknown>[] {
  return entries.length === 0 ? [] : [evidenceGroup(entries)];
}

function response(payload: Payload, resultDetails: ReviewResultDetails): RenderResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: resultDetails,
  } as RenderResult;
}

function context(
  args: Record<string, unknown> = {},
  overrides: TestRenderContext = {},
): RenderContext {
  return {
    args,
    toolCallId: 'call-id',
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
    ...overrides,
  } as RenderContext;
}

function textAt(
  renderer: NonNullable<RegisteredTool['renderResult']>,
  payload: Payload,
  resultDetails: ReviewResultDetails,
  options: Partial<RenderOptions> = {},
  renderContext: TestRenderContext = {},
  width = 120,
): string {
  return renderer(
    response(payload, resultDetails),
    { expanded: false, isPartial: false, ...options },
    identityTheme,
    context({ action: resultDetails.action }, renderContext),
  )
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join('\n');
}

function installedRendererTool(): {
  tool: RegisteredTool;
  shutdown: () => Promise<void>;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand: vi.fn(),
    registerTool(tool: RegisteredTool) {
      if (tool.name === 'remembrancer_review') registeredTool = tool;
    },
  } as unknown as ExtensionAPI;
  let registeredTool: RegisteredTool | undefined;
  remembrancer(api);
  const start = handlers.get('session_start');
  const shutdownHandler = handlers.get('session_shutdown');
  if (!start || !shutdownHandler) throw new Error('Remembrancer lifecycle was not registered');

  const startupContext = {
    cwd: '/work',
    isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  void start({}, startupContext);
  if (!registeredTool) throw new Error('Remembrancer renderer was not registered');
  return {
    tool: registeredTool,
    shutdown: async () => {
      await shutdownHandler({}, startupContext);
    },
  };
}

it('registers compact renderers and uses the configured host expansion hint', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    expect(tool.renderCall).toBeTypeOf('function');
    expect(tool.renderResult).toBeTypeOf('function');
    const call = tool.renderCall!(
      { action: 'begin', seed: '14d' },
      identityTheme,
      context({ action: 'begin', seed: '14d' }),
    );
    expect(
      call
        .render(120)
        .map((line) => stripTerminalSequences(line).trimEnd())
        .join('\n'),
    ).toBe('remembrancer_review(action=begin, seed=14d)');

    const output = textAt(
      tool.renderResult!,
      { groups: [], status: 'already-covered', capturedTips: 0 },
      details('begin'),
      {},
      { keyHint: () => 'ctrl+x to expand' },
    );
    expect(output).toContain('Nothing new · review still open');
    expect(output).toContain('ctrl+x to expand');
  } finally {
    await shutdown();
  }
});

it('renders context targets by actual parameter name and abbreviates only the collapsed session ID', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const contextCall = tool.renderCall!(
      {
        action: 'context',
        batch: 'batch-token',
        selected: {
          sessionId: '01a1af0a-f428-7476-849f-483859d09d91',
          branchId: 'branch-id',
          entryId: 'entry-id',
          editId: null,
        },
        before: 1,
        offset: 0,
      },
      identityTheme,
      context({ action: 'context' }),
    );
    expect(
      contextCall
        .render(120)
        .map((line) => stripTerminalSequences(line).trimEnd())
        .join('\n'),
    ).toBe('remembrancer_review(action=context, selected.sessionId=01a1af0a…)');

    const shortSessionCall = tool.renderCall!(
      { action: 'context', selected: { sessionId: 'short-id' } },
      identityTheme,
      context({ action: 'context' }),
    );
    expect(
      shortSessionCall
        .render(120)
        .map((line) => line.trimEnd())
        .join('\n'),
    ).toBe('remembrancer_review(action=context, selected.sessionId=short-id)');
  } finally {
    await shutdown();
  }
});

it('renders the required missing-file warning layout with full warning reasons', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const missingReason = `Error: ENOENT: no such file or directory, open ${sourcePath}`;
    const missing = warning('source-failure', {
      message: `${sourcePath}: ${missingReason}`,
      reason: missingReason,
      sources: [sourcePath],
    });
    const output = textAt(
      tool.renderResult!,
      {
        groups: [],
        hasMore: true,
        status: 'incomplete',
        capturedTips: 38,
      },
      details('begin', { incomplete: true, warnings: [missing] }),
      { expanded: true },
    );
    expect(output).toBe(
      [
        'No evidence available · review still open',
        '! Some sources could not be reviewed · 1 warning',
        '',
        '  Source',
        `    ${sourcePath}`,
        '',
        '  Error',
        `    ${missingReason}`,
        '',
        '  Effect',
        '    This source remains unreviewed.',
        '    Available sources can still be reviewed and finished.',
        '',
        '  Batch',
        '    token: batch-token',
        '    seed: none',
        '    requestedSince: none',
        '',
        '  Arguments',
        '    action: begin',
      ].join('\n'),
    );
  } finally {
    await shutdown();
  }
});

it('covers every compact action state, including zero-tip coverage and context exhaustion', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const oneEntry = evidenceGroups([{ text: 'one' }]);
    const noEntries = { groups: [] };
    const cases: Array<[ReviewResultDetails['action'], Payload, string]> = [
      [
        'begin',
        { groups: oneEntry, hasMore: true, capturedTips: 0 },
        '1 excerpt · 0 branch tips · more evidence',
      ],
      [
        'begin',
        { groups: oneEntry, hasMore: false, capturedTips: 1 },
        '1 excerpt · 1 branch tip · last evidence page',
      ],
      [
        'begin',
        { groups: oneEntry, hasMore: true, capturedTips: 2 },
        '1 excerpt · 2 branch tips · more evidence',
      ],
      [
        'begin',
        { groups: oneEntry, hasMore: false, capturedTips: 2 },
        '1 excerpt · 2 branch tips · last evidence page',
      ],
      [
        'begin',
        { groups: [], status: 'coverage-pending', coverageChanged: true },
        'No new evidence · new coverage to save',
      ],
      [
        'begin',
        { groups: [], status: 'already-covered', coverageChanged: false },
        'Nothing new · review still open',
      ],
      ['begin', { groups: [], status: 'incomplete' }, 'No evidence available · review still open'],
      ['next', { groups: oneEntry, hasMore: true }, '1 excerpt · more evidence'],
      ['next', { groups: oneEntry, hasMore: false }, '1 excerpt · last evidence page'],
      ['next', { ...noEntries, hasMore: false }, 'No more evidence · review still open'],
      [
        'context',
        { contextOnly: true, groups: oneEntry, nextOffset: 3 },
        '1 prior excerpt · context only · more context',
      ],
      [
        'context',
        { contextOnly: true, groups: oneEntry, nextOffset: null },
        '1 prior excerpt · context only · end of context',
      ],
      ['context', { contextOnly: true, ...noEntries, nextOffset: null }, 'No preceding context'],
      ['finish', { finished: true, reviewedTips: 4 }, 'Finished · 4 branch tips recorded'],
      [
        'finish',
        { finished: true, reviewedTips: 1, status: 'coverage-finished', coverageChanged: true },
        'Finished · coverage saved · 1 branch tip',
      ],
      [
        'finish',
        { finished: true, reviewedTips: 4, status: 'already-covered', coverageChanged: false },
        'Finished · no coverage changes',
      ],
      [
        'finish',
        { finished: true, reviewedTips: 0, status: 'partial', incomplete: true },
        'Finished available sources · 0 branch tips recorded',
      ],
      ['cancel', { cancelled: true }, 'Cancelled · review progress not saved'],
    ];
    for (const [action, payload, expected] of cases) {
      const resultDetails = details(action, {
        incomplete: payload['incomplete'] === true,
        coverageChanged:
          action === 'finish' &&
          payload['status'] === undefined &&
          payload['coverageChanged'] === undefined,
      });
      expect(textAt(tool.renderResult!, payload, resultDetails)).toContain(expected);
    }
  } finally {
    await shutdown();
  }
});

it('keeps partial results pending instead of treating domain incompleteness as streaming state', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const output = textAt(
      tool.renderResult!,
      { groups: [], status: 'incomplete' },
      details('begin', { incomplete: true }),
      { isPartial: true },
    );
    expect(output).toBe('Pending · begin');
    expect(output).not.toContain('incomplete');
    expect(output).not.toContain('warning');
  } finally {
    await shutdown();
  }
});

it('renders informational and mixed warnings with distinct effects', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const informational = warning('unknown-timestamp', {
      reason: 'selection timestamp unknown for entry-1',
    });
    const output = textAt(
      tool.renderResult!,
      { groups: evidenceGroups([{ text: 'evidence' }]), hasMore: false, capturedTips: 1 },
      details('begin', { warnings: [informational] }),
      { expanded: true },
    );
    expect(output).toContain('! 1 warning · source coverage complete');
    expect(output).toContain(
      'The timestamp is unknown, but this does not make coverage incomplete.',
    );

    const mixed = [
      warning('archive-scan', { reason: 'unable to enumerate archive' }),
      warning('identity-ambiguity', { reason: 'session header ID changed' }),
      informational,
    ];
    const mixedOutput = textAt(
      tool.renderResult!,
      { groups: [], status: 'incomplete' },
      details('begin', { incomplete: true, warnings: mixed }),
      { expanded: true },
    );
    expect(mixedOutput).toContain('! Some sources could not be reviewed · 3 warnings');
    expect(mixedOutput).toContain('This archive was not fully scanned.');
    expect(mixedOutput).toContain('The source identity is ambiguous, so it remains unreviewed.');
    expect(mixedOutput.indexOf('Source')).toBeLessThan(mixedOutput.indexOf('Batch'));
  } finally {
    await shutdown();
  }
});

it('keeps all returned evidence order, provenance, continuation fields, and batch metadata', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const groups = [
      evidenceGroup(
        [
          {
            role: 'user',
            timestamp: '2026-01-01T00:00:00.000Z',
            entryId: 'entry-a',
            editId: null,
            offset: 0,
            continues: true,
            text: 'first chunk',
          },
        ],
        {
          file: '/archive/a.jsonl',
          sessionId: 'session-a',
          cwd: '/work/a',
          branchId: 'branch-a',
          reviewedThrough: null,
        },
      ),
      evidenceGroup(
        [
          {
            role: 'assistant',
            timestamp: '2026-01-02T00:00:00.000Z',
            entryId: 'entry-b',
            editId: 'edit-b',
            offset: 11,
            continues: false,
            text: 'second chunk',
          },
        ],
        {
          file: '/archive/b.jsonl',
          sessionId: 'session-b',
          cwd: '/work/b',
          branchId: 'branch-b',
          reviewedThrough: 'checkpoint-b',
        },
      ),
    ];
    const resultDetails = details('next', {
      seed: '14d',
      requestedSince: '2026-01-01T00:00:00.000Z',
      warnings: [warning('source-failure')],
    });
    const collapsed = textAt(tool.renderResult!, { groups, hasMore: false }, resultDetails);
    expect(collapsed).not.toContain('first chunk');
    expect(collapsed).not.toContain('warning reason');
    expect(collapsed).not.toContain('token: batch-token');
    expect(collapsed).not.toContain('seed: 14d');
    expect(collapsed).not.toContain('requestedSince: 2026-01-01T00:00:00.000Z');

    const output = textAt(tool.renderResult!, { groups, hasMore: false }, resultDetails, {
      expanded: true,
    });
    expect(output.indexOf('first chunk')).toBeLessThan(output.indexOf('second chunk'));
    expect(output).toContain('warning reason');
    for (const expected of [
      'role: user',
      'timestamp: 2026-01-01T00:00:00.000Z',
      'sessionId: session-a',
      'branchId: branch-a',
      'entryId: entry-a',
      'editId: none',
      'source: /archive/a.jsonl',
      'cwd: /work/a',
      'reviewedThrough: none',
      'offset: 0',
      'continues: true',
      'role: assistant',
      'editId: edit-b',
      'offset: 11',
      'continues: false',
      'token: batch-token',
      'seed: 14d',
      'requestedSince: 2026-01-01T00:00:00.000Z',
    ])
      expect(output).toContain(expected);
  } finally {
    await shutdown();
  }
});

it('shows complete actual arguments in expanded successful and failed calls', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const args = {
      action: 'context',
      batch: 'full-batch-token',
      selected: {
        sessionId: '01a1af0a-f428-7476-849f-483859d09d91',
        branchId: 'full-branch-id',
        entryId: 'full-entry-id',
        editId: 'full-edit-id',
      },
      before: 3,
      offset: 120,
    };
    const output = textAt(
      tool.renderResult!,
      { contextOnly: true, groups: [], nextOffset: null },
      details('context'),
      { expanded: true },
      { args },
    );
    for (const expected of [
      'action: context',
      'batch: full-batch-token',
      'selected.sessionId: 01a1af0a-f428-7476-849f-483859d09d91',
      'selected.branchId: full-branch-id',
      'selected.entryId: full-entry-id',
      'selected.editId: full-edit-id',
      'before: 3',
      'offset: 120',
    ])
      expect(output).toContain(expected);
    expect(output).not.toContain('selected.sessionId: 01a1af0a…');

    const failed = tool.renderResult!(
      {
        content: [{ type: 'text', text: 'Read all evidence pages before finishing.' }],
        details: undefined,
      } as RenderResult,
      { expanded: true, isPartial: false },
      identityTheme,
      context(args, { isError: true }),
    );
    const failedOutput = failed
      .render(120)
      .map((line) => stripTerminalSequences(line).trimEnd())
      .join('\n');
    expect(failedOutput).toContain('Could not context');
    expect(failedOutput).toContain('Read all evidence pages before finishing.');
    expect(failedOutput).toContain('selected.entryId: full-entry-id');
    expect(failedOutput).toContain('offset: 120');
  } finally {
    await shutdown();
  }
});

it('marks context as interpretation-only and preserves the cancel explanation', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const contextOutput = textAt(
      tool.renderResult!,
      {
        contextOnly: true,
        groups: [
          evidenceGroup([
            { entryId: 'context-entry', text: 'supporting context', continues: false },
          ]),
        ],
        nextOffset: null,
      },
      details('context'),
      { expanded: true },
    );
    expect(contextOutput).toContain('Context 1');
    expect(contextOutput).toContain('interpretation only: true');

    const cancelOutput = textAt(tool.renderResult!, { cancelled: true }, details('cancel'), {
      expanded: true,
    });
    expect(cancelOutput).toContain('Cancelled · review progress not saved');
    expect(cancelOutput).toContain('Previously applied Taskwarrior changes were not undone.');
  } finally {
    await shutdown();
  }
});

it('preserves original execution errors and handles unrecognized data without throwing', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const error = tool.renderResult!(
      {
        content: [{ type: 'text', text: 'Read all evidence pages before finishing.' }],
        details: undefined,
      } as RenderResult,
      { expanded: false, isPartial: false },
      identityTheme,
      context({ action: 'finish' }, { isError: true }),
    );
    expect(
      error
        .render(120)
        .map((line) => stripTerminalSequences(line).trimEnd())
        .join('\n'),
    ).toContain('Could not finish\nRead all evidence pages before finishing.');

    const malformed = tool.renderResult!(
      {
        content: [{ type: 'text', text: '{"old":"result"}' }],
        details: {},
      } as RenderResult,
      { expanded: false, isPartial: false },
      identityTheme,
      context({ action: 'begin' }),
    );
    expect(malformed.render(120).join('\n')).toContain('{"old":"result"}');
  } finally {
    await shutdown();
  }
});

it('falls back to raw results when warning details are malformed', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const malformed = tool.renderResult!(
      {
        content: [{ type: 'text', text: '{"old":"result"}' }],
        details: {
          action: 'begin',
          batch: 'batch-token',
          incomplete: false,
          warnings: [null],
          coverageChanged: false,
        },
      } as RenderResult,
      { expanded: false, isPartial: false },
      identityTheme,
      context({ action: 'begin' }),
    );
    expect(malformed.render(120).join('\n')).toContain('{"old":"result"}');
  } finally {
    await shutdown();
  }
});

it('sanitizes control input, wraps Text output at 40/80/120 columns, and replays frozen JSON', async () => {
  const { tool, shutdown } = installedRendererTool();
  try {
    const unsafePath = `${sourcePath}\u001b[31m\r\u0000/with-a-very-long-unicode-name-漢字`;
    const frozenPayload: Payload = {
      groups: [
        evidenceGroup(
          [
            {
              role: 'assistant',
              timestamp: '2026-01-03',
              entryId: 'entry',
              editId: null,
              offset: 12000,
              continues: false,
              text: `line one\r\u0007\nline two with a long path ${unsafePath}`,
            },
          ],
          {
            sessionId: 'session',
            branchId: 'branch',
            file: unsafePath,
            cwd: '/very/long/working/directory/with/漢字',
            reviewedThrough: null,
          },
        ),
      ],
      hasMore: false,
    };
    const frozenDetails = JSON.parse(
      JSON.stringify(details('next', { requestedSince: '2026-01-01' })),
    ) as ReviewResultDetails;
    const frozen = JSON.parse(JSON.stringify(frozenPayload)) as Payload;

    for (const width of [40, 80, 120]) {
      const renderer = tool.renderResult!(
        response(frozen, frozenDetails),
        { expanded: true, isPartial: false },
        identityTheme,
        context({ action: 'next', batch: unsafePath }),
      ) as Component;
      const lines = renderer.render(width);
      expect(lines.every((line) => visibleWidth(stripTerminalSequences(line)) <= width)).toBe(true);
      const rendered = lines.join('\n');
      for (const control of ['\u001b', '\r', '\u0000', '\u0007']) {
        expect(rendered).not.toContain(control);
      }
      expect(rendered).toContain('line one');
      expect(rendered).toContain('line two');
      expect(rendered).toContain('漢字');
    }
  } finally {
    await shutdown();
  }
});
