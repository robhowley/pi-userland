import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';
import {
  usageCache,
  lastFetchTime,
  startBackgroundRefresh,
  stopBackgroundRefresh,
} from './cache.js';
import { getCredits, getActivity, AuthError } from './client.js';
import { aggregateUsage } from './format.js';
import type { ActivityItem } from './types.js';
import { UsageOverlayComponent } from './overlay.js';

export default function (pi: ExtensionAPI) {
  startBackgroundRefresh();

  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('OpenRouter extension loaded', 'info');
  });

  pi.on('session_shutdown', () => {
    stopBackgroundRefresh();
  });

  pi.registerCommand('usage', {
    description: 'Show OpenRouter usage',
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const subcommand = args.trim() || undefined;
      await showUsageOverlay(ctx, subcommand);
    },
  });
}

async function showUsageOverlay(ctx: ExtensionContext, subcommand?: string) {
  const cachedSummary = usageCache.get('usage');
  const cachedMinutesAgo = cachedSummary
    ? Math.round((Date.now() - lastFetchTime.value) / 60000)
    : null;

  if (cachedSummary) {
    await showOverlay(ctx, cachedSummary, subcommand, null, cachedMinutesAgo);
    return;
  }

  let error: string | null = null;
  let summary: UsageSummary | null = null;

  try {
    const credits = await getCredits();

    let analytics: ActivityItem[] | null = null;
    try {
      analytics = await getActivity();
    } catch (actErr) {
      console.log('Activity fetch failed (management key required):', actErr);
    }

    const timestamp = Date.now();
    summary = aggregateUsage(credits, analytics ?? [], timestamp);
    usageCache.set('usage', summary);

    await showOverlay(ctx, summary, subcommand, null, 0);
  } catch (error_) {
    const err = error_ as Error;
    error =
      err instanceof AuthError
        ? 'OpenRouter API key not found. Set OPENROUTER_API_KEY to use /usage.'
        : `API Error: ${err.message}`;
    await showOverlay(ctx, null, subcommand, error, cachedMinutesAgo || 0);
  }
}

async function showOverlay(
  ctx: ExtensionContext,
  summary: UsageSummary | null,
  subcommand: string | undefined,
  error: string | null,
  cachedMinutesAgo: number | null,
) {
  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const overlayComponent = new UsageOverlayComponent(
        summary,
        subcommand,
        error,
        cachedMinutesAgo,
        theme,
        done,
        () => _tui.requestRender(),
      );

      return {
        handleInput: (data: string) => {
          overlayComponent.handleInput(data);
          _tui.requestRender();
        },
        render: (width: number) => overlayComponent.render(width),
        invalidate: () => overlayComponent.invalidate(),
        dispose: () => {
          overlayComponent.dispose();
        },
      };
    },
    { overlay: true },
  );
}
