import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { registerOpenRouterCommands } from './commands.js';
import {
  addSessionIdToOpenRouterRequest,
  getCurrentSessionId,
  initializeSessionState,
  installOpenRouterHooks,
  loadStartupCacheState,
} from './hooks.js';

export { addSessionIdToOpenRouterRequest, getCurrentSessionId };

export default async function (pi: ExtensionAPI) {
  initializeSessionState();

  const startupState = await loadStartupCacheState(pi);

  installOpenRouterHooks(pi, startupState);
  registerOpenRouterCommands(pi);
}
