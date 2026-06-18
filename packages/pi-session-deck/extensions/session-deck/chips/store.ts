/**
 * Chips store: runtime directory, chip record path, temp path, filename checks,
 * and shared validation/default helpers for pi-session-deck chips.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHIPS_PATH_SEGMENTS } from './constants.js';

export {
  resolveChipId,
  resolveChipLevel,
  resolveChipScope,
  validateChipIdSlug,
  validateChipScope,
  validateSourceSlug,
} from './constants.js';

export function getChipsDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ...CHIPS_PATH_SEGMENTS);
}

export function getChipRuntimeDirectory(
  runtimeId: string,
  chipsDirectory = getChipsDirectory(),
): string {
  return join(chipsDirectory, runtimeId);
}

export function getChipRecordPath(
  source: string,
  chipId: string,
  runtimeId: string,
  chipsDirectory = getChipsDirectory(),
): string {
  return join(getChipRuntimeDirectory(runtimeId, chipsDirectory), `${source}.${chipId}.json`);
}

export function createChipTempPath(
  source: string,
  chipId: string,
  runtimeId: string,
  chipsDirectory = getChipsDirectory(),
  tempId = randomUUID(),
): string {
  return join(
    getChipRuntimeDirectory(runtimeId, chipsDirectory),
    `.${source}.${chipId}.${tempId}.tmp`,
  );
}

export function isChipRecordFile(fileName: string): boolean {
  return fileName.endsWith('.json') && !fileName.startsWith('.');
}
