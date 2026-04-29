/**
 * Session Hygiene Extension
 *
 * Tracks session cost and context usage in the status bar.
 */

import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SessionState, Thresholds } from './types.js';
import {
  PRESETS,
  computeHealth,
  loadConfig,
  reconstructCost,
  saveConfig,
  updateStatusIndicator,
} from './helpers.js';

// Re-export for backward compatibility
export * from './types.js';
export * from './helpers.js';

type StatusContext = Pick<ExtensionContext, 'getContextUsage' | 'ui'>;

function parsePositiveNumber(value: string, parser: (input: string) => number): number | null {
  const parsed = parser(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function buildCustomThresholds(values: {
  yellowCost: string;
  yellowContext: string;
  redCost: string;
  redContext: string;
}): Thresholds | null {
  const yellowCost = parsePositiveNumber(values.yellowCost, Number.parseFloat);
  const yellowContext = parsePositiveNumber(values.yellowContext, (input) =>
    Number.parseInt(input, 10),
  );
  const redCost = parsePositiveNumber(values.redCost, Number.parseFloat);
  const redContext = parsePositiveNumber(values.redContext, (input) => Number.parseInt(input, 10));

  if (yellowCost === null || yellowContext === null || redCost === null || redContext === null) {
    return null;
  }

  if (yellowCost >= redCost) {
    return null;
  }

  if (yellowContext >= redContext) {
    return null;
  }

  return {
    yellow: { cost: yellowCost, context: yellowContext },
    red: { cost: redCost, context: redContext },
  };
}

export default function (pi: ExtensionAPI) {
  let thresholds = loadConfig();

  const freshState = (cost = 0): SessionState => ({
    totalCost: cost,
    inputTokens: 0,
    cacheReadTokens: 0,
  });

  let state: SessionState = freshState();

  const getContextTokens = (ctx: StatusContext) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return null;
    return usage.tokens;
  };

  const refreshStatus = (ctx: StatusContext) => {
    const contextTokens = getContextTokens(ctx);
    const health = computeHealth(state.totalCost, contextTokens, thresholds);
    updateStatusIndicator(health, ctx, state);
  };

  // ─── session_start: Initialize tracking ───
  pi.on('session_start', async (_event, ctx) => {
    thresholds = loadConfig();
    state = freshState(reconstructCost(ctx));
    refreshStatus(ctx);
  });

  // ─── turn_end: Update running totals and status bar ───
  pi.on('turn_end', async (event, ctx) => {
    const msg = event.message as AssistantMessage | null | undefined;
    const turnCost = msg?.usage?.cost?.total;
    if (typeof turnCost === 'number') state.totalCost += turnCost;

    const input = msg?.usage?.input;
    const cacheRead = msg?.usage?.cacheRead;
    if (typeof input === 'number') state.inputTokens += input;
    if (typeof cacheRead === 'number') state.cacheReadTokens += cacheRead;

    refreshStatus(ctx);
  });

  // ─── /session-hygiene: Interactive configuration ───
  pi.registerCommand('session-hygiene', {
    description: 'Configure session hygiene thresholds',
    handler: async (_args, ctx) => {
      const theme = ctx.ui.theme;
      const current = [
        theme.bold('Current Thresholds:'),
        `  Yellow: $${thresholds.yellow.cost} / ${thresholds.yellow.context.toLocaleString()} tokens`,
        `  Red:    $${thresholds.red.cost} / ${thresholds.red.context.toLocaleString()} tokens`,
        '',
        'Select a preset or customize:',
      ].join('\n');

      ctx.ui.notify(current, 'info');

      const presetOptions = [
        'Conservative ($2/60K, $8/120K)',
        'Default ($5/100K, $15/200K)',
        'Relaxed ($10/150K, $25/250K)',
        'Custom (enter values manually)',
      ];

      const selected = await ctx.ui.select('Choose preset:', presetOptions);
      if (!selected) {
        ctx.ui.notify('Configuration cancelled', 'info');
        return;
      }

      const presetName = selected.split(' ')[0] as
        | 'Conservative'
        | 'Default'
        | 'Relaxed'
        | 'Custom';
      let newThresholds: Thresholds | null = null;

      if (presetName === 'Custom') {
        const yellowCost = await ctx.ui.input(
          'Yellow cost threshold ($):',
          String(thresholds.yellow.cost),
        );
        const yellowContext = await ctx.ui.input(
          'Yellow context threshold (tokens):',
          String(thresholds.yellow.context),
        );
        const redCost = await ctx.ui.input('Red cost threshold ($):', String(thresholds.red.cost));
        const redContext = await ctx.ui.input(
          'Red context threshold (tokens):',
          String(thresholds.red.context),
        );

        if (!yellowCost || !yellowContext || !redCost || !redContext) {
          ctx.ui.notify('Configuration cancelled', 'info');
          return;
        }

        newThresholds = buildCustomThresholds({ yellowCost, yellowContext, redCost, redContext });
        if (!newThresholds) {
          ctx.ui.notify(
            'Invalid thresholds. Yellow must be less than red, and all values must be positive numbers.',
            'error',
          );
          return;
        }
      } else {
        newThresholds = PRESETS[presetName] as Thresholds | null;
      }

      const saved = saveConfig(newThresholds!);
      thresholds = newThresholds!;

      if (saved) {
        ctx.ui.notify(
          [
            theme.fg('success', '✓ Configuration saved'),
            `  Yellow: $${thresholds.yellow.cost} / ${thresholds.yellow.context.toLocaleString()} tokens`,
            `  Red:    $${thresholds.red.cost} / ${thresholds.red.context.toLocaleString()} tokens`,
          ].join('\n'),
          'info',
        );
      } else {
        ctx.ui.notify(
          [
            theme.fg('warning', '⚠ Applied in this session but could not save to disk'),
            `  Yellow: $${thresholds.yellow.cost} / ${thresholds.yellow.context.toLocaleString()} tokens`,
            `  Red:    $${thresholds.red.cost} / ${thresholds.red.context.toLocaleString()} tokens`,
          ].join('\n'),
          'warning',
        );
      }

      refreshStatus(ctx);
    },
  });

  // ─── session_compact: Reset running totals after any compaction ───
  pi.on('session_compact', async (_event, ctx) => {
    state = freshState();
    refreshStatus(ctx);
  });
}
