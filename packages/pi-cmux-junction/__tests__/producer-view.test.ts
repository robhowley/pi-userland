import { describe, expect, it, vi } from 'vitest';
import {
  createProducerViewStore,
  MAX_VIEW_BYTES,
  MAX_ITEM_KEY_BYTES,
  MAX_ITEMS_PER_VIEW,
  MAX_HREF_BYTES,
  MAX_LABEL_BYTES,
  MAX_LOCAL_ITEMS,
  MAX_LOCAL_PRODUCERS,
  MAX_LOCAL_ROWS,
  MAX_PRODUCER_KEY_BYTES,
  MAX_ROW_TEXT_BYTES,
  MAX_ROWS_PER_VIEW,
  MAX_ROWS_PER_ITEM,
  MAX_SUMMARY_BYTES,
  normalizeProducerView,
  PRODUCER_VIEW_EVENT,
  type NormalizedProducerView,
  type ProducerViewErrorCode,
} from '../extensions/cmux-junction/producer-view.js';

type RawFields = Record<string, unknown>;
type ValidationCode = Exclude<ProducerViewErrorCode, 'capacity'>;

function makeRow(value = 'value', fields: RawFields = {}): RawFields {
  return { value, ...fields };
}

function makeItem(key = 'item', fields: RawFields = {}): RawFields {
  return { key, title: `Title ${key}`, ...fields };
}

function makeView(
  producerKey = 'producer',
  items: readonly unknown[] = [],
  fields: RawFields = {},
): RawFields {
  return {
    producer: { key: producerKey, label: `Producer ${producerKey}` },
    items,
    ...fields,
  };
}

function fullView(): RawFields {
  return makeView(
    'agent:1',
    [
      makeItem('item/1', {
        title: '  Title  ',
        status: ' status ',
        summary: '  Summary  ',
        progress: { label: ' Progress ', value: -0, max: 100 },
        rows: [
          makeRow('  row value  ', {
            label: ' row label ',
            detail: ' row detail ',
            href: 'https://example.test/row?q=1#fragment',
          }),
        ],
        href: 'https://example.test/item?q=1#fragment',
      }),
    ],
    { producer: { key: 'agent:1', label: '  Producer  ' } },
  );
}

function ascii(bytes: number): string {
  return 'x'.repeat(bytes);
}

function httpsUrlAtBytes(bytes: number): string {
  const prefix = 'https://example.test/?q=';
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  if (bytes < prefixBytes) throw new Error(`cannot make an HTTPS URL of ${bytes} bytes`);
  return `${prefix}${'x'.repeat(bytes - prefixBytes)}`;
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('expected JSON text');
  return Buffer.byteLength(json, 'utf8');
}

function valid(value: unknown): NormalizedProducerView {
  const result = normalizeProducerView(value);
  if (!result.ok) {
    throw new Error(`expected a valid view, got ${result.code} at ${result.path ?? '$'}`);
  }
  return result.value;
}

function invalid(value: unknown, code: ValidationCode, path?: string): void {
  const result = normalizeProducerView(value);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.path).toBe(path);
}

function expectDeepFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) expectDeepFrozen(child);
  }
}

function without(record: RawFields, field: string): RawFields {
  const copy = { ...record };
  delete copy[field];
  return copy;
}

function nullPrototypeView(): RawFields {
  const row = Object.assign(Object.create(null), { value: 'value' });
  const item = Object.assign(Object.create(null), {
    key: 'item',
    title: 'Item',
    rows: [row],
  });
  const producer = Object.assign(Object.create(null), { key: 'producer', label: 'Producer' });
  return Object.assign(Object.create(null), { producer, items: [item] });
}

function itemsOf(count: number, rowsPerItem = 0): RawFields[] {
  return Array.from({ length: count }, (_, index) =>
    makeItem(
      `item-${index}`,
      rowsPerItem > 0
        ? {
            rows: Array.from({ length: rowsPerItem }, () => makeRow('v')),
          }
        : {},
    ),
  );
}

function viewWithRowCount(producerKey: string, count: number, fields: RawFields = {}): RawFields {
  const items: RawFields[] = [];
  let remaining = count;
  while (remaining > 0) {
    const rows = Math.min(MAX_ROWS_PER_ITEM, remaining);
    items.push(makeItem(`item-${items.length}`, { rows: itemsOfRows(rows) }));
    remaining -= rows;
  }
  return makeView(producerKey, items, fields);
}

function itemsOfRows(count: number): RawFields[] {
  return Array.from({ length: count }, () => makeRow('v'));
}

function aggregateCounts(snapshot: readonly NormalizedProducerView[]): {
  producers: number;
  items: number;
  rows: number;
} {
  let items = 0;
  let rows = 0;
  for (const view of snapshot) {
    items += view.items.length;
    for (const item of view.items) rows += item.rows.length;
  }
  return { producers: snapshot.length, items, rows };
}

function viewAtByteSize(target: number): RawFields {
  const fullRow = () =>
    makeRow('v'.repeat(MAX_ROW_TEXT_BYTES), {
      detail: 'd'.repeat(MAX_ROW_TEXT_BYTES),
    });
  for (let variableLength = 1; variableLength <= MAX_ROW_TEXT_BYTES; variableLength += 1) {
    const rows = [
      ...Array.from({ length: 14 }, fullRow),
      makeRow('v'.repeat(MAX_ROW_TEXT_BYTES), { detail: 'd'.repeat(variableLength) }),
      makeRow('v'.repeat(MAX_ROW_TEXT_BYTES), { detail: 'd' }),
    ];
    const candidate = makeView('p', [makeItem('c', { rows })]);
    if (jsonBytes(candidate) === target) return candidate;
  }
  throw new Error(`could not construct a ${target}-byte view fixture`);
}

