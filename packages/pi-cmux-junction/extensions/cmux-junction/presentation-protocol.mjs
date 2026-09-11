import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

export const PRESENTATION_PROTOCOL = 'pi-junction.presentation.v1';
export const PRESENTATION_ACK_KIND = 'ack';
export const PRESENTATION_REJECTION_KIND = 'rejection';
export const PRESENTATION_MESSAGE_KINDS = ['snapshot', 'goodbye'];
export const PRESENTATION_REJECTION_REASONS = [
  'wrong-target',
  'fenced',
  'stale-revision',
  'dead-source',
  'source-limit',
  'identity-collision',
  'capacity',
];

export const MAX_PRESENTATION_IDENTITY_BYTES = 256;
export const MAX_PRESENTATION_CONNECTION_ID_BYTES = 64;
export const MAX_PRESENTATION_REQUEST_LINE_BYTES = 528 * 1024;
export const MAX_PRESENTATION_RESPONSE_LINE_BYTES = 4 * 1024;
export const MAX_PRESENTATION_PRODUCERS = 64;
export const MAX_PRESENTATION_ITEMS = 512;
export const MAX_PRESENTATION_ROWS = 4_096;

const MAX_PRODUCER_KEY_BYTES = 64;
const MAX_ITEM_KEY_BYTES = 64;
const MAX_LABEL_BYTES = 128;
const MAX_SUMMARY_BYTES = 512;
const MAX_ROW_TEXT_BYTES = 256;
export const MAX_HREF_BYTES = 2_048;
const MAX_ITEMS_PER_VIEW = 32;
const MAX_ROWS_PER_ITEM = 16;
const MAX_ROWS_PER_VIEW = 256;
const MAX_VIEW_BYTES = 8_192;

export const PRESENTATION_COMMON_FIELDS = [
  'protocol',
  'kind',
  'workspaceId',
  'surfaceId',
  'sessionId',
  'runtimeId',
  'pid',
  'processStartedAt',
  'connectionId',
  'sourceGeneration',
  'revision',
];
export const PRESENTATION_SNAPSHOT_FIELDS = [...PRESENTATION_COMMON_FIELDS, 'views'];
export const PRESENTATION_ACK_FIELDS = [
  'protocol',
  'kind',
  'workspaceId',
  'surfaceId',
  'sessionId',
  'runtimeId',
  'pid',
  'processStartedAt',
  'connectionId',
  'acceptedGeneration',
  'acceptedRevision',
  'acceptedKind',
];
export const PRESENTATION_REJECTION_FIELDS = [
  'protocol',
  'kind',
  'workspaceId',
  'surfaceId',
  'sessionId',
  'runtimeId',
  'pid',
  'processStartedAt',
  'connectionId',
  'rejectedGeneration',
  'rejectedRevision',
  'rejectedKind',
  'reason',
];

const VIEW_FIELDS = ['producer', 'items'];
const PRODUCER_FIELDS = ['key', 'label'];
const ITEM_FIELDS = ['key', 'title', 'status', 'summary', 'progress', 'rows', 'href'];
const PROGRESS_FIELDS = ['label', 'value', 'max'];
const ROW_FIELDS = ['label', 'value', 'detail', 'href'];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,63}$/u;
const CONNECTION_ID_PATTERN = /^[\x21-\x7e]{1,64}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const URL_WHITESPACE_PATTERN = /\s/u;

export function decodePresentationRequestLine(line) {
  const parsed = parseLine(line, MAX_PRESENTATION_REQUEST_LINE_BYTES);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value.protocol !== PRESENTATION_PROTOCOL) return fail('protocol');
  if (!PRESENTATION_MESSAGE_KINDS.includes(value.kind)) return fail('kind');
  if (
    !exactFields(
      value,
      value.kind === 'snapshot' ? PRESENTATION_SNAPSHOT_FIELDS : PRESENTATION_COMMON_FIELDS,
    )
  ) {
    return fail('fields');
  }
  if (!validCommon(value)) return fail('identity');
  if (value.kind === 'goodbye') {
    if (value.sourceGeneration === null) return fail('generation');
    return { ok: true, value: Object.freeze({ ...value }) };
  }

  const views = normalizeViews(value.views);
  if (!views.ok) return views;
  return { ok: true, value: Object.freeze({ ...value, views: views.value }) };
}

export function decodePresentationRequest(value) {
  let line;
  try {
    line = JSON.stringify(value);
  } catch {
    return fail('json');
  }
  return decodePresentationRequestLine(line);
}

export function createPresentationAck(message, acceptedGeneration) {
  return Object.freeze({
    ...responseIdentity(message),
    kind: PRESENTATION_ACK_KIND,
    acceptedGeneration,
    acceptedRevision: message.revision,
    acceptedKind: message.kind,
  });
}

