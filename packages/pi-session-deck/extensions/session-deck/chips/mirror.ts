/**
 * SetStatus mirror: wraps ctx.ui.setStatus to capture footer-status text
 * into chip files without owning the footer.
 */

import { stripVTControlCharacters } from 'node:util';
import {
  CHIP_DIAGNOSTIC_CODES,
  CHIPS_SCHEMA_VERSION,
  DEFAULT_CHIP_ID,
  DEFAULT_CHIP_LEVEL,
  DEFAULT_CHIP_SCOPE,
  validateSourceSlug,
} from './constants.js';
import type { ChipDiagnosticSink } from './types.js';
import { clearChipRecord, writeChipRecord } from './writer.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface StatusMirrorOptions {
  /** Override the base chips directory */
  directory?: string;
  /** Diagnostic callback for fail-open messages */
  onDiagnostic?: ChipDiagnosticSink;
}

export interface MirroredStatusContext {
  runtimeId: string;
  getSessionId: () => string | null;
}

export interface SetStatusMirror {
  /** Reconfigure with a new runtime identity (called on session_start) */
  reconfigure(context: MirroredStatusContext): void;
  /** Install wrapper on ui.setStatus — noop if already patched */
  install(ui: { setStatus: (key: string, text: string | undefined) => void }): void;
  /** Clear tracked entries for session shutdown */
  clearTracked(): Promise<void>;
}

interface ResolvedStatusContext {
  runtimeId: string;
  sessionId: string | null;
}

interface MirroredStatusEntry {
  runtimeId: string;
  sessionId: string;
  text: string;
}

interface StatusMirrorPatch {
  originalSetStatus: (key: string, text: string | undefined) => void;
  wrappedSetStatus: (key: string, text: string | undefined) => void;
  mirrorSetStatus: (key: string, text: string | undefined) => Promise<void>;
}

type SetStatusUi = {
  setStatus: (key: string, text: string | undefined) => void;
} & Record<string, unknown>;

// ─── Helpers ──────────────────────────────────────────────────────────

