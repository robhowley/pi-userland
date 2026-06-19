/**
 * pi-session-deck P4 chips module index
 *
 * Footer-mirror backend code remains available for future safe integration,
 * but normal sessions do not auto-install a custom footer. These exports
 * remain available for low-level/manual chip publishing and direct store access.
 */

export { publishSessionDeckChip, clearSessionDeckChip } from './publisher.js';
export { writeChipRecord, serializeChipRecord } from './writer.js';
export { getChipsDirectory, getChipRuntimeDirectory, getChipRecordPath } from './store.js';
export * from './types.js';
export * from './constants.js';