export function createPresentationRejection(message, reason) {
  return Object.freeze({
    ...responseIdentity(message),
    kind: PRESENTATION_REJECTION_KIND,
    rejectedGeneration: message.sourceGeneration,
    rejectedRevision: message.revision,
    rejectedKind: message.kind,
    reason,
  });
}

export function decodePresentationResponseLine(line, expected) {
  const parsed = parseLine(line, MAX_PRESENTATION_RESPONSE_LINE_BYTES);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (value.protocol !== PRESENTATION_PROTOCOL || !responseIdentityMatches(value, expected)) {
    return null;
  }

  if (value.kind === PRESENTATION_ACK_KIND) {
    if (
      !exactFields(value, PRESENTATION_ACK_FIELDS) ||
      !positiveSafeInteger(value.acceptedGeneration) ||
      !nonnegativeSafeInteger(value.acceptedRevision) ||
      value.acceptedRevision !== expected.revision ||
      value.acceptedKind !== expected.kind ||
      (expected.kind === 'goodbye' && value.acceptedGeneration !== expected.sourceGeneration)
    ) {
      return null;
    }
    return Object.freeze({ ...value });
  }

  if (
    value.kind !== PRESENTATION_REJECTION_KIND ||
    !exactFields(value, PRESENTATION_REJECTION_FIELDS) ||
    !PRESENTATION_REJECTION_REASONS.includes(value.reason) ||
    value.rejectedGeneration !== expected.sourceGeneration ||
    value.rejectedRevision !== expected.revision ||
    value.rejectedKind !== expected.kind
  ) {
    return null;
  }
  return Object.freeze({ ...value });
}

function responseIdentity(message) {
  return {
    protocol: PRESENTATION_PROTOCOL,
    workspaceId: message.workspaceId,
    surfaceId: message.surfaceId,
    sessionId: message.sessionId,
    runtimeId: message.runtimeId,
    pid: message.pid,
    processStartedAt: message.processStartedAt,
    connectionId: message.connectionId,
  };
}

function responseIdentityMatches(value, expected) {
  return (
    value.workspaceId === expected.workspaceId &&
    value.surfaceId === expected.surfaceId &&
    value.sessionId === expected.sessionId &&
    value.runtimeId === expected.runtimeId &&
    value.pid === expected.pid &&
    value.processStartedAt === expected.processStartedAt &&
    value.connectionId === expected.connectionId
  );
}

function validCommon(value) {
  return (
    validIdentity(value.workspaceId) &&
    validIdentity(value.surfaceId) &&
    validIdentity(value.sessionId) &&
    validIdentity(value.runtimeId) &&
    positiveSafeInteger(value.pid) &&
    typeof value.processStartedAt === 'number' &&
    Number.isFinite(value.processStartedAt) &&
    value.processStartedAt >= 0 &&
    validConnectionId(value.connectionId) &&
    (value.sourceGeneration === null || positiveSafeInteger(value.sourceGeneration)) &&
    nonnegativeSafeInteger(value.revision)
  );
}

function validIdentity(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !hasLoneSurrogate(value) &&
    !CONTROL_PATTERN.test(value) &&
    Buffer.byteLength(value, 'utf8') <= MAX_PRESENTATION_IDENTITY_BYTES
  );
}

function validConnectionId(value) {
  return (
    typeof value === 'string' &&
    CONNECTION_ID_PATTERN.test(value) &&
    Buffer.byteLength(value, 'utf8') <= MAX_PRESENTATION_CONNECTION_ID_BYTES
  );
}

function normalizeViews(value) {
  if (!Array.isArray(value) || value.length > MAX_PRESENTATION_PRODUCERS) return fail('views');
  const views = [];
  let previousKey = null;
  let itemCount = 0;
  let rowCount = 0;
  for (const candidate of value) {
    const view = normalizeView(candidate);
    if (!view.ok) return view;
    const key = view.value.producer.key;
    if (previousKey !== null && key <= previousKey) return fail('producer-order');
    previousKey = key;
    itemCount += view.value.items.length;
    for (const item of view.value.items) rowCount += item.rows.length;
    if (itemCount > MAX_PRESENTATION_ITEMS || rowCount > MAX_PRESENTATION_ROWS) {
      return fail('capacity');
    }
    views.push(view.value);
  }
  return { ok: true, value: Object.freeze(views) };
}

