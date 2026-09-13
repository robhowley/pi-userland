import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadJunctionConfig,
  matchDescriptionReservation,
} from '../extensions/cmux-junction/config.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

describe.sequential('junction config', () => {
  let originalAgentDir: string | undefined;
  let root: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
    root = mkdtempSync(join(tmpdir(), 'pi-cmux-junction-config-'));
    cwd = join(root, 'repo');
    agentDir = join(root, 'agent');
    mkdirSync(cwd, { recursive: true });
    process.env['PI_CODING_AGENT_DIR'] = agentDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env['PI_CODING_AGENT_DIR'];
    } else {
      process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const globalSettingsPath = () => join(agentDir, 'settings.json');
  const projectSettingsPath = () => join(cwd, '.pi', 'settings.json');

  it('defaults status on and presentation off without publication authority', () => {
    expect(loadJunctionConfig(cwd, true)).toEqual({
      disableStatus: false,
      enablePresentation: false,
      descriptionReservations: [],
    });
  });

  it.each([true, false])('loads global disableStatus=%s', (disableStatus) => {
    writeJson(globalSettingsPath(), { 'pi-cmux-junction': { disableStatus } });

    expect(loadJunctionConfig(cwd, true).disableStatus).toBe(disableStatus);
  });

  it.each([
    { global: true, project: false },
    { global: false, project: true },
  ])('lets trusted project $project override global $global', ({ global, project }) => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: global },
    });
    writeJson(projectSettingsPath(), {
      'pi-cmux-junction': { disableStatus: project },
    });

    expect(loadJunctionConfig(cwd, true).disableStatus).toBe(project);
  });

  it('does not read or apply an untrusted project setting', () => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: false },
    });
    writeJson(projectSettingsPath(), {
      'pi-cmux-junction': { disableStatus: true },
    });

    expect(loadJunctionConfig(cwd, false).disableStatus).toBe(false);
  });

  it.each([
    { 'pi-cmux-junction': { disableStatus: 'true' } },
    { 'pi-cmux-junction': 'malformed' },
    { 'pi-cmux-junction': [] },
  ])('falls back to global for an invalid or malformed project scope', (project) => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: true },
    });
    writeJson(projectSettingsPath(), project);

    expect(loadJunctionConfig(cwd, true).disableStatus).toBe(true);
  });

  it('falls back to global when project settings JSON is malformed', () => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: true },
    });
    mkdirSync(dirname(projectSettingsPath()), { recursive: true });
    writeFileSync(projectSettingsPath(), '{', 'utf8');

    expect(loadJunctionConfig(cwd, true).disableStatus).toBe(true);
  });

  it.each([{ 'pi-cmux-junction': { disableStatus: 1 } }, { 'pi-cmux-junction': null }, []])(
    'falls back to false for an invalid or malformed global scope',
    (global) => {
      writeJson(globalSettingsPath(), global);

      expect(loadJunctionConfig(cwd, true).disableStatus).toBe(false);
    },
  );

  it('falls back to false when global settings JSON is malformed', () => {
    mkdirSync(dirname(globalSettingsPath()), { recursive: true });
    writeFileSync(globalSettingsPath(), '{', 'utf8');

    expect(loadJunctionConfig(cwd, true).disableStatus).toBe(false);
  });

  it('uses trusted opt-in precedence but only global multi-workspace reservations', () => {
    const first = {
      socketPath: '/tmp/cmux.sock',
      windowId: '11111111-1111-1111-1111-111111111111',
      workspaceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    };
    const second = { ...first, workspaceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': {
        disableStatus: true,
        enablePresentation: true,
        descriptionReservations: [first, second, { ...first, windowId: 'window:1' }],
      },
    });
    writeJson(projectSettingsPath(), {
      'pi-cmux-junction': {
        enablePresentation: false,
        descriptionReservations: [{ ...first, windowId: '22222222-2222-2222-2222-222222222222' }],
      },
    });
    expect(loadJunctionConfig(cwd, true)).toEqual({
      disableStatus: true,
      enablePresentation: false,
      descriptionReservations: [first, second],
    });
    const config = loadJunctionConfig(cwd, false);
    expect(config.enablePresentation).toBe(true);
    expect(
      matchDescriptionReservation(config.descriptionReservations, {
        ...second,
        socketPath: '/tmp/./cmux.sock',
      }),
    ).toEqual(second);
    expect(matchDescriptionReservation([first, first], first)).toBeUndefined();
    expect(
      matchDescriptionReservation([first], { ...first, socketPath: '/tmp/foreign.sock' }),
    ).toBeUndefined();
  });
});
