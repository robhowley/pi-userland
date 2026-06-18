import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStatusMirror,
  createStatusMirrorFooterFactory,
  diffMirroredStatusSnapshots,
  sanitizeMirroredStatusText,
} from '../../extensions/session-deck/chips/mirror.js';
import type { SessionDeckChipRecord } from '../../extensions/session-deck/chips/types.js';

const createdDirectories: string[] = [];

async function createTestDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-deck-mirror-'));
  createdDirectories.push(dir);
  return dir;
}

function createMutableNow(initialIso: string): {
  now: () => Date;
  set: (nextIso: string) => void;
} {
  let currentIso = initialIso;
  return {
    now: () => new Date(currentIso),
    set: (nextIso: string) => {
      currentIso = nextIso;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('sanitizeMirroredStatusText', () => {
  it('strips ANSI and control characters, collapses whitespace, and trims', () => {
    expect(sanitizeMirroredStatusText('\u001b[2m Ready\u001b[0m\n\tfor\u0007  merge ')).toBe(
      'Ready for merge',
    );
  });
});

describe('diffMirroredStatusSnapshots', () => {
  it('detects add, change, and remove operations', () => {
    const diff = diffMirroredStatusSnapshots(
      new Map([
        ['merge-ready', 'Ready'],
        ['openrouter', '$1.23'],
      ]),
      new Map([
        ['openrouter', '$2.34'],
        ['session-hygiene', 'Healthy'],
      ]),
    );

    expect(diff).toEqual({
      upserts: [
        { source: 'openrouter', text: '$2.34' },
        { source: 'session-hygiene', text: 'Healthy' },
      ],
      removals: ['merge-ready'],
    });
  });
});

describe('createStatusMirror', () => {
  it('writes a default session-scoped unknown-level chip with sanitized text', async () => {
    const directory = await createTestDir();
    const clock = createMutableNow('2026-06-18T16:00:00.000Z');
    const mirror = createStatusMirror({ now: clock.now });

    await mirror.reconfigure(
      {
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
        directory,
      },
      { resetSnapshot: true },
    );
    await mirror.observeStatuses(new Map([['merge-ready', '\u001b[2m✅ Ready\u001b[0m']]));

    const file = join(directory, 'runtime-1', 'merge-ready.default.session.json');
    const record = JSON.parse(await readFile(file, 'utf8')) as SessionDeckChipRecord;

    expect(record).toEqual({
      schemaVersion: 1,
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      source: 'merge-ready',
      chipId: 'default',
      scope: 'session',
      text: '✅ Ready',
      level: 'unknown',
      updatedAt: '2026-06-18T16:00:00.000Z',
    });
  });

  it('diffs add, change, and remove snapshots against chip files', async () => {
    const directory = await createTestDir();
    const clock = createMutableNow('2026-06-18T16:00:00.000Z');
    const mirror = createStatusMirror({ now: clock.now });

    await mirror.reconfigure(
      {
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
        directory,
      },
      { resetSnapshot: true },
    );
    await mirror.observeStatuses(
      new Map([
        ['merge-ready', 'Ready'],
        ['openrouter', '$1.23'],
      ]),
    );

    clock.set('2026-06-18T16:05:00.000Z');
    await mirror.observeStatuses(
      new Map([
        ['openrouter', '$2.34'],
        ['session-hygiene', 'Healthy'],
      ]),
    );

    const runtimeDir = join(directory, 'runtime-1');
    expect((await readdir(runtimeDir)).sort()).toEqual([
      'openrouter.default.session.json',
      'session-hygiene.default.session.json',
    ]);

    const openrouter = JSON.parse(
      await readFile(join(runtimeDir, 'openrouter.default.session.json'), 'utf8'),
    ) as SessionDeckChipRecord;
    expect(openrouter.text).toBe('$2.34');
    expect(openrouter.updatedAt).toBe('2026-06-18T16:05:00.000Z');
  });

  it('treats empty-after-sanitize text as absent and clears any prior chip', async () => {
    const directory = await createTestDir();
    const diagnostics: string[] = [];
    const mirror = createStatusMirror({
      now: () => new Date('2026-06-18T16:00:00.000Z'),
      onDiagnostic: (code) => diagnostics.push(code),
    });

    await mirror.reconfigure(
      {
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
        directory,
      },
      { resetSnapshot: true },
    );
    await mirror.observeStatuses(new Map([['session-hygiene', 'Healthy']]));
    await mirror.observeStatuses(new Map([['session-hygiene', '\u001b[2m\u001b[0m\n\t']]));

    expect(await readdir(join(directory, 'runtime-1'))).toEqual([]);
    expect(diagnostics).toContain('chip_text_empty');
  });

  it('clears tracked mirrored chips on reconfigure and rewrites unchanged statuses after reset', async () => {
    const directory = await createTestDir();
    const clock = createMutableNow('2026-06-18T16:00:00.000Z');
    const mirror = createStatusMirror({ now: clock.now });

    await mirror.reconfigure(
      {
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
        directory,
      },
      { resetSnapshot: true },
    );
    await mirror.observeStatuses(new Map([['merge-ready', 'Ready']]));

    clock.set('2026-06-18T16:10:00.000Z');
    await mirror.reconfigure(
      {
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-2',
        directory,
      },
      { clearTracked: true, resetSnapshot: true },
    );

    expect(await readdir(join(directory, 'runtime-1'))).toEqual([]);

    await mirror.observeStatuses(new Map([['merge-ready', 'Ready']]));
    const record = JSON.parse(
      await readFile(join(directory, 'runtime-1', 'merge-ready.default.session.json'), 'utf8'),
    ) as SessionDeckChipRecord;

    expect(record.sessionId).toBe('session-2');
    expect(record.updatedAt).toBe('2026-06-18T16:10:00.000Z');
  });

  it('renders through the footer factory and mirrors footer statuses', async () => {
    const directory = await createTestDir();
    const mirror = createStatusMirror({
      now: () => new Date('2026-06-18T16:00:00.000Z'),
    });

    await mirror.reconfigure(
      {
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
        directory,
      },
      { resetSnapshot: true },
    );

    const footerFactory = createStatusMirrorFooterFactory(
      {
        cwd: '/repo',
        model: { id: 'gpt-5', provider: 'openai' },
        getContextUsage: () => ({ percent: 12.5, contextWindow: 200_000 }),
        sessionManager: {
          getEntries: () => [],
          getSessionName: () => 'session-1',
          getCwd: () => '/repo',
        },
      },
      mirror,
    );

    const component = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_tone, text) => text },
      {
        getGitBranch: () => 'main',
        getExtensionStatuses: () => new Map([['merge-ready', '\u001b[2mReady\u001b[0m']]),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => vi.fn(),
      },
    );

    const lines = component.render(80);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('/repo');
    expect(lines[0]).toContain('(main)');
    expect(lines[0]).toContain('session-1');
    expect(lines[1]).toContain('12.5%/200k');
    expect(lines[1]).toContain('gpt-5');
    expect(lines[2]).toBe('Ready');

    await vi.waitFor(async () => {
      const record = JSON.parse(
        await readFile(join(directory, 'runtime-1', 'merge-ready.default.session.json'), 'utf8'),
      ) as SessionDeckChipRecord;
      expect(record.text).toBe('Ready');
    });
  });

  it('fails open when write and clear operations throw', async () => {
    const diagnostics: string[] = [];
    const mirror = createStatusMirror({
      now: () => new Date('2026-06-18T16:00:00.000Z'),
      writeRecord: vi.fn().mockRejectedValue(new Error('write boom')),
      clearRecord: vi.fn().mockRejectedValue(new Error('clear boom')),
      onDiagnostic: (code) => diagnostics.push(code),
    });

    await mirror.reconfigure(
      {
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
      },
      { resetSnapshot: true },
    );

    await expect(
      mirror.observeStatuses(new Map([['merge-ready', 'Ready']])),
    ).resolves.toBeUndefined();
    await expect(mirror.clearTracked()).resolves.toBeUndefined();

    expect(diagnostics).toContain('chip_mirror_error');
  });
});
