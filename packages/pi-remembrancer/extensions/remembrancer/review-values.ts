import { detailPages, object, text } from './review-findings.js';
import { estimateReviewerTokens } from './reviewer-budget.js';

/** Attempt-local originals. A model can page a value or copy it without reproducing it. */
export class ReviewValues {
  private readonly values = new Map<string, unknown>();
  private readonly handles = new Map<unknown, string>();
  constructor(
    private readonly limit: number,
    private readonly workingLimit: number,
  ) {}

  private retain(value: unknown) {
    let handle = this.handles.get(value);
    if (!handle) {
      handle = `v${this.values.size + 1}`;
      this.values.set(handle, value);
      this.handles.set(value, handle);
    }
    return { valueHandle: handle };
  }

  working(value: unknown): unknown {
    if (estimateReviewerTokens(value) <= this.limit) return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const working = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, this.working(child)]),
      );
      // Metadata around compact children may exceed a detail page, but the full
      // aggregate still has to fit its share of the working request.
      if (estimateReviewerTokens(working) <= this.workingLimit) return working;
    }
    return this.retain(value);
  }

  /** Reject invented handles and mixed copy objects before normal draft validation. */
  expand(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((child) => this.expand(child));
    const data = object(value);
    if ('valueHandle' in data) {
      if (
        Object.keys(data).some((key) => !['valueHandle', 'append'].includes(key)) ||
        !this.values.has(text(data['valueHandle']))
      )
        throw new Error('Invalid capture value handle');
      const original = structuredClone(this.values.get(text(data['valueHandle'])));
      if (!('append' in data)) return original;
      const append = this.expand(data['append']);
      if (typeof original === 'string' && typeof append === 'string') return original + append;
      if (Array.isArray(original) && Array.isArray(append)) return [...original, ...append];
      throw new Error('Capture value append requires matching string or array types');
    }
    return Object.fromEntries(
      Object.entries(data).map(([key, child]) => [key, this.expand(child)]),
    );
  }

  page(handle: string, index: number) {
    if (!this.values.has(handle) || !Number.isSafeInteger(index) || index < 0)
      throw new Error('Invalid capture value detail cursor');
    let cursor = 0;
    const pages = detailPages(this.values.get(handle), this.limit);
    for (const page of pages) {
      if (cursor++ !== index) continue;
      return { page, nextIndex: pages.next().done ? null : index + 1 };
    }
    throw new Error('Invalid capture value detail cursor');
  }
}
