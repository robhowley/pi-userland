import type { MergeReadyStatus } from './types.js';

export const MERGE_READY_JUNCTION_UPDATE_EVENT = 'pi-cmux-junction:update' as const;
export const MERGE_READY_JUNCTION_PRODUCER_KEY = 'pi-merge-ready' as const;
export const MERGE_READY_JUNCTION_PRODUCER_LABEL = 'Merge Ready' as const;
export const MERGE_READY_JUNCTION_ITEM_KEY = 'current-branch' as const;

export type MergeReadyJunctionEventEmitter = {
  emit(channel: string, data: unknown): void;
};

export type MergeReadyJunctionItem = {
  key: typeof MERGE_READY_JUNCTION_ITEM_KEY;
  title: string;
  status: string;
  summary: string;
  href?: string;
};

export type MergeReadyJunctionUpdate = {
  producer: {
    key: typeof MERGE_READY_JUNCTION_PRODUCER_KEY;
    label: typeof MERGE_READY_JUNCTION_PRODUCER_LABEL;
  };
  items: MergeReadyJunctionItem[];
};

const MAX_JUNCTION_HREF_BYTES = 2_048;
// Keep these checks aligned with Junction's producer-view URL safety rules.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const URL_WHITESPACE_PATTERN = /\s/u;

type MergeReadyJunctionStatus = Pick<MergeReadyStatus, 'target' | 'pr' | 'openItems'>;

export function createMergeReadyJunctionUpdate(
  status: MergeReadyJunctionStatus,
  renderedStatus: string,
): MergeReadyJunctionUpdate | null {
  if (status.target.mode === 'url') {
    return null;
  }

  const title =
    status.pr === null ? 'Current branch' : `Current branch PR #${String(status.pr.number)}`;
  const href =
    status.pr !== null && isMergeReadyJunctionHref(status.pr.url) ? status.pr.url : undefined;

  return createMergeReadyJunctionView({
    title,
    renderedStatus,
    summary: formatOpenItemCount(status.openItems.length),
    ...(href === undefined ? {} : { href }),
  });
}

export function createMergeReadyJunctionUnknownUpdate(
  renderedStatus: string,
): MergeReadyJunctionUpdate {
  return createMergeReadyJunctionView({
    title: 'Current branch',
    renderedStatus,
    summary: 'Status unavailable',
  });
}

export function createMergeReadyJunctionWithdrawal(): MergeReadyJunctionUpdate {
  return {
    producer: createMergeReadyJunctionProducer(),
    items: [],
  };
}

export function emitMergeReadyJunctionUpdate(
  emitter: MergeReadyJunctionEventEmitter | undefined,
  update: MergeReadyJunctionUpdate | null,
): void {
  try {
    if (!emitter || typeof emitter.emit !== 'function' || update === null) {
      return;
    }

    emitter.emit(MERGE_READY_JUNCTION_UPDATE_EVENT, update);
  } catch {
    // Junction is optional presentation. Its failures must not affect Merge Ready.
  }
}

export function isMergeReadyJunctionHref(value: string): boolean {
  if (
    hasLoneSurrogate(value) ||
    CONTROL_PATTERN.test(value) ||
    URL_WHITESPACE_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_JUNCTION_HREF_BYTES
  ) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function createMergeReadyJunctionView(options: {
  title: string;
  renderedStatus: string;
  summary: string;
  href?: string;
}): MergeReadyJunctionUpdate {
  return {
    producer: createMergeReadyJunctionProducer(),
    items: [
      {
        key: MERGE_READY_JUNCTION_ITEM_KEY,
        title: options.title,
        status: options.renderedStatus,
        summary: options.summary,
        ...(options.href === undefined ? {} : { href: options.href }),
      },
    ],
  };
}

function createMergeReadyJunctionProducer(): MergeReadyJunctionUpdate['producer'] {
  return {
    key: MERGE_READY_JUNCTION_PRODUCER_KEY,
    label: MERGE_READY_JUNCTION_PRODUCER_LABEL,
  };
}

function formatOpenItemCount(count: number): string {
  return `${String(count)} open item${count === 1 ? '' : 's'}`;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}
