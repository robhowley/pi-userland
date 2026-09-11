export const PRODUCER_VIEW_EVENT = 'pi-cmux-junction:update' as const;

export const MAX_PRODUCER_KEY_BYTES = 64;
export const MAX_ITEM_KEY_BYTES = 64;
export const MAX_LABEL_BYTES = 128;
export const MAX_SUMMARY_BYTES = 512;
export const MAX_ROW_TEXT_BYTES = 256;
export const MAX_HREF_BYTES = 2_048;
export const MAX_ITEMS_PER_VIEW = 32;
export const MAX_ROWS_PER_ITEM = 16;
export const MAX_ROWS_PER_VIEW = 256;
export const MAX_VIEW_BYTES = 8_192;
export const MAX_LOCAL_PRODUCERS = 64;
export const MAX_LOCAL_ITEMS = 512;
export const MAX_LOCAL_ROWS = 4_096;

export interface ProducerView {
  producer: ProducerIdentity;
  items: ProducerItem[];
}

export interface ProducerIdentity {
  key: string;
  label: string;
}

export interface ProducerItem {
  key: string;
  title: string;
  status?: string;
  summary?: string;
  progress?: ProducerProgress;
  rows?: ProducerRow[];
  href?: string;
}

export interface ProducerProgress {
  label: string;
  value: number;
  max: number;
}

export interface ProducerRow {
  label?: string;
  value: string;
  detail?: string;
  href?: string;
}

export interface NormalizedProducerView {
  readonly producer: Readonly<ProducerIdentity>;
  readonly items: readonly NormalizedProducerItem[];
}

export interface NormalizedProducerItem {
  readonly key: string;
  readonly title: string;
  readonly status?: string;
  readonly summary?: string;
  readonly progress?: Readonly<NormalizedProgress>;
  readonly rows: readonly NormalizedRow[];
  readonly href?: string;
}

export interface NormalizedProgress {
  readonly label: string;
  readonly value: number;
  readonly max: number;
}

export interface NormalizedRow {
  readonly label?: string;
  readonly value: string;
  readonly detail?: string;
  readonly href?: string;
}

export type ProducerViewErrorCode =
  | 'invalid-record'
  | 'unknown-field'
  | 'required-field'
  | 'invalid-type'
  | 'invalid-identifier'
  | 'invalid-string'
  | 'invalid-url'
  | 'invalid-number'
  | 'duplicate-key'
  | 'view-limit'
  | 'capacity';

export type ProducerViewValidationResult =
  | { readonly ok: true; readonly value: NormalizedProducerView }
  | {
      readonly ok: false;
      readonly code: Exclude<ProducerViewErrorCode, 'capacity'>;
      readonly path?: string;
    };

export type ProducerViewUpdateResult =
  | {
      readonly accepted: true;
      readonly action: 'replaced' | 'withdrawn' | 'none';
    }
  | { readonly accepted: false; readonly code: ProducerViewErrorCode; readonly path?: string };

export interface ProducerViewStore {
  clear(): void;
  accept(value: unknown): ProducerViewUpdateResult;
  snapshot(): readonly NormalizedProducerView[];
  subscribe(listener: (snapshot: readonly NormalizedProducerView[]) => void): () => void;
}

type ValidationErrorCode = Exclude<ProducerViewErrorCode, 'capacity'>;
type ValidationFailure = {
  readonly ok: false;
  readonly code: ValidationErrorCode;
  readonly path: string;
};
type Parsed<T> = { readonly ok: true; readonly value: T } | ValidationFailure;

type Listener = (snapshot: readonly NormalizedProducerView[]) => void;

interface ViewEntry {
  readonly view: NormalizedProducerView;
  readonly json: string;
  readonly itemCount: number;
  readonly rowCount: number;
}

interface Notification {
  readonly snapshot: readonly NormalizedProducerView[];
  readonly listeners: readonly Listener[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,63}$/;
// The C0/C1 ranges are intentional and must remain exact.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const URL_WHITESPACE_PATTERN = /\s/u;

const VIEW_FIELDS = ['producer', 'items'] as const;
const PRODUCER_FIELDS = ['key', 'label'] as const;
const ITEM_FIELDS = ['key', 'title', 'status', 'summary', 'progress', 'rows', 'href'] as const;
const PROGRESS_FIELDS = ['label', 'value', 'max'] as const;
const ROW_FIELDS = ['label', 'value', 'detail', 'href'] as const;

export function normalizeProducerView(value: unknown): ProducerViewValidationResult {
  try {
    const viewRecord = inspectRecord(value, '$', VIEW_FIELDS, VIEW_FIELDS);
    if (!viewRecord.ok) return viewRecord;

    const producer = parseProducer(viewRecord.value.get('producer'));
    if (!producer.ok) return producer;

    const itemsArray = inspectArray(viewRecord.value.get('items'), 'items', MAX_ITEMS_PER_VIEW);
    if (!itemsArray.ok) return itemsArray;

    const items: NormalizedProducerItem[] = [];
    for (let index = 0; index < itemsArray.value.length; index += 1) {
      const item = parseItem(itemsArray.value[index], index);
      if (!item.ok) return item;
      items.push(item.value);
    }

    const seenItemKeys = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) return failure('invalid-record', `items[${index}]`);
      if (seenItemKeys.has(item.key)) return failure('duplicate-key', `items[${index}].key`);
      seenItemKeys.add(item.key);
    }

