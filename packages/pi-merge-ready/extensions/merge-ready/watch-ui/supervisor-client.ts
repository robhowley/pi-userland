import { MERGE_READY_WATCH_UI_SERVICE } from './supervisor-state.js';

export type MergeReadyWatchUiHealth = {
  service: typeof MERGE_READY_WATCH_UI_SERVICE;
  pid: number;
  port: number;
  startedAt: string;
  packageVersion: string;
  snapshotLoaded: boolean;
  snapshotSignature: string;
};

export function createMergeReadyWatchUiUrl(port: number, token: string, cwd?: string): string {
  const params = new URLSearchParams({ token });
  if (cwd) {
    params.set('cwd', cwd);
  }

  return `http://127.0.0.1:${String(port)}/#${params.toString()}`;
}

export async function fetchMergeReadyWatchUiHealth(
  port: number,
  options: { signal?: AbortSignal } = {},
): Promise<MergeReadyWatchUiHealth | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
      method: 'GET',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as Partial<MergeReadyWatchUiHealth>;
    if (
      payload.service !== MERGE_READY_WATCH_UI_SERVICE ||
      typeof payload.pid !== 'number' ||
      typeof payload.port !== 'number' ||
      typeof payload.startedAt !== 'string' ||
      typeof payload.packageVersion !== 'string'
    ) {
      return null;
    }

    return {
      service: payload.service,
      pid: payload.pid,
      port: payload.port,
      startedAt: payload.startedAt,
      packageVersion: payload.packageVersion,
      snapshotLoaded: typeof payload.snapshotLoaded === 'boolean' ? payload.snapshotLoaded : false,
      snapshotSignature:
        typeof payload.snapshotSignature === 'string' ? payload.snapshotSignature : '',
    };
  } catch {
    return null;
  }
}
