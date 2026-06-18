import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SESSION_DECK_COMMAND_NAME } from './presence/constants.js';
import { registerSessionDeckCommand, type PresenceCommandAPI } from './identity/command.js';
import {
  ensurePresenceRuntimeStarted,
  type PresenceRuntimeController,
} from './presence/runtime.js';
import { ensureIdentityRuntimeStarted } from './identity/runtime.js';
import type { SessionManagerLike } from './identity/types.js';

export default async function (pi: ExtensionAPI): Promise<void> {
  registerSessionDeckCommand(pi as unknown as PresenceCommandAPI);

  pi.on('session_start', async (_event, ctx) => {
    const presenceRuntime = await ensurePresenceRuntimeStarted();
    ctx.ui.setStatus(SESSION_DECK_COMMAND_NAME, getPresenceStartupStatus(presenceRuntime));

    // Start identity runtime with same runtimeId
    const identityRuntime = await ensureIdentityRuntimeStarted(presenceRuntime.runtime.runtimeId);

    // Build sessionManager adapter from ctx
    const sessionManager: SessionManagerLike = {
      getSessionId: () => ctx.sessionManager?.getSessionId() ?? null,
      getSessionFile: () => ctx.sessionManager?.getSessionFile() ?? null,
    };

    // Refresh identity on every session_start (covers both startup and /new)
    await identityRuntime.refreshIdentity(
      _event.reason === 'new' ? 'new' : 'startup',
      sessionManager,
    );
  });

  await ensurePresenceRuntimeStarted();
}

function getPresenceStartupStatus(runtime: PresenceRuntimeController): string | undefined {
  if (runtime.startup.state === 'healthy') {
    return undefined;
  }

  return `${SESSION_DECK_COMMAND_NAME} degraded: ${runtime.startup.diagnostic.message}`;
}