const stringBoundaryCases: Array<{
  name: string;
  limit: number;
  valueAt: (bytes: number) => string;
  build: (value: string) => unknown;
  path: string;
}> = [
  {
    name: 'producer label',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) => makeView('p', [], { producer: { key: 'p', label: value } }),
    path: 'producer.label',
  },
  {
    name: 'item title',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) => makeView('p', [makeItem('c', { title: value })]),
    path: 'items[0].title',
  },
  {
    name: 'item status',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) => makeView('p', [makeItem('c', { status: value })]),
    path: 'items[0].status',
  },
  {
    name: 'item summary',
    limit: MAX_SUMMARY_BYTES,
    valueAt: ascii,
    build: (value) => makeView('p', [makeItem('c', { summary: value })]),
    path: 'items[0].summary',
  },
  {
    name: 'progress label',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) =>
      makeView('p', [makeItem('c', { progress: { label: value, value: 0, max: 1 } })]),
    path: 'items[0].progress.label',
  },
  {
    name: 'row label',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) => makeView('p', [makeItem('c', { rows: [makeRow('v', { label: value })] })]),
    path: 'items[0].rows[0].label',
  },
  {
    name: 'row value',
    limit: MAX_ROW_TEXT_BYTES,
    valueAt: ascii,
    build: (value) => makeView('p', [makeItem('c', { rows: [makeRow(value)] })]),
    path: 'items[0].rows[0].value',
  },
  {
    name: 'row detail',
    limit: MAX_ROW_TEXT_BYTES,
    valueAt: ascii,
    build: (value) => makeView('p', [makeItem('c', { rows: [makeRow('v', { detail: value })] })]),
    path: 'items[0].rows[0].detail',
  },
  {
    name: 'item href',
    limit: MAX_HREF_BYTES,
    valueAt: httpsUrlAtBytes,
    build: (value) => makeView('p', [makeItem('c', { href: value })]),
    path: 'items[0].href',
  },
  {
    name: 'row href',
    limit: MAX_HREF_BYTES,
    valueAt: httpsUrlAtBytes,
    build: (value) => makeView('p', [makeItem('c', { rows: [makeRow('v', { href: value })] })]),
    path: 'items[0].rows[0].href',
  },
];

const identifierBoundaryCases = [
  {
    name: 'producer key',
    limit: MAX_PRODUCER_KEY_BYTES,
    build: (value: string) => makeView(value),
    path: 'producer.key',
  },
  {
    name: 'item key',
    limit: MAX_ITEM_KEY_BYTES,
    build: (value: string) => makeView('p', [makeItem(value)]),
    path: 'items[0].key',
  },
];

const requiredFieldCases: Array<{
  name: string;
  path: string;
  build: () => unknown;
}> = [
  { name: 'view producer', path: 'producer', build: () => without(makeView(), 'producer') },
  { name: 'view items', path: 'items', build: () => without(makeView(), 'items') },
  {
    name: 'producer key',
    path: 'producer.key',
    build: () => makeView('p', [], { producer: without({ key: 'p', label: 'P' }, 'key') }),
  },
  {
    name: 'producer label',
    path: 'producer.label',
    build: () => makeView('p', [], { producer: without({ key: 'p', label: 'P' }, 'label') }),
  },
  {
    name: 'item key',
    path: 'items[0].key',
    build: () => makeView('p', [without(makeItem('c'), 'key')]),
  },
  {
    name: 'item title',
    path: 'items[0].title',
    build: () => makeView('p', [without(makeItem('c'), 'title')]),
  },
  {
    name: 'progress label',
    path: 'items[0].progress.label',
    build: () =>
      makeView('p', [
        makeItem('c', { progress: without({ label: 'P', value: 0, max: 1 }, 'label') }),
      ]),
  },
  {
    name: 'progress value',
    path: 'items[0].progress.value',
    build: () =>
      makeView('p', [
        makeItem('c', { progress: without({ label: 'P', value: 0, max: 1 }, 'value') }),
      ]),
  },
  {
    name: 'progress max',
    path: 'items[0].progress.max',
    build: () =>
      makeView('p', [
        makeItem('c', { progress: without({ label: 'P', value: 0, max: 1 }, 'max') }),
      ]),
  },
  {
    name: 'row value',
    path: 'items[0].rows[0].value',
    build: () => makeView('p', [makeItem('c', { rows: [without(makeRow('v'), 'value')] })]),
  },
];

const optionalTextCases: Array<{
  name: string;
  path: string;
  build: (value: unknown) => unknown;
}> = [
  {
    name: 'status',
    path: 'items[0].status',
    build: (value) => makeView('p', [makeItem('c', { status: value })]),
  },
  {
    name: 'summary',
    path: 'items[0].summary',
    build: (value) => makeView('p', [makeItem('c', { summary: value })]),
  },
  {
    name: 'item href',
    path: 'items[0].href',
    build: (value) => makeView('p', [makeItem('c', { href: value })]),
  },
  {
    name: 'row label',
    path: 'items[0].rows[0].label',
    build: (value) => makeView('p', [makeItem('c', { rows: [makeRow('v', { label: value })] })]),
  },
  {
    name: 'row detail',
    path: 'items[0].rows[0].detail',
    build: (value) => makeView('p', [makeItem('c', { rows: [makeRow('v', { detail: value })] })]),
  },
  {
    name: 'row href',
    path: 'items[0].rows[0].href',
    build: (value) => makeView('p', [makeItem('c', { rows: [makeRow('v', { href: value })] })]),
  },
];

const requiredTypeCases: Array<{
  name: string;
  path: string;
  build: (value: unknown) => unknown;
}> = [
  {
    name: 'producer key',
    path: 'producer.key',
    build: (value) => makeView('p', [], { producer: { key: value, label: 'P' } }),
  },
  {
    name: 'producer label',
    path: 'producer.label',
    build: (value) => makeView('p', [], { producer: { key: 'p', label: value } }),
  },
  {
    name: 'item key',
    path: 'items[0].key',
    build: (value) => makeView('p', [{ key: value, title: 'C' }]),
  },
  {
    name: 'item title',
    path: 'items[0].title',
    build: (value) => makeView('p', [{ key: 'c', title: value }]),
  },
  {
    name: 'progress label',
    path: 'items[0].progress.label',
    build: (value) =>
      makeView('p', [makeItem('c', { progress: { label: value, value: 0, max: 1 } })]),
  },
  {
    name: 'progress value',
    path: 'items[0].progress.value',
    build: (value) => makeView('p', [makeItem('c', { progress: { label: 'P', value, max: 1 } })]),
  },
  {
    name: 'progress max',
    path: 'items[0].progress.max',
    build: (value) =>
      makeView('p', [makeItem('c', { progress: { label: 'P', value: 0, max: value } })]),
  },
  {
    name: 'row value',
    path: 'items[0].rows[0].value',
    build: (value) => makeView('p', [makeItem('c', { rows: [{ value }] })]),
  },
];

