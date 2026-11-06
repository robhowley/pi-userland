import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEBIBYTE = 1024 * 1024;
export const MEMORY_HEAP_MEBIBYTES = 192;
export const MAIN_PAYLOAD_BYTES = 28 * MEBIBYTE;
export const NEAR_LIMIT_PAYLOAD_BYTES = 31 * MEBIBYTE;
export const OVER_LIMIT_PAYLOAD_BYTES = 32 * MEBIBYTE + 128 * 1024;
export const MAX_ARCHIVE_BYTES = 256 * MEBIBYTE;

export type MemoryArchive = {
  root: string;
  sourceFiles: string[];
  nearLimitFile: string;
  overLimitFile: string;
  sourceIds: string[];
  diskBytes: number;
};

function toolRecord(id: string, parentId: string, payloadBytes: number) {
  const first = Math.floor(payloadBytes / 2);
  const image = 'i'.repeat(first);
  const output = 't'.repeat(payloadBytes - first);
  return {
    type: 'message',
    id: `tool-${id}`,
    parentId,
    timestamp: '2026-01-30T00:00:01.000Z',
    message: {
      role: 'toolResult',
      content: [
        { type: 'image', data: image },
        { type: 'text', text: output },
      ],
    },
  };
}

function visibleRecord(id: string, entryId: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id: entryId,
    parentId,
    timestamp: '2026-01-30T00:00:02.000Z',
    message: { role: id === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text }] },
  };
}

function writeSession(file: string, sessionId: string, payloadBytes: number) {
  const userId = `user-${sessionId}`;
  const toolId = `tool-${sessionId}`;
  const assistantId = `assistant-${sessionId}`;
  const records = [
    { type: 'session', id: sessionId, cwd: '/memory-test' },
    visibleRecord('user', userId, null, `user-${sessionId}`),
    toolRecord(sessionId, userId, payloadBytes),
    visibleRecord('assistant', assistantId, toolId, `assistant-${sessionId}`),
  ];
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { userId, toolId, assistantId };
}

export function createMemoryArchive(root: string): MemoryArchive {
  mkdirSync(root, { recursive: true });
  const sourceFiles: string[] = [];
  const sourceIds: string[] = [];

  for (let index = 0; index < 6; index += 1) {
    const sessionId = `memory-${String(index).padStart(2, '0')}`;
    const file = join(root, `source-${String(index).padStart(2, '0')}.jsonl`);
    writeSession(file, sessionId, MAIN_PAYLOAD_BYTES);
    sourceFiles.push(file);
    sourceIds.push(sessionId);
  }

  const nearLimitFile = join(root, 'source-near-limit.jsonl');
  const nearLimitId = 'memory-near-limit';
  writeSession(nearLimitFile, nearLimitId, NEAR_LIMIT_PAYLOAD_BYTES);
  sourceFiles.push(nearLimitFile);
  sourceIds.push(nearLimitId);

  const limitDirectory = join(root, 'limit-edge');
  mkdirSync(limitDirectory);
  const overLimitFile = join(limitDirectory, 'over-limit.jsonl');
  writeSession(overLimitFile, 'memory-over-limit', OVER_LIMIT_PAYLOAD_BYTES);

  const diskBytes = [...sourceFiles, overLimitFile].reduce(
    (total, file) => total + statSync(file).size,
    0,
  );
  if (diskBytes > MAX_ARCHIVE_BYTES)
    throw new Error(`Memory fixture exceeds ${MAX_ARCHIVE_BYTES} bytes: ${diskBytes}`);

  return { root, sourceFiles, nearLimitFile, overLimitFile, sourceIds, diskBytes };
}
