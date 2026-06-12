import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  registerPresenceCommand,
  SESSION_DECK_COMMAND_NAME,
  type PresenceCommandAPI,
} from './presence/command.js';
import {
  ensurePresenceRuntimeStarted,
  type PresenceRuntimeController,
} from './presence/runtime.js';

export default async function (pi: ExtensionAPI): Promise<void> {
  registerPresenceCommand(pi as unknown as PresenceCommandAPI);

  pi.on('session_start', async (_event, ctx) => {
    const runtime = await ensurePresenceRuntimeStarted();
    ctx.ui.setStatus(SESSION_DECK_COMMAND_NAME, getPresenceStartupStatus(runtime));
  });

  await ensurePresenceRuntimeStarted();
}

function getPresenceStartupStatus(runtime: PresenceRuntimeController): string | undefined {
  if (runtime.startup.state === 'healthy') {
    return undefined;
  }

  return `${SESSION_DECK_COMMAND_NAME} degraded: ${runtime.startup.diagnostic.message}`;
}
