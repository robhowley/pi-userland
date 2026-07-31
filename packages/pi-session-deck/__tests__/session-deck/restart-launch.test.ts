import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeRestartRecipe } from '../../extensions/session-deck/restart/store.js';
import type { ManagedRestartRecipeV1 } from '../../extensions/session-deck/restart/types.js';
import { launchDetachedTmuxPiForCwd } from '../../extensions/session-deck/worktree/launch.js';

const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';
const MANAGED_LAUNCH_SECRET = 'managed-launch-secret-sentinel';

describe('managed restart launch recipe', () => {
  it('writes the fixed private recipe before tmux spawn and passes the assigned runtime id', async () => {
    const events: string[] = [];
    let recipe: ManagedRestartRecipeV1 | null = null;
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'tmux' && args[0] === '-V')
        return { stdout: 'tmux 3.7b\n', stderr: '', exitCode: 0 };
      if (file === 'which') return { stdout: '/opt/pi/bin/pi\n', stderr: '', exitCode: 0 };
      if (file === 'tmux' && args[0] === 'has-session')
        return { stdout: '', stderr: '', exitCode: 1 };
      if (file === 'tmux' && args[0] === 'new-session') {
        events.push('spawn');
        expect(recipe).not.toBeNull();
        expect(args.at(-1)).toContain(`PI_SESSION_DECK_ASSIGNED_RUNTIME_ID=${RUNTIME_ID}`);
        expect(args.at(-1)).toContain('/opt/pi/bin/pi');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message')
        return { stdout: '/tmp/project\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const result = await launchDetachedTmuxPiForCwd(
      { cwd: '/tmp/project', repoName: 'project' },
      'project',
      {
        execFile,
        env: {
          PATH: '/opt/pi/bin:/usr/bin',
          PI_CODING_AGENT_DIR: '/Users/test/.pi/agent-custom',
          PI_CODING_AGENT_SESSION_DIR: '/Users/test/.pi/sessions-custom',
          OPENAI_API_KEY: MANAGED_LAUNCH_SECRET,
        },
        postLaunchVerifyDelayMs: 0,
        randomUUID: () => RUNTIME_ID,
        writeRestartRecipe: async (value) => {
          events.push('recipe');
          recipe = value;
        },
      },
    );

    expect(result).toMatchObject({ ok: true, runtimeId: RUNTIME_ID });
    expect(events).toEqual(['recipe', 'spawn']);
    expect(recipe).toMatchObject({
      runtimeId: RUNTIME_ID,
      launch: {
        piExecutable: '/opt/pi/bin/pi',
        effectivePath: '/opt/pi/bin:/usr/bin',
        agentDir: { mode: 'ambient', path: '/Users/test/.pi/agent-custom' },
        sessionDir: { mode: 'explicit', path: '/Users/test/.pi/sessions-custom' },
      },
      cwd: '/tmp/project',
      tmux: { socketSelector: 'name:default', windowIndex: 0, paneIndex: 0 },
    });
    expect(JSON.stringify(recipe)).not.toContain(MANAGED_LAUNCH_SECRET);
  });

  it('rejects an invalid managed recipe before tmux spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-deck-invalid-managed-launch-'));
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'tmux' && args[0] === '-V')
        return { stdout: 'tmux 3.7b\n', stderr: '', exitCode: 0 };
      if (file === 'which') return { stdout: '/opt/pi/bin/pi\n', stderr: '', exitCode: 0 };
      if (file === 'tmux' && args[0] === 'has-session')
        return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    await expect(
      launchDetachedTmuxPiForCwd({ cwd: '/tmp/project', repoName: 'project' }, 'project', {
        execFile,
        env: {
          PATH: '/opt/pi/bin:/usr/bin',
          PI_CODING_AGENT_DIR: 'relative-agent-dir',
        },
        randomUUID: () => RUNTIME_ID,
        writeRestartRecipe: async (recipe) => writeRestartRecipe(recipe, directory),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'spawn-failed' });
    expect(
      execFile.mock.calls.some(([file, args]) => file === 'tmux' && args[0] === 'new-session'),
    ).toBe(false);
  });
});
