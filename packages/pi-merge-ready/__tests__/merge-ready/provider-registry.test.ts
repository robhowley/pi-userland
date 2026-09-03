import { describe, expect, it, vi } from 'vitest';
import type { MergeReadyExec } from '../../extensions/merge-ready/git.js';
import { getMergeReadyStatus } from '../../extensions/merge-ready/merge-ready.js';
import type {
  MergeReadyProviderReadResultV1,
  MergeReadyProviderV1,
} from '../../extensions/merge-ready/provider-api.js';
import {
  createMergeReadyProviders,
  readMergeReadyProvider,
  resolveMergeReadyProviderForRemote,
  resolveMergeReadyProviderForUrl,
} from '../../extensions/merge-ready/provider-registry.js';
import { createFakeExec, createGitDiscoveryCalls } from './test-fixtures.js';

const URL = 'https://code.example/shop/pi/changes/7';
const REMOTE_URL = 'ssh://code.example/shop/pi';
const SIGNALS = {
  draft: false,
  mergeability: 'mergeable' as const,
  checks: 'passing' as const,
  review: 'approved' as const,
  unresolvedConversations: false,
  unresolvedConversationRequirement: 'optional' as const,
};
const PULL_REQUEST = {
  lifecycle: 'open' as const,
  number: 7,
  title: 'Change',
  url: URL,
  headRefName: 'feature',
  baseRefName: 'main',
};
const exec = vi.fn() as unknown as MergeReadyExec;

function provider(id = 'custom'): MergeReadyProviderV1 {
  const read: MergeReadyProviderV1['read'] = async () => ({
    kind: 'found',
    pullRequest: PULL_REQUEST,
    signals: SIGNALS,
  });
  return {
    apiVersion: 1,
    id,
    matchUrl: vi.fn((url) =>
      url.href === URL ? { url: URL, owner: 'shop', repo: 'pi', prNumber: 7, extra: true } : null,
    ),
    matchRemote: vi.fn((remote) =>
      remote.url === 'ssh://code.example/shop/pi'
        ? { owner: 'shop', repo: 'pi', extra: true }
        : null,
    ),
    read: vi.fn(read),
  };
}

function setReadResult(value: MergeReadyProviderV1, result: unknown): void {
  value.read = vi.fn(async () => result as MergeReadyProviderReadResultV1);
}

