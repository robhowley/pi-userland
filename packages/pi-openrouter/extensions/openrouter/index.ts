import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';
import { usageCache, lastFetchTime } from './cache.js';
import { fetchCredits, fetchAnalytics, AuthError, ApiError } from './openrouter.js';
import { aggregateUsage } from './format.js';
import { UsageOverlayComponent } from './overlay.js';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('OpenRouter extension loaded', 'info');
  });

  pi.registerCommand('usage', {
    description: 'Show OpenRouter usage (try: /usage, /usage models, /usage keys, /usage 7d)',
    getArgumentCompletions: (prefix) => {
      const subcommands = ['models', 'keys', '7d'];
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

  // Show loading state
  await showOverlay(ctx, null, subcommand, null, null);

  // Fetch data in background and re-render
  try {
    lastFetchTime.value = Date.now();
    const [credits, analytics] = await Promise.all([
      fetchCredits(),
      fetchAnalytics(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), new Date()),
    ]);

    const summary = aggregateUsage(credits.data, analytics);
    usageCache.set('usage', summary);

    await showOverlay(ctx, summary, subcommand, null, 0);
  } catch (error) {
    const message =
      error instanceof AuthError
        ? error.message
        : error instanceof ApiError
          ? error.message
          : 'Unknown error fetching usage data';

    await showOverlay(ctx, null, subcommand, message, cachedMinutesAgo || 0);
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
        () => done(),
      );

      return {
        handleInput: (data: string) => {
          overlayComponent.handleInput(data);
        },
        render: (width: number) => overlayComponent.render(width),
        invalidate: () => overlayComponent.invalidate(),
        dispose: () => {},
      };
    },
    { overlay: true },
  );
}
