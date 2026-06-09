import { readFile } from 'node:fs/promises';
import {
  MERGE_READY_WATCH_STATUS_CUSTOM_TYPE,
  type MergeReadyWatchStatusRecord,
} from '../watch-status.js';

export type MergeReadyTranscriptRow = {
  timestamp: string;
  kind: 'user' | 'assistant' | 'tool' | 'watch-status' | 'custom';
  label: string;
  text: string;
};

export async function readMergeReadyTranscript(
  sessionFile: string,
  tail = 200,
): Promise<MergeReadyTranscriptRow[]> {
  const content = await readFile(sessionFile, 'utf8');
  const rows = parseMergeReadyTranscript(content);
  return rows.slice(Math.max(0, rows.length - Math.max(1, tail)));
}

export function parseMergeReadyTranscript(content: string): MergeReadyTranscriptRow[] {
  const rows: MergeReadyTranscriptRow[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = typeof entry['type'] === 'string' ? entry['type'] : undefined;
    const timestamp = normalizeTimestamp(entry['timestamp']);

    if (entryType === 'message') {
      const message = isRecord(entry['message']) ? entry['message'] : null;
      const role = typeof message?.['role'] === 'string' ? message['role'] : undefined;
      if (role === 'user') {
        rows.push({
          timestamp,
          kind: 'user',
          label: 'User',
          text: readMessageText(message?.['content']),
        });
        continue;
      }

      if (role === 'assistant') {
        rows.push({
          timestamp,
          kind: 'assistant',
          label: 'Assistant',
          text: readAssistantText(message?.['content']),
        });
        continue;
      }

      if (role === 'toolResult') {
        const toolName = typeof message?.['toolName'] === 'string' ? message['toolName'] : 'tool';
        const isError = message?.['isError'] === true;
        rows.push({
          timestamp,
          kind: 'tool',
          label: isError ? `${toolName} error` : toolName,
          text: readMessageText(message?.['content']),
        });
      }

      continue;
    }

    if (entryType === 'custom') {
      const customType = typeof entry['customType'] === 'string' ? entry['customType'] : undefined;
      if (
        customType === MERGE_READY_WATCH_STATUS_CUSTOM_TYPE &&
        isRecord(entry['data']) &&
        typeof entry['data']['lifecycle'] === 'string' &&
        typeof entry['data']['summary'] === 'string'
      ) {
        const status = entry['data'] as unknown as MergeReadyWatchStatusRecord;
        rows.push({
          timestamp,
          kind: 'watch-status',
          label: `${status.lifecycle}/${status.mergeReadyState}`,
          text: status.summary,
        });
        continue;
      }

      rows.push({
        timestamp,
        kind: 'custom',
        label: customType ?? 'custom',
        text: readLooseText(entry['data']),
      });
    }
  }

  return rows;
}

function readAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return readMessageText(content);
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    if (item['type'] === 'text' && typeof item['text'] === 'string') {
      parts.push(item['text']);
      continue;
    }

    if (item['type'] === 'toolCall' && typeof item['name'] === 'string') {
      parts.push(`Tool call: ${item['name']}`);
    }
  }

  return parts.join('\n').trim();
}

function readMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      if (item['type'] === 'text' && typeof item['text'] === 'string') {
        return [item['text']];
      }

      if (item['type'] === 'image') {
        return ['[image]'];
      }

      return [];
    })
    .join('\n')
    .trim();
}

function readLooseText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