describe('merge-ready provider registry', () => {
  it('rejects reserved and duplicate IDs', () => {
    expect(() => createMergeReadyProviders(exec, [provider('github')])).toThrow('reserved');
    expect(() => createMergeReadyProviders(exec, [provider('same'), provider('same')])).toThrow(
      'Duplicate',
    );
  });

  it('canonicalizes a URL alias, matches each provider once, and reads one exact target', async () => {
    const alias = `${URL}?tab=checks#overview`;
    const first = provider('first');
    first.matchUrl = vi.fn((url) =>
      url.origin === 'https://code.example' && url.pathname === '/shop/pi/changes/7'
        ? { url: URL, owner: 'shop', repo: 'pi', prNumber: 7, extra: true }
        : null,
    );
    const second = provider('second');
    second.matchUrl = vi.fn(() => null);
    first.read = vi.fn(async (input: Parameters<MergeReadyProviderV1['read']>[0]) => {
      expect(Object.keys(input).sort()).toEqual(['mode', 'target', 'timeoutMs']);
      if (input.mode !== 'url') throw new Error('expected URL input');
      expect(Object.keys(input.target).sort()).toEqual(['owner', 'prNumber', 'repo', 'url']);
      expect(input.target).toEqual({ url: URL, owner: 'shop', repo: 'pi', prNumber: 7 });
      expect(input.timeoutMs).toBe(50);
      return { kind: 'found', pullRequest: PULL_REQUEST, signals: SIGNALS } as const;
    });

    const status = await getMergeReadyStatus({
      exec,
      url: alias,
      timeout: 50,
      providers: [first, second],
    });

    expect(first.matchUrl).toHaveBeenCalledTimes(1);
    expect(second.matchUrl).toHaveBeenCalledTimes(1);
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(status.target).toEqual({
      mode: 'url',
      url: URL,
      owner: 'shop',
      repo: 'pi',
      prNumber: 7,
    });
    expect(status.state).toBe('ready');
  });

  it('evaluates each remote matcher once and copies documented repository fields', () => {
    const first = provider('first');
    const second = provider('second');
    second.matchRemote = vi.fn(() => null);
    const selection = resolveMergeReadyProviderForRemote({ name: 'origin', url: REMOTE_URL }, [
      first,
      second,
    ]);

    expect(first.matchRemote).toHaveBeenCalledTimes(1);
    expect(second.matchRemote).toHaveBeenCalledTimes(1);
    expect(selection?.repository).toEqual({ owner: 'shop', repo: 'pi' });
  });

  it('rejects overlap and identifies matcher exceptions', () => {
    expect(() => resolveMergeReadyProviderForUrl(URL, [provider('a'), provider('b')])).toThrow(
      'a, b',
    );
    const brokenUrl = provider('broken-url');
    brokenUrl.matchUrl = () => {
      throw new Error('url boom');
    };
    expect(() => resolveMergeReadyProviderForUrl(URL, [brokenUrl])).toThrow(
      '"broken-url" URL matcher failed: url boom',
    );

    const brokenRemote = provider('broken-remote');
    brokenRemote.matchRemote = () => {
      throw new Error('remote boom');
    };
    expect(() =>
      resolveMergeReadyProviderForRemote({ name: 'origin', url: 'x' }, [brokenRemote]),
    ).toThrow('"broken-remote" remote matcher failed: remote boom');
  });

  it('preserves provider this', async () => {
    const value = provider();
    value.read = async function () {
      expect(this).toBe(value);
      return { kind: 'absent' };
    };
    await expect(
      readMergeReadyProvider(value, {
        mode: 'url',
        target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 },
      }),
    ).resolves.toEqual({ kind: 'absent' });
  });

  it('caps reads and reports the provider ID', async () => {
    vi.useFakeTimers();
    try {
      const slow = provider('slow');
      slow.read = () => new Promise(() => undefined);
      const pending = readMergeReadyProvider(
        slow,
        { mode: 'url', target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 } },
        50,
      );
      const assertion = expect(pending).rejects.toThrow(
        'provider "slow" read timed out after 50ms',
      );
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps provider timeouts to 20 seconds and observes a late rejection', async () => {
    vi.useFakeTimers();
    try {
      let rejectRead: (reason?: unknown) => void = () => undefined;
      const lateRead = new Promise<never>((_, reject) => {
        rejectRead = reject;
      });
      const slow = provider('slow');
      slow.read = vi.fn(() => lateRead);
      const pending = readMergeReadyProvider(
        slow,
        { mode: 'url', target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 } },
        60_000,
      );
      const assertion = expect(pending).rejects.toThrow('timed out after 20000ms');

      await Promise.resolve();
      expect(slow.read).toHaveBeenCalledWith({
        mode: 'url',
        target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 },
        timeoutMs: 20_000,
      });
      await vi.advanceTimersByTimeAsync(19_999);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;

      rejectRead(new Error('late failure'));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps provider read errors with the provider ID', async () => {
    const broken = provider('broken');
    broken.read = vi.fn(async () => {
      throw new Error('read boom');
    });

    await expect(
      readMergeReadyProvider(broken, {
        mode: 'url',
        target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 },
      }),
    ).rejects.toThrow('Merge-ready provider "broken" read failed: read boom');
  });

  it.each([
    { kind: 'absent' },
    { kind: 'unavailable', presence: 'known', message: 'down' },
    { kind: 'unavailable', presence: 'unknown', message: 'unknown' },
    { kind: 'found', pullRequest: PULL_REQUEST, signals: SIGNALS },
    { kind: 'found', pullRequest: { ...PULL_REQUEST, lifecycle: 'merged' as const } },
    { kind: 'found', pullRequest: { ...PULL_REQUEST, lifecycle: 'closed' as const } },
  ] as const)('accepts result kind $kind', async (result) => {
    const value = provider();
    value.read = async () => result;
    await expect(
      readMergeReadyProvider(value, {
        mode: 'url',
        target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 },
      }),
    ).resolves.toEqual(result);
  });

  it.each([
    {
      name: 'absent',
      result: { kind: 'absent' },
      state: 'unknown',
      summary: 'Pull request not found: shop/pi#7',
      openItemIds: ['no_pull_request'],
    },
    {
      name: 'known unavailable',
      result: { kind: 'unavailable', presence: 'known', message: 'source is down' },
      state: 'unknown',
      summary: 'Unable to determine readiness for shop/pi#7: source is down',
      openItemIds: ['status_ambiguous'],
    },
    {
      name: 'unknown unavailable',
      result: { kind: 'unavailable', presence: 'unknown', message: 'source is unreachable' },
      state: 'unknown',
      summary: 'Unable to determine readiness for shop/pi#7: source is unreachable',
      openItemIds: ['status_ambiguous'],
    },
    {
      name: 'merged',
      result: { kind: 'found', pullRequest: { ...PULL_REQUEST, lifecycle: 'merged' as const } },
      state: 'unknown',
      summary: 'PR is already merged',
      openItemIds: [],
    },
    {
      name: 'closed',
      result: { kind: 'found', pullRequest: { ...PULL_REQUEST, lifecycle: 'closed' as const } },
      state: 'unknown',
      summary: 'PR is closed',
      openItemIds: [],
    },
  ] as const)('maps custom $name results through core status derivation', async (fixture) => {
    const value = provider();
    setReadResult(value, fixture.result);

    const status = await getMergeReadyStatus({ exec, url: URL, providers: [value] });

    expect(status.state).toBe(fixture.state);
    expect(status.summary).toBe(fixture.summary);
    expect(status.openItems.map(({ id }) => id)).toEqual(fixture.openItemIds);
  });

  it.each(['known', 'unknown'] as const)(
    'preserves an ambient %s unavailable message in ambiguity details',
    async (presence) => {
      const { exec: ambientExec, assertDone } = createFakeExec(
        createGitDiscoveryCalls().map((call, index) =>
          index === 3 ? { ...call, result: { stdout: `${REMOTE_URL}\n` } } : call,
        ),
      );
      const value = provider();
      setReadResult(value, {
        kind: 'unavailable',
        presence,
        message: 'source access is unavailable',
      });

      const status = await getMergeReadyStatus({
        exec: ambientExec,
        cwd: '/repo',
        providers: [value],
        now: () => new Date('2026-05-26T22:00:00.000Z'),
      });

      assertDone();
      expect(status.state).toBe('unknown');
      expect(status.summary).toBe('Unable to determine readiness: source access is unavailable');
      expect(status.openItems).toEqual([
        {
          id: 'status_ambiguous',
          summary: 'Unable to determine readiness: source access is unavailable',
          details: [{ label: 'source access is unavailable' }],
        },
      ]);
    },
  );

  it.each([
    {
      name: 'signals',
      result: {
        kind: 'found',
        pullRequest: PULL_REQUEST,
        signals: { ...SIGNALS, checks: 'not-a-signal' },
      },
    },
    {
      name: 'check details',
      result: {
        kind: 'found',
        pullRequest: PULL_REQUEST,
        signals: { ...SIGNALS, checkDetails: { failing: [] } },
      },
    },
    {
      name: 'evidence',
      result: {
        kind: 'found',
        pullRequest: PULL_REQUEST,
        signals: SIGNALS,
        evidence: { reviewPending: [{ label: '', url: 'not-a-url' }] },
      },
    },
    {
      name: 'issues',
      result: {
        kind: 'found',
        pullRequest: PULL_REQUEST,
        signals: SIGNALS,
        issues: ['valid issue', 42],
      },
    },
    {
      name: 'terminal fields',
      result: {
        kind: 'found',
        pullRequest: { ...PULL_REQUEST, lifecycle: 'merged' as const },
        signals: undefined,
      },
    },
  ] as const)('rejects malformed consumed $name fields', async ({ result }) => {
    const value = provider();
    setReadResult(value, result);

    await expect(
      readMergeReadyProvider(value, {
        mode: 'url',
        target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 },
      }),
    ).rejects.toThrow('malformed read result');
  });

  it('keeps a concrete blocker authoritative while exposing provider issues', async () => {
    const value = provider();
    value.read = async () => ({
      kind: 'found',
      pullRequest: PULL_REQUEST,
      signals: { ...SIGNALS, mergeability: 'unknown', checks: 'failing' },
      issues: ['mergeability payload was incomplete'],
    });
    const status = await getMergeReadyStatus({ exec, url: URL, providers: [value] });
    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('Required checks are failing');
    expect(status.openItems.find(({ id }) => id === 'status_ambiguous')?.details).toEqual([
      { label: 'mergeability payload was incomplete' },
    ]);
  });

  it('rejects provider readiness and wrong URL identity while allowing extras', async () => {
    const value = provider();
    value.read = async () => ({
      ...({ kind: 'found', pullRequest: PULL_REQUEST, signals: SIGNALS } as const),
      harmless: true,
    });
    await expect(
      readMergeReadyProvider(value, {
        mode: 'url',
        target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 },
      }),
    ).resolves.toHaveProperty('harmless', true);

    for (const pullRequest of [
      { ...PULL_REQUEST, number: 8 },
      { ...PULL_REQUEST, url: 'https://code.example/shop/pi/changes/other' },
    ]) {
      value.read = async () => ({ kind: 'found', pullRequest, signals: SIGNALS });
      await expect(
        readMergeReadyProvider(value, {
          mode: 'url',
          target: { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 },
        }),
      ).rejects.toThrow('malformed read result');
    }
  });
});
