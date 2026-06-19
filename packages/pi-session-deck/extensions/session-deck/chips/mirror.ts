import { stripVTControlCharacters } from 'node:util';
import {
  CHIP_DIAGNOSTIC_CODES,
  CHIPS_SCHEMA_VERSION,
  DEFAULT_CHIP_ID,
  DEFAULT_CHIP_LEVEL,
  DEFAULT_CHIP_SCOPE,
  validateSourceSlug,
} from './constants.js';
import type {
  ChipDiagnosticSink,
  ClearSessionDeckChipKey,
  MirroredStatusContext,
  MirroredStatusDiff,
  MirroredStatusSnapshot,
  MirroredStatusTrackingEntry,
  SessionDeckChipRecord,
} from './types.js';
import {
  clearChipRecord,
  type ClearChipRecordOptions,
  writeChipRecord,
  type WriteChipRecordOptions,
} from './writer.js';

const WHITESPACE_PATTERN = /\s+/g;

export interface StatusMirrorOptions {
  now?: () => Date;
  writeRecord?: (
    record: SessionDeckChipRecord,
    options?: WriteChipRecordOptions,
  ) => Promise<string | null>;
  clearRecord?: (
    key: ClearSessionDeckChipKey,
    options?: ClearChipRecordOptions,
  ) => Promise<boolean>;
  onDiagnostic?: ChipDiagnosticSink;
}

export interface SessionDeckStatusMirror {
  reconfigure(
    context: MirroredStatusContext,
    options?: { clearTracked?: boolean; resetSnapshot?: boolean },
  ): Promise<void>;
  resetSnapshot(): Promise<void>;
  observeStatuses(statuses: ReadonlyMap<string, string>): Promise<void>;
  clearTracked(): Promise<void>;
  getSnapshot(): MirroredStatusSnapshot;
}

export function sanitizeMirroredStatusText(text: string): string {
  return replaceControlCharacters(stripVTControlCharacters(text))
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

export function diffMirroredStatusSnapshots(
  previous: MirroredStatusSnapshot,
  current: MirroredStatusSnapshot,
): MirroredStatusDiff {
  const upserts: MirroredStatusDiff['upserts'] = [];
  const removals: string[] = [];

  for (const [source, text] of current.entries()) {
    if (previous.get(source) !== text) {
      upserts.push({ source, text });
    }
  }

  for (const source of previous.keys()) {
    if (!current.has(source)) {
      removals.push(source);
    }
  }

  return { upserts, removals };
}

export function createStatusMirror(options: StatusMirrorOptions = {}): SessionDeckStatusMirror {
  const emit = options.onDiagnostic ?? noopDiagnostic;
  const now = options.now ?? (() => new Date());
  const writeRecord = options.writeRecord ?? writeChipRecord;
  const clearRecord = options.clearRecord ?? clearChipRecord;

  let context: MirroredStatusContext | null = null;
  let snapshot = new Map<string, string>();
  const tracked = new Map<string, MirroredStatusTrackingEntry>();
  let pending = Promise.resolve();

  return {
    reconfigure(nextContext, reconfigureOptions = {}) {
      return runSerialized(async () => {
        if (reconfigureOptions.clearTracked === true) {
          await clearTrackedEntries();
        }

        context = nextContext;

        if (reconfigureOptions.resetSnapshot === true) {
          snapshot = new Map();
        }
      });
    },
    resetSnapshot() {
      return runSerialized(async () => {
        snapshot = new Map();
      });
    },
    observeStatuses(statuses) {
      return runSerialized(async () => {
        const current = buildMirroredStatusSnapshot(statuses, emit);
        const diff = diffMirroredStatusSnapshots(snapshot, current);

        for (const source of diff.removals) {
          await clearTrackedSource(source, context);
        }

        if (diff.upserts.length === 0) {
          snapshot = current;
          return;
        }

        if (context === null || context.runtimeId.trim().length === 0) {
          emit(
            CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING,
            'status mirror requires a resolved runtimeId',
          );
          snapshot = removeSourcesFromSnapshot(snapshot, diff.removals);
          return;
        }

        const sessionId = resolveSessionId(context.getSessionId, emit);
        if (sessionId === null) {
          emit(
            CHIP_DIAGNOSTIC_CODES.CHIP_SESSION_ID_MISSING,
            'status mirror requires a resolved sessionId',
          );
          snapshot = removeSourcesFromSnapshot(snapshot, diff.removals);
          return;
        }

        const observedAt = now().toISOString();
        for (const upsert of diff.upserts) {
          await writeMirroredChip({
            runtimeId: context.runtimeId,
            sessionId,
            source: upsert.source,
            text: upsert.text,
            updatedAt: observedAt,
            directory: context.directory,
          });
        }

        snapshot = current;
      });
    },
    clearTracked() {
      return runSerialized(clearTrackedEntries);
    },
    getSnapshot() {
      return new Map(snapshot);
    },
  };

  function runSerialized(operation: () => Promise<void>): Promise<void> {
    const run = pending.then(operation, operation);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function clearTrackedEntries(): Promise<void> {
    const entries = Array.from(tracked.values());
    for (const entry of entries) {
      await clearTrackedEntry(entry);
    }
    tracked.clear();
    snapshot = new Map();
  }

  async function clearTrackedSource(
    source: string,
    activeContext: MirroredStatusContext | null,
  ): Promise<void> {
    const entry =
      findTrackedEntry(tracked, source, activeContext?.runtimeId) ??
      buildFallbackTrackedEntry(source, activeContext);
    if (entry === null) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING,
        `status mirror cannot clear "${source}" without a runtimeId`,
      );
      return;
    }

    await clearTrackedEntry(entry);
  }

  async function clearTrackedEntry(entry: MirroredStatusTrackingEntry): Promise<void> {
    try {
      await clearRecord(
        {
          source: entry.source,
          chipId: DEFAULT_CHIP_ID,
          scope: DEFAULT_CHIP_SCOPE,
          runtimeId: entry.runtimeId,
        },
        {
          ...(entry.directory === undefined ? {} : { directory: entry.directory }),
          onDiagnostic: emit,
        },
      );
    } catch (error) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
        `Failed to clear mirrored chip "${entry.source}": ${getErrorMessage(error)}`,
      );
    }

    tracked.delete(getTrackedEntryKey(entry.runtimeId, entry.source));
  }

  async function writeMirroredChip(input: {
    runtimeId: string;
    sessionId: string;
    source: string;
    text: string;
    updatedAt: string;
    directory: string | undefined;
  }): Promise<void> {
    const record: SessionDeckChipRecord = {
      schemaVersion: CHIPS_SCHEMA_VERSION,
      runtimeId: input.runtimeId,
      sessionId: input.sessionId,
      source: input.source,
      chipId: DEFAULT_CHIP_ID,
      scope: DEFAULT_CHIP_SCOPE,
      text: input.text,
      level: DEFAULT_CHIP_LEVEL,
      updatedAt: input.updatedAt,
    };

    try {
      await writeRecord(record, {
        ...(input.directory === undefined ? {} : { directory: input.directory }),
        onDiagnostic: emit,
      });
    } catch (error) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
        `Failed to write mirrored chip "${input.source}": ${getErrorMessage(error)}`,
      );
    }

    tracked.set(getTrackedEntryKey(input.runtimeId, input.source), {
      runtimeId: input.runtimeId,
      source: input.source,
      chipId: DEFAULT_CHIP_ID,
      scope: DEFAULT_CHIP_SCOPE,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
    });
  }
}

