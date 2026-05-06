import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { LocalUsageEvent, UsageAggregate } from './types.js';
import { ZERO_AGGREGATE } from './types.js';

export type { LocalUsageEvent };

const LOCAL_USAGE_DIR = path.join(os.homedir(), '.pi', 'openrouter', 'usage');

/**
 * Get current UTC date as YYYY-MM-DD
 */
export function getCurrentUtcDate(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/**
 * Extract UTC date from ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)
 */
export function getUtcDateFromTimestamp(isoString: string): string {
  return isoString.slice(0, 10);
}

/**
 * Add days to a YYYY-MM-DD date string, return new YYYY-MM-DD in UTC
 */
export function addUtcDays(dateStr: string, days: number): string {
  const date = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date string: ${dateStr}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Iterate dates from start to end (inclusive), return array of YYYY-MM-DD strings
 */
export function* iterateDates(start: string, end: string): Generator<string> {
  let current = start;
  while (current <= end) {
    yield current;
    current = addUtcDays(current, 1);
  }
}

/**
 * Append a single LocalUsageEvent to the appropriate daily JSONL file.
 * File is determined by UTC date from completedAt.
 */
export async function writeLocalUsage(event: LocalUsageEvent): Promise<void> {
  try {
    const dateStr = getUtcDateFromTimestamp(event.completedAt);
    const filePath = path.join(LOCAL_USAGE_DIR, `${dateStr}.jsonl`);

    await fs.mkdir(LOCAL_USAGE_DIR, { recursive: true });

    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(filePath, line, 'utf8');
  } catch (err) {
    // Fail open - log but don't throw to avoid breaking the user experience
    console.error('[local-usage] Failed to write usage event:', err);
  }
}

export interface ReadLocalUsageOptions {
  /** Start date inclusive (YYYY-MM-DD) */
  fromDateUtc: string;
  /** End date inclusive (YYYY-MM-DD) */
  toDateUtc: string;
}

/**
 * Read local usage events from JSONL files for the given date range.
 * Tolerates missing files, blank lines, and malformed lines.
 */
export async function readLocalUsage(options: ReadLocalUsageOptions): Promise<LocalUsageEvent[]> {
  const events: LocalUsageEvent[] = [];

  for (const dateStr of iterateDates(options.fromDateUtc, options.toDateUtc)) {
    const filePath = path.join(LOCAL_USAGE_DIR, `${dateStr}.jsonl`);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed) as LocalUsageEvent;
          events.push(event);
        } catch (parseErr) {
          // Skip malformed lines but continue
          console.warn(`[local-usage] Malformed line in ${dateStr}.jsonl:`, parseErr);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Missing file is OK - just no data for this date
        continue;
      }
      console.error(`[local-usage] Failed to read ${dateStr}.jsonl:`, err);
      // Continue to next date despite error
    }
  }

  return events;
}

/**
 * Aggregate local usage events into UsageAggregate.
 * Deduplicates by id (first occurrence wins).
 */
export function aggregateLocal(events: LocalUsageEvent[]): UsageAggregate {
  if (events.length === 0) {
    return ZERO_AGGREGATE;
  }

  // Deduplicate by id
  const seen = new Set<string>();
  const unique: LocalUsageEvent[] = [];

  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }

  // Aggregate
  const result = unique.reduce(
    (acc, event) => {
      acc.requests += event.requests ?? 1;
      acc.promptTokens += event.promptTokens || 0;
      acc.completionTokens += event.completionTokens || 0;
      acc.reasoningTokens += event.reasoningTokens || 0;
      acc.cacheReadTokens += event.cacheReadTokens || 0;
      acc.cacheWriteTokens += event.cacheWriteTokens || 0;
      acc.cost += event.cost || 0;
      return acc;
    },
    { ...ZERO_AGGREGATE },
  );
  return result;
}