const unknownFieldCases: Array<{ name: string; path: string; value: unknown }> = [
  { name: 'view', path: '$', value: makeView('p', [], { extra: true }) },
  {
    name: 'producer',
    path: 'producer',
    value: makeView('p', [], { producer: { key: 'p', label: 'P', extra: true } }),
  },
  {
    name: 'item',
    path: 'items[0]',
    value: makeView('p', [makeItem('c', { extra: true })]),
  },
  {
    name: 'progress',
    path: 'items[0].progress',
    value: makeView('p', [
      makeItem('c', { progress: { label: 'P', value: 0, max: 1, extra: true } }),
    ]),
  },
  {
    name: 'row',
    path: 'items[0].rows[0]',
    value: makeView('p', [makeItem('c', { rows: [makeRow('v', { extra: true })] })]),
  },
];

describe('producer view source contract', () => {
  describe('normalization', () => {
    it('exports the event name and every Phase 1 limit', () => {
      expect(PRODUCER_VIEW_EVENT).toBe('pi-cmux-junction:update');
      expect({
        MAX_PRODUCER_KEY_BYTES,
        MAX_ITEM_KEY_BYTES,
        MAX_LABEL_BYTES,
        MAX_SUMMARY_BYTES,
        MAX_ROW_TEXT_BYTES,
        MAX_HREF_BYTES,
        MAX_ITEMS_PER_VIEW,
        MAX_ROWS_PER_ITEM,
        MAX_ROWS_PER_VIEW,
        MAX_VIEW_BYTES,
        MAX_LOCAL_PRODUCERS,
        MAX_LOCAL_ITEMS,
        MAX_LOCAL_ROWS,
      }).toEqual({
        MAX_PRODUCER_KEY_BYTES: 64,
        MAX_ITEM_KEY_BYTES: 64,
        MAX_LABEL_BYTES: 128,
        MAX_SUMMARY_BYTES: 512,
        MAX_ROW_TEXT_BYTES: 256,
        MAX_HREF_BYTES: 2_048,
        MAX_ITEMS_PER_VIEW: 32,
        MAX_ROWS_PER_ITEM: 16,
        MAX_ROWS_PER_VIEW: 256,
        MAX_VIEW_BYTES: 8_192,
        MAX_LOCAL_PRODUCERS: 64,
        MAX_LOCAL_ITEMS: 512,
        MAX_LOCAL_ROWS: 4_096,
      });
      expect(MAX_LOCAL_PRODUCERS * MAX_VIEW_BYTES).toBe(524_288);
    });

    it('accepts the minimal shape and fills omitted rows with a frozen array', () => {
      const minimal = valid(makeView('p'));
      expect(minimal).toEqual({
        producer: { key: 'p', label: 'Producer p' },
        items: [],
      });
      expectDeepFrozen(minimal);

      const item = valid(makeView('p', [makeItem('c')])).items[0];
      expect(item?.rows).toEqual([]);
      expect(Object.isFrozen(item?.rows)).toBe(true);
    });

    it('accepts every optional field, preserves literals and order, and converts only -0', () => {
      const normalized = valid(fullView());
      expect(normalized).toEqual({
        producer: { key: 'agent:1', label: '  Producer  ' },
        items: [
          {
            key: 'item/1',
            title: '  Title  ',
            status: ' status ',
            summary: '  Summary  ',
            progress: { label: ' Progress ', value: 0, max: 100 },
            rows: [
              {
                label: ' row label ',
                value: '  row value  ',
                detail: ' row detail ',
                href: 'https://example.test/row?q=1#fragment',
              },
            ],
            href: 'https://example.test/item?q=1#fragment',
          },
        ],
      });
      expect(Object.is(normalized.items[0]?.progress?.value, 0)).toBe(true);
      expect(Object.keys(normalized)).toEqual(['producer', 'items']);
      expect(Object.keys(normalized.producer)).toEqual(['key', 'label']);
      expect(Object.keys(normalized.items[0] ?? {})).toEqual([
        'key',
        'title',
        'status',
        'summary',
        'progress',
        'rows',
        'href',
      ]);
      expect(Object.keys(normalized.items[0]?.progress ?? {})).toEqual(['label', 'value', 'max']);
      expect(Object.keys(normalized.items[0]?.rows[0] ?? {})).toEqual([
        'label',
        'value',
        'detail',
        'href',
      ]);
      expectDeepFrozen(normalized);
    });

    it('accepts null-prototype records, frozen arrays, and frozen data descriptors', () => {
      expect(valid(nullPrototypeView()).producer).toEqual({ key: 'producer', label: 'Producer' });

      const frozenRows = Object.freeze([makeRow()]);
      const frozenItems = Object.freeze([makeItem('c', { rows: frozenRows })]);
      const frozenView = Object.freeze(makeView('p', frozenItems));
      expect(valid(frozenView).items).toHaveLength(1);
    });

    it('copies inbound values before returning normalized output', () => {
      const input = fullView();
      const normalized = valid(input);
      const producer = input['producer'] as RawFields;
      const items = input['items'] as RawFields[];
      const inputItem = items[0] as RawFields;
      const rows = inputItem['rows'] as RawFields[];
      const inputRow = rows[0] as RawFields;

      producer['label'] = 'mutated';
      inputItem['title'] = 'mutated';
      inputRow['value'] = 'mutated';
      items.length = 0;

      expect(normalized.producer.label).toBe('  Producer  ');
      expect(normalized.items[0]?.title).toBe('  Title  ');
      expect(normalized.items[0]?.rows[0]?.value).toBe('  row value  ');
      expect(normalized.producer).not.toBe(producer);
      expect(normalized.items).not.toBe(items);
      expect(normalized.items[0]?.rows[0]).not.toBe(inputRow);
      expectDeepFrozen(normalized);
    });

    it.each(stringBoundaryCases)(
      'accepts $name at its exact UTF-8 byte limit',
      ({ limit, valueAt, build }) => {
        const value = valueAt(limit);
        expect(Buffer.byteLength(value, 'utf8')).toBe(limit);
        expect(valid(build(value))).toBeDefined();
      },
    );

    it.each(stringBoundaryCases)(
      'rejects $name one byte over its limit',
      ({ limit, valueAt, build, path }) => {
        invalid(
          build(valueAt(limit + 1)),
          path.endsWith('.href') ? 'invalid-url' : 'invalid-string',
          path,
        );
      },
    );

    it.each(identifierBoundaryCases)('accepts $name at 64 bytes', ({ limit, build }) => {
      expect(valid(build(ascii(limit)))).toBeDefined();
    });

    it.each(identifierBoundaryCases)(
      'rejects $name one byte over 64 bytes',
      ({ limit, build, path }) => {
        invalid(build(ascii(limit + 1)), 'invalid-identifier', path);
      },
    );

    it.each(['', ' leading', '-leading', 'p?', 'p\u200b', 'é'])(
      'rejects malformed producer key %j',
      (key) => invalid(makeView(key), 'invalid-identifier', 'producer.key'),
    );

    it.each(requiredFieldCases)('rejects missing $name as required-field', ({ build, path }) => {
      invalid(build(), 'required-field', path);
    });

    it.each(requiredTypeCases)(
      'rejects null and undefined for required $name',
      ({ build, path }) => {
        invalid(build(undefined), 'invalid-type', path);
        invalid(build(null), 'invalid-type', path);
      },
    );

    it.each(optionalTextCases)('rejects null/undefined/blank optional $name', ({ build, path }) => {
      invalid(build(undefined), 'invalid-type', path);
      invalid(build(null), 'invalid-type', path);
      for (const blank of ['', ' \t', '\u00a0']) {
        invalid(build(blank), path.endsWith('.href') ? 'invalid-url' : 'invalid-string', path);
      }
    });

    it('rejects present undefined/null for optional progress and rows', () => {
      invalid(
        makeView('p', [makeItem('c', { progress: undefined })]),
        'invalid-type',
        'items[0].progress',
      );
      invalid(
        makeView('p', [makeItem('c', { progress: null })]),
        'invalid-type',
        'items[0].progress',
      );
      invalid(makeView('p', [makeItem('c', { rows: undefined })]), 'invalid-type', 'items[0].rows');
      invalid(makeView('p', [makeItem('c', { rows: null })]), 'invalid-type', 'items[0].rows');
    });

    it.each(unknownFieldCases)(
      'reports unknown $name fields at the containing path',
      ({ value, path }) => {
        invalid(value, 'unknown-field', path);
      },
    );

    it('rejects wrong root and nested categories with invalid-type', () => {
      for (const value of [null, 1, true, 'view', Symbol('view'), 1n, [], () => undefined]) {
        invalid(value, 'invalid-type', '$');
      }
      invalid(makeView('p', [], { producer: [] }), 'invalid-type', 'producer');
      invalid(makeView('p', {} as unknown as unknown[]), 'invalid-type', 'items');
      invalid(
        makeView('p', [makeItem('c', { progress: [] })]),
        'invalid-type',
        'items[0].progress',
      );
      invalid(makeView('p', [makeItem('c', { rows: {} })]), 'invalid-type', 'items[0].rows');
      invalid(makeView('p', [makeItem('c', { rows: [null] })]), 'invalid-type', 'items[0].rows[0]');
    });

    it('rejects non-plain record prototypes and keeps allowed frozen data descriptors valid', () => {
      class ViewLike {
        producer = { key: 'p', label: 'P' };
        items: unknown[] = [];
      }
      for (const value of [new Date(), new Map(), new Set(), new ViewLike(), Object.create({})]) {
        invalid(value, 'invalid-record', '$');
      }

      const frozen = Object.freeze(makeView());
      expect(valid(frozen)).toEqual({
        producer: { key: 'producer', label: 'Producer producer' },
        items: [],
      });
    });

    it('rejects symbols, non-enumerable fields, and accessors without invoking accessors', () => {
      const root = makeView();
      Object.defineProperty(root, 'extra', { value: true, enumerable: false });
      invalid(root, 'invalid-record', '$');

      const symbolRoot = makeView();
      Object.defineProperty(symbolRoot, Symbol('secret'), { value: true, enumerable: true });
      invalid(symbolRoot, 'invalid-record', '$');

      const producer = { key: 'p', label: 'P' };
      let accessed = false;
      Object.defineProperty(producer, 'label', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessed = true;
          throw new Error('secret getter');
        },
      });
      invalid(makeView('p', [], { producer }), 'invalid-record', 'producer');
      expect(accessed).toBe(false);

      const nonEnumerableProducer = { key: 'p', label: 'P' };
      Object.defineProperty(nonEnumerableProducer, 'label', {
        configurable: true,
        enumerable: false,
        value: 'P',
        writable: true,
      });
      invalid(makeView('p', [], { producer: nonEnumerableProducer }), 'invalid-record', 'producer');
    });

    it('accepts ordinary frozen arrays but rejects prototype, key, descriptor, and hole hazards', () => {
      const frozen = Object.freeze([makeItem('c')]);
      expect(valid(makeView('p', frozen))).toBeDefined();

      const wrongPrototype = [makeItem('c')];
      Object.setPrototypeOf(wrongPrototype, {});
      invalid(makeView('p', wrongPrototype), 'invalid-record', 'items');

      const customProperty = [makeItem('c')];
      Object.defineProperty(customProperty, 'extra', { enumerable: true, value: true });
      invalid(makeView('p', customProperty), 'invalid-record', 'items');

      const symbolProperty = [makeItem('c')];
      Object.defineProperty(symbolProperty, Symbol('extra'), { enumerable: true, value: true });
      invalid(makeView('p', symbolProperty), 'invalid-record', 'items');

      const nonEnumerableIndex = [makeItem('c')];
      Object.defineProperty(nonEnumerableIndex, '0', {
        configurable: true,
        enumerable: false,
        value: nonEnumerableIndex[0],
        writable: true,
      });
      invalid(
        makeView('p', [makeItem('c', { rows: nonEnumerableIndex })]),
        'invalid-record',
        'items[0].rows',
      );

      const accessorIndex = [makeRow('v')];
      let accessed = false;
      Object.defineProperty(accessorIndex, '0', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessed = true;
          throw new Error('secret row getter');
        },
      });
      invalid(
        makeView('p', [makeItem('c', { rows: accessorIndex })]),
        'invalid-record',
        'items[0].rows',
      );
      expect(accessed).toBe(false);

      invalid(
        makeView('p', [makeItem('c', { rows: new Array(1) })]),
        'invalid-record',
        'items[0].rows',
      );
    });

    it.each([
      {
        name: 'root ownKeys',
        value: () =>
          new Proxy(makeView(), {
            ownKeys: () => {
              throw new Error('secret ownKeys');
            },
          }),
        path: '$',
      },
      {
        name: 'root prototype',
        value: () =>
          new Proxy(makeView(), {
            getPrototypeOf: () => {
              throw new Error('secret proto');
            },
          }),
        path: '$',
      },
      {
        name: 'root descriptor',
        value: () =>
          new Proxy(makeView(), {
            getOwnPropertyDescriptor: () => {
              throw new Error('secret descriptor');
            },
          }),
        path: '$',
      },
      {
        name: 'nested array ownKeys',
        value: () =>
          makeView(
            'p',
            new Proxy([makeItem('c')], {
              ownKeys: () => {
                throw new Error('secret array');
              },
            }),
          ),
        path: 'items',
      },
      {
        name: 'nested array descriptor',
        value: () =>
          makeView(
            'p',
            new Proxy([makeItem('c')], {
              getOwnPropertyDescriptor: () => {
                throw new Error('secret array descriptor');
              },
            }),
          ),
        path: 'items',
      },
    ])('turns $name reflection failures into invalid-record', ({ value, path }) => {
      invalid(value(), 'invalid-record', path);
    });

    it.each([
      {
        name: 'items',
        length: MAX_ITEMS_PER_VIEW + 1,
        build: (items: unknown[]) => makeView('p', items),
        path: 'items',
      },
      {
        name: 'rows',
        length: MAX_ROWS_PER_ITEM + 1,
        build: (items: unknown[]) => makeView('p', [makeItem('c', { rows: items })]),
        path: 'items[0].rows',
      },
    ])('checks the $name length before traversing hostile elements', ({ length, build, path }) => {
      const items = new Array<unknown>(length);
      let accessed = false;
      Object.defineProperty(items, '0', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessed = true;
          throw new Error('secret oversized element');
        },
      });
      invalid(build(items), 'view-limit', path);
      expect(accessed).toBe(false);
    });

    it.each([
      { name: 'NUL', value: '\u0000' },
      { name: 'unit separator', value: '\u001f' },
      { name: 'delete', value: '\u007f' },
      { name: 'C1 NEL', value: '\u0085' },
      { name: 'C1 control', value: '\u009f' },
    ])('rejects $name controls in preserved text', ({ value }) => {
      invalid(
        makeView('p', [], { producer: { key: 'p', label: `ok${value}ok` } }),
        'invalid-string',
        'producer.label',
      );
    });

    it.each(['\u00a0', '\ufeff'])('treats %j as ECMAScript-trim blank text', (value) => {
      invalid(
        makeView('p', [], { producer: { key: 'p', label: value } }),
        'invalid-string',
        'producer.label',
      );
    });

    it('accepts U+200B and valid surrogate pairs while rejecting lone surrogates', () => {
      const zeroWidth = valid(makeView('p', [], { producer: { key: 'p', label: '\u200b' } }));
      expect(zeroWidth.producer.label).toBe('\u200b');
      const pair = valid(makeView('p', [], { producer: { key: 'p', label: 'before😀after' } }));
      expect(pair.producer.label).toBe('before😀after');
      invalid(
        makeView('p', [], { producer: { key: 'p', label: '\ud800' } }),
        'invalid-string',
        'producer.label',
      );
      invalid(
        makeView('p', [], { producer: { key: 'p', label: '\udfff' } }),
        'invalid-string',
        'producer.label',
      );

      const emojiExact = '😀'.repeat(MAX_LABEL_BYTES / 4);
      expect(Buffer.byteLength(emojiExact, 'utf8')).toBe(MAX_LABEL_BYTES);
      expect(valid(makeView('p', [], { producer: { key: 'p', label: emojiExact } }))).toBeDefined();
    });

    it.each([
      'http://example.test/path',
      'ftp://example.test/path',
      '/relative/path',
      'example.test/path',
      'https://?missing-host',
      'https://user:password@example.test/path',
      'https://example.test:bad/path',
      'https://example.test/a b',
      'https://example.test/a\u00a0b',
      'https://',
    ])('rejects non-HTTPS or malformed href %j', (href) => {
      invalid(makeView('p', [makeItem('c', { href })]), 'invalid-url', 'items[0].href');
    });

    it.each([
      'https://example.test/',
      'https://example.test/path?query=1#fragment',
      'https://example.test:8443/path',
      'https://example.test/path%20with%20escapes',
    ])('accepts parser-valid HTTPS href %j literally', (href) => {
      const normalized = valid(makeView('p', [makeItem('c', { href })]));
      expect(normalized.items[0]?.href).toBe(href);
    });

    it('uses URL whitespace rules without treating U+200B as URL whitespace', () => {
      invalid(
        makeView('p', [makeItem('c', { href: 'https://example.test/\ufeff' })]),
        'invalid-url',
        'items[0].href',
      );
      const normalized = valid(
        makeView('p', [makeItem('c', { href: 'https://example.test/\u200b' })]),
      );
      expect(normalized.items[0]?.href).toBe('https://example.test/\u200b');
    });

    it('accepts progress endpoints and safe integers, but never clamps invalid values', () => {
      for (const [value, max] of [
        [0, 1],
        [1, 1],
        [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        [-0, 1],
      ] as const) {
        expect(
          valid(makeView('p', [makeItem('c', { progress: { label: 'P', value, max } })])),
        ).toBeDefined();
      }
      expect(
        Object.is(
          valid(makeView('p', [makeItem('c', { progress: { label: 'P', value: -0, max: 1 } })]))
            .items[0]?.progress?.value,
          0,
        ),
      ).toBe(true);
    });

    it.each([
      { name: 'fractional value', value: 0.5, max: 1, path: 'items[0].progress.value' },
      { name: 'NaN value', value: Number.NaN, max: 1, path: 'items[0].progress.value' },
      {
        name: 'infinite value',
        value: Number.POSITIVE_INFINITY,
        max: 1,
        path: 'items[0].progress.value',
      },
      { name: 'negative value', value: -1, max: 1, path: 'items[0].progress.value' },
      {
        name: 'unsafe value',
        value: Number.MAX_SAFE_INTEGER + 1,
        max: Number.MAX_SAFE_INTEGER + 1,
        path: 'items[0].progress.value',
      },
      { name: 'zero max', value: 0, max: 0, path: 'items[0].progress.max' },
      { name: 'fractional max', value: 0, max: 0.5, path: 'items[0].progress.max' },
      { name: 'NaN max', value: 0, max: Number.NaN, path: 'items[0].progress.max' },
      {
        name: 'infinite max',
        value: 0,
        max: Number.POSITIVE_INFINITY,
        path: 'items[0].progress.max',
      },
      { name: 'negative max', value: 0, max: -1, path: 'items[0].progress.max' },
      {
        name: 'unsafe max',
        value: 0,
        max: Number.MAX_SAFE_INTEGER + 1,
        path: 'items[0].progress.max',
      },
      { name: 'value above max', value: 2, max: 1, path: 'items[0].progress.value' },
    ])('rejects $name without clamping', ({ value, max, path }) => {
      invalid(
        makeView('p', [makeItem('c', { progress: { label: 'P', value, max } })]),
        'invalid-number',
        path,
      );
    });

    it('rejects duplicate item keys but allows repeated row labels', () => {
      invalid(makeView('p', [makeItem('same'), makeItem('same')]), 'duplicate-key', 'items[1].key');
      const normalized = valid(
        makeView('p', [
          makeItem('a', {
            rows: [makeRow('one', { label: 'same' }), makeRow('two', { label: 'same' })],
          }),
        ]),
      );
      expect(normalized.items[0]?.rows.map((row) => row.label)).toEqual(['same', 'same']);
    });

    it('enforces exact item and row counts before accepting one-over fixtures', () => {
      expect(valid(makeView('p', itemsOf(MAX_ITEMS_PER_VIEW)))).toBeDefined();
      invalid(makeView('p', itemsOf(MAX_ITEMS_PER_VIEW + 1)), 'view-limit', 'items');

      expect(valid(makeView('p', itemsOf(1, MAX_ROWS_PER_ITEM)))).toBeDefined();
      invalid(makeView('p', itemsOf(1, MAX_ROWS_PER_ITEM + 1)), 'view-limit', 'items[0].rows');

      const exactRows = viewWithRowCount('p', MAX_ROWS_PER_VIEW);
      expect(jsonBytes(exactRows)).toBeLessThan(MAX_VIEW_BYTES);
      expect(valid(exactRows)).toBeDefined();
      invalid(viewWithRowCount('p', MAX_ROWS_PER_VIEW + 1), 'view-limit', 'items');
    });

    it('accepts exact 8 KiB and rejects one byte over the normalized view budget', () => {
      expect(MAX_VIEW_BYTES).toBe(8_192);
      const exact = viewAtByteSize(8_192);
      const over = viewAtByteSize(8_193);
      expect(jsonBytes(exact)).toBe(8_192);
      expect(jsonBytes(over)).toBe(8_193);
      expect(jsonBytes(valid(exact))).toBe(8_192);
      invalid(over, 'view-limit', '$');
    });

    it('documents that minimal exact total-row fixtures fit below the view ceiling', () => {
      const exactView = viewWithRowCount('p', 256);
      expect(jsonBytes(exactView)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
      expect(valid(exactView).items.reduce((total, item) => total + item.rows.length, 0)).toBe(256);

      // Four items × sixteen minimal rows per view reaches 4,096 rows without relying on
      // optional text. Keep this fixture small enough for each view's independent 8 KiB limit.
      const localView = viewWithRowCount('p', 64);
      expect(jsonBytes(localView)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
      expect(valid(localView).items.reduce((total, item) => total + item.rows.length, 0)).toBe(64);
    });

    it('documents JavaScript duplicate-property behavior rather than inventing a duplicate case', () => {
      const input = JSON.parse(
        '{"producer":{"key":"p","label":"first","label":"last"},"items":[]}',
      ) as RawFields;
      expect(Object.keys(input['producer'] as RawFields)).toEqual(['key', 'label']);
      expect(valid(input).producer.label).toBe('last');
    });
  });

  describe('store', () => {
    it('creates one isolated store per factory call', () => {
      const first = createProducerViewStore();
      const second = createProducerViewStore();

      expect(first.accept(makeView('p', [makeItem('c')]))).toEqual({
        accepted: true,
        action: 'replaced',
      });
      expect(second.snapshot()).toEqual([]);
    });

    it('replaces same-key views, withdraws existing keys, and reports no-op actions', () => {
      const store = createProducerViewStore();
      const listener = vi.fn();
      store.subscribe(listener);

      expect(store.accept(makeView('missing'))).toEqual({ accepted: true, action: 'none' });
      expect(listener).not.toHaveBeenCalled();

      const first = makeView('p', [makeItem('old', { summary: 'old' })]);
      expect(store.accept(first)).toEqual({ accepted: true, action: 'replaced' });
      expect(store.accept(makeView('p', [makeItem('old', { summary: 'old' })]))).toEqual({
        accepted: true,
        action: 'none',
      });

      const replacement = makeView('p', [makeItem('new', { rows: [makeRow('new')] })]);
      expect(store.accept(replacement)).toEqual({ accepted: true, action: 'replaced' });
      expect(store.snapshot()).toEqual([valid(replacement)]);

      expect(store.accept(makeView('p'))).toEqual({ accepted: true, action: 'withdrawn' });
      expect(store.snapshot()).toEqual([]);
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it('orders producers by exact ASCII key and preserves item and row input order', () => {
      const store = createProducerViewStore();
      const values = [
        ['b', ['z', 'a']],
        ['A', ['a']],
        ['a', ['z']],
        ['aa', ['m']],
        ['B', ['b']],
      ] as const;
      for (const [producerKey, itemKeys] of values) {
        expect(
          store.accept(
            makeView(
              producerKey,
              itemKeys.map((key) =>
                makeItem(key, { rows: [makeRow(`${key}-1`), makeRow(`${key}-2`)] }),
              ),
            ),
          ),
        ).toEqual({ accepted: true, action: 'replaced' });
      }

      expect(store.snapshot().map((entry) => entry.producer.key)).toEqual([
        'A',
        'B',
        'a',
        'aa',
        'b',
      ]);
      expect(store.snapshot()[4]?.items.map((item) => item.key)).toEqual(['z', 'a']);
      expect(store.snapshot()[4]?.items[0]?.rows.map((row) => row.value)).toEqual(['z-1', 'z-2']);
    });

    it('keeps invalid updates and failed view limits atomically invisible', () => {
      const store = createProducerViewStore();
      const listener = vi.fn();
      store.subscribe(listener);
      const original = makeView('p', [makeItem('c', { summary: 'original' })]);
      expect(store.accept(original)).toEqual({ accepted: true, action: 'replaced' });
      const before = store.snapshot();

      expect(store.accept(makeView('p', [makeItem('c', { summary: '\u0000secret' })]))).toEqual({
        accepted: false,
        code: 'invalid-string',
        path: 'items[0].summary',
      });
      expect(store.snapshot()).toEqual(before);

      expect(store.accept(makeView('p', itemsOf(MAX_ITEMS_PER_VIEW + 1)))).toEqual({
        accepted: false,
        code: 'view-limit',
        path: 'items',
      });
      expect(store.snapshot()).toEqual(before);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('returns fresh frozen snapshot arrays while reusing stored frozen view graphs', () => {
      const store = createProducerViewStore();
      const input = fullView();
      expect(store.accept(input)).toEqual({ accepted: true, action: 'replaced' });
      const first = store.snapshot();
      const second = store.snapshot();
      expect(first).not.toBe(second);
      expect(first[0]).toBe(second[0]);
      expect(first[0]?.producer).toBe(second[0]?.producer);
      expect(first[0]?.items).toBe(second[0]?.items);
      expect(first[0]?.items[0]?.rows).toBe(second[0]?.items[0]?.rows);
      expectDeepFrozen(first);
      expectDeepFrozen(second);

      const producer = input['producer'] as RawFields;
      const items = input['items'] as RawFields[];
      producer['label'] = 'changed after accept';
      items.length = 0;
      expect(store.snapshot()).toEqual(first);

      const views: Array<readonly NormalizedProducerView[]> = [];
      store.subscribe((snapshot) => views.push(snapshot));
      store.subscribe((snapshot) => views.push(snapshot));
      expect(store.accept(makeView('q', [makeItem('q-item')]))).toEqual({
        accepted: true,
        action: 'replaced',
      });
      expect(views).toHaveLength(2);
      expect(views[0]).toBe(views[1]);
      expect(views[0]).not.toBe(first);
      expect(views[0]?.[0]).toBe(first[0]);
      expect(views[0]?.[1]).toBeDefined();
      expectDeepFrozen(views[0]);

      const afterCommit = store.snapshot();
      expect(afterCommit).not.toBe(views[0]);
      expect(afterCommit[0]).toBe(views[0]?.[0]);
      expect(afterCommit[1]).toBe(views[0]?.[1]);

      expect(store.accept(makeView('r', [makeItem('r-item')]))).toEqual({
        accepted: true,
        action: 'replaced',
      });
      expect(views).toHaveLength(4);
      expect(views[2]).toBe(views[3]);
      expect(views[2]).not.toBe(views[0]);
      expect(views[2]?.[0]).toBe(views[0]?.[0]);
      expect(views[2]?.[1]).toBe(views[0]?.[1]);
      expect(views[2]?.[2]).toBeDefined();
      expectDeepFrozen(views[2]);
    });

    it('does not replay on subscribe and captures subscriber membership per commit', () => {
      const store = createProducerViewStore();
      const events: string[] = [];
      let removeSecond: () => void = () => undefined;
      let changedMembership = false;
      const third = vi.fn(() => events.push('third'));
      const first = vi.fn(() => {
        events.push('first');
        if (!changedMembership) {
          changedMembership = true;
          removeSecond();
          store.subscribe(third);
        }
      });
      const second = vi.fn(() => events.push('second'));

      store.subscribe(first);
      removeSecond = store.subscribe(second);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();

      store.accept(makeView('p', [makeItem('p-item')]));
      expect(events).toEqual(['first', 'second']);
      removeSecond();
      removeSecond();

      store.accept(makeView('q', [makeItem('q-item')]));
      expect(events).toEqual(['first', 'second', 'first', 'third']);
      expect(second).toHaveBeenCalledOnce();
      expect(third).toHaveBeenCalledOnce();
    });

    it('captures subscriber timing and drains reentrant commits in FIFO order', () => {
      const store = createProducerViewStore();
      const events: string[] = [];
      let removeSecond: () => void = () => undefined;
      let removeThird: () => void = () => undefined;
      const snapshotLabel = (snapshot: readonly NormalizedProducerView[]): 'A' | 'B' | 'C' => {
        if (snapshot.some((entry) => entry.producer.key === 'C')) return 'C';
        if (snapshot.some((entry) => entry.producer.key === 'B')) return 'B';
        return 'A';
      };
      const second = vi.fn((snapshot: readonly NormalizedProducerView[]) => {
        events.push(`second:${snapshotLabel(snapshot)}`);
      });
      const third = vi.fn((snapshot: readonly NormalizedProducerView[]) => {
        events.push(`third:${snapshotLabel(snapshot)}`);
      });
      const fourth = vi.fn((snapshot: readonly NormalizedProducerView[]) => {
        events.push(`fourth:${snapshotLabel(snapshot)}`);
      });
      const first = vi.fn((snapshot: readonly NormalizedProducerView[]) => {
        const label = snapshotLabel(snapshot);
        events.push(`first:${label}`);
        if (label !== 'A') return;

        removeSecond();
        removeThird = store.subscribe(third);
        expect(store.accept(makeView('B', [makeItem('b-item')]))).toEqual({
          accepted: true,
          action: 'replaced',
        });
        events.push('reentrant accept(B) returns');
        removeThird();
        store.subscribe(fourth);
        expect(store.accept(makeView('C', [makeItem('c-item')]))).toEqual({
          accepted: true,
          action: 'replaced',
        });
        events.push('reentrant accept(C) returns');
        events.push('first:A returns');
      });

      store.subscribe(first);
      removeSecond = store.subscribe(second);

      expect(store.accept(makeView('A', [makeItem('a-item')]))).toEqual({
        accepted: true,
        action: 'replaced',
      });
      events.push('outer accept(A) returns');
      expect(events).toEqual([
        'first:A',
        'reentrant accept(B) returns',
        'reentrant accept(C) returns',
        'first:A returns',
        'second:A',
        'first:B',
        'third:B',
        'first:C',
        'fourth:C',
        'outer accept(A) returns',
      ]);
      expect(first).toHaveBeenCalledTimes(3);
      expect(second).toHaveBeenCalledOnce();
      expect(third).toHaveBeenCalledOnce();
      expect(fourth).toHaveBeenCalledOnce();
    });

    it('makes unsubscribe idempotent and leaves committed state after subscriber errors', () => {
      const store = createProducerViewStore();
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      unsubscribe();
      unsubscribe();
      expect(store.accept(makeView('p', [makeItem('c')]))).toEqual({
        accepted: true,
        action: 'replaced',
      });
      expect(listener).not.toHaveBeenCalled();

      const secret = 'subscriber-secret-value';
      const thrown = new Error(secret);
      thrown.stack = `Error: ${secret}\n    at secret-stack-frame`;
      const diagnostic = 'pi-cmux-junction: producer-view subscriber failed';
      const error = vi.spyOn(console, 'error').mockImplementation(() => {
        throw new Error('diagnostic-failure');
      });
      const failing = vi.fn(() => {
        throw thrown;
      });
      const succeeding = vi.fn();
      try {
        store.subscribe(failing);
        store.subscribe(succeeding);
        expect(() => store.accept(makeView('q', [makeItem('q-item')]))).not.toThrow();
        expect(() => store.accept(makeView('r', [makeItem('r-item')]))).not.toThrow();
        expect(succeeding).toHaveBeenCalledTimes(2);
        expect(error.mock.calls).toEqual([[diagnostic], [diagnostic]]);
        expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(error.mock.calls)).not.toContain('secret-stack-frame');
        expect(store.snapshot().map((entry) => entry.producer.key)).toEqual(['p', 'q', 'r']);
      } finally {
        error.mockRestore();
      }
    });

    it.each([
      {
        name: 'producer capacity',
        views: Array.from({ length: MAX_LOCAL_PRODUCERS }, (_, index) =>
          makeView(`p-${index}`, [makeItem('c')]),
        ),
        candidateKey: `p-${MAX_LOCAL_PRODUCERS}`,
        candidate: makeView(`p-${MAX_LOCAL_PRODUCERS}`, [makeItem('c')]),
        withdrawKey: 'p-0',
        expected: { producers: MAX_LOCAL_PRODUCERS, items: MAX_LOCAL_PRODUCERS, rows: 0 },
      },
      {
        name: 'item capacity',
        views: Array.from({ length: MAX_LOCAL_ITEMS / MAX_ITEMS_PER_VIEW }, (_, index) =>
          makeView(`p-${index}`, itemsOf(MAX_ITEMS_PER_VIEW)),
        ),
        candidateKey: `p-${MAX_LOCAL_ITEMS / MAX_ITEMS_PER_VIEW}`,
        candidate: makeView(`p-${MAX_LOCAL_ITEMS / MAX_ITEMS_PER_VIEW}`, [makeItem('c')]),
        withdrawKey: 'p-0',
        expected: {
          producers: MAX_LOCAL_ITEMS / MAX_ITEMS_PER_VIEW,
          items: MAX_LOCAL_ITEMS,
          rows: 0,
        },
      },
      {
        name: 'row capacity',
        views: Array.from({ length: MAX_LOCAL_ROWS / MAX_ROWS_PER_VIEW }, (_, index) =>
          viewWithRowCount(`p-${index}`, MAX_ROWS_PER_VIEW),
        ),
        candidateKey: `p-${MAX_LOCAL_ROWS / MAX_ROWS_PER_VIEW}`,
        candidate: viewWithRowCount(`p-${MAX_LOCAL_ROWS / MAX_ROWS_PER_VIEW}`, 1),
        withdrawKey: 'p-0',
        expected: {
          producers: MAX_LOCAL_ROWS / MAX_ROWS_PER_VIEW,
          items: MAX_LOCAL_ROWS / MAX_ROWS_PER_ITEM,
          rows: MAX_LOCAL_ROWS,
        },
      },
    ])(
      '$name saturates, rejects over-capacity, and recovers after withdrawal',
      ({ views, candidate, candidateKey, withdrawKey, expected }) => {
        const store = createProducerViewStore();
        const listener = vi.fn();
        store.subscribe(listener);

        for (const view of views) {
          expect(jsonBytes(view)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
          expect(store.accept(view)).toEqual({ accepted: true, action: 'replaced' });
        }
        expect(aggregateCounts(store.snapshot())).toEqual(expected);
        expect(listener).toHaveBeenCalledTimes(views.length);

        const before = store.snapshot();
        expect(store.accept(candidate)).toEqual({ accepted: false, code: 'capacity' });
        expect(store.snapshot()).toEqual(before);
        expect(listener).toHaveBeenCalledTimes(views.length);

        expect(store.accept(makeView(withdrawKey))).toEqual({
          accepted: true,
          action: 'withdrawn',
        });
        expect(store.accept(candidate)).toEqual({ accepted: true, action: 'replaced' });
        expect(store.snapshot().map((entry) => entry.producer.key)).toContain(candidateKey);
      },
    );
  });
});