    let totalRows = 0;
    for (const item of items) totalRows += item.rows.length;
    if (totalRows > MAX_ROWS_PER_VIEW) return failure('view-limit', 'items');

    const normalized = freezeView({ producer: producer.value, items });
    const json = JSON.stringify(normalized);
    if (Buffer.byteLength(json, 'utf8') > MAX_VIEW_BYTES) {
      return failure('view-limit', '$');
    }

    return { ok: true, value: normalized };
  } catch {
    return failure('invalid-record', '$');
  }
}

export function createProducerViewStore(): ProducerViewStore {
  const entries = new Map<string, ViewEntry>();
  const subscribers = new Set<Listener>();
  const notifications: Notification[] = [];
  let totalItems = 0;
  let totalRows = 0;
  let notifying = false;

  function captureSnapshot(): readonly NormalizedProducerView[] {
    const ordered = [...entries.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return freezeSnapshot(ordered.map(([, entry]) => entry.view));
  }

  function enqueueNotification(): void {
    notifications.push({
      snapshot: captureSnapshot(),
      listeners: [...subscribers],
    });
  }

  function drainNotifications(): void {
    if (notifying) return;
    notifying = true;
    try {
      while (notifications.length > 0) {
        const notification = notifications.shift();
        if (notification === undefined) continue;
        for (const listener of notification.listeners) {
          try {
            listener(notification.snapshot);
          } catch {
            reportSubscriberError();
          }
        }
      }
    } finally {
      notifying = false;
    }
  }

  return {
    clear(): void {
      if (entries.size === 0) return;
      entries.clear();
      totalItems = 0;
      totalRows = 0;
      enqueueNotification();
      drainNotifications();
    },
    accept(value: unknown): ProducerViewUpdateResult {
      const normalized = normalizeProducerView(value);
      if (!normalized.ok) {
        return {
          accepted: false,
          code: normalized.code,
          ...(normalized.path === undefined ? {} : { path: normalized.path }),
        };
      }

      const view = normalized.value;
      const key = view.producer.key;
      const previous = entries.get(key);

      if (view.items.length === 0) {
        if (previous === undefined) {
          return { accepted: true, action: 'none' };
        }

        entries.delete(key);
        totalItems -= previous.itemCount;
        totalRows -= previous.rowCount;
        enqueueNotification();
        drainNotifications();
        return { accepted: true, action: 'withdrawn' };
      }

      const json = JSON.stringify(view);
      if (previous?.json === json) {
        return { accepted: true, action: 'none' };
      }

      const itemCount = view.items.length;
      let rowCount = 0;
      for (const item of view.items) rowCount += item.rows.length;

      const nextProducerCount = entries.size + (previous === undefined ? 1 : 0);
      const nextItemCount = totalItems - (previous?.itemCount ?? 0) + itemCount;
      const nextRowCount = totalRows - (previous?.rowCount ?? 0) + rowCount;
      if (
        nextProducerCount > MAX_LOCAL_PRODUCERS ||
        nextItemCount > MAX_LOCAL_ITEMS ||
        nextRowCount > MAX_LOCAL_ROWS
      ) {
        return { accepted: false, code: 'capacity' };
      }

      entries.set(key, { view, json, itemCount, rowCount });
      totalItems = nextItemCount;
      totalRows = nextRowCount;
      enqueueNotification();
      drainNotifications();
      return { accepted: true, action: 'replaced' };
    },

    snapshot(): readonly NormalizedProducerView[] {
      return captureSnapshot();
    },

    subscribe(listener: Listener): () => void {
      subscribers.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        subscribers.delete(listener);
      };
    },
  };
}