function sanitizeVisibleText(raw: string): string {
  return stripVTControlCharacters(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNonEmptyString(candidate: string | null | undefined): candidate is string {
  return typeof candidate === 'string' && candidate.trim().length > 0;
}

function noopDiagnostic(_code: string, _message: string): void {
  // intentionally empty
}

// ─── Mirror factory ───────────────────────────────────────────────────

const PATCH_KEY = '__piSessionDeckStatusMirrorPatched__' as const;

export function createSetStatusMirror(options: StatusMirrorOptions = {}): SetStatusMirror {
  const emit = options.onDiagnostic ?? noopDiagnostic;
  const directory = options.directory;

  let context: MirroredStatusContext | null = null;
  let configuredContext: ResolvedStatusContext | null = null;
  let lifecycleVersion = 0;
  let operationQueue = Promise.resolve();

  // Track the last committed record per source so dedupe does not cross lifecycle boundaries.
  const lastMirrored = new Map<string, MirroredStatusEntry>();

  return {
    reconfigure(nextContext) {
      const previousContext = configuredContext;
      const nextResolvedContext: ResolvedStatusContext = {
        runtimeId: nextContext.runtimeId,
        sessionId: safeCall(() => nextContext.getSessionId(), null) ?? null,
      };

      context = {
        runtimeId: nextContext.runtimeId,
        getSessionId: nextContext.getSessionId,
      };
      configuredContext = nextResolvedContext;
      lifecycleVersion += 1;

      if (!shouldClearTracked(previousContext, nextResolvedContext)) {
        return;
      }

      const clearContext: ResolvedStatusContext = previousContext;
      const trackedSources = Array.from(lastMirrored.keys());
      lastMirrored.clear();

      void enqueue(async () => {
        await clearSources(clearContext, trackedSources);
      });
    },

    install(ui) {
      const target = ui as SetStatusUi;
      const existingPatch = readPatch(target);
      if (existingPatch !== null) {
        existingPatch.mirrorSetStatus = queueMirrorSetStatus;
        return;
      }

      const patch: StatusMirrorPatch = {
        originalSetStatus: target.setStatus.bind(target),
        wrappedSetStatus: (key, text) => {
          // Always delegate to the original first
          patch.originalSetStatus(key, text);

          // Then mirror asynchronously (fail open — never throw through caller)
          patch.mirrorSetStatus(key, text).catch((error) => {
            emit(
              CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
              `Failed to mirror status "${key}": ${getErrorMessage(error)}`,
            );
          });
        },
        mirrorSetStatus: queueMirrorSetStatus,
      };

      target[PATCH_KEY] = patch;
      target.setStatus = patch.wrappedSetStatus;
    },

    async clearTracked() {
      const previousContext = resolveContextSnapshot(context);
      const trackedSources = Array.from(lastMirrored.keys());

      context = null;
      configuredContext = null;
      lifecycleVersion += 1;
      lastMirrored.clear();

      await enqueue(async () => {
        await clearSources(previousContext, trackedSources);
      });
    },
  };

  function queueMirrorSetStatus(source: string, text: string | undefined): Promise<void> {
    const snapshot = resolveContextSnapshot(context);
    const version = lifecycleVersion;
    return enqueue(async () => {
      await mirrorSetStatus(snapshot, version, source, text);
    });
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = operationQueue.then(task, task);
    operationQueue = next.catch(() => {});
    return next;
  }

  async function mirrorSetStatus(
    snapshot: ResolvedStatusContext | null,
    version: number,
    source: string,
    text: string | undefined,
  ): Promise<void> {
    if (snapshot === null || version !== lifecycleVersion) {
      return;
    }

    const sourceValidation = validateSourceSlug(source);
    if (!sourceValidation.valid) {
      emit(CHIP_DIAGNOSTIC_CODES.CHIP_SOURCE_INVALID, sourceValidation.reason);
      return;
    }

    // Clear case: undefined or empty-after-sanitize
    if (text === undefined) {
      await clearSourceChip(snapshot, source);
      if (version === lifecycleVersion) {
        lastMirrored.delete(source);
      }
      return;
    }

    const sanitized = sanitizeVisibleText(text);
    if (sanitized.length === 0) {
      await clearSourceChip(snapshot, source);
      if (version === lifecycleVersion) {
        lastMirrored.delete(source);
      }
      return;
    }

    if (!isNonEmptyString(snapshot.sessionId)) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_SESSION_ID_MISSING,
        `Cannot mirror status "${source}" without a resolved sessionId`,
      );
      return;
    }

    const previous = lastMirrored.get(source);
    if (
      previous?.runtimeId === snapshot.runtimeId &&
      previous.sessionId === snapshot.sessionId &&
      previous.text === sanitized
    ) {
      return;
    }

    const result = await writeChipRecord(
      {
        schemaVersion: CHIPS_SCHEMA_VERSION,
        source,
        text: sanitized,
        updatedAt: new Date().toISOString(),
        chipId: DEFAULT_CHIP_ID,
        scope: DEFAULT_CHIP_SCOPE,
        level: DEFAULT_CHIP_LEVEL,
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.sessionId,
      },
      {
        ...(directory === undefined ? {} : { directory }),
        onDiagnostic: emit,
      },
    );

    if (result === null) {
      return;
    }

    if (version !== lifecycleVersion) {
      await clearSourceChip(snapshot, source);
      return;
    }

    lastMirrored.set(source, {
      runtimeId: snapshot.runtimeId,
      sessionId: snapshot.sessionId,
      text: sanitized,
    });
  }

  async function clearSources(
    snapshot: ResolvedStatusContext | null,
    sources: string[],
  ): Promise<void> {
    if (snapshot === null) {
      return;
    }

    for (const source of sources) {
      await clearSourceChip(snapshot, source);
    }
  }

  async function clearSourceChip(snapshot: ResolvedStatusContext, source: string): Promise<void> {
    await clearChipRecord(
      {
        source,
        chipId: DEFAULT_CHIP_ID,
        scope: DEFAULT_CHIP_SCOPE,
        runtimeId: snapshot.runtimeId,
      },
      {
        ...(directory === undefined ? {} : { directory }),
        onDiagnostic: emit,
      },
    );
  }
}

// ─── Utilities ────────────────────────────────────────────────────────

function resolveContextSnapshot(
  context: MirroredStatusContext | null,
): ResolvedStatusContext | null {
  if (context === null) {
    return null;
  }

  return {
    runtimeId: context.runtimeId,
    sessionId: safeCall(() => context.getSessionId(), null) ?? null,
  };
}

function shouldClearTracked(
  previousContext: ResolvedStatusContext | null,
  nextContext: ResolvedStatusContext,
): previousContext is ResolvedStatusContext {
  if (previousContext === null) {
    return false;
  }

  return (
    previousContext.runtimeId !== nextContext.runtimeId ||
    previousContext.sessionId !== nextContext.sessionId ||
    previousContext.sessionId === null ||
    nextContext.sessionId === null
  );
}

function readPatch(ui: SetStatusUi): StatusMirrorPatch | null {
  const patch = ui[PATCH_KEY];
  if (!isStatusMirrorPatch(patch)) {
    return null;
  }

  return patch;
}

function isStatusMirrorPatch(candidate: unknown): candidate is StatusMirrorPatch {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as StatusMirrorPatch).originalSetStatus === 'function' &&
    typeof (candidate as StatusMirrorPatch).wrappedSetStatus === 'function' &&
    typeof (candidate as StatusMirrorPatch).mirrorSetStatus === 'function'
  );
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
