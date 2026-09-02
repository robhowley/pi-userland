import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMergeReadyStatus,
  type MergeReadyExec,
  type MergeReadyProviderFactsV1,
  type MergeReadyProviderReadResultV1,
  type MergeReadyProviderV1,
} from '../../extensions/merge-ready/index.js';
import {
  createMergeReadyProviderCatalog,
  CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS,
} from '../../extensions/merge-ready/provider-catalog.js';
import { createCatalogBoundMergeReadyStatusReader } from '../../extensions/merge-ready/merge-ready.js';
import {
  resolveMergeReadyProviderForRemote,
  resolveMergeReadyProviderForUrl,
} from '../../extensions/merge-ready/provider-registry.js';
import { createFakeExec, createGitDiscoveryCalls } from './test-fixtures.js';

const URL = 'https://gitlab.example/shop/pi/-/merge_requests/7';
const TARGET = {
  url: URL,
  owner: 'shop',
  repo: 'pi',
  prNumber: 7,
} as const;
const GENERATED_AT = '2026-09-02T18:00:00.000Z';
const NOOP_EXEC = vi.fn(async () => ({})) as MergeReadyExec;

function knownFacts(overrides: Partial<MergeReadyProviderFactsV1> = {}): MergeReadyProviderFactsV1 {
  return {
    draft: { kind: 'known', value: false },
    mergeability: { kind: 'known', value: 'mergeable' },
    checks: { kind: 'known', value: { state: 'passing' } },
    review: { kind: 'known', value: 'approved' },
    conversations: {
      kind: 'known',
      value: { unresolvedCount: 0, requirement: 'required' },
    },
    ...overrides,
  };
}

function foundResult(
  overrides: Partial<Extract<MergeReadyProviderReadResultV1, { kind: 'found' }>> = {},
): Extract<MergeReadyProviderReadResultV1, { kind: 'found' }> {
  return {
    kind: 'found',
    pullRequest: {
      lifecycle: 'open',
      number: 7,
      title: 'Custom provider support',
      url: URL,
      headRefName: 'feat/providers',
      baseRefName: 'main',
    },
    facts: knownFacts(),
    ...overrides,
  };
}

function createProvider(
  options: {
    id?: string;
    matchUrl?: MergeReadyProviderV1['matchUrl'];
    matchRemote?: MergeReadyProviderV1['matchRemote'];
    read?: MergeReadyProviderV1['read'];
  } = {},
): MergeReadyProviderV1 {
  return {
    apiVersion: 1,
    id: options.id ?? 'gitlab',
    matchUrl: options.matchUrl ?? ((url) => (url.href === URL ? TARGET : null)),
    matchRemote: options.matchRemote ?? (() => null),
    read: options.read ?? (async () => foundResult()),
  };
}

