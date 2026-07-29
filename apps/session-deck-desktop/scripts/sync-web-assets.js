#!/usr/bin/env node
/* global process */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE_WEB_ROOT = resolve(
  PACKAGE_ROOT,
  '../../packages/pi-session-deck/extensions/session-deck/iterm2/web',
);
const DESTINATION_WEB_ROOT = resolve(PACKAGE_ROOT, 'web');
const ACTION_TOKEN_META_PATTERN = /\n\s*<meta\s+id="session-deck-action-token"[\s\S]*?\/>/u;
const CANONICAL_SCRIPT_TAGS_PATTERN =
  /\n\s*<script src="\/session-deck-ui\.js"><\/script>\n\s*<script src="\/iterm2-host\.js"><\/script>\n\s*<script src="\/app\.js"><\/script>/u;
const DESKTOP_SCRIPT_TAGS = [
  '<script src="./session-deck-ui.js"></script>',
  '<script src="./app.js" type="module"></script>',
].join('\n    ');

/**
 * @param {string} sourceIndex
 * @returns {string}
 */
export function buildDesktopIndex(sourceIndex) {
  if (!CANONICAL_SCRIPT_TAGS_PATTERN.test(sourceIndex)) {
    throw new Error(
      'Canonical Session Deck index.html no longer has the expected shared-ui/iTerm2/app script tags.',
    );
  }

  return sourceIndex
    .replace(ACTION_TOKEN_META_PATTERN, '')
    .replaceAll('href="/style.css"', 'href="./style.css"')
    .replace(CANONICAL_SCRIPT_TAGS_PATTERN, `\n    ${DESKTOP_SCRIPT_TAGS}`);
}

/**
 * @param {{ sourceWebRoot?: string, destinationWebRoot?: string }} [options]
 */
export async function syncWebAssets(options = {}) {
  const sourceWebRoot = options.sourceWebRoot ?? SOURCE_WEB_ROOT;
  const destinationWebRoot = options.destinationWebRoot ?? DESTINATION_WEB_ROOT;
  const [sourceIndex, sourceStyle, sourceSharedUi] = await Promise.all([
    readFile(resolve(sourceWebRoot, 'index.html'), 'utf8'),
    readFile(resolve(sourceWebRoot, 'style.css'), 'utf8'),
    readFile(resolve(sourceWebRoot, 'session-deck-ui.js')),
  ]);

  await mkdir(destinationWebRoot, { recursive: true });
  await Promise.all([
    writeFile(resolve(destinationWebRoot, 'index.html'), buildDesktopIndex(sourceIndex), 'utf8'),
    writeFile(resolve(destinationWebRoot, 'style.css'), sourceStyle, 'utf8'),
    writeFile(resolve(destinationWebRoot, 'session-deck-ui.js'), sourceSharedUi),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncWebAssets();
}
