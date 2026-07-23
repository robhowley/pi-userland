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
const CANONICAL_INDEX_PATH = resolve(SOURCE_WEB_ROOT, 'index.html');
const CANONICAL_STYLE_PATH = resolve(SOURCE_WEB_ROOT, 'style.css');
const CANONICAL_SHARED_UI_PATH = resolve(SOURCE_WEB_ROOT, 'session-deck-ui.js');
const PLACEHOLDER_SHARED_UI = `/* Shared Session Deck UI has not been copied into this worktree yet.\n   Replace this file by syncing the canonical session-deck-ui.js asset. */\n`;
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
 * @param {string | null} sourceSharedUi
 * @returns {string}
 */
export function buildSharedUiAsset(sourceSharedUi) {
  return sourceSharedUi ?? PLACEHOLDER_SHARED_UI;
}

export async function syncWebAssets() {
  await mkdir(DESTINATION_WEB_ROOT, { recursive: true });

  const [sourceIndex, sourceStyle, sourceSharedUi] = await Promise.all([
    readFile(CANONICAL_INDEX_PATH, 'utf8'),
    readFile(CANONICAL_STYLE_PATH, 'utf8'),
    readOptionalFile(CANONICAL_SHARED_UI_PATH),
  ]);

  await Promise.all([
    writeFile(resolve(DESTINATION_WEB_ROOT, 'index.html'), buildDesktopIndex(sourceIndex), 'utf8'),
    writeFile(resolve(DESTINATION_WEB_ROOT, 'style.css'), sourceStyle, 'utf8'),
    writeFile(
      resolve(DESTINATION_WEB_ROOT, 'session-deck-ui.js'),
      buildSharedUiAsset(sourceSharedUi),
      'utf8',
    ),
  ]);
}

/**
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function readOptionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException}
 */
function isMissingFileError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncWebAssets();
}
