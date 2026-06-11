import { access, mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  captureWatchUiRuntimeSnapshot,
  createWatchUiRuntimeSnapshotSignature,
  readWatchUiRuntimeSnapshotHandoff,
  writeWatchUiRuntimeSnapshotHandoff,
  type WatchUiRuntimeModel,
  type WatchUiRuntimeSnapshot,
} from '../../extensions/merge-ready/watch-ui/runtime-snapshot.js';

const MODEL: WatchUiRuntimeModel = {
  id: 'claude-sonnet-4-20250514',
  name: 'Claude Sonnet 4',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1/messages',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

describe('merge-ready watch UI runtime snapshot', () => {
  it('captures the full parent runtime contract and signatures resolved auth changes', async () => {
    const first = await captureWatchUiRuntimeSnapshot({
      agentDir: '/tmp/agent-dir',
      defaultCwd: '/tmp/repo',
      getThinkingLevel: () => 'high',
      model: MODEL,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true as const,
          apiKey: 'sk-runtime-one',
          headers: {
            Authorization: 'Bearer runtime-one',
            'anthropic-beta': 'tools-2025-06-09',
          },
        })),
      },
      sdkVersion: '0.78.1',
    });
    const second = await captureWatchUiRuntimeSnapshot({
      agentDir: '/tmp/agent-dir',
      defaultCwd: '/tmp/repo',
      getThinkingLevel: () => 'high',
      model: MODEL,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true as const,
          apiKey: 'sk-runtime-two',
          headers: {
            Authorization: 'Bearer runtime-two',
            'anthropic-beta': 'tools-2025-06-09',
          },
        })),
      },
      sdkVersion: '0.78.1',
    });

    expect(first).toMatchObject({
      sdkVersion: '0.78.1',
      agentDir: '/tmp/agent-dir',
      defaultCwd: '/tmp/repo',
      thinkingLevel: 'high',
      auth: {
        provider: 'anthropic',
        apiKey: 'sk-runtime-one',
        headers: {
          Authorization: 'Bearer runtime-one',
          'anthropic-beta': 'tools-2025-06-09',
        },
      },
      model: {
        provider: 'anthropic',
        id: MODEL.id,
        headers: {
          Authorization: 'Bearer runtime-one',
          'anthropic-beta': 'tools-2025-06-09',
        },
      },
    });
    expect(first.signature).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.signature).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.signature).not.toBe(first.signature);
  });

  it('rejects unresolved auth placeholders before writing a handoff', async () => {
    await expect(
      captureWatchUiRuntimeSnapshot({
        agentDir: '/tmp/agent-dir',
        defaultCwd: '/tmp/repo',
        getThinkingLevel: () => 'high',
        model: MODEL,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({
            ok: true as const,
            apiKey: '$PI_PROXY_API_KEY',
            headers: {
              Authorization: '$PI_PROXY_AUTH_HEADER',
            },
          })),
        },
        sdkVersion: '0.78.1',
      }),
    ).rejects.toThrow('runtime snapshot auth apiKey still looks unresolved');
  });

  it('writes a private handoff file and removes it after the supervisor reads it', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-runtime-'));
    const snapshot = createSnapshot({
      agentDir: stateDir,
      defaultCwd: stateDir,
    });

    const handoffPath = await writeWatchUiRuntimeSnapshotHandoff({ stateDir }, snapshot);
    const fileMode = (await stat(handoffPath)).mode & 0o777;
    expect(fileMode).toBe(0o600);

    const loaded = await readWatchUiRuntimeSnapshotHandoff(handoffPath, {
      expectedSdkVersion: snapshot.sdkVersion,
    });
    expect(loaded).toEqual(snapshot);
    await expect(access(handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails with a clear SDK version mismatch and still removes the handoff file', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-runtime-'));
    const snapshot = createSnapshot({
      sdkVersion: '0.74.0',
      agentDir: stateDir,
      defaultCwd: stateDir,
    });

    const handoffPath = await writeWatchUiRuntimeSnapshotHandoff({ stateDir }, snapshot);
    await expect(
      readWatchUiRuntimeSnapshotHandoff(handoffPath, {
        expectedSdkVersion: '0.78.1',
      }),
    ).rejects.toThrow('runtime snapshot SDK version mismatch');
    await expect(access(handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function createSnapshot(overrides: Partial<WatchUiRuntimeSnapshot> = {}): WatchUiRuntimeSnapshot {
  const snapshotWithoutSignature: Omit<WatchUiRuntimeSnapshot, 'signature'> = {
    sdkVersion: overrides.sdkVersion ?? '0.78.1',
    agentDir: overrides.agentDir ?? '/tmp/agent-dir',
    defaultCwd: overrides.defaultCwd ?? '/tmp/repo',
    model: {
      ...MODEL,
      ...overrides.model,
    },
    thinkingLevel: overrides.thinkingLevel ?? 'high',
    auth: {
      provider: overrides.auth?.provider ?? 'anthropic',
      ...(overrides.auth?.apiKey === undefined
        ? { apiKey: 'sk-runtime-secret' }
        : { apiKey: overrides.auth.apiKey }),
      headers:
        overrides.auth?.headers === undefined
          ? {
              Authorization: 'Bearer runtime-secret',
              'anthropic-beta': 'tools-2025-06-09',
            }
          : overrides.auth.headers,
    },
  };

  return {
    ...snapshotWithoutSignature,
    signature: createWatchUiRuntimeSnapshotSignature(snapshotWithoutSignature),
  };
}
