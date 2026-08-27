import { describe, expect, it, vi } from 'vitest';
import {
  createProducerBoardStore,
  MAX_BOARD_BYTES,
  MAX_CARD_KEY_BYTES,
  MAX_CARDS_PER_BOARD,
  MAX_HREF_BYTES,
  MAX_LABEL_BYTES,
  MAX_LOCAL_CARDS,
  MAX_LOCAL_PRODUCERS,
  MAX_LOCAL_ROWS,
  MAX_PRODUCER_KEY_BYTES,
  MAX_ROW_TEXT_BYTES,
  MAX_ROWS_PER_BOARD,
  MAX_ROWS_PER_CARD,
  MAX_SUMMARY_BYTES,
  normalizeProducerBoard,
  PRODUCER_BOARD_EVENT,
  type NormalizedProducerBoard,
  type ProducerBoardErrorCode,
} from '../extensions/cmux-junction/producer-board.js';

type RawFields = Record<string, unknown>;
type ValidationCode = Exclude<ProducerBoardErrorCode, 'capacity'>;

function makeRow(value = 'value', fields: RawFields = {}): RawFields {
  return { value, ...fields };
}

function makeCard(key = 'card', fields: RawFields = {}): RawFields {
  return { key, title: `Title ${key}`, ...fields };
}

function makeBoard(
  producerKey = 'producer',
  cards: readonly unknown[] = [],
  fields: RawFields = {},
): RawFields {
  return {
    producer: { key: producerKey, label: `Producer ${producerKey}` },
    cards,
    ...fields,
  };
}

