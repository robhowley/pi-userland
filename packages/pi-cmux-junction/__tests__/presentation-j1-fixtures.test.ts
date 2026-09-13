import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectPresentationJ1 } from '../extensions/cmux-junction/presentation-j1.mjs';

const directory = new URL('../extensions/cmux-junction/sidebar/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as {
  cases: {
    filename: string;
    classification: string;
    blocks?: unknown[];
    sha256?: string;
    metrics?: unknown;
  }[];
};

describe('shared J2 projector fixtures (historical J1 API names)', () => {
  for (const fixture of manifest.cases.filter((entry) => entry.classification === 'valid')) {
    it(fixture.filename, () => {
      const bytes = readFileSync(new URL(fixture.filename, directory));
      const projected = projectPresentationJ1(fixture.blocks);
      expect(projected).toMatchObject({
        kind: 'set',
        j1: bytes.toString('utf8'),
        digest: fixture.sha256,
        metrics: fixture.metrics,
      });
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      const [header, ...records] = bytes.toString('utf8').split('\u001e');
      const body = records.join('\u001e');
      expect(header).toBe(`J2\u001f${createHash('sha256').update(body, 'utf8').digest('hex')}`);
      const decoded = records.map((record) => record.split('\u001f'));
      // Independent identity decode/reencode: JS equality and Buffer equality,
      // not Swift's canonical-equivalence comparison.
      expect(
        Buffer.from([header, ...decoded.map((fields) => fields.join('\u001f'))].join('\u001e')),
      ).toEqual(bytes);
      if (fixture.filename.startsWith('unicode-') && /^unicode-\d/u.test(fixture.filename)) {
        const blocks = fixture.blocks as { producer: { label: string } }[];
        const text = blocks[0]!.producer.label;
        const producer = decoded.find((fields) => fields[0] === 'P')!;
        const card = decoded.find((fields) => fields[0] === 'C')!;
        const row = decoded.find((fields) => fields[0] === 'R')!;
        expect([producer[4], ...card.slice(5, 8), card[10], ...row.slice(5, 8)]).toEqual(
          Array(8).fill(text),
        );
        expect(row[8]).toBe('\u001d');
        expect(card[11]).toBe(
          'https://example.com/%C3%A9%F0%9F%91%A9%F0%9F%8F%BD%E2%80%8D%F0%9F%92%BB',
        );
      }
    });
  }
});
