import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_PRESENTATION_J1_BLOCKS,
  MAX_PRESENTATION_J1_BYTES,
  MAX_PRESENTATION_J1_FIELDS,
  MAX_PRESENTATION_J1_ITEMS,
  MAX_PRESENTATION_J1_RECORDS,
  MAX_PRESENTATION_J1_ROWS,
  MAX_PRESENTATION_J1_SOURCES,
  measurePresentationJ1,
  presentationJ1Capacity,
  projectPresentationJ1,
} from '../extensions/cmux-junction/presentation-j1.mjs';

const sourceA = 'a'.repeat(64);
const sourceB = 'b'.repeat(64);

type TestRow = { label?: string; value: string; detail?: string; href?: string };
type TestItem = {
  key: string;
  title: string;
  status?: string;
  summary?: string;
  progress?: { label: string; value: number; max: number };
  rows: TestRow[];
  href?: string;
};

function item(key = 'item', overrides: Partial<TestItem> = {}): TestItem {
  return { key, title: `Title ${key}`, rows: [], ...overrides };
}

function block(producerKey = 'producer', sourceId = sourceA, items: TestItem[] = [item()]) {
  return {
    sourceId,
    producer: { key: producerKey, label: `Producer ${producerKey}` },
    items,
  };
}

function expectSet(blocks: unknown[]) {
  const result = projectPresentationJ1(blocks);
  expect(result.kind).toBe('set');
  if (result.kind !== 'set') throw new Error('expected set projection');
  return result as {
    kind: 'set';
    j1: string;
    digest: string;
    metrics: {
      sourceCount: number;
      blockCount: number;
      itemCount: number;
      rowCount: number;
      recordCount: number;
      fieldCount: number;
      byteCount: number;
    };
  };
}

function aggregateMaximum() {
  return Array.from({ length: MAX_PRESENTATION_J1_BLOCKS }, (_, blockIndex) =>
    block(
      `p-${String(blockIndex).padStart(2, '0')}`,
      String(blockIndex % MAX_PRESENTATION_J1_SOURCES).padStart(64, '0'),
      Array.from({ length: 8 }, (_, itemIndex) =>
        item(`i-${itemIndex}`, {
          rows: Array.from({ length: 8 }, (_, rowIndex) => ({ value: `v-${rowIndex}` })),
        }),
      ),
    ),
  );
}

function exactByteAggregate() {
  const blocks = Array.from({ length: 64 }, (_, blockIndex) =>
    block(
      `p-${String(blockIndex).padStart(2, '0')}`,
      sourceA,
      Array.from({ length: 8 }, (_, itemIndex) => item(`i-${itemIndex}`)),
    ),
  );
  const base = expectSet(blocks);
  let remaining = MAX_PRESENTATION_J1_BYTES - base.metrics.byteCount;
  expect(remaining).toBeGreaterThan(0);
  for (const candidate of blocks.flatMap((entry) => entry.items)) {
    if (remaining === 0) break;
    const length = Math.min(512, remaining + 1);
    candidate.summary = 'x'.repeat(length);
    remaining -= length - 1;
  }
  expect(remaining).toBe(0);
  return blocks;
}

