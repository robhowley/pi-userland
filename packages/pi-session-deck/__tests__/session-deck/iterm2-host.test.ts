import { afterEach, describe, expect, it, vi } from 'vitest';

let cleanupGlobals: (() => void) | null = null;

afterEach(() => {
  cleanupGlobals?.();
  cleanupGlobals = null;
  vi.restoreAllMocks();
});

function installGlobals(overrides: {
  document?: unknown;
  fetch?: unknown;
  navigator?: unknown;
  window?: unknown;
}): () => void {
  const previous = {
    document: Reflect.get(globalThis, 'document'),
    fetch: Reflect.get(globalThis, 'fetch'),
    navigator: Reflect.get(globalThis, 'navigator'),
    window: Reflect.get(globalThis, 'window'),
  };

  for (const [name, value] of Object.entries(overrides)) {
    Reflect.set(globalThis, name, value);
  }

  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Reflect.set(globalThis, name, value);
      }
    }
  };
}

async function loadFreshHostFactory(): Promise<{
  createHost: (options?: Record<string, unknown>) => {
    copyText: (text: string) => Promise<unknown>;
    createSession: (request: unknown) => Promise<unknown>;
    createWorktree: (request: unknown) => Promise<unknown>;
    loadSnapshot: () => Promise<unknown>;
    killSession: (runtimeId: string) => Promise<unknown>;
    openExternal: (url: string) => Promise<unknown>;
    openTerminal: (runtimeId: string) => Promise<unknown>;
    previewWorktreeBaseRef: (request: unknown) => Promise<unknown>;
    previewWorktreeLaunchContext: (request: unknown) => Promise<unknown>;
  };
}> {
  const moduleUrl = new URL(
    '../../extensions/session-deck/iterm2/web/iterm2-host.js',
    import.meta.url,
  );
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  await import(moduleUrl.href);
  const windowLike = Reflect.get(globalThis, 'window') as { SessionDeckIterm2Host: unknown };
  return windowLike.SessionDeckIterm2Host as {
    createHost: (options?: Record<string, unknown>) => {
      copyText: (text: string) => Promise<unknown>;
      createSession: (request: unknown) => Promise<unknown>;
      createWorktree: (request: unknown) => Promise<unknown>;
      loadSnapshot: () => Promise<unknown>;
      killSession: (runtimeId: string) => Promise<unknown>;
      openExternal: (url: string) => Promise<unknown>;
      openTerminal: (runtimeId: string) => Promise<unknown>;
      previewWorktreeBaseRef: (request: unknown) => Promise<unknown>;
      previewWorktreeLaunchContext: (request: unknown) => Promise<unknown>;
    };
  };
}

function buildDocument(token = 'test-token') {
  return {
    getElementById(id: string) {
      if (id !== 'session-deck-action-token') {
        return null;
      }
      return {
        getAttribute(name: string) {
          return name === 'content' ? token : null;
        },
      };
    },
  };
}

describe('SessionDeckIterm2Host', () => {
  it('loads the snapshot with the current iTerm2 route and headers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    cleanupGlobals = installGlobals({
      document: buildDocument(),
      fetch: fetchMock,
      window: {},
    });

    const { createHost } = await loadFreshHostFactory();
    await createHost().loadSnapshot();

    expect(fetchMock).toHaveBeenCalledWith('/snapshot.json', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  });

  it('posts the preview request with the exact iTerm2 route, token header, and payload', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, baseRef: 'origin/main' }),
    }));
    cleanupGlobals = installGlobals({
      document: buildDocument('preview-token'),
      fetch: fetchMock,
      window: {},
    });

    const { createHost } = await loadFreshHostFactory();
    await createHost().previewWorktreeBaseRef({
      repoIntent: {
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        candidateRuntimeIds: ['rt-1'],
      },
    });

    expect(fetchMock).toHaveBeenCalledWith('/actions/create-worktree-preview', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Session-Deck-Action-Token': 'preview-token',
      },
      body: JSON.stringify({
        action: 'preview-base-ref',
        repoIntent: {
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
          candidateRuntimeIds: ['rt-1'],
        },
      }),
    });
  });

  it('posts the launch preview request with the exact iTerm2 route, token header, and payload', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 'resolved' }),
    }));
    cleanupGlobals = installGlobals({
      document: buildDocument('launch-preview-token'),
      fetch: fetchMock,
      window: {},
    });

    const { createHost } = await loadFreshHostFactory();
    await createHost().previewWorktreeLaunchContext({
      launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
    });

    expect(fetchMock).toHaveBeenCalledWith('/actions/create-worktree-preview', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Session-Deck-Action-Token': 'launch-preview-token',
      },
      body: JSON.stringify({
        action: 'preview-launch-context',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
      }),
    });
  });

  it('posts create-worktree and runtime action requests with the current payloads and error mapping', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, status: 'created' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, status: 'launched' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        json: async () => {
          throw new Error('bad json');
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, status: 'terminated' }),
      });
    cleanupGlobals = installGlobals({
      document: buildDocument('action-token'),
      fetch: fetchMock,
      window: {},
    });

    const { createHost } = await loadFreshHostFactory();
    const host = createHost();

    await host.createWorktree({
      repoIntent: {
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        candidateRuntimeIds: ['rt-1'],
      },
      branchName: 'rh/feature-name',
      baseRef: 'origin/main',
      launch: { mode: 'tmux-detached' },
    });

    await host.createSession({
      action: 'create-session',
      cwd: '~/scratch',
      launch: { mode: 'tmux-detached' },
    });

    await expect(host.openTerminal('rt-1')).rejects.toThrow('HTTP 504');
    await host.killSession('rt-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/actions/create-worktree', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Session-Deck-Action-Token': 'action-token',
      },
      body: JSON.stringify({
        repoIntent: {
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'rh/feature-name',
        baseRef: 'origin/main',
        launch: { mode: 'tmux-detached' },
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/actions/create-session', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Session-Deck-Action-Token': 'action-token',
      },
      body: JSON.stringify({
        action: 'create-session',
        cwd: '~/scratch',
        launch: { mode: 'tmux-detached' },
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/actions/open-terminal', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Session-Deck-Action-Token': 'action-token',
      },
      body: JSON.stringify({ runtimeId: 'rt-1' }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/actions/kill-session', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Session-Deck-Action-Token': 'action-token',
      },
      body: JSON.stringify({ runtimeId: 'rt-1' }),
    });
  });

  it('routes external links through window.open', async () => {
    const openMock = vi.fn();
    cleanupGlobals = installGlobals({
      document: buildDocument(),
      fetch: vi.fn(),
      window: { open: openMock },
    });

    const { createHost } = await loadFreshHostFactory();
    await createHost().openExternal('https://example.com/reviews/123');

    expect(openMock).toHaveBeenCalledWith(
      'https://example.com/reviews/123',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('maps clipboard success and fallback through the host adapter', async () => {
    const clipboardWriteText = vi.fn(async () => undefined);
    cleanupGlobals = installGlobals({
      document: buildDocument(),
      fetch: vi.fn(),
      window: {},
    });

    const { createHost } = await loadFreshHostFactory();
    const successHost = createHost({
      navigator: { clipboard: { writeText: clipboardWriteText } },
    });
    await expect(successHost.copyText('copy me')).resolves.toEqual({ ok: true });
    expect(clipboardWriteText).toHaveBeenCalledWith('copy me');

    const fallbackHost = createHost({ navigator: {} });
    await expect(fallbackHost.copyText('copy me')).resolves.toEqual({
      ok: false,
      message: 'Clipboard unavailable.',
    });
  });
});
