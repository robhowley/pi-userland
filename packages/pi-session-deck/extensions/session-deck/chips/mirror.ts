/**
 * SetStatus mirror: wraps ctx.ui.setStatus to capture footer-status text
 * into chip files without owning the footer.
 */

import { stripVTControlCharacters } from 'node:util';
import {
  CHIP_DIAGNOSTIC_CODES,
  DEFAULT_CHIP_ID,
  DEFAULT_CHIP_LEVEL,
  DEFAULT_CHIP_SCOPE,
  validateSourceSlug,
} from './constants.js';
import type { ChipDiagnosticSink } from './types.js';
import { clearSessionDeckChip, publishSessionDeckChip } from './publisher.js';

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

  // Track last-written text per source to skip identical writes
  const lastMirrored = new Map<string, string>();

  return {
    reconfigure(nextContext) {
      context = {
        runtimeId: nextContext.runtimeId,
        getSessionId: nextContext.getSessionId,
      };
    },

    install(ui) {
      if ((ui as Record<string, unknown>)[PATCH_KEY] === true) {
        return; // already patched
      }

      const priorSetStatus = ui.setStatus.bind(ui);

      const wrapped = (key: string, text: string | undefined): void => {
        // Always delegate to the original first
        priorSetStatus(key, text);

        // Then mirror asynchronously (fail open — never throw through caller)
        mirrorSetStatus(key, text).catch((error) => {
          emit(
            CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
            `Failed to mirror status "${key}": ${getErrorMessage(error)}`,
          );
        });
      };

      (ui as Record<string, unknown>)[PATCH_KEY] = true;
      ui.setStatus = wrapped;
    },

    async clearTracked() {
      const sources = Array.from(lastMirrored.keys());
      for (const source of sources) {
        await clearSourceChip(source);
      }
      lastMirrored.clear();
    },
  };

  async function mirrorSetStatus(source: string, text: string | undefined): Promise<void> {
    if (context === null) {
      return;
    }

    const sourceValidation = validateSourceSlug(source);
    if (!sourceValidation.valid) {
      emit(CHIP_DIAGNOSTIC_CODES.CHIP_SOURCE_INVALID, sourceValidation.reason);
      return;
    }

    // Clear case: undefined or empty-after-sanitize
    if (text === undefined) {
      await clearSourceChip(source);
      lastMirrored.delete(source);
      return;
    }

    const sanitized = sanitizeVisibleText(text);
    if (sanitized.length === 0) {
      await clearSourceChip(source);
      lastMirrored.delete(source);
      return;
    }

    // Skip if text hasn't changed (no-op dedupe)
    const previous = lastMirrored.get(source);
    if (previous === sanitized) {
      return;
    }

    const sessionId = safeCall(() => context!.getSessionId(), null);

    if (!isNonEmptyString(sessionId)) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_SESSION_ID_MISSING,
        `Cannot mirror status "${source}" without a resolved sessionId`,
      );
      return;
    }

    const result = await publishSessionDeckChip(
      {
        source,
        text: sanitized,
        updatedAt: new Date().toISOString(),
        chipId: DEFAULT_CHIP_ID,
        scope: DEFAULT_CHIP_SCOPE,
        level: DEFAULT_CHIP_LEVEL,
        runtimeId: context.runtimeId,
        sessionId,
      },
      {
        ...(directory === undefined ? {} : { directory }),
        onDiagnostic: emit,
      },
    );

    if (result !== null) {
      lastMirrored.set(source, sanitized);
    }
  }

  async function clearSourceChip(source: string): Promise<void> {
    if (context === null) {
      return;
    }

    await clearSessionDeckChip(
      {
        source,
        chipId: DEFAULT_CHIP_ID,
        scope: DEFAULT_CHIP_SCOPE,
        runtimeId: context.runtimeId,
      },
      {
        ...(directory === undefined ? {} : { directory }),
        onDiagnostic: emit,
      }
    );
  }
}

// ─── Utilities ────────────────────────────────────────────────────────

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