function inspectRecord(
  value: unknown,
  path: string,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
): Parsed<Map<string, unknown>> {
  if (typeof value !== 'object' || value === null) return failure('invalid-type', path);

  try {
    if (Array.isArray(value)) return failure('invalid-type', path);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return failure('invalid-record', path);
    }

    const keys = Reflect.ownKeys(value);
    const values = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== 'string') return failure('invalid-record', path);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return failure('invalid-record', path);
      }
      values.set(key, descriptor.value);
    }

    for (const key of keys) {
      if (typeof key === 'string' && !allowedFields.includes(key)) {
        return failure('unknown-field', path);
      }
    }

    for (const field of requiredFields) {
      if (!values.has(field)) return failure('required-field', childPath(path, field));
    }

    return { ok: true, value: values };
  } catch {
    return failure('invalid-record', path);
  }
}

function inspectArray(value: unknown, path: string, maximumLength: number): Parsed<unknown[]> {
  if (typeof value !== 'object' || value === null) return failure('invalid-type', path);

  try {
    if (!Array.isArray(value)) return failure('invalid-type', path);
    if (Object.getPrototypeOf(value) !== Array.prototype) return failure('invalid-record', path);

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      lengthDescriptor.enumerable ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return failure('invalid-record', path);
    }

    const length = lengthDescriptor.value;
    if (length > maximumLength) return failure('view-limit', path);

    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) return failure('invalid-record', path);
    const stringKeys = new Set<string>();
    for (const key of keys) {
      if (typeof key !== 'string') return failure('invalid-record', path);
      stringKeys.add(key);
    }
    if (!stringKeys.has('length')) return failure('invalid-record', path);
    for (let index = 0; index < length; index += 1) {
      if (!stringKeys.has(String(index))) return failure('invalid-record', path);
    }

    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return failure('invalid-record', path);
      }
      items.push(descriptor.value);
    }
    return { ok: true, value: items };
  } catch {
    return failure('invalid-record', path);
  }
}

function parseProducer(value: unknown): Parsed<Readonly<ProducerIdentity>> {
  const record = inspectRecord(value, 'producer', PRODUCER_FIELDS, PRODUCER_FIELDS);
  if (!record.ok) return record;

  const key = parseIdentifier(record.value.get('key'), 'producer.key', MAX_PRODUCER_KEY_BYTES);
  if (!key.ok) return key;
  const label = parseText(record.value.get('label'), 'producer.label', MAX_LABEL_BYTES);
  if (!label.ok) return label;

  return { ok: true, value: { key: key.value, label: label.value } };
}

function parseItem(value: unknown, index: number): Parsed<NormalizedProducerItem> {
  const path = `items[${index}]`;
  const record = inspectRecord(value, path, ITEM_FIELDS, ['key', 'title']);
  if (!record.ok) return record;

  const key = parseIdentifier(record.value.get('key'), `${path}.key`, MAX_ITEM_KEY_BYTES);
  if (!key.ok) return key;
  const title = parseText(record.value.get('title'), `${path}.title`, MAX_LABEL_BYTES);
  if (!title.ok) return title;
  const status = parseOptionalText(record.value, 'status', `${path}.status`, MAX_LABEL_BYTES);
  if (!status.ok) return status;
  const summary = parseOptionalText(record.value, 'summary', `${path}.summary`, MAX_SUMMARY_BYTES);
  if (!summary.ok) return summary;
  const href = parseOptionalUrl(record.value, 'href', `${path}.href`);
  if (!href.ok) return href;

  let progress: NormalizedProgress | undefined;
  if (record.value.has('progress')) {
    const parsedProgress = parseProgress(record.value.get('progress'), `${path}.progress`);
    if (!parsedProgress.ok) return parsedProgress;
    progress = parsedProgress.value;
  }

  let rows: NormalizedRow[] = [];
  if (record.value.has('rows')) {
    const rowsArray = inspectArray(record.value.get('rows'), `${path}.rows`, MAX_ROWS_PER_ITEM);
    if (!rowsArray.ok) return rowsArray;
    rows = [];
    for (let rowIndex = 0; rowIndex < rowsArray.value.length; rowIndex += 1) {
      const row = parseRow(rowsArray.value[rowIndex], `${path}.rows[${rowIndex}]`);
      if (!row.ok) return row;
      rows.push(row.value);
    }
  }

  return {
    ok: true,
    value: {
      key: key.value,
      title: title.value,
      ...(status.value === undefined ? {} : { status: status.value }),
      ...(summary.value === undefined ? {} : { summary: summary.value }),
      ...(progress === undefined ? {} : { progress }),
      rows,
      ...(href.value === undefined ? {} : { href: href.value }),
    },
  };
}

