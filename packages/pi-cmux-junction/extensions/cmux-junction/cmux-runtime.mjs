import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';

export async function resolveCmuxExecutable(env, executableAccess = access) {
  const candidate = env.CMUX_BUNDLED_CLI_PATH?.trim();
  if (!candidate) return 'cmux';
  try {
    await executableAccess(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return 'cmux';
  }
}

/**
 * @param {any} error
 * @returns {
 *   | { kind: 'timeout'; signal: string }
 *   | { kind: 'signal'; signal: string }
 *   | { kind: 'exit'; exitCode: number }
 *   | { kind: 'spawn'; message: string; code?: string }
 * }
 */
export function classifyExecFileFailure(error) {
  if (error.killed) return { kind: 'timeout', signal: error.signal ?? 'SIGTERM' };
  if (error.signal !== undefined && error.signal !== null) {
    return { kind: 'signal', signal: error.signal };
  }
  if (typeof error.code === 'number') return { kind: 'exit', exitCode: error.code };
  return {
    kind: 'spawn',
    message: error.message,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
  };
}
