/**
 * pi-session-deck P4 chips module index
 *
 * Public exports stay focused on manual chip publishing and direct store access.
 * No footer mirroring helper is exported or auto-installed.
 */

export { publishSessionDeckChip, clearSessionDeckChip } from './publisher.js';
export { writeChipRecord, serializeChipRecord } from './writer.js';
export { getChipsDirectory, getChipRuntimeDirectory, getChipRecordPath } from './store.js';
export * from './types.js';
export * from './constants.js';
