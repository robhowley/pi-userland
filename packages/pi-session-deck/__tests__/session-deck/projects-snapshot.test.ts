import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAndAssignProject,
  deleteProject,
} from '../../extensions/session-deck/projects/actions.js';
import { writeIdentityRecord } from '../../extensions/session-deck/identity/writer.js';
import { writePresenceRecord } from '../../extensions/session-deck/presence/writer.js';
import { readSessionDeckSnapshot } from '../../extensions/session-deck/reader.js';
import {
  writeRestartJournal,
  writeRestartRecipe,
} from '../../extensions/session-deck/restart/store.js';
import type { SessionIdentityRecord } from '../../extensions/session-deck/identity/types.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';
const RECOVERY_RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';
const createdDirectories: string[] = [];

async function createDirectories() {
  const root = await mkdtemp(join(tmpdir(), 'session-deck-project-snapshot-'));
  createdDirectories.push(root);
  return {
    root,
    presenceDirectory: join(root, 'presence'),
    identityDirectory: join(root, 'identity'),
    activityDirectory: join(root, 'activity'),
    chipsDirectory: join(root, 'chips'),
    restartDirectory: join(root, 'restart'),
    projectsDirectory: join(root, 'projects'),
  };
}

function presence(runtimeId: string, pid: number): PresenceRecord {
  return {
    runtimeId,
    pid,
    startedAt: '2026-08-01T12:00:00.000Z',
    heartbeatAt: '2026-08-01T12:09:55.000Z',
  };
}

function identity(runtimeId: string, sessionId: string): SessionIdentityRecord {
  return {
    runtimeId,
    sessionId,
    sessionFile: `/tmp/${sessionId}.json`,
    sessionName: sessionId,
    cwd: '/same/repository',
    worktree: '/same/repository',
    repoName: 'repository',
    qualifiedRepoName: 'owner/repository',
    branch: 'main',
    prUrl: null,
    isLinkedWorktree: false,
    worktreeLabel: null,
    identityUpdatedAt: '2026-08-01T12:09:55.000Z',
    sessionStartedAt: '2026-08-01T12:00:00.000Z',
    gitRemote: null,
    gitRoot: '/same/repository',
    identitySource: 'startup',
    sessionStart: { reason: 'startup', mode: 'tui', hasUI: true },
    sessionHeader: {
      id: sessionId,
      timestamp: '2026-08-01T12:00:00.000Z',
      cwd: '/same/repository',
    },
  };
}

