import {
  lookupIdentityTerminalFocusTarget,
  type IdentityTerminalFocusLookupOptions,
  type IdentityTerminalFocusLookupResult,
} from './terminal-focus.js';

export type IdentityTerminalRevealLookupFailureReason =
  | 'identity-missing'
  | 'identity-read-error'
  | 'identity-malformed'
  | 'runtime-mismatch'
  | 'terminal-missing';

export type IdentityTerminalRevealLookupResult =
  | { ok: true; revealUrl: string }
  | {
      ok: false;
      reason: IdentityTerminalRevealLookupFailureReason;
      message: string;
    };

export type IdentityTerminalRevealLookupOptions = IdentityTerminalFocusLookupOptions;

export async function lookupIdentityTerminalRevealUrl(
  runtimeId: string,
  options: IdentityTerminalRevealLookupOptions = {},
): Promise<IdentityTerminalRevealLookupResult> {
  const focusResult = await lookupIdentityTerminalFocusTarget(runtimeId, options);
  if (!focusResult.ok) {
    return toRevealFailure(focusResult);
  }

  if (focusResult.target.kind !== 'iterm2-session') {
    return {
      ok: false,
      reason: 'terminal-missing',
      message: 'No iTerm2 reveal metadata is available for the selected session.',
    };
  }

  return { ok: true, revealUrl: focusResult.target.revealUrl };
}

function toRevealFailure(
  result: Extract<IdentityTerminalFocusLookupResult, { ok: false }>,
): Extract<IdentityTerminalRevealLookupResult, { ok: false }> {
  return {
    ok: false,
    reason: result.reason === 'terminal-target-incomplete' ? 'terminal-missing' : result.reason,
    message: result.message,
  };
}