describe('J2 projection grammar (historical J1 API names)', () => {
  it('matches the minimal golden and hashes the exact UTF-8 J2', () => {
    const result = expectSet([block('p', sourceA, [item('i', { title: 'Title' })])]);
    const body = [
      `S\u001f0\u001f${sourceA}`,
      'P\u001f0\u001f0\u001fp\u001fProducer p',
      'C\u001f0\u001f0\u001f0\u001fi\u001fTitle\u001f\u001d\u001f\u001d\u001f\u001d\u001f\u001d\u001f\u001d\u001f\u001d',
    ].join('\u001e');
    const golden = `J2\u001f${createHash('sha256').update(body, 'utf8').digest('hex')}\u001e${body}`;
    expect(result.j1).toBe(golden);
    expect(result.digest).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));
    expect(result.j1.endsWith('\u001e')).toBe(false);
  });

  it('uses exact arities, scoped references, literal item/row order, progress, and HTTPS', () => {
    const result = expectSet([
      block('z', sourceB, [item('z')]),
      block('same', sourceB, [item('second')]),
      block('same', sourceA, [
        item('first', {
          progress: { label: '2/3', value: 2, max: 3 },
          href: 'https://example.com/card?q=1',
          rows: [
            { label: 'B', value: '2', detail: 'second', href: 'https://example.com/b' },
            { value: '1' },
          ],
        }),
      ]),
    ]);
    const records = result.j1.split('\u001e').map((record) => record.split('\u001f'));
    expect(records.map((record) => record.length)).toEqual([2, 3, 3, 5, 12, 9, 9, 5, 12, 5, 12]);
    expect(records.slice(1, 3).map((record) => record[2])).toEqual([sourceA, sourceB]);
    expect(records.filter(([kind]) => kind === 'P').map((record) => record.slice(1, 5))).toEqual([
      ['0', '0', 'same', 'Producer same'],
      ['1', '1', 'same', 'Producer same'],
      ['1', '2', 'z', 'Producer z'],
    ]);
    expect(records.filter(([kind]) => kind === 'C')[0]!.slice(1)).toEqual([
      '0',
      '0',
      '0',
      'first',
      'Title first',
      '\u001d',
      '\u001d',
      '2',
      '3',
      '2/3',
      'https://example.com/card?q=1',
    ]);
    expect(records.filter(([kind]) => kind === 'R').map((record) => record[4])).toEqual(['0', '1']);
  });

  it('preserves printable literals and distinguishes absent fields from emoji text', () => {
    const literal = '%␞␟∅😀';
    const result = expectSet([
      block('p', sourceA, [item('i', { title: literal, rows: [{ value: literal }] })]),
    ]);
    expect(result.j1).toContain(literal);
    expect(result.j1).toContain(
      '\u001f\u001d\u001f\u001d\u001f\u001d\u001f\u001d\u001f\u001d\u001f\u001d',
    );
  });

  it('is deterministic across arrival/replay order and permits repeated keys across sources', () => {
    const blocks = [block('same', sourceB), block('same', sourceA), block('z', sourceA)];
    expect(projectPresentationJ1(blocks)).toEqual(projectPresentationJ1([...blocks].reverse()));
    expect(projectPresentationJ1([block('same', sourceA), block('same', sourceA)])).toMatchObject({
      kind: 'reject',
      code: 'duplicate-block',
      limit: 'duplicates',
      saturatedActual: 1,
    });
  });

  it('does not retain mutable input', () => {
    const blocks = [block()];
    const result = expectSet(blocks);
    blocks[0]!.producer.label = 'changed';
    blocks[0]!.items[0]!.title = 'changed';
    expect(result.j1).not.toContain('changed');
    expect(Object.isFrozen(result.metrics)).toBe(true);
  });

  it('returns clear metrics for an empty aggregate', () => {
    expect(projectPresentationJ1([])).toEqual({
      kind: 'clear',
      metrics: {
        sourceCount: 0,
        blockCount: 0,
        itemCount: 0,
        rowCount: 0,
        recordCount: 0,
        fieldCount: 0,
        byteCount: 0,
      },
    });
  });
});

