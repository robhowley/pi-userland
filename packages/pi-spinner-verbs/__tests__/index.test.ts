import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERBS_DIR = join(__dirname, '..', 'spinner-verbs');

let verbFiles: string[];

beforeAll(() => {
  verbFiles = readdirSync(VERBS_DIR).filter(f => f.endsWith('.json'));
});

// Reusable helper to validate and load verb file data
const validateVerbFile = (file: string) => {
  const path = join(VERBS_DIR, file);
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return { path, data };
};

// Single definition of parseVerbsData for reuse
const parseVerbsData = (data: unknown): string[] | undefined =>
  Array.isArray(data) && data.length > 0 ? data : undefined;

describe('spinner-verbs', () => {
  describe('available verb sets', () => {
    it('should have at least one verb set file', () => {
      expect(verbFiles.length).toBeGreaterThan(0);
    });

    it('should load all verb sets successfully', () => {
      for (const file of verbFiles) {
        const { data } = validateVerbFile(file);
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
      }
    });
  });

  describe('parseVerbsData', () => {
    it.each([
      { input: [], expected: undefined, description: 'empty array' },
      { input: 'string' as unknown as string[], expected: undefined, description: 'non-array string' },
      { input: {} as unknown as string[], expected: undefined, description: 'non-array object' },
      { input: null as unknown as string[], expected: undefined, description: 'null' },
    ])('should return undefined for $description', ({ input }) => {
      expect(parseVerbsData(input)).toBeUndefined();
    });

    it('should return array with valid verbs', () => {
      const result = parseVerbsData(['working', 'processing']);
      expect(result).toEqual(['working', 'processing']);
    });
  });
});
