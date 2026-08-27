export const PRODUCER_BOARD_EVENT = 'pi-cmux-junction:update' as const;

export const MAX_PRODUCER_KEY_BYTES = 64;
export const MAX_CARD_KEY_BYTES = 64;
export const MAX_LABEL_BYTES = 128;
export const MAX_SUMMARY_BYTES = 512;
export const MAX_ROW_TEXT_BYTES = 256;
export const MAX_HREF_BYTES = 2_048;
export const MAX_CARDS_PER_BOARD = 32;
export const MAX_ROWS_PER_CARD = 16;
export const MAX_ROWS_PER_BOARD = 256;
export const MAX_BOARD_BYTES = 8_192;
export const MAX_LOCAL_PRODUCERS = 64;
export const MAX_LOCAL_CARDS = 512;
export const MAX_LOCAL_ROWS = 4_096;

export interface ProducerBoard {
  producer: ProducerIdentity;
  cards: ProducerCard[];
}

export interface ProducerIdentity {
  key: string;
  label: string;
}

export interface ProducerCard {
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

export interface NormalizedProducerBoard {
  readonly producer: Readonly<ProducerIdentity>;
  readonly cards: readonly NormalizedProducerCard[];
}

export interface NormalizedProducerCard {
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

export type ProducerBoardErrorCode =
  | 'invalid-record'
  | 'unknown-field'
  | 'required-field'
  | 'invalid-type'
  | 'invalid-identifier'
  | 'invalid-string'
  | 'invalid-url'
  | 'invalid-number'
  | 'duplicate-key'
  | 'board-limit'
  | 'capacity';

export type ProducerBoardValidationResult =
  | { readonly ok: true; readonly value: NormalizedProducerBoard }
  | {
      readonly ok: false;
      readonly code: Exclude<ProducerBoardErrorCode, 'capacity'>;
      readonly path?: string;
    };

export type ProducerBoardUpdateResult =
  | {
      readonly accepted: true;
      readonly changed: boolean;
      readonly action: 'replaced' | 'withdrawn' | 'none';
    }
  | { readonly accepted: false; readonly code: ProducerBoardErrorCode; readonly path?: string };

export interface ProducerBoardStore {
  accept(value: unknown): ProducerBoardUpdateResult;
  snapshot(): readonly NormalizedProducerBoard[];
  subscribe(listener: (snapshot: readonly NormalizedProducerBoard[]) => void): () => void;
}

type ValidationErrorCode = Exclude<ProducerBoardErrorCode, 'capacity'>;
type ValidationFailure = {
  readonly ok: false;
  readonly code: ValidationErrorCode;
  readonly path: string;
};
type Parsed<T> = { readonly ok: true; readonly value: T } | ValidationFailure;

type Listener = (snapshot: readonly NormalizedProducerBoard[]) => void;

interface BoardEntry {
  readonly board: NormalizedProducerBoard;
  readonly json: string;
  readonly cardCount: number;
  readonly rowCount: number;
}

interface Notification {
  readonly snapshot: readonly NormalizedProducerBoard[];
  readonly listeners: readonly Listener[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,63}$/;
// The C0/C1 ranges are intentional and must remain exact.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const URL_WHITESPACE_PATTERN = /\s/u;

const BOARD_FIELDS = ['producer', 'cards'] as const;
const PRODUCER_FIELDS = ['key', 'label'] as const;
const CARD_FIELDS = ['key', 'title', 'status', 'summary', 'progress', 'rows', 'href'] as const;
const PROGRESS_FIELDS = ['label', 'value', 'max'] as const;
const ROW_FIELDS = ['label', 'value', 'detail', 'href'] as const;

export function normalizeProducerBoard(value: unknown): ProducerBoardValidationResult {
  try {
    const boardRecord = inspectRecord(value, '$', BOARD_FIELDS, BOARD_FIELDS);
    if (!boardRecord.ok) return boardRecord;

    const producer = parseProducer(boardRecord.value.get('producer'));
    if (!producer.ok) return producer;

    const cardsArray = inspectArray(boardRecord.value.get('cards'), 'cards', MAX_CARDS_PER_BOARD);
    if (!cardsArray.ok) return cardsArray;

    const cards: NormalizedProducerCard[] = [];
    for (let index = 0; index < cardsArray.value.length; index += 1) {
      const card = parseCard(cardsArray.value[index], index);
      if (!card.ok) return card;
      cards.push(card.value);
    }

    const seenCardKeys = new Set<string>();
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      if (card === undefined) return failure('invalid-record', `cards[${index}]`);
      if (seenCardKeys.has(card.key)) return failure('duplicate-key', `cards[${index}].key`);
      seenCardKeys.add(card.key);
    }

    let totalRows = 0;
    for (const card of cards) totalRows += card.rows.length;
    if (totalRows > MAX_ROWS_PER_BOARD) return failure('board-limit', 'cards');

    const normalized = freezeBoard({ producer: producer.value, cards });
    const json = JSON.stringify(normalized);
    if (Buffer.byteLength(json, 'utf8') > MAX_BOARD_BYTES) {
      return failure('board-limit', '$');
    }

    return { ok: true, value: normalized };
  } catch {
    return failure('invalid-record', '$');
  }
}

export function createProducerBoardStore(): ProducerBoardStore {
  const entries = new Map<string, BoardEntry>();
  const subscribers = new Set<Listener>();
  const notifications: Notification[] = [];
  let totalCards = 0;
  let totalRows = 0;
  let notifying = false;

  function captureSnapshot(): readonly NormalizedProducerBoard[] {
    const ordered = [...entries.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return freezeSnapshot(ordered.map(([, entry]) => cloneBoard(entry.board)));
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
            listener(cloneSnapshot(notification.snapshot));
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
    accept(value: unknown): ProducerBoardUpdateResult {
      const normalized = normalizeProducerBoard(value);
      if (!normalized.ok) {
        return {
          accepted: false,
          code: normalized.code,
          ...(normalized.path === undefined ? {} : { path: normalized.path }),
        };
      }

      const board = normalized.value;
      const key = board.producer.key;
      const previous = entries.get(key);

      if (board.cards.length === 0) {
        if (previous === undefined) {
          return { accepted: true, changed: false, action: 'none' };
        }

        entries.delete(key);
        totalCards -= previous.cardCount;
        totalRows -= previous.rowCount;
        enqueueNotification();
        drainNotifications();
        return { accepted: true, changed: true, action: 'withdrawn' };
      }

      const json = JSON.stringify(board);
      if (previous?.json === json) {
        return { accepted: true, changed: false, action: 'none' };
      }

      const cardCount = board.cards.length;
      let rowCount = 0;
      for (const card of board.cards) rowCount += card.rows.length;

      const nextProducerCount = entries.size + (previous === undefined ? 1 : 0);
      const nextCardCount = totalCards - (previous?.cardCount ?? 0) + cardCount;
      const nextRowCount = totalRows - (previous?.rowCount ?? 0) + rowCount;
      if (
        nextProducerCount > MAX_LOCAL_PRODUCERS ||
        nextCardCount > MAX_LOCAL_CARDS ||
        nextRowCount > MAX_LOCAL_ROWS
      ) {
        return { accepted: false, code: 'capacity' };
      }

      entries.set(key, { board, json, cardCount, rowCount });
      totalCards = nextCardCount;
      totalRows = nextRowCount;
      enqueueNotification();
      drainNotifications();
      return { accepted: true, changed: true, action: 'replaced' };
    },

    snapshot(): readonly NormalizedProducerBoard[] {
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
    if (length > maximumLength) return failure('board-limit', path);

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

function parseCard(value: unknown, index: number): Parsed<NormalizedProducerCard> {
  const path = `cards[${index}]`;
  const record = inspectRecord(value, path, CARD_FIELDS, ['key', 'title']);
  if (!record.ok) return record;

  const key = parseIdentifier(record.value.get('key'), `${path}.key`, MAX_CARD_KEY_BYTES);
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
    const rowsArray = inspectArray(record.value.get('rows'), `${path}.rows`, MAX_ROWS_PER_CARD);
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

function freezeBoard(board: NormalizedProducerBoard): NormalizedProducerBoard {
  Object.freeze(board.producer);
  for (const card of board.cards) {
    if (card.progress !== undefined) Object.freeze(card.progress);
    for (const row of card.rows) Object.freeze(row);
    Object.freeze(card.rows);
    Object.freeze(card);
  }
  Object.freeze(board.cards);
  return Object.freeze(board);
}

function cloneBoard(board: NormalizedProducerBoard): NormalizedProducerBoard {
  return freezeBoard({
    producer: { key: board.producer.key, label: board.producer.label },
    cards: board.cards.map((card) => ({
      key: card.key,
      title: card.title,
      ...(card.status === undefined ? {} : { status: card.status }),
      ...(card.summary === undefined ? {} : { summary: card.summary }),
      ...(card.progress === undefined
        ? {}
        : {
            progress: {
              label: card.progress.label,
              value: card.progress.value,
              max: card.progress.max,
            },
          }),
      rows: card.rows.map((row) => ({
        ...(row.label === undefined ? {} : { label: row.label }),
        value: row.value,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
        ...(row.href === undefined ? {} : { href: row.href }),
      })),
      ...(card.href === undefined ? {} : { href: card.href }),
    })),
  });
}

function freezeSnapshot(snapshot: NormalizedProducerBoard[]): readonly NormalizedProducerBoard[] {
  return Object.freeze(snapshot);
}

function cloneSnapshot(
  snapshot: readonly NormalizedProducerBoard[],
): readonly NormalizedProducerBoard[] {
  return freezeSnapshot(snapshot.map(cloneBoard));
}

function reportSubscriberError(): void {
  try {
    console.error('pi-cmux-junction: producer-board subscriber failed');
  } catch {
    // Diagnostics must not interrupt delivery of committed snapshots.
  }
}
