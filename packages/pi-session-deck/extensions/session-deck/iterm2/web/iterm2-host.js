(function () {
  function getActionToken(document) {
    const tokenElement = document?.getElementById?.('session-deck-action-token');
    return tokenElement?.getAttribute?.('content') ?? '';
  }

  async function postJson(fetchImpl, path, actionToken, body) {
    const response = await fetchImpl(path, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Session-Deck-Action-Token': actionToken,
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message ?? `HTTP ${response.status}`);
    }
    return payload;
  }

  function createHost(options = {}) {
    const document = options.document ?? globalThis.document;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const runtimeNavigator = options.navigator ?? globalThis.navigator;
    const runtimeWindow = options.window ?? globalThis.window ?? globalThis;

    if (typeof fetchImpl !== 'function') {
      throw new Error('Session Deck iTerm2 host requires fetch.');
    }

    const actionToken = getActionToken(document);

    return {
      doctorCommand: '/session-deck iterm2 doctor',
      async loadSnapshot() {
        const response = await fetchImpl('/snapshot.json', {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return response.json();
      },
      previewWorktreeBaseRef(request) {
        return postJson(fetchImpl, '/actions/create-worktree-preview', actionToken, {
          action: 'preview-base-ref',
          repoIntent: request.repoIntent,
        });
      },
      previewWorktreeLaunchContext(request) {
        return postJson(fetchImpl, '/actions/create-worktree-preview', actionToken, {
          action: 'preview-launch-context',
          launch: request.launch,
        });
      },
      createWorktree(request) {
        return postJson(fetchImpl, '/actions/create-worktree', actionToken, request);
      },
      createSession(request) {
        return postJson(fetchImpl, '/actions/create-session', actionToken, request);
      },
      async openTerminal(runtimeId) {
        const response = await fetchImpl('/actions/open-terminal', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Session-Deck-Action-Token': actionToken,
          },
          body: JSON.stringify({ runtimeId }),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            typeof payload?.message === 'string' && payload.message.length > 0
              ? payload.message
              : `HTTP ${response.status}`,
          );
        }
        return payload;
      },
      async killSession(runtimeId) {
        const response = await fetchImpl('/actions/kill-session', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Session-Deck-Action-Token': actionToken,
          },
          body: JSON.stringify({ runtimeId }),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            typeof payload?.message === 'string' && payload.message.length > 0
              ? payload.message
              : `HTTP ${response.status}`,
          );
        }
        return payload;
      },
      async openExternal(url) {
        if (typeof runtimeWindow.open === 'function') {
          runtimeWindow.open(url, '_blank', 'noopener,noreferrer');
          return { ok: true };
        }

        return { ok: false, message: 'Could not open link.' };
      },
      async copyText(text) {
        if (typeof runtimeNavigator?.clipboard?.writeText !== 'function') {
          return { ok: false, message: 'Clipboard unavailable.' };
        }

        try {
          await runtimeNavigator.clipboard.writeText(text);
          return { ok: true };
        } catch {
          return { ok: false, message: 'Clipboard unavailable.' };
        }
      },
    };
  }

  const target = globalThis.window ?? globalThis;
  target.SessionDeckIterm2Host = { createHost };
})();
