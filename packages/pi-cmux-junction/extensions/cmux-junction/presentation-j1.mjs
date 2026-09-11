import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { decodePresentationRequest, PRESENTATION_PROTOCOL } from './presentation-protocol.mjs';

export const MAX_PRESENTATION_J1_SOURCES = 16;
export const MAX_PRESENTATION_J1_BLOCKS = 64;
export const MAX_PRESENTATION_J1_ITEMS = 512;
export const MAX_PRESENTATION_J1_ROWS = 4_096;
export const MAX_PRESENTATION_J1_RECORDS = 4_689;
export const MAX_PRESENTATION_J1_FIELDS = 43_377;
export const MAX_PRESENTATION_J1_BYTES = 262_144;

const RECORD_SEPARATOR = '␞';
const FIELD_SEPARATOR = '␟';
const NULL = '∅';
const SOURCE_ID_PATTERN = /^[a-f0-9]{64}$/u;
const BLOCK_FIELDS = ['sourceId', 'producer', 'items'];
const VALIDATION_MESSAGE = Object.freeze({
  protocol: PRESENTATION_PROTOCOL,
  kind: 'snapshot',
  workspaceId: 'j1',
  surfaceId: 'j1',
  sessionId: 'j1',
  runtimeId: 'j1',
  pid: 1,
  processStartedAt: 0,
  connectionId: 'j1',
  sourceGeneration: null,
  revision: 0,
});

function saturated(value, maximum) {
  return Math.min(value, maximum + 1);
}

function metrics(sourceCount, blockCount, itemCount, rowCount, recordCount, fieldCount, byteCount) {
  return Object.freeze({
    sourceCount: saturated(sourceCount, MAX_PRESENTATION_J1_SOURCES),
    blockCount: saturated(blockCount, MAX_PRESENTATION_J1_BLOCKS),
    itemCount: saturated(itemCount, MAX_PRESENTATION_J1_ITEMS),
    rowCount: saturated(rowCount, MAX_PRESENTATION_J1_ROWS),
    recordCount: saturated(recordCount, MAX_PRESENTATION_J1_RECORDS),
    fieldCount: saturated(fieldCount, MAX_PRESENTATION_J1_FIELDS),
    byteCount: saturated(byteCount, MAX_PRESENTATION_J1_BYTES),
  });
}

function rejection(code, path, limit, maximum, actual, measured) {
  return Object.freeze({
    kind: 'reject',
    code,
    path,
    limit,
    maximum,
    saturatedActual: saturated(actual, maximum),
    metrics: measured,
  });
}

function capacityRejection(limit, maximum, actual, measured) {
  return rejection('capacity', '$', limit, maximum, actual, measured);
}

function plainDataRecord(value, fields) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function normalizeBlock(value, index) {
  if (!plainDataRecord(value, BLOCK_FIELDS)) {
    return { ok: false, path: `blocks[${index}]` };
  }
  if (typeof value.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(value.sourceId)) {
    return { ok: false, path: `blocks[${index}].sourceId` };
  }
  const decoded = decodePresentationRequest({
    ...VALIDATION_MESSAGE,
    views: [{ producer: value.producer, items: value.items }],
  });
  if (!decoded.ok) return { ok: false, path: `blocks[${index}]` };
  const view = decoded.value.views[0];
  if (!view) return { ok: false, path: `blocks[${index}]` };
  return {
    ok: true,
    value: Object.freeze({ sourceId: value.sourceId, producer: view.producer, items: view.items }),
  };
}

function compareBlocks(left, right) {
  return (
    (left.producer.key < right.producer.key
      ? -1
      : left.producer.key > right.producer.key
        ? 1
        : 0) || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0)
  );
}

function escapeField(value) {
  return value
    .replaceAll('%', '%25')
    .replaceAll(RECORD_SEPARATOR, '%1E')
    .replaceAll(FIELD_SEPARATOR, '%1F')
    .replaceAll(NULL, '%00');
}

function field(value) {
  return value === undefined ? NULL : escapeField(String(value));
}

function record(values) {
  return values.map(field).join(FIELD_SEPARATOR);
}