function fullBoard(): RawFields {
  return makeBoard(
    'agent:1',
    [
      makeCard('card/1', {
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
        href: 'https://example.test/card?q=1#fragment',
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

function valid(value: unknown): NormalizedProducerBoard {
  const result = normalizeProducerBoard(value);
  if (!result.ok) {
    throw new Error(`expected a valid board, got ${result.code} at ${result.path ?? '$'}`);
  }
  return result.value;
}

function invalid(value: unknown, code: ValidationCode, path?: string): void {
  const result = normalizeProducerBoard(value);
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

function nullPrototypeBoard(): RawFields {
  const row = Object.assign(Object.create(null), { value: 'value' });
  const card = Object.assign(Object.create(null), {
    key: 'card',
    title: 'Card',
    rows: [row],
  });
  const producer = Object.assign(Object.create(null), { key: 'producer', label: 'Producer' });
  return Object.assign(Object.create(null), { producer, cards: [card] });
}

function cardsOf(count: number, rowsPerCard = 0): RawFields[] {
  return Array.from({ length: count }, (_, index) =>
    makeCard(
      `card-${index}`,
      rowsPerCard > 0
        ? {
            rows: Array.from({ length: rowsPerCard }, () => makeRow('v')),
          }
        : {},
    ),
  );
}

function boardWithRowCount(producerKey: string, count: number, fields: RawFields = {}): RawFields {
  const cards: RawFields[] = [];
  let remaining = count;
  while (remaining > 0) {
    const rows = Math.min(MAX_ROWS_PER_CARD, remaining);
    cards.push(makeCard(`card-${cards.length}`, { rows: cardsOfRows(rows) }));
    remaining -= rows;
  }
  return makeBoard(producerKey, cards, fields);
}

function cardsOfRows(count: number): RawFields[] {
  return Array.from({ length: count }, () => makeRow('v'));
}

function boardAtByteSize(target: number): RawFields {
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
    const candidate = makeBoard('p', [makeCard('c', { rows })]);
    if (jsonBytes(candidate) === target) return candidate;
  }
  throw new Error(`could not construct a ${target}-byte board fixture`);
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
    build: (value) => makeBoard('p', [], { producer: { key: 'p', label: value } }),
    path: 'producer.label',
  },
  {
    name: 'card title',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) => makeBoard('p', [makeCard('c', { title: value })]),
    path: 'cards[0].title',
  },
  {
    name: 'card status',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) => makeBoard('p', [makeCard('c', { status: value })]),
    path: 'cards[0].status',
  },
  {
    name: 'card summary',
    limit: MAX_SUMMARY_BYTES,
    valueAt: ascii,
    build: (value) => makeBoard('p', [makeCard('c', { summary: value })]),
    path: 'cards[0].summary',
  },
  {
    name: 'progress label',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) =>
      makeBoard('p', [makeCard('c', { progress: { label: value, value: 0, max: 1 } })]),
    path: 'cards[0].progress.label',
  },
  {
    name: 'row label',
    limit: MAX_LABEL_BYTES,
    valueAt: ascii,
    build: (value) => makeBoard('p', [makeCard('c', { rows: [makeRow('v', { label: value })] })]),
    path: 'cards[0].rows[0].label',
  },
  {
    name: 'row value',
    limit: MAX_ROW_TEXT_BYTES,
    valueAt: ascii,
    build: (value) => makeBoard('p', [makeCard('c', { rows: [makeRow(value)] })]),
    path: 'cards[0].rows[0].value',
  },
  {
    name: 'row detail',
    limit: MAX_ROW_TEXT_BYTES,
    valueAt: ascii,
    build: (value) => makeBoard('p', [makeCard('c', { rows: [makeRow('v', { detail: value })] })]),
    path: 'cards[0].rows[0].detail',
  },
  {
    name: 'card href',
    limit: MAX_HREF_BYTES,
    valueAt: httpsUrlAtBytes,
    build: (value) => makeBoard('p', [makeCard('c', { href: value })]),
    path: 'cards[0].href',
  },
  {
    name: 'row href',
    limit: MAX_HREF_BYTES,
    valueAt: httpsUrlAtBytes,
    build: (value) => makeBoard('p', [makeCard('c', { rows: [makeRow('v', { href: value })] })]),
    path: 'cards[0].rows[0].href',
  },
];

const identifierBoundaryCases = [
  {
    name: 'producer key',
    limit: MAX_PRODUCER_KEY_BYTES,
    build: (value: string) => makeBoard(value),
    path: 'producer.key',
  },
  {
    name: 'card key',
    limit: MAX_CARD_KEY_BYTES,
    build: (value: string) => makeBoard('p', [makeCard(value)]),
    path: 'cards[0].key',
  },
];

const requiredFieldCases: Array<{
  name: string;
  path: string;
  build: () => unknown;
}> = [
  { name: 'board producer', path: 'producer', build: () => without(makeBoard(), 'producer') },
  { name: 'board cards', path: 'cards', build: () => without(makeBoard(), 'cards') },
  {
    name: 'producer key',
    path: 'producer.key',
    build: () => makeBoard('p', [], { producer: without({ key: 'p', label: 'P' }, 'key') }),
  },
  {
    name: 'producer label',
    path: 'producer.label',
    build: () => makeBoard('p', [], { producer: without({ key: 'p', label: 'P' }, 'label') }),
  },
  {
    name: 'card key',
    path: 'cards[0].key',
    build: () => makeBoard('p', [without(makeCard('c'), 'key')]),
  },
  {
    name: 'card title',
    path: 'cards[0].title',
    build: () => makeBoard('p', [without(makeCard('c'), 'title')]),
  },
  {
    name: 'progress label',
    path: 'cards[0].progress.label',
    build: () =>
      makeBoard('p', [
        makeCard('c', { progress: without({ label: 'P', value: 0, max: 1 }, 'label') }),
      ]),
  },
  {
    name: 'progress value',
    path: 'cards[0].progress.value',
    build: () =>
      makeBoard('p', [
        makeCard('c', { progress: without({ label: 'P', value: 0, max: 1 }, 'value') }),
      ]),
  },
  {
    name: 'progress max',
    path: 'cards[0].progress.max',
    build: () =>
      makeBoard('p', [
        makeCard('c', { progress: without({ label: 'P', value: 0, max: 1 }, 'max') }),
      ]),
  },
  {
    name: 'row value',
    path: 'cards[0].rows[0].value',
    build: () => makeBoard('p', [makeCard('c', { rows: [without(makeRow('v'), 'value')] })]),
  },
];

const optionalTextCases: Array<{
  name: string;
  path: string;
  build: (value: unknown) => unknown;
}> = [
  {
    name: 'status',
    path: 'cards[0].status',
    build: (value) => makeBoard('p', [makeCard('c', { status: value })]),
  },
  {
    name: 'summary',
    path: 'cards[0].summary',
    build: (value) => makeBoard('p', [makeCard('c', { summary: value })]),
  },
  {
    name: 'card href',
    path: 'cards[0].href',
    build: (value) => makeBoard('p', [makeCard('c', { href: value })]),
  },
  {
    name: 'row label',
    path: 'cards[0].rows[0].label',
    build: (value) => makeBoard('p', [makeCard('c', { rows: [makeRow('v', { label: value })] })]),
  },
  {
    name: 'row detail',
    path: 'cards[0].rows[0].detail',
    build: (value) => makeBoard('p', [makeCard('c', { rows: [makeRow('v', { detail: value })] })]),
  },
  {
    name: 'row href',
    path: 'cards[0].rows[0].href',
    build: (value) => makeBoard('p', [makeCard('c', { rows: [makeRow('v', { href: value })] })]),
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
    build: (value) => makeBoard('p', [], { producer: { key: value, label: 'P' } }),
  },
  {
    name: 'producer label',
    path: 'producer.label',
    build: (value) => makeBoard('p', [], { producer: { key: 'p', label: value } }),
  },
  {
    name: 'card key',
    path: 'cards[0].key',
    build: (value) => makeBoard('p', [{ key: value, title: 'C' }]),
  },
  {
    name: 'card title',
    path: 'cards[0].title',
    build: (value) => makeBoard('p', [{ key: 'c', title: value }]),
  },
  {
    name: 'progress label',
    path: 'cards[0].progress.label',
    build: (value) =>
      makeBoard('p', [makeCard('c', { progress: { label: value, value: 0, max: 1 } })]),
  },
  {
    name: 'progress value',
    path: 'cards[0].progress.value',
    build: (value) => makeBoard('p', [makeCard('c', { progress: { label: 'P', value, max: 1 } })]),
  },
  {
    name: 'progress max',
    path: 'cards[0].progress.max',
    build: (value) =>
      makeBoard('p', [makeCard('c', { progress: { label: 'P', value: 0, max: value } })]),
  },
  {
    name: 'row value',
    path: 'cards[0].rows[0].value',
    build: (value) => makeBoard('p', [makeCard('c', { rows: [{ value }] })]),
  },
];

const unknownFieldCases: Array<{ name: string; path: string; value: unknown }> = [
  { name: 'board', path: '$', value: makeBoard('p', [], { extra: true }) },
  {
    name: 'producer',
    path: 'producer',
    value: makeBoard('p', [], { producer: { key: 'p', label: 'P', extra: true } }),
  },
  {
    name: 'card',
    path: 'cards[0]',
    value: makeBoard('p', [makeCard('c', { extra: true })]),
  },
  {
    name: 'progress',
    path: 'cards[0].progress',
    value: makeBoard('p', [
      makeCard('c', { progress: { label: 'P', value: 0, max: 1, extra: true } }),
    ]),
  },
  {
    name: 'row',
    path: 'cards[0].rows[0]',
    value: makeBoard('p', [makeCard('c', { rows: [makeRow('v', { extra: true })] })]),
  },
];

describe('producer board source contract', () => {
  describe('normalization', () => {
    it('exports the event name and every Phase 1 limit', () => {
      expect(PRODUCER_BOARD_EVENT).toBe('pi-cmux-junction:update');
      expect({
        MAX_PRODUCER_KEY_BYTES,
        MAX_CARD_KEY_BYTES,
        MAX_LABEL_BYTES,
        MAX_SUMMARY_BYTES,
        MAX_ROW_TEXT_BYTES,
        MAX_HREF_BYTES,
        MAX_CARDS_PER_BOARD,
        MAX_ROWS_PER_CARD,
        MAX_ROWS_PER_BOARD,
        MAX_BOARD_BYTES,
        MAX_LOCAL_PRODUCERS,
        MAX_LOCAL_CARDS,
        MAX_LOCAL_ROWS,
      }).toEqual({
        MAX_PRODUCER_KEY_BYTES: 64,
        MAX_CARD_KEY_BYTES: 64,
        MAX_LABEL_BYTES: 128,
        MAX_SUMMARY_BYTES: 512,
        MAX_ROW_TEXT_BYTES: 256,
        MAX_HREF_BYTES: 2_048,
        MAX_CARDS_PER_BOARD: 32,
        MAX_ROWS_PER_CARD: 16,
        MAX_ROWS_PER_BOARD: 256,
        MAX_BOARD_BYTES: 8_192,
        MAX_LOCAL_PRODUCERS: 64,
        MAX_LOCAL_CARDS: 512,
        MAX_LOCAL_ROWS: 4_096,
      });
      expect(MAX_LOCAL_PRODUCERS * MAX_BOARD_BYTES).toBe(524_288);
    });

    it('accepts the minimal shape and fills omitted rows with a frozen array', () => {
      const minimal = valid(makeBoard('p'));
      expect(minimal).toEqual({
        producer: { key: 'p', label: 'Producer p' },
        cards: [],
      });
      expectDeepFrozen(minimal);

      const card = valid(makeBoard('p', [makeCard('c')])).cards[0];
      expect(card?.rows).toEqual([]);
      expect(Object.isFrozen(card?.rows)).toBe(true);
    });

    it('accepts every optional field, preserves literals and order, and converts only -0', () => {
      const normalized = valid(fullBoard());
      expect(normalized).toEqual({
        producer: { key: 'agent:1', label: '  Producer  ' },
        cards: [
          {
            key: 'card/1',
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
            href: 'https://example.test/card?q=1#fragment',
          },
        ],
      });
      expect(Object.is(normalized.cards[0]?.progress?.value, 0)).toBe(true);
      expect(Object.keys(normalized)).toEqual(['producer', 'cards']);
      expect(Object.keys(normalized.producer)).toEqual(['key', 'label']);
      expect(Object.keys(normalized.cards[0] ?? {})).toEqual([
        'key',
        'title',
        'status',
        'summary',
        'progress',
        'rows',
        'href',
      ]);
      expect(Object.keys(normalized.cards[0]?.progress ?? {})).toEqual(['label', 'value', 'max']);
      expect(Object.keys(normalized.cards[0]?.rows[0] ?? {})).toEqual([
        'label',
        'value',
        'detail',
        'href',
      ]);
      expectDeepFrozen(normalized);
    });

    it('accepts null-prototype records, frozen arrays, and frozen data descriptors', () => {
      expect(valid(nullPrototypeBoard()).producer).toEqual({ key: 'producer', label: 'Producer' });

      const frozenRows = Object.freeze([makeRow()]);
      const frozenCards = Object.freeze([makeCard('c', { rows: frozenRows })]);
      const frozenBoard = Object.freeze(makeBoard('p', frozenCards));
      expect(valid(frozenBoard).cards).toHaveLength(1);
    });

    it('copies inbound values before returning normalized output', () => {
      const input = fullBoard();
      const normalized = valid(input);
      const producer = input['producer'] as RawFields;
      const cards = input['cards'] as RawFields[];
      const inputCard = cards[0] as RawFields;
      const rows = inputCard['rows'] as RawFields[];
      const inputRow = rows[0] as RawFields;

      producer['label'] = 'mutated';
      inputCard['title'] = 'mutated';
      inputRow['value'] = 'mutated';
      cards.length = 0;

      expect(normalized.producer.label).toBe('  Producer  ');
      expect(normalized.cards[0]?.title).toBe('  Title  ');
      expect(normalized.cards[0]?.rows[0]?.value).toBe('  row value  ');
      expect(normalized.producer).not.toBe(producer);
      expect(normalized.cards).not.toBe(cards);
      expect(normalized.cards[0]?.rows[0]).not.toBe(inputRow);
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
      (key) => invalid(makeBoard(key), 'invalid-identifier', 'producer.key'),
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
        makeBoard('p', [makeCard('c', { progress: undefined })]),
        'invalid-type',
        'cards[0].progress',
      );
      invalid(
        makeBoard('p', [makeCard('c', { progress: null })]),
        'invalid-type',
        'cards[0].progress',
      );
      invalid(
        makeBoard('p', [makeCard('c', { rows: undefined })]),
        'invalid-type',
        'cards[0].rows',
      );
      invalid(makeBoard('p', [makeCard('c', { rows: null })]), 'invalid-type', 'cards[0].rows');
    });

    it.each(unknownFieldCases)(
      'reports unknown $name fields at the containing path',
      ({ value, path }) => {
        invalid(value, 'unknown-field', path);
      },
    );

    it('rejects wrong root and nested categories with invalid-type', () => {
      for (const value of [null, 1, true, 'board', Symbol('board'), 1n, [], () => undefined]) {
        invalid(value, 'invalid-type', '$');
      }
      invalid(makeBoard('p', [], { producer: [] }), 'invalid-type', 'producer');
      invalid(makeBoard('p', {} as unknown as unknown[]), 'invalid-type', 'cards');
      invalid(
        makeBoard('p', [makeCard('c', { progress: [] })]),
        'invalid-type',
        'cards[0].progress',
      );
      invalid(makeBoard('p', [makeCard('c', { rows: {} })]), 'invalid-type', 'cards[0].rows');
      invalid(
        makeBoard('p', [makeCard('c', { rows: [null] })]),
        'invalid-type',
        'cards[0].rows[0]',
      );
    });

    it('rejects non-plain record prototypes and keeps allowed frozen data descriptors valid', () => {
      class BoardLike {
        producer = { key: 'p', label: 'P' };
        cards: unknown[] = [];
      }
      for (const value of [new Date(), new Map(), new Set(), new BoardLike(), Object.create({})]) {
        invalid(value, 'invalid-record', '$');
      }

      const frozen = Object.freeze(makeBoard());
      expect(valid(frozen)).toEqual({
        producer: { key: 'producer', label: 'Producer producer' },
        cards: [],
      });
    });

    it('rejects symbols, non-enumerable fields, and accessors without invoking accessors', () => {
      const root = makeBoard();
      Object.defineProperty(root, 'extra', { value: true, enumerable: false });
      invalid(root, 'invalid-record', '$');

      const symbolRoot = makeBoard();
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
      invalid(makeBoard('p', [], { producer }), 'invalid-record', 'producer');
      expect(accessed).toBe(false);

      const nonEnumerableProducer = { key: 'p', label: 'P' };
      Object.defineProperty(nonEnumerableProducer, 'label', {
        configurable: true,
        enumerable: false,
        value: 'P',
        writable: true,
      });
      invalid(
        makeBoard('p', [], { producer: nonEnumerableProducer }),
        'invalid-record',
        'producer',
      );
    });

    it('accepts ordinary frozen arrays but rejects prototype, key, descriptor, and hole hazards', () => {
      const frozen = Object.freeze([makeCard('c')]);
      expect(valid(makeBoard('p', frozen))).toBeDefined();

      const wrongPrototype = [makeCard('c')];
      Object.setPrototypeOf(wrongPrototype, {});
      invalid(makeBoard('p', wrongPrototype), 'invalid-record', 'cards');

      const customProperty = [makeCard('c')];
      Object.defineProperty(customProperty, 'extra', { enumerable: true, value: true });
      invalid(makeBoard('p', customProperty), 'invalid-record', 'cards');

      const symbolProperty = [makeCard('c')];
      Object.defineProperty(symbolProperty, Symbol('extra'), { enumerable: true, value: true });
      invalid(makeBoard('p', symbolProperty), 'invalid-record', 'cards');

      const nonEnumerableIndex = [makeCard('c')];
      Object.defineProperty(nonEnumerableIndex, '0', {
        configurable: true,
        enumerable: false,
        value: nonEnumerableIndex[0],
        writable: true,
      });
      invalid(
        makeBoard('p', [makeCard('c', { rows: nonEnumerableIndex })]),
        'invalid-record',
        'cards[0].rows',
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
        makeBoard('p', [makeCard('c', { rows: accessorIndex })]),
        'invalid-record',
        'cards[0].rows',
      );
      expect(accessed).toBe(false);

      invalid(
        makeBoard('p', [makeCard('c', { rows: new Array(1) })]),
        'invalid-record',
        'cards[0].rows',
      );
    });

    it.each([
      {
        name: 'root ownKeys',
        value: () =>
          new Proxy(makeBoard(), {
            ownKeys: () => {
              throw new Error('secret ownKeys');
            },
          }),
        path: '$',
      },
      {
        name: 'root prototype',
        value: () =>
          new Proxy(makeBoard(), {
            getPrototypeOf: () => {
              throw new Error('secret proto');
            },
          }),
        path: '$',
      },
      {
        name: 'root descriptor',
        value: () =>
          new Proxy(makeBoard(), {
            getOwnPropertyDescriptor: () => {
              throw new Error('secret descriptor');
            },
          }),
        path: '$',
      },
      {
        name: 'nested array ownKeys',
        value: () =>
          makeBoard(
            'p',
            new Proxy([makeCard('c')], {
              ownKeys: () => {
                throw new Error('secret array');
              },
            }),
          ),
        path: 'cards',
      },
      {
        name: 'nested array descriptor',
        value: () =>
          makeBoard(
            'p',
            new Proxy([makeCard('c')], {
              getOwnPropertyDescriptor: () => {
                throw new Error('secret array descriptor');
              },
            }),
          ),
        path: 'cards',
      },
    ])('turns $name reflection failures into invalid-record', ({ value, path }) => {
      invalid(value(), 'invalid-record', path);
    });

    it.each([
      {
        name: 'cards',
        length: MAX_CARDS_PER_BOARD + 1,
        build: (items: unknown[]) => makeBoard('p', items),
        path: 'cards',
      },
      {
        name: 'rows',
        length: MAX_ROWS_PER_CARD + 1,
        build: (items: unknown[]) => makeBoard('p', [makeCard('c', { rows: items })]),
        path: 'cards[0].rows',
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
      invalid(build(items), 'board-limit', path);
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
        makeBoard('p', [], { producer: { key: 'p', label: `ok${value}ok` } }),
        'invalid-string',
        'producer.label',
      );
    });

    it.each(['\u00a0', '\ufeff'])('treats %j as ECMAScript-trim blank text', (value) => {
      invalid(
        makeBoard('p', [], { producer: { key: 'p', label: value } }),
        'invalid-string',
        'producer.label',
      );
    });

    it('accepts U+200B and valid surrogate pairs while rejecting lone surrogates', () => {
      const zeroWidth = valid(makeBoard('p', [], { producer: { key: 'p', label: '\u200b' } }));
      expect(zeroWidth.producer.label).toBe('\u200b');
      const pair = valid(makeBoard('p', [], { producer: { key: 'p', label: 'before😀after' } }));
      expect(pair.producer.label).toBe('before😀after');
      invalid(
        makeBoard('p', [], { producer: { key: 'p', label: '\ud800' } }),
        'invalid-string',
        'producer.label',
      );
      invalid(
        makeBoard('p', [], { producer: { key: 'p', label: '\udfff' } }),
        'invalid-string',
        'producer.label',
      );

      const emojiExact = '😀'.repeat(MAX_LABEL_BYTES / 4);
      expect(Buffer.byteLength(emojiExact, 'utf8')).toBe(MAX_LABEL_BYTES);
      expect(
        valid(makeBoard('p', [], { producer: { key: 'p', label: emojiExact } })),
      ).toBeDefined();
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
      invalid(makeBoard('p', [makeCard('c', { href })]), 'invalid-url', 'cards[0].href');
    });

    it.each([
      'https://example.test/',
      'https://example.test/path?query=1#fragment',
      'https://example.test:8443/path',
      'https://example.test/path%20with%20escapes',
    ])('accepts parser-valid HTTPS href %j literally', (href) => {
      const normalized = valid(makeBoard('p', [makeCard('c', { href })]));
      expect(normalized.cards[0]?.href).toBe(href);
    });

    it('uses URL whitespace rules without treating U+200B as URL whitespace', () => {
      invalid(
        makeBoard('p', [makeCard('c', { href: 'https://example.test/\ufeff' })]),
        'invalid-url',
        'cards[0].href',
      );
      const normalized = valid(
        makeBoard('p', [makeCard('c', { href: 'https://example.test/\u200b' })]),
      );
      expect(normalized.cards[0]?.href).toBe('https://example.test/\u200b');
    });

    it('accepts progress endpoints and safe integers, but never clamps invalid values', () => {
      for (const [value, max] of [
        [0, 1],
        [1, 1],
        [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        [-0, 1],
      ] as const) {
        expect(
          valid(makeBoard('p', [makeCard('c', { progress: { label: 'P', value, max } })])),
        ).toBeDefined();
      }
      expect(
        Object.is(
          valid(makeBoard('p', [makeCard('c', { progress: { label: 'P', value: -0, max: 1 } })]))
            .cards[0]?.progress?.value,
          0,
        ),
      ).toBe(true);
    });

    it.each([
      { name: 'fractional value', value: 0.5, max: 1, path: 'cards[0].progress.value' },
      { name: 'NaN value', value: Number.NaN, max: 1, path: 'cards[0].progress.value' },
      {
        name: 'infinite value',
        value: Number.POSITIVE_INFINITY,
        max: 1,
        path: 'cards[0].progress.value',
      },
      { name: 'negative value', value: -1, max: 1, path: 'cards[0].progress.value' },
      {
        name: 'unsafe value',
        value: Number.MAX_SAFE_INTEGER + 1,
        max: Number.MAX_SAFE_INTEGER + 1,
        path: 'cards[0].progress.value',
      },
      { name: 'zero max', value: 0, max: 0, path: 'cards[0].progress.max' },
      { name: 'fractional max', value: 0, max: 0.5, path: 'cards[0].progress.max' },
      { name: 'NaN max', value: 0, max: Number.NaN, path: 'cards[0].progress.max' },
      {
        name: 'infinite max',
        value: 0,
        max: Number.POSITIVE_INFINITY,
        path: 'cards[0].progress.max',
      },
      { name: 'negative max', value: 0, max: -1, path: 'cards[0].progress.max' },
      {
        name: 'unsafe max',
        value: 0,
        max: Number.MAX_SAFE_INTEGER + 1,
        path: 'cards[0].progress.max',
      },
      { name: 'value above max', value: 2, max: 1, path: 'cards[0].progress.value' },
    ])('rejects $name without clamping', ({ value, max, path }) => {
      invalid(
        makeBoard('p', [makeCard('c', { progress: { label: 'P', value, max } })]),
        'invalid-number',
        path,
      );
    });

    it('rejects duplicate card keys but allows repeated row labels', () => {
      invalid(
        makeBoard('p', [makeCard('same'), makeCard('same')]),
        'duplicate-key',
        'cards[1].key',
      );
      const normalized = valid(
        makeBoard('p', [
          makeCard('a', {
            rows: [makeRow('one', { label: 'same' }), makeRow('two', { label: 'same' })],
          }),
        ]),
      );
      expect(normalized.cards[0]?.rows.map((row) => row.label)).toEqual(['same', 'same']);
    });

    it('enforces exact card and row counts before accepting one-over fixtures', () => {
      expect(valid(makeBoard('p', cardsOf(MAX_CARDS_PER_BOARD)))).toBeDefined();
      invalid(makeBoard('p', cardsOf(MAX_CARDS_PER_BOARD + 1)), 'board-limit', 'cards');

      expect(valid(makeBoard('p', cardsOf(1, MAX_ROWS_PER_CARD)))).toBeDefined();
      invalid(makeBoard('p', cardsOf(1, MAX_ROWS_PER_CARD + 1)), 'board-limit', 'cards[0].rows');

      const exactRows = boardWithRowCount('p', MAX_ROWS_PER_BOARD);
      expect(jsonBytes(exactRows)).toBeLessThan(MAX_BOARD_BYTES);
      expect(valid(exactRows)).toBeDefined();
      invalid(boardWithRowCount('p', MAX_ROWS_PER_BOARD + 1), 'board-limit', 'cards');
    });

    it('accepts exact 8 KiB and rejects one byte over the normalized board budget', () => {
      expect(MAX_BOARD_BYTES).toBe(8_192);
      const exact = boardAtByteSize(8_192);
      const over = boardAtByteSize(8_193);
      expect(jsonBytes(exact)).toBe(8_192);
      expect(jsonBytes(over)).toBe(8_193);
      expect(jsonBytes(valid(exact))).toBe(8_192);
      invalid(over, 'board-limit', '$');
    });

    it('documents that minimal exact total-row fixtures fit below the board ceiling', () => {
      const exactBoard = boardWithRowCount('p', 256);
      expect(jsonBytes(exactBoard)).toBeLessThanOrEqual(MAX_BOARD_BYTES);
      expect(valid(exactBoard).cards.reduce((total, card) => total + card.rows.length, 0)).toBe(
        256,
      );

      // Four cards × sixteen minimal rows per board reaches 4,096 rows without relying on
      // optional text. Keep this fixture small enough for each board's independent 8 KiB limit.
      const localBoard = boardWithRowCount('p', 64);
      expect(jsonBytes(localBoard)).toBeLessThanOrEqual(MAX_BOARD_BYTES);
      expect(valid(localBoard).cards.reduce((total, card) => total + card.rows.length, 0)).toBe(64);
    });

    it('documents JavaScript duplicate-property behavior rather than inventing a duplicate case', () => {
      const input = JSON.parse(
        '{"producer":{"key":"p","label":"first","label":"last"},"cards":[]}',
      ) as RawFields;
      expect(Object.keys(input['producer'] as RawFields)).toEqual(['key', 'label']);
      expect(valid(input).producer.label).toBe('last');
    });
  });

  describe('store', () => {
    it('creates one isolated store per factory call', () => {
      const first = createProducerBoardStore();
      const second = createProducerBoardStore();

      expect(first.accept(makeBoard('p', [makeCard('c')]))).toMatchObject({
        accepted: true,
        changed: true,
      });
      expect(second.snapshot()).toEqual([]);
    });

    it('replaces same-key boards, withdraws existing keys, and reports no-op actions', () => {
      const store = createProducerBoardStore();
      const listener = vi.fn();
      store.subscribe(listener);

      expect(store.accept(makeBoard('missing'))).toEqual({
        accepted: true,
        changed: false,
        action: 'none',
      });
      expect(listener).not.toHaveBeenCalled();

      const first = makeBoard('p', [makeCard('old', { summary: 'old' })]);
      expect(store.accept(first)).toEqual({ accepted: true, changed: true, action: 'replaced' });
      expect(store.accept(makeBoard('p', [makeCard('old', { summary: 'old' })]))).toEqual({
        accepted: true,
        changed: false,
        action: 'none',
      });

      const replacement = makeBoard('p', [makeCard('new', { rows: [makeRow('new')] })]);
      expect(store.accept(replacement)).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });
      expect(store.snapshot()).toEqual([valid(replacement)]);

      expect(store.accept(makeBoard('p'))).toEqual({
        accepted: true,
        changed: true,
        action: 'withdrawn',
      });
      expect(store.snapshot()).toEqual([]);
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it('orders producers by exact ASCII key and preserves card and row input order', () => {
      const store = createProducerBoardStore();
      const values = [
        ['b', ['z', 'a']],
        ['A', ['a']],
        ['a', ['z']],
        ['aa', ['m']],
        ['B', ['b']],
      ] as const;
      for (const [producerKey, cardKeys] of values) {
        expect(
          store.accept(
            makeBoard(
              producerKey,
              cardKeys.map((key) =>
                makeCard(key, { rows: [makeRow(`${key}-1`), makeRow(`${key}-2`)] }),
              ),
            ),
          ),
        ).toMatchObject({ accepted: true, changed: true, action: 'replaced' });
      }

      expect(store.snapshot().map((entry) => entry.producer.key)).toEqual([
        'A',
        'B',
        'a',
        'aa',
        'b',
      ]);
      expect(store.snapshot()[4]?.cards.map((card) => card.key)).toEqual(['z', 'a']);
      expect(store.snapshot()[4]?.cards[0]?.rows.map((row) => row.value)).toEqual(['z-1', 'z-2']);
    });

    it('keeps invalid updates and failed board limits atomically invisible', () => {
      const store = createProducerBoardStore();
      const listener = vi.fn();
      store.subscribe(listener);
      const original = makeBoard('p', [makeCard('c', { summary: 'original' })]);
      expect(store.accept(original)).toMatchObject({ accepted: true, changed: true });
      const before = store.snapshot();

      expect(store.accept(makeBoard('p', [makeCard('c', { summary: '\u0000secret' })]))).toEqual({
        accepted: false,
        code: 'invalid-string',
        path: 'cards[0].summary',
      });
      expect(store.snapshot()).toEqual(before);

      expect(store.accept(makeBoard('p', cardsOf(MAX_CARDS_PER_BOARD + 1)))).toEqual({
        accepted: false,
        code: 'board-limit',
        path: 'cards',
      });
      expect(store.snapshot()).toEqual(before);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('gives every snapshot and subscriber an independent deep-frozen graph', () => {
      const store = createProducerBoardStore();
      const input = fullBoard();
      expect(store.accept(input)).toMatchObject({ accepted: true, changed: true });
      const first = store.snapshot();
      const second = store.snapshot();
      expect(first).not.toBe(second);
      expect(first[0]).not.toBe(second[0]);
      expect(first[0]?.producer).not.toBe(second[0]?.producer);
      expect(first[0]?.cards[0]?.rows[0]).not.toBe(second[0]?.cards[0]?.rows[0]);
      expectDeepFrozen(first);
      expectDeepFrozen(second);

      const producer = input['producer'] as RawFields;
      const cards = input['cards'] as RawFields[];
      producer['label'] = 'changed after accept';
      cards.length = 0;
      expect(store.snapshot()).toEqual(first);

      const views: Array<readonly NormalizedProducerBoard[]> = [];
      store.subscribe((snapshot) => views.push(snapshot));
      store.subscribe((snapshot) => views.push(snapshot));
      store.accept(makeBoard('q', [makeCard('q-card')]));
      expect(views).toHaveLength(2);
      expect(views[0]).not.toBe(views[1]);
      expect(views[0]?.[0]).not.toBe(views[1]?.[0]);
      expectDeepFrozen(views[0]);
      expectDeepFrozen(views[1]);
      expect(views[0]).toEqual(store.snapshot());
      expect(views[1]).toEqual(store.snapshot());
    });

    it('does not replay on subscribe and captures subscriber membership per commit', () => {
      const store = createProducerBoardStore();
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

      store.accept(makeBoard('p', [makeCard('p-card')]));
      expect(events).toEqual(['first', 'second']);
      removeSecond();
      removeSecond();

      store.accept(makeBoard('q', [makeCard('q-card')]));
      expect(events).toEqual(['first', 'second', 'first', 'third']);
      expect(second).toHaveBeenCalledOnce();
      expect(third).toHaveBeenCalledOnce();
    });

    it('captures subscriber membership when a reentrant commit is queued', () => {
      const store = createProducerBoardStore();
      const events: string[] = [];
      let removeSecond: () => void = () => undefined;
      let removeThird: () => void = () => undefined;
      let changedMembership = false;
      const snapshotLabel = (snapshot: readonly NormalizedProducerBoard[]): 'A' | 'B' =>
        snapshot.some((entry) => entry.producer.key === 'B') ? 'B' : 'A';
      const second = vi.fn((snapshot: readonly NormalizedProducerBoard[]) => {
        events.push(`second:${snapshotLabel(snapshot)}`);
      });
      const third = vi.fn((snapshot: readonly NormalizedProducerBoard[]) => {
        events.push(`third:${snapshotLabel(snapshot)}`);
      });
      const fourth = vi.fn((snapshot: readonly NormalizedProducerBoard[]) => {
        events.push(`fourth:${snapshotLabel(snapshot)}`);
      });
      const first = vi.fn((snapshot: readonly NormalizedProducerBoard[]) => {
        const label = snapshotLabel(snapshot);
        events.push(`first:${label}`);
        if (label !== 'A' || changedMembership) return;

        changedMembership = true;
        removeSecond();
        removeThird = store.subscribe(third);
        expect(store.accept(makeBoard('B', [makeCard('b-card')]))).toEqual({
          accepted: true,
          changed: true,
          action: 'replaced',
        });
        removeThird();
        store.subscribe(fourth);
      });

      store.subscribe(first);
      removeSecond = store.subscribe(second);

      expect(store.accept(makeBoard('A', [makeCard('a-card')]))).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });
      expect(events).toEqual(['first:A', 'second:A', 'first:B', 'third:B']);
      expect(second).toHaveBeenCalledOnce();
      expect(third).toHaveBeenCalledOnce();
      expect(fourth).not.toHaveBeenCalled();
    });

    it('makes unsubscribe idempotent and leaves committed state after subscriber errors', () => {
      const store = createProducerBoardStore();
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      unsubscribe();
      unsubscribe();
      expect(store.accept(makeBoard('p', [makeCard('c')]))).toMatchObject({
        accepted: true,
        changed: true,
      });
      expect(listener).not.toHaveBeenCalled();

      const secret = 'subscriber-secret-value';
      const thrown = new Error(secret);
      thrown.stack = `Error: ${secret}\n    at secret-stack-frame`;
      const diagnostic = 'pi-cmux-junction: producer-board subscriber failed';
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failing = vi.fn(() => {
        throw thrown;
      });
      const succeeding = vi.fn();
      try {
        store.subscribe(failing);
        store.subscribe(succeeding);
        expect(() => store.accept(makeBoard('q', [makeCard('q-card')]))).not.toThrow();
        expect(() => store.accept(makeBoard('r', [makeCard('r-card')]))).not.toThrow();
        expect(succeeding).toHaveBeenCalledTimes(2);
        expect(error.mock.calls).toEqual([[diagnostic], [diagnostic]]);
        expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(error.mock.calls)).not.toContain('secret-stack-frame');
        expect(store.snapshot().map((entry) => entry.producer.key)).toEqual(['p', 'q', 'r']);
      } finally {
        error.mockRestore();
      }
    });

    it('drains reentrant changed commits in the exact FIFO order', () => {
      const store = createProducerBoardStore();
      const order: string[] = [];
      const first = vi.fn((snapshot: readonly NormalizedProducerBoard[]) => {
        const isB = snapshot.some((entry) => entry.producer.key === 'B');
        if (isB) {
          order.push('B/subscriber-1');
          return;
        }
        order.push('A/subscriber-1');
        expect(store.accept(makeBoard('B', [makeCard('b-card')]))).toEqual({
          accepted: true,
          changed: true,
          action: 'replaced',
        });
        order.push('reentrant accept(B) returns');
        order.push('A/subscriber-1 returns');
      });
      const second = vi.fn((snapshot: readonly NormalizedProducerBoard[]) => {
        const isB = snapshot.some((entry) => entry.producer.key === 'B');
        order.push(`${isB ? 'B' : 'A'}/subscriber-2`);
      });
      store.subscribe(first);
      store.subscribe(second);

      expect(store.accept(makeBoard('A', [makeCard('a-card')]))).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });
      order.push('outer accept(A) returns');
      expect(order).toEqual([
        'A/subscriber-1',
        'reentrant accept(B) returns',
        'A/subscriber-1 returns',
        'A/subscriber-2',
        'B/subscriber-1',
        'B/subscriber-2',
        'outer accept(A) returns',
      ]);
    });

    it('accepts exact aggregate producer/card/row capacities and rejects each one-over atomically', () => {
      const producers = createProducerBoardStore();
      for (let index = 0; index < MAX_LOCAL_PRODUCERS; index += 1) {
        expect(producers.accept(makeBoard(`p-${index}`, [makeCard('c')]))).toMatchObject({
          accepted: true,
          changed: true,
          action: 'replaced',
        });
      }
      expect(producers.snapshot()).toHaveLength(MAX_LOCAL_PRODUCERS);
      const producerBefore = producers.snapshot();
      expect(producers.accept(makeBoard(`p-${MAX_LOCAL_PRODUCERS}`, [makeCard('c')]))).toEqual({
        accepted: false,
        code: 'capacity',
      });
      expect(producers.snapshot()).toEqual(producerBefore);

      const cards = createProducerBoardStore();
      const cardsPerBoard = MAX_LOCAL_CARDS / MAX_LOCAL_PRODUCERS;
      for (let index = 0; index < MAX_LOCAL_PRODUCERS; index += 1) {
        expect(cards.accept(makeBoard(`p-${index}`, cardsOf(cardsPerBoard)))).toMatchObject({
          accepted: true,
          changed: true,
        });
      }
      expect(
        cards.accept(
          makeBoard('p-0', cardsOf(cardsPerBoard), {
            producer: { key: 'p-0', label: 'same-size replacement' },
          }),
        ),
      ).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });
      expect(cards.accept(makeBoard('p-0', cardsOf(cardsPerBoard - 1)))).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });
      expect(cards.accept(makeBoard('p-0', cardsOf(cardsPerBoard)))).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });

      const cardBefore = cards.snapshot();
      expect(cards.accept(makeBoard('p-0', cardsOf(cardsPerBoard + 1)))).toEqual({
        accepted: false,
        code: 'capacity',
      });
      expect(cards.snapshot()).toEqual(cardBefore);

      const rows = createProducerBoardStore();
      const rowsPerBoard = MAX_LOCAL_ROWS / MAX_LOCAL_PRODUCERS;
      for (let index = 0; index < MAX_LOCAL_PRODUCERS; index += 1) {
        const entry = boardWithRowCount(`p-${index}`, rowsPerBoard);
        expect(jsonBytes(entry)).toBeLessThanOrEqual(MAX_BOARD_BYTES);
        expect(rows.accept(entry)).toMatchObject({ accepted: true, changed: true });
      }
      expect(
        rows
          .snapshot()
          .reduce(
            (total, entry) =>
              total + entry.cards.reduce((cardsTotal, card) => cardsTotal + card.rows.length, 0),
            0,
          ),
      ).toBe(MAX_LOCAL_ROWS);
      expect(
        rows.accept(
          boardWithRowCount('p-0', rowsPerBoard, {
            producer: { key: 'p-0', label: 'same-size replacement' },
          }),
        ),
      ).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });
      expect(rows.accept(boardWithRowCount('p-0', rowsPerBoard - 1))).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });
      expect(rows.accept(boardWithRowCount('p-0', rowsPerBoard))).toEqual({
        accepted: true,
        changed: true,
        action: 'replaced',
      });

      const rowBefore = rows.snapshot();
      expect(rows.accept(boardWithRowCount('p-0', rowsPerBoard + 1))).toEqual({
        accepted: false,
        code: 'capacity',
      });
      expect(rows.snapshot()).toEqual(rowBefore);
    });
  });
});
