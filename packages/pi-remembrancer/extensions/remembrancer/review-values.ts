import { isDeepStrictEqual } from 'node:util';
import { detailPages, object, text } from './review-findings.js';
import { estimateReviewerTokens } from './reviewer-budget.js';

type Retained = {
  value: unknown;
  issued: boolean;
  pages: object[];
  iterator?: Generator<object>;
  done: boolean;
};

/** Attempt-local originals. Sizing retains values but only issue() authorizes model access. */
export class ReviewValues {
  private readonly values = new Map<string, Retained>();
  private readonly handles = new Map<string, string[]>();
  private readonly transport = new WeakMap<object, unknown>();
  constructor(
    private readonly limit: number,
    private readonly workingLimit: number,
  ) {}

  private marker(value: object, original: unknown) {
    this.transport.set(value, original);
    return value;
  }

  private original(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (this.transport.has(value)) return this.original(this.transport.get(value));
    if (Array.isArray(value)) return value.map((child) => this.original(child));
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, this.original(child)]),
    );
  }

  private retain(value: unknown) {
    // Callers may combine already compacted fields into a new aggregate.
    value = this.original(value);
    const key = JSON.stringify(value);
    const candidates = this.handles.get(key) ?? [];
    let handle = candidates.find((id) => isDeepStrictEqual(this.values.get(id)!.value, value));
    if (!handle) {
      handle = `v${this.values.size + 1}`;
      this.values.set(handle, {
        value: structuredClone(value),
        issued: false,
        pages: [],
        done: false,
      });
      this.handles.set(key, [...candidates, handle]);
    }
    return this.marker({ valueHandle: handle }, value);
  }

  /** Pure with respect to authorization. Safe to call while testing candidate request sizes. */
  working(value: unknown, retain = true): unknown {
    if (value && typeof value === 'object' && this.transport.has(value)) return value;
    let working = value;
    if (Array.isArray(value)) working = value.map((child) => this.working(child, retain));
    else if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, child]) => [
        key,
        this.working(child, retain),
      ]);
      // Escape reserved keys even for small objects and arbitrary task custom fields.
      working =
        'valueHandle' in value || 'valueLiteral' in value
          ? this.marker({ valueLiteral: entries }, value)
          : Object.fromEntries(entries);
    }
    // Exact inspection pages were bounded by their producer. Escape reserved keys
    // without hiding the requested text or continuation cursors behind another handle.
    if (!retain || estimateReviewerTokens(working) <= this.limit) return working;
    // Preserve aggregate paging: compact children can share a larger working request.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (estimateReviewerTokens(working) <= this.workingLimit) return working;
    }
    return this.retain(value);
  }

  /** Call on the exact encoded payload after dispatch succeeds, before interpreting its reply. */
  issue<T>(value: T): T {
    if (!value || typeof value !== 'object') return value;
    if (this.isHandle(value)) this.values.get(text(object(value)['valueHandle']))!.issued = true;
    else for (const child of Object.values(value)) this.issue(child);
    return value;
  }

  isHandle(value: unknown): boolean {
    return (
      !!value && typeof value === 'object' && this.transport.has(value) && 'valueHandle' in value
    );
  }

  hasHandles(value: unknown): boolean {
    return (
      !!value &&
      typeof value === 'object' &&
      (this.isHandle(value) || Object.values(value).some((child) => this.hasHandles(child)))
    );
  }

  /** Reject unissued handles and mixed copy objects before normal draft validation. */
  expand(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((child) => this.expand(child));
    const data = object(value);
    if ('valueLiteral' in data) {
      if (Object.keys(data).length !== 1 || !Array.isArray(data['valueLiteral']))
        throw new Error('Invalid capture value literal');
      const entries = data['valueLiteral'].map((entry: unknown) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
          throw new Error('Invalid capture value literal');
        return [entry[0], this.expand(entry[1])] as const;
      });
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw new Error('Invalid capture value literal');
      return Object.fromEntries(entries);
    }
    if ('valueHandle' in data) {
      if (
        Object.keys(data).some((key) => !['valueHandle', 'append'].includes(key)) ||
        !this.values.get(text(data['valueHandle']))?.issued
      )
        throw new Error('Invalid capture value handle');
      const original = structuredClone(this.values.get(text(data['valueHandle']))!.value);
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
    const retained = this.values.get(handle);
    if (!retained?.issued || !Number.isSafeInteger(index) || index < 0)
      throw new Error('Invalid capture value detail cursor');
    retained.iterator ??= detailPages(retained.value, this.limit, [], (page, index) => ({
      page,
      // null is wider than a one-, two-, or three-digit continuation cursor.
      nextIndex: index + 1 < 1000 ? null : index + 1,
    }));
    // Keep one lookahead page, so repeated and sequential reads never restart traversal.
    while (!retained.done && retained.pages.length <= index + 1) {
      const next = retained.iterator.next();
      if (next.done) retained.done = true;
      else retained.pages.push(next.value);
    }
    const page = retained.pages[index];
    if (!page) throw new Error('Invalid capture value detail cursor');
    return structuredClone({
      page,
      nextIndex: index + 1 < retained.pages.length ? index + 1 : null,
    });
  }
}
