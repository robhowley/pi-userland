import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.notify('Cmux Junction loaded', 'info');
  });
}
