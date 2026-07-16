import {
  openTerminalFocusTarget,
  type TerminalOpenOptions,
  type TerminalOpenResult,
} from '../terminal-open.js';
import {
  lookupIdentityTerminalFocusTarget,
  type IdentityTerminalFocusLookupOptions,
  type IdentityTerminalFocusLookupResult,
} from './terminal-focus.js';

export type SessionDeckOpenSelectedResult =
  | TerminalOpenResult
  | Extract<IdentityTerminalFocusLookupResult, { ok: false }>;

export type OpenTerminalForRuntimeOptions = IdentityTerminalFocusLookupOptions &
  TerminalOpenOptions;

export type OpenIterm2TerminalForRuntimeOptions = OpenTerminalForRuntimeOptions;

export async function openTerminalForRuntime(
  runtimeId: string,
  options: OpenTerminalForRuntimeOptions = {},
): Promise<SessionDeckOpenSelectedResult> {
  const lookupResult = await lookupIdentityTerminalFocusTarget(runtimeId, {
    ...(options.identityDirectory === undefined
      ? {}
      : { identityDirectory: options.identityDirectory }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  });
  if (!lookupResult.ok) {
    return lookupResult;
  }

  return openTerminalFocusTarget(lookupResult.target, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.execFile === undefined ? {} : { execFile: options.execFile }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.bridgeMode === undefined ? {} : { bridgeMode: options.bridgeMode }),
    ...(options.iterm2RuntimeClient === undefined
      ? {}
      : { iterm2RuntimeClient: options.iterm2RuntimeClient }),
    ...(options.pythonBridgeClient === undefined
      ? {}
      : { pythonBridgeClient: options.pythonBridgeClient }),
    ...(options.tmuxPreflightTimeoutMs === undefined
      ? {}
      : { tmuxPreflightTimeoutMs: options.tmuxPreflightTimeoutMs }),
  });
}

export async function openIterm2TerminalForRuntime(
  runtimeId: string,
  options: OpenIterm2TerminalForRuntimeOptions = {},
): Promise<SessionDeckOpenSelectedResult> {
  return openTerminalForRuntime(runtimeId, options);
}
