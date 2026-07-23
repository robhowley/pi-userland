import { describe, expect, it, vi } from 'vitest';
import { createTauriSessionDeckHost, resolveTauriInvoke } from '../web/tauri-host.js';

describe('tauri-host', () => {
  it('resolves the global Tauri invoke bridge', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const resolved = resolveTauriInvoke({
      __TAURI__: {
        core: {
          invoke,
        },
      },
    } as unknown as Window & typeof globalThis);

    await resolved('load_snapshot');

    expect(invoke).toHaveBeenCalledWith('load_snapshot');
  });

  it('maps the desktop host contract to the expected command names and payloads', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const host = createTauriSessionDeckHost({
      window: {
        __TAURI__: {
          core: {
            invoke,
          },
        },
      } as unknown as Window & typeof globalThis,
    });

    expect(host.doctorCommand).toBe(
      'Open desktop diagnostics or run /session-deck desktop doctor.',
    );

    await host.loadSnapshot();
    await host.previewWorktreeBaseRef({ repoIntent: { repoName: 'pi-userland' } });
    await host.previewWorktreeLaunchContext({
      launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
    });
    await host.createWorktree({
      repoIntent: { repoName: 'pi-userland' },
      branchName: 'feat/desktop-shell',
      baseRef: 'origin/main',
      launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
    });
    await host.createSession({
      action: 'create-session',
      cwd: '~/scratch',
      launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
    });
    await host.openTerminal('runtime-1');
    await host.killSession('runtime-1');
    await host.openExternal('https://example.com');
    await host.copyText('copied');
    await host.doctorStatus();

    expect(invoke.mock.calls).toEqual([
      ['load_snapshot'],
      ['preview_worktree_base_ref', { request: { repoIntent: { repoName: 'pi-userland' } } }],
      [
        'preview_worktree_launch_context',
        {
          request: {
            launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
          },
        },
      ],
      [
        'create_worktree',
        {
          request: {
            repoIntent: { repoName: 'pi-userland' },
            branchName: 'feat/desktop-shell',
            baseRef: 'origin/main',
            launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
          },
        },
      ],
      [
        'create_session',
        {
          request: {
            action: 'create-session',
            cwd: '~/scratch',
            launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
          },
        },
      ],
      ['open_terminal', { request: { runtimeId: 'runtime-1' } }],
      ['kill_session', { request: { runtimeId: 'runtime-1' } }],
      ['open_external', { url: 'https://example.com' }],
      ['copy_text', { text: 'copied' }],
      ['doctor_status'],
    ]);
  });

  it('fails clearly when the global Tauri bridge is unavailable', () => {
    expect(() => resolveTauriInvoke(undefined)).toThrow(
      'Tauri invoke bridge is unavailable. Ensure app.withGlobalTauri is enabled.',
    );
  });
});