function parseProgress(value: unknown, path: string): Parsed<NormalizedProgress> {
  const record = inspectRecord(value, path, PROGRESS_FIELDS, PROGRESS_FIELDS);
  if (!record.ok) return record;

  const label = parseText(record.value.get('label'), `${path}.label`, MAX_LABEL_BYTES);
  if (!label.ok) return label;
  const progressValue = parseProgressNumber(record.value.get('value'), `${path}.value`);
  if (!progressValue.ok) return progressValue;
  if (progressValue.value < 0) return failure('invalid-number', `${path}.value`);
  const maximum = parseProgressNumber(record.value.get('max'), `${path}.max`);
  if (!maximum.ok) return maximum;
  if (maximum.value <= 0) return failure('invalid-number', `${path}.max`);
  if (progressValue.value > maximum.value) return failure('invalid-number', `${path}.value`);

  return {
    ok: true,
    value: { label: label.value, value: progressValue.value, max: maximum.value },
  };
}

function parseRow(value: unknown, path: string): Parsed<NormalizedRow> {
  const record = inspectRecord(value, path, ROW_FIELDS, ['value']);
  if (!record.ok) return record;

  const label = parseOptionalText(record.value, 'label', `${path}.label`, MAX_LABEL_BYTES);
  if (!label.ok) return label;
  const rowValue = parseText(record.value.get('value'), `${path}.value`, MAX_ROW_TEXT_BYTES);
  if (!rowValue.ok) return rowValue;
  const detail = parseOptionalText(record.value, 'detail', `${path}.detail`, MAX_ROW_TEXT_BYTES);
  if (!detail.ok) return detail;
  const href = parseOptionalUrl(record.value, 'href', `${path}.href`);
  if (!href.ok) return href;

  return {
    ok: true,
    value: {
      ...(label.value === undefined ? {} : { label: label.value }),
      value: rowValue.value,
      ...(detail.value === undefined ? {} : { detail: detail.value }),
      ...(href.value === undefined ? {} : { href: href.value }),
    },
  };
}

function parseIdentifier(value: unknown, path: string, maximumBytes: number): Parsed<string> {
  if (typeof value !== 'string') return failure('invalid-type', path);
  if (!IDENTIFIER_PATTERN.test(value) || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    return failure('invalid-identifier', path);
  }
  return { ok: true, value };
}

function parseOptionalText(
  record: ReadonlyMap<string, unknown>,
  field: string,
  path: string,
  maximumBytes: number,
): Parsed<string | undefined> {
  if (!record.has(field)) return { ok: true, value: undefined };
  return parseText(record.get(field), path, maximumBytes);
}

function parseText(value: unknown, path: string, maximumBytes: number): Parsed<string> {
  if (typeof value !== 'string') return failure('invalid-type', path);
  if (
    hasLoneSurrogate(value) ||
    CONTROL_PATTERN.test(value) ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return failure('invalid-string', path);
  }
  return { ok: true, value };
}

function parseOptionalUrl(
  record: ReadonlyMap<string, unknown>,
  field: string,
  path: string,
): Parsed<string | undefined> {
  if (!record.has(field)) return { ok: true, value: undefined };
  return parseUrl(record.get(field), path);
}

function parseUrl(value: unknown, path: string): Parsed<string> {
  if (typeof value !== 'string') return failure('invalid-type', path);
  if (
    hasLoneSurrogate(value) ||
    CONTROL_PATTERN.test(value) ||
    URL_WHITESPACE_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_HREF_BYTES
  ) {
    return failure('invalid-url', path);
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return failure('invalid-url', path);
    }
  } catch {
    return failure('invalid-url', path);
  }

  return { ok: true, value };
}

function parseProgressNumber(value: unknown, path: string): Parsed<number> {
  if (typeof value !== 'number') return failure('invalid-type', path);
  if (!Number.isSafeInteger(value)) return failure('invalid-number', path);
  return { ok: true, value: Object.is(value, -0) ? 0 : value };
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

function childPath(path: string, field: string): string {
  return path === '$' ? field : `${path}.${field}`;
}

function failure(code: ValidationErrorCode, path: string): ValidationFailure {
  return { ok: false, code, path };
}

function freezeView(view: NormalizedProducerView): NormalizedProducerView {
  Object.freeze(view.producer);
  for (const item of view.items) {
    if (item.progress !== undefined) Object.freeze(item.progress);
    for (const row of item.rows) Object.freeze(row);
    Object.freeze(item.rows);
    Object.freeze(item);
  }
  Object.freeze(view.items);
  return Object.freeze(view);
}

function freezeSnapshot(snapshot: NormalizedProducerView[]): readonly NormalizedProducerView[] {
  return Object.freeze(snapshot);
}

function reportSubscriberError(): void {
  try {
    console.error('pi-cmux-junction: producer-view subscriber failed');
  } catch {
    // Diagnostics must not interrupt delivery of committed snapshots.
  }
}
