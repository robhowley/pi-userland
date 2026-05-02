import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('Extension loaded', 'info');
  });
}
