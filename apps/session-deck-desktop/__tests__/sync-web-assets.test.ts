import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDesktopIndex, syncWebAssets } from '../scripts/sync-web-assets.js';

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

  it('copies the required canonical shared UI byte-for-byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-deck-sync-web-'));
    const sourceWebRoot = join(root, 'source');
    const destinationWebRoot = join(root, 'destination');
    const sharedUi = Buffer.from([0, 1, 2, 10, 13, 255]);
    await mkdir(sourceWebRoot);
    await Promise.all([
      writeFile(join(sourceWebRoot, 'index.html'), CANONICAL_INDEX),
      writeFile(join(sourceWebRoot, 'style.css'), 'body { color: red; }\n'),
      writeFile(join(sourceWebRoot, 'session-deck-ui.js'), sharedUi),
    ]);

    await syncWebAssets({ sourceWebRoot, destinationWebRoot });

    await expect(readFile(join(destinationWebRoot, 'session-deck-ui.js'))).resolves.toEqual(
      sharedUi,
    );
  });

  it('rejects sync when the canonical shared UI is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-deck-sync-web-'));
    const sourceWebRoot = join(root, 'source');
    const destinationWebRoot = join(root, 'destination');
    await mkdir(sourceWebRoot);
    await Promise.all([
      writeFile(join(sourceWebRoot, 'index.html'), CANONICAL_INDEX),
      writeFile(join(sourceWebRoot, 'style.css'), 'body {}\n'),
    ]);

    await expect(syncWebAssets({ sourceWebRoot, destinationWebRoot })).rejects.toThrow(
      'session-deck-ui.js',
    );
    await expect(readFile(join(destinationWebRoot, 'session-deck-ui.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