async function readUrl(provider: MergeReadyProviderV1, options: { timeout?: number } = {}) {
  return getMergeReadyStatus({
    exec: NOOP_EXEC,
    url: URL,
    providers: [provider],
    generatedAt: GENERATED_AT,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('merge-ready provider catalog', () => {
  it('freezes the catalog and snapshots provider methods for the session', async () => {
    const provider = createProvider();
    const catalog = createMergeReadyProviderCatalog([provider]);
    const reader = createCatalogBoundMergeReadyStatusReader(catalog);
    provider.read = async () => ({ kind: 'absent' });

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[1])).toBe(true);
    await expect(
      reader({ exec: NOOP_EXEC, url: URL, generatedAt: GENERATED_AT }),
    ).resolves.toMatchObject({ state: 'ready', pr: { number: 7 } });
  });

  it.each([
    null,
    {},
    { apiVersion: 2, id: 'bad', matchUrl: vi.fn(), matchRemote: vi.fn(), read: vi.fn() },
    { apiVersion: 1, id: ' ', matchUrl: vi.fn(), matchRemote: vi.fn(), read: vi.fn() },
    { apiVersion: 1, id: 'bad', matchUrl: vi.fn(), matchRemote: vi.fn() },
    { ...createProvider({ id: 'bad' }), state: 'ready' },
    { ...createProvider({ id: 'bad' }), summary: 'provider-owned' },
    { ...createProvider({ id: 'bad' }), openItems: [] },
  ])('rejects malformed provider contracts %#', (candidate) => {
    expect(() =>
      createMergeReadyProviderCatalog([candidate as unknown as MergeReadyProviderV1]),
    ).toThrow(/Invalid merge-ready provider contract|forbidden field/u);
  });

  it('rejects built-in and duplicate custom ids', () => {
    expect(() => createMergeReadyProviderCatalog([createProvider({ id: 'github' })])).toThrow(
      'Merge-ready provider id "github" is reserved by a built-in provider.',
    );
    expect(() => createMergeReadyProviderCatalog([createProvider(), createProvider()])).toThrow(
      'Duplicate merge-ready provider id "gitlab".',
    );
  });

  it('evaluates every URL matcher and rejects overlap', () => {
    const firstMatch = vi.fn(() => TARGET);
    const secondMatch = vi.fn(() => TARGET);
    const catalog = createMergeReadyProviderCatalog([
      createProvider({ id: 'first', matchUrl: firstMatch }),
      createProvider({ id: 'second', matchUrl: secondMatch }),
    ]);

    expect(() => resolveMergeReadyProviderForUrl(URL, catalog)).toThrow(
      'Multiple merge-ready providers matched',
    );
    expect(firstMatch).toHaveBeenCalledTimes(1);
    expect(secondMatch).toHaveBeenCalledTimes(1);
  });

  it('evaluates every remote matcher and rejects built-in overlap', () => {
    const customMatch = vi.fn(() => ({ owner: 'other', repo: 'repo' }));
    const catalog = createMergeReadyProviderCatalog([createProvider({ matchRemote: customMatch })]);

    expect(() =>
      resolveMergeReadyProviderForRemote(
        { name: 'origin', url: 'git@github.com:shop/pi.git' },
        catalog,
      ),
    ).toThrow('Multiple merge-ready providers matched');
    expect(customMatch).toHaveBeenCalledWith({
      name: 'origin',
      url: 'git@github.com:shop/pi.git',
    });
  });

  it.each([
    {
      name: 'URL matcher exception',
      select: (catalog: ReturnType<typeof createMergeReadyProviderCatalog>) =>
        resolveMergeReadyProviderForUrl(URL, catalog),
      provider: createProvider({
        matchUrl: () => {
          throw new Error('url exploded');
        },
      }),
      expected: 'URL matcher failed: url exploded',
    },
    {
      name: 'remote matcher exception',
      select: (catalog: ReturnType<typeof createMergeReadyProviderCatalog>) =>
        resolveMergeReadyProviderForRemote({ name: 'origin', url: 'custom://repo' }, catalog),
      provider: createProvider({
        matchRemote: () => {
          throw new Error('remote exploded');
        },
      }),
      expected: 'remote matcher failed: remote exploded',
    },
    {
      name: 'malformed URL match',
      select: (catalog: ReturnType<typeof createMergeReadyProviderCatalog>) =>
        resolveMergeReadyProviderForUrl(URL, catalog),
      provider: createProvider({
        matchUrl: () => ({ ...TARGET, mode: 'url' }) as never,
      }),
      expected: 'returned a malformed URL match',
    },
    {
      name: 'malformed remote match',
      select: (catalog: ReturnType<typeof createMergeReadyProviderCatalog>) =>
        resolveMergeReadyProviderForRemote({ name: 'origin', url: 'custom://repo' }, catalog),
      provider: createProvider({ matchRemote: () => ({ owner: '', repo: 'pi' }) }),
      expected: 'returned a malformed remote match',
    },
  ])('rejects $name', ({ select, provider, expected }) => {
    expect(() => select(createMergeReadyProviderCatalog([provider]))).toThrow(expected);
  });

  it.each(['64', 'https://github.com/shop/pi/pull/7?tab=checks'])(
    'preserves the GitHub URL error for an unhandled target: %s',
    async (url) => {
      await expect(
        getMergeReadyStatus({
          exec: NOOP_EXEC,
          url,
          providers: [createProvider({ matchUrl: () => null })],
          generatedAt: GENERATED_AT,
        }),
      ).rejects.toThrow(
        'Pass a full HTTPS GitHub pull request URL like https://github.com/OWNER/REPO/pull/NUMBER with no query string, fragment, or extra path.',
      );
    },
  );

  it('wraps provider read failures', async () => {
    await expect(
      readUrl(
        createProvider({
          read: async () => {
            throw new Error('network down');
          },
        }),
      ),
    ).rejects.toThrow('Merge-ready provider "gitlab" read failed: network down');
  });

  it('bounds provider reads by the caller timeout and the V1 maximum', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<MergeReadyProviderReadResultV1>(() => undefined));
    const shortRead = readUrl(createProvider({ read }), { timeout: 25 });
    const shortReadExpectation = expect(shortRead).rejects.toThrow(
      'Merge-ready provider "gitlab" read timed out after 25ms.',
    );
    await vi.advanceTimersByTimeAsync(25);
    await shortReadExpectation;

    const boundedRead = readUrl(createProvider({ read }), {
      timeout: CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS + 1,
    });
    const boundedReadExpectation = expect(boundedRead).rejects.toThrow(
      `Merge-ready provider "gitlab" read timed out after ${String(CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS)}ms.`,
    );
    await vi.advanceTimersByTimeAsync(CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS);
    await boundedReadExpectation;
  });

  it('clears the provider timeout timer after a successful read', async () => {
    vi.useFakeTimers();

    await expect(readUrl(createProvider())).resolves.toMatchObject({ state: 'ready' });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a provider rejection that arrives after timeout', async () => {
    vi.useFakeTimers();
    let rejectRead!: (reason?: unknown) => void;
    const read = vi.fn(
      () =>
        new Promise<MergeReadyProviderReadResultV1>((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    const pendingRead = readUrl(createProvider({ read }), { timeout: 25 });
    const timeoutExpectation = expect(pendingRead).rejects.toThrow(
      'Merge-ready provider "gitlab" read timed out after 25ms.',
    );

    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;

    rejectRead(new Error('late provider failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      name: 'lifecycle boxed string',
      result: foundResult({
        pullRequest: { ...foundResult().pullRequest, lifecycle: new String('open') as never },
      }),
    },
    {
      name: 'mergeability coercible object',
      result: foundResult({
        facts: knownFacts({
          mergeability: {
            kind: 'known',
            value: { toString: () => 'mergeable' } as never,
          },
        }),
      }),
    },
    {
      name: 'check state boxed string',
      result: foundResult({
        facts: knownFacts({
          checks: { kind: 'known', value: { state: new String('passing') as never } },
        }),
      }),
    },
    {
      name: 'review coercible object',
      result: foundResult({
        facts: knownFacts({
          review: {
            kind: 'known',
            value: { valueOf: () => 'approved' } as never,
          },
        }),
      }),
    },
    {
      name: 'evidence status boxed string',
      result: foundResult({
        evidence: {
          reviewPending: [{ label: 'reviewer', status: new String('unknown') as never }],
        },
      }),
    },
  ])('rejects $name instead of producing ready', async ({ result }) => {
    await expect(
      readUrl(
        createProvider({
          read: async () => result as MergeReadyProviderReadResultV1,
        }),
      ),
    ).rejects.toThrow('returned a malformed read result');
  });

  it.each([
    undefined,
    { kind: 'absent', extra: true },
    { kind: 'found' },
    { ...foundResult(), state: 'ready' },
    { ...foundResult(), summary: 'provider-owned summary' },
    { ...foundResult(), openItems: [] },
    { ...foundResult(), pullRequest: { ...foundResult().pullRequest, number: 8 } },
    {
      ...foundResult(),
      facts: knownFacts({ checks: { kind: 'known', value: { state: 'unknown' as never } } }),
    },
    {
      ...foundResult(),
      evidence: { reviewPending: [{ label: '', url: 'not-a-url' }] },
    },
  ])('rejects malformed or forbidden read result %#', async (result) => {
    await expect(
      readUrl(
        createProvider({
          read: async () => result as MergeReadyProviderReadResultV1,
        }),
      ),
    ).rejects.toThrow(/malformed read result|forbidden field/u);
  });

  it('adapts known facts and evidence while status owns readiness fields', async () => {
    const status = await readUrl(
      createProvider({
        read: async () =>
          foundResult({
            facts: knownFacts({
              checks: {
                kind: 'known',
                value: {
                  state: 'failing',
                  details: {
                    failing: [
                      {
                        label: 'unit',
                        status: 'failing',
                        url: 'https://ci.example/jobs/7',
                      },
                    ],
                    running: [],
                    unknown: [],
                  },
                },
              },
              review: { kind: 'known', value: 'changes_requested' },
            }),
            evidence: {
              changesRequested: [{ label: '@reviewer', url: 'https://gitlab.example/reviews/9' }],
            },
          }),
      }),
    );

    expect(status).toMatchObject({
      state: 'blocked',
      summary: 'Required checks are failing',
      openItems: [
        {
          id: 'ci_failing',
          summary: 'Required checks are failing',
          details: [{ label: 'unit', status: 'failing', url: 'https://ci.example/jobs/7' }],
        },
        {
          id: 'changes_requested',
          summary: 'Changes requested by reviewers',
          details: [{ label: '@reviewer', url: 'https://gitlab.example/reviews/9' }],
        },
      ],
      signals: { checks: 'failing', review: 'changes_requested' },
    });
  });

  it('turns explicit unknown facts into private unknown signals and integrity ambiguity', async () => {
    const status = await readUrl(
      createProvider({
        read: async () =>
          foundResult({
            facts: knownFacts({
              draft: { kind: 'unknown', message: 'draft unavailable' },
              review: { kind: 'unknown', message: 'review unavailable' },
            }),
          }),
      }),
    );

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(status.openItems.map((item) => item.id)).toEqual(['status_ambiguous']);
    expect(status.signals).toMatchObject({ draft: false, review: 'unknown' });
  });

  it.each([
    {
      result: { kind: 'absent' } as const,
      summary: 'Pull request not found: shop/pi#7',
      openItem: 'no_pull_request',
    },
    {
      result: {
        kind: 'unavailable',
        presence: 'known',
        message: 'service unavailable',
      } as const,
      summary: 'Unable to determine readiness for shop/pi#7: service unavailable',
      openItem: 'status_ambiguous',
    },
    {
      result: {
        kind: 'unavailable',
        presence: 'unknown',
        message: 'lookup failed',
      } as const,
      summary: 'Unable to determine readiness for shop/pi#7: lookup failed',
      openItem: 'status_ambiguous',
    },
  ])('adapts $result.kind results', async ({ result, summary, openItem }) => {
    const status = await readUrl(createProvider({ read: async () => result }));
    expect(status).toMatchObject({
      state: 'unknown',
      summary,
      openItems: [{ id: openItem, summary }],
    });
  });

  it('passes selected remote identity and a bounded timeout to direct ambient providers', async () => {
    const calls = createGitDiscoveryCalls({ timeout: 30_000 });
    const remoteCall = calls.find((call) => call.args.join(' ') === 'remote get-url origin');
    if (remoteCall?.result) remoteCall.result.stdout = 'ssh://git@gitlab.example/shop/pi.git\n';
    const { exec, assertDone } = createFakeExec(calls);
    const read = vi.fn(async () => foundResult());
    const provider = createProvider({
      matchUrl: () => null,
      matchRemote: (remote) =>
        remote.url.includes('gitlab.example') ? { owner: 'shop', repo: 'pi' } : null,
      read,
    });

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      timeout: 30_000,
      providers: [provider],
      generatedAt: GENERATED_AT,
    });

    assertDone();
    expect(status.state).toBe('ready');
    expect(read).toHaveBeenCalledWith({
      mode: 'ambient',
      cwd: '/repo',
      timeoutMs: CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS,
      remote: { name: 'origin', url: 'ssh://git@gitlab.example/shop/pi.git' },
      repository: { owner: 'shop', repo: 'pi' },
    });
  });

  it('lets a new session replace providers while an existing reader stays pinned', async () => {
    const oldProvider = createProvider({
      read: async () =>
        foundResult({ pullRequest: { ...foundResult().pullRequest, title: 'old' } }),
    });
    const newProvider = createProvider({
      read: async () =>
        foundResult({ pullRequest: { ...foundResult().pullRequest, title: 'new' } }),
    });
    const oldReader = createCatalogBoundMergeReadyStatusReader(
      createMergeReadyProviderCatalog([oldProvider]),
    );
    const newReader = createCatalogBoundMergeReadyStatusReader(
      createMergeReadyProviderCatalog([newProvider]),
    );

    await expect(
      oldReader({ exec: NOOP_EXEC, url: URL, generatedAt: GENERATED_AT }),
    ).resolves.toMatchObject({ pr: { title: 'old' } });
    await expect(
      newReader({ exec: NOOP_EXEC, url: URL, generatedAt: GENERATED_AT }),
    ).resolves.toMatchObject({ pr: { title: 'new' } });
    await expect(
      oldReader({ exec: NOOP_EXEC, url: URL, generatedAt: GENERATED_AT }),
    ).resolves.toMatchObject({ pr: { title: 'old' } });
  });
});
