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
 *   restartSession: (request: { runtimeId: string, generation: string, operationId: string }) => Promise<unknown>,
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
  /**
   * @param {string} command
   * @param {Record<string, unknown> | undefined} [args]
   */
  const invokeCommand = (command, args) =>
    (args === undefined ? invoke(command) : invoke(command, args)).catch((rejection) => {
      throw normalizeTauriRejection(rejection);
    });
  const doctorCommand =
    options.doctorCommand ?? 'Open desktop diagnostics or run /session-deck desktop doctor.';

  return {
    loadSnapshot() {
      return invokeCommand('load_snapshot');
    },
    previewWorktreeBaseRef(request) {
      return invokeCommand('preview_worktree_base_ref', { request });
    },
    previewWorktreeLaunchContext(request) {
      return invokeCommand('preview_worktree_launch_context', { request });
    },
    createWorktree(request) {
      return invokeCommand('create_worktree', { request });
    },
    createSession(request) {
      return invokeCommand('create_session', { request });
    },
    openTerminal(runtimeId) {
      return invokeCommand('open_terminal', { request: { runtimeId } });
    },
    killSession(runtimeId) {
      return invokeCommand('kill_session', { request: { runtimeId } });
    },
    restartSession(request) {
      return invokeCommand('restart_session', { request });
    },
    openExternal(url) {
      return /** @type {Promise<{ ok: boolean, message?: string }>} */ (
        invokeCommand('open_external', { url })
      );
    },
    copyText(text) {
      return /** @type {Promise<{ ok: boolean, message?: string }>} */ (
        invokeCommand('copy_text', { text })
      );
    },
    doctorCommand,
    doctorStatus() {
      return invokeCommand('doctor_status');
    },
  };
}

/** @param {unknown} rejection */
function normalizeTauriRejection(rejection) {
  if (rejection instanceof Error) {
    return rejection;
  }

  if (typeof rejection === 'object' && rejection !== null) {
    const structured = /** @type {Record<string, unknown>} */ (rejection);
    const error = new Error(
      typeof structured['message'] === 'string' ? structured['message'] : String(rejection),
    );
    return Object.assign(error, structured);
  }

  return new Error(String(rejection));
}