function buildMirroredStatusSnapshot(
  statuses: ReadonlyMap<string, string>,
  emit: ChipDiagnosticSink,
): Map<string, string> {
  const snapshot = new Map<string, string>();

  for (const [source, text] of statuses.entries()) {
    const sourceValidation = validateSourceSlug(source);
    if (!sourceValidation.valid) {
      emit(CHIP_DIAGNOSTIC_CODES.CHIP_SOURCE_INVALID, sourceValidation.reason);
      continue;
    }

    const sanitized = sanitizeMirroredStatusText(text);
    if (sanitized.length === 0) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_TEXT_EMPTY,
        `status mirror text for "${source}" is empty after sanitize`,
      );
      continue;
    }

    snapshot.set(sourceValidation.value, sanitized);
  }

  return snapshot;
}

function resolveSessionId(
  getSessionId: () => string | null,
  emit: ChipDiagnosticSink,
): string | null {
  try {
    const sessionId = getSessionId();
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : null;
  } catch (error) {
    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
      `Failed to resolve mirror sessionId: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

function buildFallbackTrackedEntry(
  source: string,
  context: MirroredStatusContext | null,
): MirroredStatusTrackingEntry | null {
  if (context === null || context.runtimeId.trim().length === 0) {
    return null;
  }

  return {
    runtimeId: context.runtimeId,
    source,
    chipId: DEFAULT_CHIP_ID,
    scope: DEFAULT_CHIP_SCOPE,
    ...(context.directory === undefined ? {} : { directory: context.directory }),
  };
}

function findTrackedEntry(
  tracked: ReadonlyMap<string, MirroredStatusTrackingEntry>,
  source: string,
  runtimeId: string | undefined,
): MirroredStatusTrackingEntry | undefined {
  if (runtimeId !== undefined) {
    const direct = trackedLookup(tracked, source, runtimeId);
    if (direct !== undefined) {
      return direct;
    }
  }

  return Array.from(tracked.values()).find((entry) => entry.source === source);
}

function trackedLookup(
  tracked: ReadonlyMap<string, MirroredStatusTrackingEntry>,
  source: string,
  runtimeId: string,
): MirroredStatusTrackingEntry | undefined {
  return tracked.get(getTrackedEntryKey(runtimeId, source));
}

function getTrackedEntryKey(runtimeId: string, source: string): string {
  return `${runtimeId}:${source}`;
}

function removeSourcesFromSnapshot(
  previous: MirroredStatusSnapshot,
  removals: readonly string[],
): Map<string, string> {
  const next = new Map(previous);
  for (const source of removals) {
    next.delete(source);
  }
  return next;
}

function replaceControlCharacters(text: string): string {
  let sanitized = '';

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += isControlCodePoint(codePoint) ? ' ' : character;
  }

  return sanitized;
}

function isControlCodePoint(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 31) || (codePoint >= 127 && codePoint <= 159);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function noopDiagnostic(_code: string, _message: string): void {
  // intentionally empty
}
