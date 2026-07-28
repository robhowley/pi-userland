import type { UiDialogKind } from './types.js';

const PATCH_KEY = '__piSessionDeckUiDialogMirrorPatched__' as const;

export interface UiDialogMirrorOptions {
  recordStart: (event: { waitId: string; kind: UiDialogKind }) => Promise<void>;
  recordEnd: (event: { waitId: string }) => Promise<void>;
  clear: () => Promise<void>;
  onDiagnostic?: (message: string) => void;
}

export interface UiDialogMirror {
  install(ui: UiDialogUi): void;
  clearTracked(): Promise<void>;
}

export type UiDialogMethod = (...args: never[]) => unknown;
export type UiDialogUi = Partial<Record<UiDialogKind, UiDialogMethod>>;

type PatchableUiDialogUi = UiDialogUi & { [PATCH_KEY]?: unknown };
type UiDialogRecorder = Pick<UiDialogMirrorOptions, 'recordStart' | 'recordEnd' | 'clear'>;

interface UiDialogMirrorPatch {
  originals: Partial<Record<UiDialogKind, UiDialogMethod>>;
  activeWaitIds: Set<string>;
  recorders: UiDialogRecorder;
}

const UI_DIALOG_KINDS: readonly UiDialogKind[] = ['select', 'input', 'editor', 'confirm'];

export function createUiDialogMirror(options: UiDialogMirrorOptions): UiDialogMirror {
  const installedPatches = new Set<UiDialogMirrorPatch>();
  let nextWaitId = 0;
  let recorders: UiDialogRecorder = options;
  const onDiagnostic = options.onDiagnostic ?? noopDiagnostic;

  return {
    install(ui) {
      recorders = options;
      const target = ui as PatchableUiDialogUi;
      const patch = readPatch(target) ?? createPatch(target, recorders);
      patch.recorders = recorders;
      installedPatches.add(patch);

      for (const kind of UI_DIALOG_KINDS) {
        wrapDialogMethod(target, patch, kind);
      }
    },

    async clearTracked() {
      await recordOrThrow(() => recorders.clear(), 'clear UI dialog waits');

      for (const patch of installedPatches) {
        patch.activeWaitIds.clear();
      }
    },
  };

  function createPatch(
    target: PatchableUiDialogUi,
    initialRecorders: UiDialogRecorder,
  ): UiDialogMirrorPatch {
    const patch: UiDialogMirrorPatch = {
      originals: {},
      activeWaitIds: new Set(),
      recorders: initialRecorders,
    };
    target[PATCH_KEY] = patch;
    return patch;
  }

  function wrapDialogMethod(
    target: PatchableUiDialogUi,
    patch: UiDialogMirrorPatch,
    kind: UiDialogKind,
  ): void {
    if (patch.originals[kind] !== undefined) {
      return;
    }

    const original = target[kind];
    if (typeof original !== 'function') {
      return;
    }

    patch.originals[kind] = original;
    target[kind] = async (...args: unknown[]) => {
      const waitId = createWaitId(kind);
      patch.activeWaitIds.add(waitId);
      const startRecorded = scheduleRecord(async () => {
        if (!patch.activeWaitIds.has(waitId)) {
          return;
        }

        await patch.recorders.recordStart({ waitId, kind });
      }, `start ${kind}`);

      try {
        return await Reflect.apply(original, target, args);
      } finally {
        const wasTracked = patch.activeWaitIds.delete(waitId);
        if (wasTracked) {
          const recordEnd = () =>
            scheduleRecord(() => patch.recorders.recordEnd({ waitId }), `end ${kind}`);
          void startRecorded.then(recordEnd, recordEnd);
        }
      }
    };
  }

  function createWaitId(kind: UiDialogKind): string {
    nextWaitId += 1;
    return `${kind}-${nextWaitId}`;
  }

  function scheduleRecord(operation: () => Promise<void>, action: string): Promise<void> {
    return Promise.resolve().then(() => safelyRecord(operation, action));
  }

  async function safelyRecord(operation: () => Promise<void>, action: string): Promise<void> {
    try {
      await operation();
    } catch (error) {
      reportFailure(action, error);
    }
  }

  async function recordOrThrow(operation: () => Promise<void>, action: string): Promise<void> {
    try {
      await operation();
    } catch (error) {
      reportFailure(action, error);
      throw error;
    }
  }

  function reportFailure(action: string, error: unknown): void {
    try {
      onDiagnostic(`Failed to ${action}: ${getErrorMessage(error)}`);
    } catch {
      // Fail-open on diagnostic sink errors.
    }
  }
}

function readPatch(target: PatchableUiDialogUi): UiDialogMirrorPatch | null {
  const patch = target[PATCH_KEY];
  if (
    !isObject(patch) ||
    !isObject(patch['originals']) ||
    !(patch['activeWaitIds'] instanceof Set) ||
    !isObject(patch['recorders'])
  ) {
    return null;
  }

  return patch as unknown as UiDialogMirrorPatch;
}

function noopDiagnostic(_message: string): void {
  // intentionally empty
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
