import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { LocalUsageEvent, UsageAggregate } from './types.js';
import { ZERO_AGGREGATE } from './types.js';

export type { LocalUsageEvent };

const DEFAULT_LOCAL_USAGE_DIR = path.join(os.homedir(), '.pi', 'openrouter', 'usage');

// Allow overriding usage directory for testing
let localUsageDirOverride: string | null = null;

/**
 * Get the local usage directory.
 * Uses override if set (for testing), otherwise uses default.
 */
function getLocalUsageDir(): string {
  return localUsageDirOverride ?? DEFAULT_LOCAL_USAGE_DIR;
}

/**
 * Set a custom local usage directory (for testing).
 * Pass null to reset to default.
 */
export function setLocalUsageDir(dir: string | null): void {
  localUsageDirOverride = dir;
}

/**
 * Default retention period for local usage files (90 days).
 * Files older than this will be deleted during opportunistic cleanup.
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Check if debug logging is enabled via environment variable.
 * When PI_OPENROUTER_DEBUG_USAGE=1, verbose logging is enabled.
 * Otherwise, logging is quiet to avoid noise.
 */
function isDebugEnabled(): boolean {
  return process.env['PI_OPENROUTER_DEBUG_USAGE'] === '1';
}

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
 *
 * Performs opportunistic cleanup of old files after successful write.
 * All errors fail open - logged only when debug flag is enabled.
 */
export async function writeLocalUsage(event: LocalUsageEvent): Promise<void> {
  try {
    const dateStr = getUtcDateFromTimestamp(event.completedAt);
    const usageDir = getLocalUsageDir();
    const filePath = path.join(usageDir, `${dateStr}.jsonl`);

    await fs.mkdir(usageDir, { recursive: true });

    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(filePath, line, 'utf8');

    // Opportunistically clean up old files after successful write
    // This is fire-and-forget - errors are caught and logged only if debug is enabled
    cleanupOldUsageFiles().catch((err) => {
      if (isDebugEnabled()) {
        console.error('[local-usage] Background cleanup failed:', err);
      }
    });
  } catch (err) {
    // Fail open - log but don't throw to avoid breaking the user experience
    if (isDebugEnabled()) {
      console.error('[local-usage] Failed to write usage event:', err);
    }
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
  const usageDir = getLocalUsageDir();

  for (const dateStr of iterateDates(options.fromDateUtc, options.toDateUtc)) {
    const filePath = path.join(usageDir, `${dateStr}.jsonl`);

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
          if (isDebugEnabled()) {
            console.warn(`[local-usage] Malformed line in ${dateStr}.jsonl:`, parseErr);
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Missing file is OK - just no data for this date
        continue;
      }
      if (isDebugEnabled()) {
        console.error(`[local-usage] Failed to read ${dateStr}.jsonl:`, err);
      }
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

export interface CleanupOptions {
  /** Number of days to retain (default: 90) */
  retentionDays?: number;
}

/**
 * Delete local usage files older than the retention window.
 *
 * This is called opportunistically after writes and fails open.
 * Errors are logged only when debug flag is enabled.
 *
 * @param options - Cleanup configuration
 * @param options.retentionDays - Days to retain (default: 90)
 */
export async function cleanupOldUsageFiles(options: CleanupOptions = {}): Promise<void> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const usageDir = getLocalUsageDir();

  try {
    // Calculate cutoff date
    const today = getCurrentUtcDate();
    const cutoffDate = addUtcDays(today, -retentionDays);

    // List all files in usage directory
    const files = await fs.readdir(usageDir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

    let deletedCount = 0;

    for (const filename of jsonlFiles) {
      try {
        // Extract date from filename (YYYY-MM-DD.jsonl)
        const dateStr = filename.replace('.jsonl', '');

        // Validate date format and value
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          // Skip malformed filenames
          continue;
        }

        const fileDate = new Date(dateStr + 'T00:00:00Z');
        if (isNaN(fileDate.getTime())) {
          // Skip invalid dates
          continue;
        }

        // Delete if older than cutoff
        if (dateStr < cutoffDate) {
          const filePath = path.join(usageDir, filename);
          await fs.unlink(filePath);
          deletedCount++;
        }
      } catch (err) {
        // Skip individual file errors
        if (isDebugEnabled()) {
          console.error(`[local-usage] Failed to delete ${filename}:`, err);
        }
      }
    }

    if (isDebugEnabled() && deletedCount > 0) {
      console.log(
        `[local-usage] Cleaned up ${deletedCount} old usage file${deletedCount === 1 ? '' : 's'}`,
      );
    }
  } catch (err) {
    // Fail open on directory read errors
    if (isDebugEnabled()) {
      console.error('[local-usage] Failed to cleanup old usage files:', err);
    }
  }
}
