import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    ctx.ui.notify('Session Deck loaded', 'info');
  });
}
