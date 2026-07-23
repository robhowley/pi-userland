/**
 * @typedef {{
 *   loadSnapshot: () => Promise<unknown>,
 *   previewWorktreeBaseRef: (request: { repoIntent: unknown }) => Promise<unknown>,
 *   previewWorktreeLaunchContext: (request: {
 *     launch?: {
 *       mode: 'tmux-detached',
 *       agentDir?: { mode: 'ambient' | 'default' } | { mode: 'custom', customDir: string }
 *     }
 *   }) => Promise<unknown>,
 *   createWorktree: (request: {
 *     repoIntent: unknown,
 *     branchName: string,
 *     baseRef?: string,
 *     launch?: {
 *       mode: 'tmux-detached',
 *       agentDir?: { mode: 'ambient' | 'default' } | { mode: 'custom', customDir: string }
 *     }
 *   }) => Promise<unknown>,
 *   createSession: (request: {
 *     action: 'create-session',
 *     cwd: string,
 *     launch?: {
 *       mode: 'tmux-detached',
 *       agentDir?: { mode: 'ambient' | 'default' } | { mode: 'custom', customDir: string }
 *     }
 *   }) => Promise<unknown>,
 *   openTerminal: (runtimeId: string) => Promise<unknown>,
 *   killSession: (runtimeId: string) => Promise<unknown>,
 *   openExternal: (url: string) => Promise<{ ok: boolean, message?: string }>,
 *   copyText: (text: string) => Promise<{ ok: boolean, message?: string }>,
 *   doctorCommand: string,
 *   doctorStatus: () => Promise<unknown>,
 * }} SessionDeckHost
 */

/**
 * @param {Window & typeof globalThis | undefined} [windowLike]
 * @returns {(command: string, args?: Record<string, unknown>) => Promise<unknown>}
 */
export function resolveTauriInvoke(windowLike = globalThis.window) {
  const tauriWindow =
    /** @type {{ __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } }} */ (
      windowLike ?? {}
    );
  const invoke = tauriWindow.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('Tauri invoke bridge is unavailable. Ensure app.withGlobalTauri is enabled.');
  }
  return invoke;
}

/**
 * @param {{ window?: Window & typeof globalThis, doctorCommand?: string }} [options]
 * @returns {SessionDeckHost}
 */
export function createTauriSessionDeckHost(options = {}) {
  const invoke = resolveTauriInvoke(options.window);
  const doctorCommand =
    options.doctorCommand ?? 'Open desktop diagnostics or run /session-deck desktop doctor.';

  return {
    loadSnapshot() {
      return invoke('load_snapshot');
    },
    previewWorktreeBaseRef(request) {
      return invoke('preview_worktree_base_ref', { request });
    },
    previewWorktreeLaunchContext(request) {
      return invoke('preview_worktree_launch_context', { request });
    },
    createWorktree(request) {
      return invoke('create_worktree', { request });
    },
    createSession(request) {
      return invoke('create_session', { request });
    },
    openTerminal(runtimeId) {
      return invoke('open_terminal', { request: { runtimeId } });
    },
    killSession(runtimeId) {
      return invoke('kill_session', { request: { runtimeId } });
    },
    openExternal(url) {
      return /** @type {Promise<{ ok: boolean, message?: string }>} */ (
        invoke('open_external', { url })
      );
    },
    copyText(text) {
      return /** @type {Promise<{ ok: boolean, message?: string }>} */ (
        invoke('copy_text', { text })
      );
    },
    doctorCommand,
    doctorStatus() {
      return invoke('doctor_status');
    },
  };
}