async function readSnapshot(directories: Awaited<ReturnType<typeof createDirectories>>) {
  return readSessionDeckSnapshot({
    directory: directories.presenceDirectory,
    identityDirectory: directories.identityDirectory,
    activityDirectory: directories.activityDirectory,
    chipsDirectory: directories.chipsDirectory,
    restartDirectory: directories.restartDirectory,
    projectsDirectory: directories.projectsDirectory,
    now: new Date('2026-08-01T12:10:00.000Z'),
    inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
  });
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('project snapshot join', () => {
  it('joins only the exact non-empty session ID and never repository metadata', async () => {
    const directories = await createDirectories();
    await createAndAssignProject('session-assigned', 'Explicit', {
      directory: directories.projectsDirectory,
      generateProjectId: () => PROJECT_ID,
    });

    await writePresenceRecord(presence('rt-assigned', 101), {
      directory: directories.presenceDirectory,
    });
    await writeIdentityRecord(identity('rt-assigned', 'session-assigned'), {
      directory: directories.identityDirectory,
    });
    await writePresenceRecord(presence('rt-same-repo', 102), {
      directory: directories.presenceDirectory,
    });
    await writeIdentityRecord(identity('rt-same-repo', 'session-other'), {
      directory: directories.identityDirectory,
    });
    await writePresenceRecord(presence('rt-no-session', 103), {
      directory: directories.presenceDirectory,
    });

    const snapshot = await readSnapshot(directories);

    expect(snapshot.projectState).toEqual({
      status: 'available',
      projects: [{ projectId: PROJECT_ID, name: 'Explicit' }],
    });
    expect(
      Object.fromEntries(snapshot.records.map((record) => [record.runtimeId, record.projectId])),
    ).toEqual({
      'rt-assigned': PROJECT_ID,
      'rt-no-session': null,
      'rt-same-repo': null,
    });
  });

  it('does not create phantom rows for stale memberships and joins only exact later IDs', async () => {
    const directories = await createDirectories();
    await createAndAssignProject('session-stale', 'Stale membership', {
      directory: directories.projectsDirectory,
      generateProjectId: () => PROJECT_ID,
    });

    expect((await readSnapshot(directories)).records).toEqual([]);

    await writePresenceRecord(presence('rt-near-match', 101), {
      directory: directories.presenceDirectory,
    });
    await writeIdentityRecord(identity('rt-near-match', 'session-stale-near'), {
      directory: directories.identityDirectory,
    });
    await writePresenceRecord(presence('rt-different', 102), {
      directory: directories.presenceDirectory,
    });
    await writeIdentityRecord(identity('rt-different', 'session-other'), {
      directory: directories.identityDirectory,
    });
    await writePresenceRecord(presence('rt-exact', 103), {
      directory: directories.presenceDirectory,
    });
    await writeIdentityRecord(identity('rt-exact', 'session-stale'), {
      directory: directories.identityDirectory,
    });

    const snapshot = await readSnapshot(directories);

    expect(
      Object.fromEntries(snapshot.records.map((record) => [record.runtimeId, record.projectId])),
    ).toEqual({
      'rt-different': null,
      'rt-exact': PROJECT_ID,
      'rt-near-match': null,
    });
  });

  it('makes deleted-project memberships inert without removing repository rows', async () => {
    const directories = await createDirectories();
    await createAndAssignProject('session-assigned', 'Deleted', {
      directory: directories.projectsDirectory,
      generateProjectId: () => PROJECT_ID,
    });
    await deleteProject(PROJECT_ID, { directory: directories.projectsDirectory });
    await writePresenceRecord(presence('rt-assigned', 101), {
      directory: directories.presenceDirectory,
    });
    await writeIdentityRecord(identity('rt-assigned', 'session-assigned'), {
      directory: directories.identityDirectory,
    });

    const snapshot = await readSnapshot(directories);

    expect(snapshot.projectState).toEqual({ status: 'available', projects: [] });
    expect(snapshot.records[0]).toMatchObject({
      runtimeId: 'rt-assigned',
      repoName: 'repository',
      projectId: null,
    });
  });

  it('keeps repository records usable when project state is malformed', async () => {
    const directories = await createDirectories();
    await mkdir(join(directories.projectsDirectory, 'catalog'), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(directories.projectsDirectory, 'memberships'), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(directories.projectsDirectory, 'catalog', `${PROJECT_ID}.json`), '{bad', {
      mode: 0o600,
    });
    await writePresenceRecord(presence('rt-1', 101), {
      directory: directories.presenceDirectory,
    });
    await writeIdentityRecord(identity('rt-1', 'session-1'), {
      directory: directories.identityDirectory,
    });

    const snapshot = await readSnapshot(directories);

    expect(snapshot.projectState).toEqual({ status: 'unavailable', projects: [] });
    expect(snapshot.records[0]).toMatchObject({
      runtimeId: 'rt-1',
      repoName: 'repository',
      projectId: null,
    });
  });

  it('joins restart-recovery rows after they are assembled', async () => {
    const directories = await createDirectories();
    await createAndAssignProject('session-recovery', 'Recovery', {
      directory: directories.projectsDirectory,
      generateProjectId: () => PROJECT_ID,
    });
    await writeIdentityRecord(identity(RECOVERY_RUNTIME_ID, 'session-recovery'), {
      directory: directories.identityDirectory,
    });
    await writeRestartRecipe(
      {
        schemaVersion: 1,
        runtimeId: RECOVERY_RUNTIME_ID,
        launch: {
          piExecutable: process.execPath,
          effectivePath: '/usr/bin:/bin',
          agentDir: { mode: 'default' },
        },
        cwd: '/same/repository',
        tmux: {
          socketSelector: 'name:default',
          sessionName: 'pi-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        createdAt: '2026-08-01T12:00:00.000Z',
        binding: {
          sessionId: 'session-recovery',
          sessionFile: '/tmp/session-recovery.json',
          pid: 42,
          osProcessStartedAt: '2026-08-01T12:00:00.000Z',
          boundAt: '2026-08-01T12:00:00.000Z',
        },
      },
      directories.restartDirectory,
    );
    await writeRestartJournal(
      {
        schemaVersion: 1,
        runtimeId: RECOVERY_RUNTIME_ID,
        generation: 'opaque-generation-token',
        operationId: 'operation-1',
        state: 'stopped-not-restarted',
        coordinator: { pid: 99, osProcessStartedAt: '2026-08-01T12:00:00.000Z' },
        oldPid: 42,
        oldOsProcessStartedAt: '2026-08-01T12:00:00.000Z',
        oldPresenceStartedAt: '2026-08-01T12:00:01.000Z',
        previousRemainOnExit: { explicit: false },
        pane: {
          id: '%1',
          socketPath: '/tmp/tmux-501/default',
          sessionName: 'pi-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        updatedAt: '2026-08-01T12:00:02.000Z',
        messageCode: 'respawn-failed',
      },
      directories.restartDirectory,
    );

    const snapshot = await readSnapshot(directories);

    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      runtimeId: RECOVERY_RUNTIME_ID,
      presenceReason: 'restart_recovery',
      sessionId: 'session-recovery',
      projectId: PROJECT_ID,
    });
  });
});
