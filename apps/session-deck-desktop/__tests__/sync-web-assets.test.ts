import { describe, expect, it } from 'vitest';
import { buildDesktopIndex, buildSharedUiAsset } from '../scripts/sync-web-assets.js';

const CANONICAL_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      id="session-deck-action-token"
      name="session-deck-action-token"
      content="__SESSION_DECK_ACTION_TOKEN__"
    />
    <title>Session Deck</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main class="app"></main>
    <script src="/session-deck-ui.js"></script>
    <script src="/iterm2-host.js"></script>
    <script src="/app.js"></script>
  </body>
</html>
`;

describe('sync-web-assets', () => {
  it('rewrites the canonical index for the desktop host', () => {
    const rewritten = buildDesktopIndex(CANONICAL_INDEX);

    expect(rewritten).not.toContain('session-deck-action-token');
    expect(rewritten).toContain('href="./style.css"');
    expect(rewritten).toContain('<script src="./session-deck-ui.js"></script>');
    expect(rewritten).toContain('<script src="./app.js" type="module"></script>');
    expect(rewritten).not.toContain('iterm2-host.js');
  });

  it('writes a deterministic shared-ui placeholder when the canonical asset is missing', () => {
    expect(buildSharedUiAsset(null)).toContain('Shared Session Deck UI');
    expect(buildSharedUiAsset('window.SessionDeckUI = {};')).toBe('window.SessionDeckUI = {};');
  });
});
