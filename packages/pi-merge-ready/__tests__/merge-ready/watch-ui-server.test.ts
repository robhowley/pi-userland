import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMergeReadyWatchUiSupervisorServer,
  type MergeReadyWatchUiRunner,
} from '../../extensions/merge-ready/watch-ui/supervisor-server.js';

describe('merge-ready watch UI supervisor server', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('serves health unauthenticated and gates API routes by bearer token', async () => {
    const publicDir = await createPublicDir();
    const watch = {
      id: 'one',
      canonicalUrl: 'https://github.com/shopify/pi/pull/64',
      cwd: '/repo',
      createdAt: '2026-06-08T12:00:00.000Z',
      updatedAt: '2026-06-08T12:01:00.000Z',
      state: 'active' as const,
      session: {
        sessionId: 'session-123',
        sessionFile: '/tmp/session.jsonl',
      },
      lastStatus: {
        schemaVersion: 1 as const,
        lifecycle: 'watching' as const,
        mergeReadyState: 'pending' as const,
        summary: 'Checks are still running',
        updatedAt: '2026-06-08T12:01:00.000Z',
        target: {
          mode: 'url' as const,
          requestedUrl: 'https://github.com/shopify/pi/pull/64',
        },
        session: {
          sessionId: 'session-123',
          sessionFile: '/tmp/session.jsonl',
        },
      },
    };

    const runner: MergeReadyWatchUiRunner = {
      addWatch: vi.fn(async (_options) => ({ created: true, watch })),
      getDefaultCwd: vi.fn(() => '/repo'),
      listWatches: vi.fn(() => [watch]),
      openWatch: vi.fn(async (_id) => null),
      readTranscriptForWatch: async (_id, _tail) => ({
        watch,
        rows: [
          {
            timestamp: '2026-06-08T12:00:00.000Z',
            kind: 'watch-status',
            label: 'watching/pending',
            text: 'Checks are still running',
          },
        ],
      }),
      removeWatch: vi.fn(async (_id) => true),
      stopWatch: vi.fn(async (_id) => null),
    };

    const server = await createMergeReadyWatchUiSupervisorServer({
      packageVersion: '0.6.0',
      publicDir,
      runner,
      snapshotLoaded: true,
      snapshotSignature: 'runtime-signature-1',
      token: 'token-123',
    });
    servers.push(server);

    const healthResponse = await fetch(`http://127.0.0.1:${String(server.port)}/api/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      service: 'merge-ready-watch-ui',
      packageVersion: '0.6.0',
      snapshotLoaded: true,
      snapshotSignature: 'runtime-signature-1',
    });

    const unauthorizedResponse = await fetch(`http://127.0.0.1:${String(server.port)}/api/watches`);
    expect(unauthorizedResponse.status).toBe(401);

    const authorizedResponse = await fetch(`http://127.0.0.1:${String(server.port)}/api/watches`, {
      headers: {
        Authorization: 'Bearer token-123',
      },
    });
    expect(authorizedResponse.status).toBe(200);
    await expect(authorizedResponse.json()).resolves.toMatchObject({
      defaultCwd: '/repo',
      watches: [
        {
          id: 'one',
          canonicalUrl: 'https://github.com/shopify/pi/pull/64',
        },
      ],
    });

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${String(server.port)}/api/watches/one/transcript?tail=1`,
      {
        headers: {
          Authorization: 'Bearer token-123',
        },
      },
    );
    expect(transcriptResponse.status).toBe(200);
    await expect(transcriptResponse.json()).resolves.toMatchObject({
      rows: [
        {
          label: 'watching/pending',
          text: 'Checks are still running',
        },
      ],
    });
  });
});

async function createPublicDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-'));
  const publicDir = path.join(tempDir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>watch-ui</title>');
  await writeFile(path.join(publicDir, 'app.js'), 'console.log("watch-ui")');
  await writeFile(path.join(publicDir, 'style.css'), 'body { color: white; }');
  return publicDir;
}
