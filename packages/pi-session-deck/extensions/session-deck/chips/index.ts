/**
 * pi-session-deck P4 chips module index
 *
 * The primary v1 path is zero-touch footer mirroring inside the
 * session-deck extension. These exports remain available for
 * low-level/manual chip publishing and direct store access.
 */

export { publishSessionDeckChip, clearSessionDeckChip } from './publisher.js';
export { writeChipRecord, serializeChipRecord } from './writer.js';
export { getChipsDirectory, getChipRuntimeDirectory, getChipRecordPath } from './store.js';
export * from './types.js';
export * from './constants.js';
