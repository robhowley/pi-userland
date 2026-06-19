import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSetStatusMirror } from '../../extensions/session-deck/chips/mirror.js';
import {
  getPresenceRuntimeIdentity,
  resetPresenceRuntimeForTests,
} from '../../extensions/session-deck/presence/runtime.js';

const createdDirectories: string[] = [];

async function createTestDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-deck-mirror-'));
  createdDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  await resetPresenceRuntimeForTests();
  await Promise.all(
    createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeUi(setStatus?: (key: string, text: string | undefined) => void) {
  return { setStatus: setStatus ?? vi.fn() };
}

async function readChipFile(dir: string, runtimeId: string, source: string): Promise<unknown> {
  const filePath = join(dir, runtimeId, `${source}.default.session.json`);
  return JSON.parse(await readFile(filePath, 'utf8'));
}

describe('createSetStatusMirror', () => {
  describe('install', () => {
    it('wraps setStatus without calling setFooter', () => {
      const mirror = createSetStatusMirror();
      const original = vi.fn();
      const ui = makeUi(original);

      mirror.reconfigure({
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      // Wrapper installed — original still works
      ui.setStatus('test-key', 'hello');

      expect(original).toHaveBeenCalledWith('test-key', 'hello');
    });

    it('does not double-wrap on repeated install', () => {
      const mirror = createSetStatusMirror();
      const original = vi.fn();
      const ui = makeUi(original);

      mirror.reconfigure({
        runtimeId: 'runtime-1',
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);
      mirror.install(ui); // second install should be noop

      ui.setStatus('test-key', 'hello');

      expect(original).toHaveBeenCalledTimes(1);
    });
  });

  describe('mirror writes', () => {
    it('writes a chip file for each setStatus call', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const diagnostics: string[] = [];
      const mirror = createSetStatusMirror({
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('pi-openrouter', 'connected');
      // Await internal async work
      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toContain('pi-openrouter.default.session.json');
      });

      const record = await readChipFile(dir, runtime.runtimeId, 'pi-openrouter');
      expect(record).toMatchObject({
        source: 'pi-openrouter',
        text: 'connected',
        scope: 'session',
        chipId: 'default',
        runtimeId: runtime.runtimeId,
        sessionId: 'session-1',
      });

      expect(diagnostics).toEqual([]);
    });

    it('stores ANSI-colored text as plain visible text', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const mirror = createSetStatusMirror({ directory: dir });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('pi-test', '\x1b[32mhealthy\x1b[0m');

      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toContain('pi-test.default.session.json');
      });

      const record = await readChipFile(dir, runtime.runtimeId, 'pi-test');
      expect(record).toMatchObject({
        source: 'pi-test',
        text: 'healthy',
      });
    });

    it('does not rewrite identical status text', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const mirror = createSetStatusMirror({ directory: dir });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('pi-dupe', 'same text');
      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toHaveLength(1);
      });

      // Read the file to get the updatedAt before second call
      const before = await readChipFile(dir, runtime.runtimeId, 'pi-dupe') as Record<string, unknown>;
      const beforeUpdatedAt = before['updatedAt'] as string;

      // Wait a tick, then set the same text again
      await new Promise((r) => setTimeout(r, 100));
      ui.setStatus('pi-dupe', 'same text');

      // Let any async work settle
      await new Promise((r) => setTimeout(r, 100));

      // File should still have the original updatedAt (not rewritten)
      const after = await readChipFile(dir, runtime.runtimeId, 'pi-dupe') as Record<string, unknown>;
      expect(after['updatedAt']).toBe(beforeUpdatedAt);
    });

    it('writes a new file when text changes for same source', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const mirror = createSetStatusMirror({ directory: dir });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('pi-change', 'first');
      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toHaveLength(1);
      });

      ui.setStatus('pi-change', 'second');
      await vi.waitFor(async () => {
        const record = await readChipFile(dir, runtime.runtimeId, 'pi-change');
        expect(record).toMatchObject({ text: 'second' });
      });
    });
  });

  describe('mirror clears', () => {
    it('clears mirrored chip when setStatus is called with undefined', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const mirror = createSetStatusMirror({ directory: dir });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('pi-clear', 'present');
      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toHaveLength(1);
      });

      ui.setStatus('pi-clear', undefined);
      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toHaveLength(0);
      });
    });

    it('clears mirrored chip when text is empty after sanitize', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const mirror = createSetStatusMirror({ directory: dir });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('pi-empty', 'present');
      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toHaveLength(1);
      });

      ui.setStatus('pi-empty', '\x1b[0m   ');
      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toHaveLength(0);
      });
    });

    it('does not clear unknown source (no error)', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const diagnostics: string[] = [];
      const mirror = createSetStatusMirror({
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      // Clear a source that was never written — should be silent
      ui.setStatus('never-written', undefined);

      // Let async work settle
      await new Promise((r) => setTimeout(r, 100));

      expect(diagnostics).toEqual([]);
    });
  });

  describe('clearTracked', () => {
    it('clears all tracked mirrored entries', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const mirror = createSetStatusMirror({ directory: dir });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('source-a', 'text a');
      ui.setStatus('source-b', 'text b');

      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toHaveLength(2);
      });

      await mirror.clearTracked();

      const files = await readdir(join(dir, runtime.runtimeId));
      expect(files).toHaveLength(0);
    });
  });

  describe('first class behavior', () => {
    it('does not mirror without reconfigure (no runtime context)', async () => {
      const dir = await createTestDir();
      const diagnostics: string[] = [];
      const mirror = createSetStatusMirror({
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      });
      const ui = makeUi();

      // Install without reconfigure
      mirror.install(ui);

      // Should still call original
      const original = vi.fn();
      const ui2 = makeUi(original);
      mirror.install(ui2);
      ui2.setStatus('test', 'hello');

      expect(original).toHaveBeenCalledWith('test', 'hello');
    });

    it('rejects invalid source slugs silently', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const diagnostics: string[] = [];
      const mirror = createSetStatusMirror({
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      });
      const ui = makeUi();

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      ui.setStatus('INVALID/SLUG', 'text');

      await vi.waitFor(() => {
        expect(diagnostics).toContain('chip_source_invalid');
      });
    });

    it('mirrors session-deck own status (wrapper installed before setStatus call)', async () => {
      const dir = await createTestDir();
      const runtime = getPresenceRuntimeIdentity();
      const mirror = createSetStatusMirror({ directory: dir });
      const original = vi.fn();
      const ui = makeUi(original);

      mirror.reconfigure({
        runtimeId: runtime.runtimeId,
        getSessionId: () => 'session-1',
      });
      mirror.install(ui);

      // Simulate session-deck setting its own status after wrapper installation
      ui.setStatus('session-deck', 'healthy');

      await vi.waitFor(async () => {
        const files = await readdir(join(dir, runtime.runtimeId));
        expect(files).toContain('session-deck.default.session.json');
      });
    });
  });
});
