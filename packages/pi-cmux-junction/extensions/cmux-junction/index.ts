import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerJunctionCommand } from './command.js';

export default function (pi: ExtensionAPI): void {
  registerJunctionCommand(pi);

  pi.on('session_start', (_event, ctx) => {
    ctx.ui.notify('Cmux Junction loaded', 'info');
  });
}