function normalizeView(value) {
  if (!plainRecord(value) || !exactFields(value, VIEW_FIELDS)) return fail('view');
  const producer = normalizeProducer(value.producer);
  if (
    !producer ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > MAX_ITEMS_PER_VIEW
  ) {
    return fail('view');
  }
  const items = [];
  const itemKeys = new Set();
  let rows = 0;
  for (const candidate of value.items) {
    const item = normalizeItem(candidate);
    if (!item || itemKeys.has(item.key)) return fail('view');
    itemKeys.add(item.key);
    rows += item.rows.length;
    if (rows > MAX_ROWS_PER_VIEW) return fail('view');
    items.push(item);
  }
  const view = { producer, items: Object.freeze(items) };
  if (Buffer.byteLength(JSON.stringify(view), 'utf8') > MAX_VIEW_BYTES) return fail('view');
  return { ok: true, value: Object.freeze(view) };
}

function normalizeProducer(value) {
  if (!plainRecord(value) || !exactFields(value, PRODUCER_FIELDS)) return null;
  if (
    !validIdentifier(value.key, MAX_PRODUCER_KEY_BYTES) ||
    !validText(value.label, MAX_LABEL_BYTES)
  )
    return null;
  return Object.freeze({ key: value.key, label: value.label });
}

function normalizeItem(value) {
  if (!plainRecord(value) || !exactOptionalFields(value, ITEM_FIELDS, ['key', 'title', 'rows']))
    return null;
  if (
    !validIdentifier(value.key, MAX_ITEM_KEY_BYTES) ||
    !validText(value.title, MAX_LABEL_BYTES) ||
    !optionalText(value.status, MAX_LABEL_BYTES) ||
    !optionalText(value.summary, MAX_SUMMARY_BYTES) ||
    !optionalUrl(value.href) ||
    !Array.isArray(value.rows) ||
    value.rows.length > MAX_ROWS_PER_ITEM
  ) {
    return null;
  }
  const progress = value.progress === undefined ? undefined : normalizeProgress(value.progress);
  if (value.progress !== undefined && !progress) return null;
  const rows = [];
  for (const candidate of value.rows) {
    const row = normalizeRow(candidate);
    if (!row) return null;
    rows.push(row);
  }
  return Object.freeze({
    key: value.key,
    title: value.title,
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(progress === undefined ? {} : { progress }),
    rows: Object.freeze(rows),
    ...(value.href === undefined ? {} : { href: value.href }),
  });
}

function normalizeProgress(value) {
  if (!plainRecord(value) || !exactFields(value, PROGRESS_FIELDS)) return null;
  if (
    !validText(value.label, MAX_LABEL_BYTES) ||
    !nonnegativeSafeInteger(value.value) ||
    !positiveSafeInteger(value.max) ||
    value.value > value.max
  ) {
    return null;
  }
  return Object.freeze({
    label: value.label,
    value: Object.is(value.value, -0) ? 0 : value.value,
    max: value.max,
  });
}

function normalizeRow(value) {
  if (!plainRecord(value) || !exactOptionalFields(value, ROW_FIELDS, ['value'])) return null;
  if (
    !optionalText(value.label, MAX_LABEL_BYTES) ||
    !validText(value.value, MAX_ROW_TEXT_BYTES) ||
    !optionalText(value.detail, MAX_ROW_TEXT_BYTES) ||
    !optionalUrl(value.href)
  ) {
    return null;
  }
  return Object.freeze({
    ...(value.label === undefined ? {} : { label: value.label }),
    value: value.value,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.href === undefined ? {} : { href: value.href }),
  });
}

function optionalText(value, maximumBytes) {
  return value === undefined || validText(value, maximumBytes);
}

function validText(value, maximumBytes) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !hasLoneSurrogate(value) &&
    !CONTROL_PATTERN.test(value) &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  );
}

function validIdentifier(value, maximumBytes) {
  return (
    typeof value === 'string' &&
    IDENTIFIER_PATTERN.test(value) &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  );
}

function optionalUrl(value) {
  return value === undefined || validUrl(value);
}

function validUrl(value) {
  if (
    typeof value !== 'string' ||
    hasLoneSurrogate(value) ||
    CONTROL_PATTERN.test(value) ||
    URL_WHITESPACE_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_HREF_BYTES
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function parseLine(line, maximumBytes) {
  if (
    typeof line !== 'string' ||
    Buffer.byteLength(line, 'utf8') > maximumBytes ||
    line.includes('\n') ||
    line.includes('\r') ||
    line.includes('\0')
  ) {
    return fail('line');
  }
  try {
    const value = JSON.parse(line);
    return plainRecord(value) ? { ok: true, value } : fail('type');
  } catch {
    return fail('json');
  }
}

function plainRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactFields(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function exactOptionalFields(value, allowed, required) {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.includes(field))
  );
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasLoneSurrogate(value) {
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

function fail(reason) {
  return { ok: false, reason };
}
