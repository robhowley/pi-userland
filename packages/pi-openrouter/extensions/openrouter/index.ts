import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AnalyticsResponse, UsageSummary } from './types.js';
import { usageCache, lastFetchTime } from './cache.js';
import { fetchCredits, fetchActivity } from './openrouter.js';
import { aggregateUsage } from './format.js';
import { UsageOverlayComponent } from './overlay.js';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('OpenRouter extension loaded', 'info');
  });

  pi.registerCommand('usage', {
    description: 'Show OpenRouter usage (try: /usage, /usage models, /usage providers, /usage 7d)',
    getArgumentCompletions: (prefix) => {
      const subcommands = ['models', 'providers', '7d'];
      const filtered = subcommands.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim(); // 'models', 'keys', '7d', or ''
      await showUsageOverlay(ctx, subcommand || undefined);
    },
  });
}

async function showUsageOverlay(ctx: ExtensionContext, subcommand?: string) {
  // Check cache first
  const cachedSummary = usageCache.get('usage');
  const cachedMinutesAgo = cachedSummary
    ? Math.round((Date.now() - lastFetchTime.value) / 60000)
    : null;

  if (cachedSummary) {
    await showOverlay(ctx, cachedSummary, subcommand, null, cachedMinutesAgo);
    return;
  }

  // Fetch data
  let error: string | null = null;
  let summary: UsageSummary | null = null;

  try {
    lastFetchTime.value = Date.now();
    const credits = await fetchCredits();

    let analytics: AnalyticsResponse | null = null;
    try {
      analytics = await fetchActivity();
    } catch (actErr) {
      // Activity fetch failed (likely needs management key), continue with credits only
      // This allows regular API key users to see usage data
      console.log('Activity fetch failed (management key required):', actErr);
    }

    summary = aggregateUsage(credits.data, analytics);
    usageCache.set('usage', summary);

    await showOverlay(ctx, summary, subcommand, null, 0);
  } catch (error_) {
    const err = error_ as Error;
    error = `API Error: ${err.message}`;
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
      );

      return {
        handleInput: (data: string) => {
          overlayComponent.handleInput(data);
          _tui.requestRender();
        },
        render: (width: number) => overlayComponent.render(width),
        invalidate: () => overlayComponent.invalidate(),
        dispose: () => {},
      };
    },
    { overlay: true },
  );
}
