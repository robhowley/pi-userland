import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerPresenceCommand, type PresenceCommandAPI } from './presence/command.js';
import { ensurePresenceRuntimeStarted } from './presence/runtime.js';

export default function (pi: ExtensionAPI): void {
  registerPresenceCommand(pi as unknown as PresenceCommandAPI);

  pi.on('session_start', async () => {
    await ensurePresenceRuntimeStarted();
  });
}
