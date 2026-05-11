/**
 * TUI overlay rendering for OpenRouter models sync and status commands.
 */

import { Text } from '@mariozechner/pi-tui';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SyncResult } from './types.js';

/**
 * Show sync result in ephemeral overlay.
 * Displays different output formats based on success/failure state.
 */
export async function showSyncResultOverlay(
  ctx: ExtensionContext,
  result: SyncResult | null
): Promise<void> {
  const { custom } = ctx.ui;

  await custom<void>((_tui, theme, _kb, done) => {
    const overlay = createOverlay(theme, result, done);
    return overlay.component;
  }, { overlay: true });
}

/**
 * Show status in ephemeral overlay.
 * Displays current sync state with appropriate formatting.
 */
export async function showStatusOverlay(
  ctx: ExtensionContext,
  state: SyncResult | null
): Promise<void> {
  const { custom } = ctx.ui;

  await custom<void>((_tui, theme, _kb, done) => {
    const overlay = createOverlay(theme, state, done);
    return overlay.component;
  }, { overlay: true });
}

// ============== RENDERING FUNCTIONS ==============

function renderEmptyState(theme: any, _result: SyncResult | null): Text {
  const lines = [
    '',
    'OpenRouter Models',
    '',
    theme.fg('dim', '  No sync data available'),
    theme.fg('dim', '  Run /openrouter models sync to fetch models'),
    '',
    theme.fg('dim', 'Press any key to close'),
  ];

  const text = new Text(lines.join('\n'), 0, 0);
  text.setText(lines.join('\n'));
  return text;
}

function renderSuccessState(theme: any, result: SyncResult): Text {
  const lines = [
    '',
    theme.fg('success', 'OpenRouter models synced'),
    '',
    `  models     ${result.registeredCount} registered`,
    `  skipped    ${result.skippedCount}`,
    `  source     /api/v1/models/user`,
    `  cache      updated`,
    '',
    theme.fg('dim', 'Press any key to close'),
  ];

  const text = new Text(lines.join('\n'), 0, 0);
  text.setText(lines.join('\n'));
  return text;
}

function renderCacheFallbackState(theme: any, result: SyncResult): Text {
  const lines = [
    '',
    theme.fg('warning', 'OpenRouter models sync failed'),
    '',
    `  models     ${result.registeredCount} registered from cache`,
    `  skipped    ${result.skippedCount}`,
    `  cache age  ${formatAge(result.cacheAgeMs)}`,
    `  error      ${result.error}`,
    '',
    theme.fg('dim', 'Press any key to close'),
  ];

  const text = new Text(lines.join('\n'), 0, 0);
  text.setText(lines.join('\n'));
  return text;
}

function renderBrokenState(theme: any, result: SyncResult): Text {
  const lines = [
    '',
    theme.fg('error', 'OpenRouter models unavailable'),
    '',
    `  models     0 registered`,
    `  error      ${result.error}`,
    '',
    theme.fg('dim', 'Press any key to close'),
  ];

  const text = new Text(lines.join('\n'), 0, 0);
  text.setText(lines.join('\n'));
  return text;
}

// ============== HELPERS ==============

interface OverlayComponent {
  component: {
    render: (width: number) => string[];
    handleInput: (data: string) => boolean;
    invalidate: () => void;
    dispose: () => void;
  };
}

function createOverlay(theme: any, state: SyncResult | null, done: () => void): OverlayComponent {
  let lastRenderedText: Text;

  function renderComponent(): Text {
    if (!state) {
      lastRenderedText = renderEmptyState(theme, state);
    } else if (state.success) {
      lastRenderedText = renderSuccessState(theme, state);
    } else if (state.source === 'cache') {
      lastRenderedText = renderCacheFallbackState(theme, state);
    } else {
      lastRenderedText = renderBrokenState(theme, state);
    }
    return lastRenderedText;
  }

  return {
    component: {
      render: (width: number) => {
        const text = renderComponent();
        return text.render(width);
      },
      handleInput: (_data: string) => {
        // Any key closes
        done();
        return true;
      },
      invalidate: () => {
        // Invalidation handled by re-rendering
      },
      dispose: () => {
        // Cleanup if needed
      },
    },
  };
}

/**
 * Format milliseconds to human-readable age.
 * Examples: "<1m", "4m", "2h", "1d"
 */
function formatAge(ms: number | null): string {
  if (ms === null) return 'unknown';

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}