describe('J2 aggregate capacity', () => {
  it('accepts every exact count, record, and field ceiling', () => {
    const result = expectSet(aggregateMaximum());
    expect(result.metrics).toMatchObject({
      sourceCount: MAX_PRESENTATION_J1_SOURCES,
      blockCount: MAX_PRESENTATION_J1_BLOCKS,
      itemCount: MAX_PRESENTATION_J1_ITEMS,
      rowCount: MAX_PRESENTATION_J1_ROWS,
      recordCount: MAX_PRESENTATION_J1_RECORDS,
      fieldCount: MAX_PRESENTATION_J1_FIELDS,
    });
  });

  it.each([
    [
      'sources',
      () =>
        Array.from({ length: MAX_PRESENTATION_J1_SOURCES + 1 }, (_, index) =>
          block(`p-${index}`, String(index).padStart(64, '0')),
        ),
      MAX_PRESENTATION_J1_SOURCES,
    ],
    [
      'blocks',
      () =>
        Array.from({ length: MAX_PRESENTATION_J1_BLOCKS + 1 }, (_, index) =>
          block(`p-${index}`, sourceA),
        ),
      MAX_PRESENTATION_J1_BLOCKS,
    ],
    [
      'items',
      () =>
        Array.from({ length: 17 }, (_, blockIndex) =>
          block(
            `p-${blockIndex}`,
            sourceA,
            Array.from({ length: blockIndex === 16 ? 1 : 32 }, (_, itemIndex) =>
              item(`i-${itemIndex}`),
            ),
          ),
        ),
      MAX_PRESENTATION_J1_ITEMS,
    ],
    [
      'rows',
      () => {
        const blocks = aggregateMaximum();
        blocks[0]!.items[0]!.rows.push({ value: 'over' });
        return blocks;
      },
      MAX_PRESENTATION_J1_ROWS,
    ],
  ])('rejects one over the %s ceiling with saturated metrics', (limit, makeBlocks, maximum) => {
    expect(projectPresentationJ1(makeBlocks())).toMatchObject({
      kind: 'reject',
      code: 'capacity',
      limit,
      maximum,
      saturatedActual: maximum + 1,
      metrics: { [`${limit.slice(0, -1)}Count`]: maximum + 1 },
    });
  });

  it('bounds derived record and field metrics on the one-over aggregate', () => {
    const blocks = aggregateMaximum();
    blocks[0]!.items[0]!.rows.push({ value: 'over' });
    const result = projectPresentationJ1(blocks);
    expect(result).toMatchObject({
      kind: 'reject',
      metrics: {
        recordCount: MAX_PRESENTATION_J1_RECORDS + 1,
        fieldCount: MAX_PRESENTATION_J1_FIELDS + 1,
      },
    });
  });

  it('accepts the exact UTF-8 byte ceiling and rejects one byte over without bytes or digest', () => {
    const blocks = exactByteAggregate();
    const exact = expectSet(blocks);
    expect(exact.metrics.byteCount).toBe(MAX_PRESENTATION_J1_BYTES);

    const extensible = blocks
      .flatMap((entry) => entry.items)
      .find((candidate) => typeof candidate.summary === 'string' && candidate.summary.length < 512);
    if (extensible) extensible.summary += 'x';
    else
      blocks.flatMap((entry) => entry.items).find((candidate) => !candidate.summary)!.summary =
        'xxxx';
    const rejected = projectPresentationJ1(blocks);
    expect(rejected).toMatchObject({
      kind: 'reject',
      code: 'capacity',
      limit: 'bytes',
      maximum: MAX_PRESENTATION_J1_BYTES,
      saturatedActual: MAX_PRESENTATION_J1_BYTES + 1,
      metrics: { byteCount: MAX_PRESENTATION_J1_BYTES + 1 },
    });
    expect(rejected).not.toHaveProperty('j1');
    expect(rejected).not.toHaveProperty('digest');
  });

  it('exposes equivalent total measure, capacity, and projection APIs', () => {
    const candidate = [block()];
    expect(measurePresentationJ1(candidate)).toEqual(projectPresentationJ1(candidate));
    expect(presentationJ1Capacity(candidate)).toEqual(projectPresentationJ1(candidate));
  });
});

describe('J2 hostile input', () => {
  it('rejects malformed values without throwing', () => {
    const candidates = [
      null,
      {},
      [null],
      [{ sourceId: sourceA, producer: {}, items: [] }],
      [block('p', 'A'.repeat(64))],
      [block('p', sourceA, [item('i', { href: 'http://example.com' })])],
      [block('p', sourceA, [item('i', { progress: { label: 'bad', value: 2, max: 1 } })])],
      [block('p', sourceA, [item('i', { title: '\ud800' })])],
      [Object.defineProperty({}, 'sourceId', { enumerable: true, get: () => sourceA })],
      new Proxy([], {
        get: () => {
          throw new Error('hostile');
        },
      }),
    ];
    for (const candidate of candidates) {
      expect(() => projectPresentationJ1(candidate)).not.toThrow();
      expect(projectPresentationJ1(candidate)).toMatchObject({ kind: 'reject' });
    }
  });
});