function buildPresentationJ1(input) {
  const emptyMetrics = metrics(0, 0, 0, 0, 0, 0, 0);
  try {
    if (!Array.isArray(input)) {
      return rejection('invalid-input', '$', 'input', 0, 1, emptyMetrics);
    }
    if (input.length > MAX_PRESENTATION_J1_BLOCKS) {
      const measured = metrics(0, input.length, 0, 0, 0, 0, 0);
      return capacityRejection('blocks', MAX_PRESENTATION_J1_BLOCKS, input.length, measured);
    }
    if (input.length === 0) return Object.freeze({ kind: 'clear', metrics: emptyMetrics });

    const blocks = [];
    const sourceIds = new Set();
    let itemCount = 0;
    let rowCount = 0;
    for (let index = 0; index < input.length; index += 1) {
      const normalized = normalizeBlock(input[index], index);
      if (!normalized.ok) {
        return rejection('invalid-input', normalized.path, 'input', 0, 1, emptyMetrics);
      }
      blocks.push(normalized.value);
      sourceIds.add(normalized.value.sourceId);
      itemCount += normalized.value.items.length;
      for (const item of normalized.value.items) rowCount += item.rows.length;
    }
    blocks.sort(compareBlocks);

    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1];
      const current = blocks[index];
      if (
        previous.sourceId === current.sourceId &&
        previous.producer.key === current.producer.key
      ) {
        const measured = metrics(sourceIds.size, blocks.length, itemCount, rowCount, 0, 0, 0);
        return rejection('duplicate-block', `blocks[${index}]`, 'duplicates', 0, 1, measured);
      }
    }

    const recordCount = 1 + sourceIds.size + blocks.length + itemCount + rowCount;
    const fieldCount = 1 + sourceIds.size * 3 + blocks.length * 5 + itemCount * 12 + rowCount * 9;
    let measured = metrics(
      sourceIds.size,
      blocks.length,
      itemCount,
      rowCount,
      recordCount,
      fieldCount,
      0,
    );
    const limits = [
      ['sources', sourceIds.size, MAX_PRESENTATION_J1_SOURCES],
      ['blocks', blocks.length, MAX_PRESENTATION_J1_BLOCKS],
      ['items', itemCount, MAX_PRESENTATION_J1_ITEMS],
      ['rows', rowCount, MAX_PRESENTATION_J1_ROWS],
      ['records', recordCount, MAX_PRESENTATION_J1_RECORDS],
      ['fields', fieldCount, MAX_PRESENTATION_J1_FIELDS],
    ];
    for (const [limit, actual, maximum] of limits) {
      if (actual > maximum) return capacityRejection(limit, maximum, actual, measured);
    }

    const orderedSourceIds = [...sourceIds].sort();
    const sourceRefs = new Map(
      orderedSourceIds.map((sourceId, index) => [sourceId, String(index)]),
    );
    const records = ['J1'];
    for (let index = 0; index < orderedSourceIds.length; index += 1) {
      records.push(record(['S', index, orderedSourceIds[index]]));
    }
    for (let producerRef = 0; producerRef < blocks.length; producerRef += 1) {
      const block = blocks[producerRef];
      const sourceRef = sourceRefs.get(block.sourceId);
      records.push(record(['P', sourceRef, producerRef, block.producer.key, block.producer.label]));
      for (let itemRef = 0; itemRef < block.items.length; itemRef += 1) {
        const item = block.items[itemRef];
        records.push(
          record([
            'C',
            sourceRef,
            producerRef,
            itemRef,
            item.key,
            item.title,
            item.status,
            item.summary,
            item.progress?.value,
            item.progress?.max,
            item.progress?.label,
            item.href,
          ]),
        );
        for (let rowRef = 0; rowRef < item.rows.length; rowRef += 1) {
          const row = item.rows[rowRef];
          records.push(
            record([
              'R',
              sourceRef,
              producerRef,
              itemRef,
              rowRef,
              row.label,
              row.value,
              row.detail,
              row.href,
            ]),
          );
        }
      }
    }

    const j1 = records.join(RECORD_SEPARATOR);
    const byteCount = Buffer.byteLength(j1, 'utf8');
    measured = metrics(
      sourceIds.size,
      blocks.length,
      itemCount,
      rowCount,
      recordCount,
      fieldCount,
      byteCount,
    );
    if (byteCount > MAX_PRESENTATION_J1_BYTES) {
      return capacityRejection('bytes', MAX_PRESENTATION_J1_BYTES, byteCount, measured);
    }
    return { kind: 'set', j1, metrics: measured };
  } catch {
    return rejection('invalid-input', '$', 'input', 0, 1, emptyMetrics);
  }
}

export function measurePresentationJ1(blocks) {
  const result = buildPresentationJ1(blocks);
  if (result.kind !== 'set') return result;
  return Object.freeze({
    kind: 'set',
    j1: result.j1,
    digest: createHash('sha256').update(result.j1, 'utf8').digest('hex'),
    metrics: result.metrics,
  });
}

export function presentationJ1Capacity(blocks) {
  return measurePresentationJ1(blocks);
}

export function projectPresentationJ1(blocks) {
  return measurePresentationJ1(blocks);
}
