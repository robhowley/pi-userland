import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCoordinatorRuntime } from '../extensions/cmux-junction/coordinator.mjs';
import { resolveDescriptionTarget } from '../extensions/cmux-junction/description-publisher.mjs';
import { registerJunctionLifecycle } from '../extensions/cmux-junction/lifecycle.js';
import { attachPresentationClient } from '../extensions/cmux-junction/presentation-client.js';
import { createProducerViewStore } from '../extensions/cmux-junction/producer-view.js';

const socketPath = '/tmp/cmux.sock';
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const windowId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const target = { socketPath, workspaceId: a };

describe('automatic publication routing', () => {
  it.each([
    'focus',
    'workspace',
    'wrong-surface',
    'wrong-workspace',
    'wrong-window',
    'missing',
    'failure',
  ])('fails closed on %s lookup evidence', async (failure) => {
    const run = vi.fn(async (args: string[]) => {
      if (failure === 'failure') return { ok: false };
      if (args.includes('rpc'))
        return {
          ok: true,
          stdout: Buffer.from(
            JSON.stringify({
              source:
                failure === 'focus' ? 'focused' : failure === 'workspace' ? 'workspace' : 'surface',
              workspace_id: failure === 'wrong-workspace' ? b : a,
              surface_id: failure === 'wrong-surface' ? 'other' : 'surface-a',
            }),
          ),
        };
      return {
        ok: true,
        stdout: Buffer.from(
          JSON.stringify({
            caller: {
              workspace_id: a,
              surface_id: 'surface-a',
              window_id: failure === 'wrong-window' ? 'window:1' : windowId,
              surface_type: 'terminal',
              is_browser_surface: false,
              ...(failure === 'missing' ? { surface_id: undefined } : {}),
            },
          }),
        ),
      };
    });
    expect(await resolveDescriptionTarget(target, 'surface-a', run)).toBeNull();
    expect(run.mock.calls.flatMap(([args]) => args)).not.toContain('--focus');
  });

  it('enables a status-first coordinator, aggregates sessions, follows moves and withdraws on disable', async () => {
    const root = await mkdtemp('/tmp/junction-routing-');
    const descriptions = new Map<string, string | null>([
      [a, null],
      [b, null],
    ]);
    const live = new Map([
      ['surface-a', a],
      ['surface-b', a],
    ]);
    const writes: string[][] = [];
    let lookupAvailable = true;
    const execute = (_file: string, args: string[], _options: unknown, callback: Function) => {
      const reply = (value: unknown) => callback(null, Buffer.from(JSON.stringify(value)));
      if (args.includes('rpc')) {
        const input = JSON.parse(args.at(-1)!);
        return reply({
          source: 'surface',
          workspace_id: live.get(input.surface_id),
          surface_id: input.surface_id,
        });
      }
      if (args.includes('identify')) {
        const surfaceId = args[args.indexOf('--surface') + 1]!;
        return reply({
          caller: {
            window_id: windowId,
            workspace_id: live.get(surfaceId),
            surface_id: surfaceId,
            surface_type: 'terminal',
            is_browser_surface: false,
          },
        });
      }
      expect(args).toContain(windowId);
      if (args.includes('list')) {
        if (!lookupAvailable) return callback(new Error('old window cannot be verified'));
        return reply({
          window_id: windowId,
          workspaces: [...descriptions].map(([id, description]) => ({ id, description })),
        });
      }
      const workspace = args[args.indexOf('--workspace') + 1]!;
      writes.push(args);
      descriptions.set(workspace, args.includes('set-description') ? args.at(-1)! : null);
      return reply({});
    };
    const paths = (workspace: string) => ({
      directory: root,
      socketPath: join(root, workspace + '.sock'),
      ledgerPath: join(root, workspace + '.json'),
      lockPath: join(root, workspace + '.lock'),
    });
    const coordinators = await Promise.all(
      [a, b].map((workspace) =>
        runCoordinatorRuntime(
          [
            '--listen',
            paths(workspace).socketPath,
            '--ledger',
            paths(workspace).ledgerPath,
            '--cmux-socket',
            socketPath,
            '--workspace',
            workspace,
          ],
          {
            execFile: execute,
            probePid: () => 'match',
            publish: async () => ({ ok: true }),
            schedule: () => undefined,
            store: { read: async () => null, write: async () => {} },
          },
        ),
      ),
    );
    // A status-only source starts the shared process before routing is enabled.
    // Keep both processes alive so disable/re-enable can reuse them.
    for (const [index, runtime] of coordinators.entries()) {
      expect(
        await runtime.core.acceptSnapshot(
          {
            protocol: 'pi-junction.lifecycle.v1',
            kind: 'snapshot',
            workspaceId: [a, b][index],
            surfaceId: 'status-surface',
            sessionId: 'status-session',
            runtimeId: 'status-runtime',
            pid: 123,
            processStartedAt: 1000,
            connectionId: 'status-connection',
            ownerGeneration: null,
            revision: 0,
            sentAt: Date.now(),
            state: 'idle',
            toolName: null,
            transitionAt: Date.now(),
            lastEventAt: null,
            compactionAt: null,
          },
          'status-socket',
        ),
      ).toMatchObject({ ok: true });
    }
    const session = (surfaceId: string) => {
      const views = createProducerViewStore();
      const handlers = new Map<string, Function>();
      const maintenance: Array<() => void> = [];
      let enabled = false;
      let sessionId = 'session-' + surfaceId;
      const ctx = {
        mode: 'tui',
        cwd: '/repo',
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => sessionId },
        ui: {},
      };
      const attached: string[] = [];
      const observe = registerJunctionLifecycle(
        { on: (name: string, handler: Function) => handlers.set(name, handler) } as any,
        {
          producerViews: views,
          env: { CMUX_SOCKET_PATH: socketPath, CMUX_WORKSPACE_ID: a, CMUX_SURFACE_ID: surfaceId },
          loadConfig: () => ({ disableStatus: true, enablePresentation: enabled }),
          resolveTarget: async () => ({
            ok: true,
            socketPath,
            workspaceId: live.get(surfaceId)!,
            surfaceId,
          }),
          observeProcessStart: async () => 1000,
          attachPresentation: (store, options) => {
            attached.push(options.target.workspaceId);
            return attachPresentationClient(store, {
              ...options,
              createPaths: (target) => paths(target.workspaceId),
              preparePaths: async () => {},
              spawn: () => {
                throw new Error('must reuse coordinator');
              },
            });
          },
          setInterval: ((callback: () => void) => {
            maintenance.push(callback);
            return maintenance.length;
          }) as any,
          clearInterval: () => {},
        },
      );
      return {
        attached,
        views,
        announce(title: string) {
          observe();
          views.accept({
            producer: { key: 'test', label: 'Test' },
            items: [{ key: 'item', title }],
          });
        },
        start: () => handlers.get('session_start')!({}, ctx),
        stop: () => handlers.get('session_shutdown')!({}, ctx),
        enable(value: boolean) {
          enabled = value;
        },
        maintain() {
          maintenance.at(-1)?.();
        },
        changeSession() {
          sessionId += '-new';
        },
      };
    };
    const first = session('surface-a');
    const second = session('surface-b');
    try {
      await first.start();
      first.announce('First');
      expect(writes).toEqual([]);
      first.enable(true);
      await first.start();
      await vi.waitFor(() => expect(descriptions.get(a)).toContain('First'));
      second.enable(true);
      second.announce('Second');
      await second.start();
      await vi.waitFor(() => expect(descriptions.get(a)).toContain('Second'));
      expect(descriptions.get(a)).toContain('First');
      live.set('surface-a', b);
      first.maintain();
      await vi.waitFor(() => expect(descriptions.get(b)).toContain('First'));
      await vi.waitFor(() => expect(descriptions.get(a)).not.toContain('First'));
      expect(descriptions.get(a)).toContain('Second');
      expect(first.attached).toEqual([a, b]);
      expect(second.attached).toEqual([a]);
      first.changeSession();
      first.announce('New session');
      await vi.waitFor(() => expect(descriptions.get(b)).toContain('New session'));
      expect(descriptions.get(b)).not.toContain('First');
      first.enable(false);
      await first.start();
      await vi.waitFor(() => expect(descriptions.get(b)).toBeNull());
      expect(descriptions.get(a)).toContain('Second');
      // Final-source cleanup does not depend on a surviving surface. A failed
      // explicit old-window lookup still must leave the last owned bytes alone.
      lookupAvailable = false;
      live.delete('surface-b');
      const prior = descriptions.get(a);
      await second.stop();
      await coordinators[0]!.description.drain();
      expect(descriptions.get(a)).toBe(prior);
      lookupAvailable = true;
      await coordinators[0]!.description.reconcile();
      expect(descriptions.get(a)).toBeNull();
    } finally {
      await first.stop();
      await second.stop();
      await Promise.all(coordinators.map((runtime) => runtime.close()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
