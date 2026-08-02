import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assignProject,
  createAndAssignProject,
  deleteProject,
  unassignProject,
} from '../../extensions/session-deck/projects/actions.js';
import {
  getProjectCatalogPath,
  getProjectMembershipPath,
  hashSessionId,
  readProjectStore,
} from '../../extensions/session-deck/projects/store.js';

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '550e8400-e29b-41d4-a716-446655440001';
const createdDirectories: string[] = [];

async function createDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-deck-projects-'));
  createdDirectories.push(root);
  return join(root, 'projects');
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('project store and actions', () => {
  it('treats a missing store as available and empty', async () => {
    const directory = await createDirectory();
    const state = await readProjectStore(directory);

    expect(state.status).toBe('available');
    expect(state.projects).toEqual([]);
    expect(state.memberships.size).toBe(0);
  });

  it('creates private deterministic records and keeps the exact session ID', async () => {
    const directory = await createDirectory();
    const sessionId = ' session/日本語:\nexact ';

    const result = await createAndAssignProject(sessionId, '  Reléase work  ', {
      directory,
      generateProjectId: () => UUID_A,
    });

    expect(result).toEqual({
      ok: true,
      status: 'created-and-assigned',
      project: { projectId: UUID_A, name: 'Reléase work' },
      sessionId,
    });
    const state = await readProjectStore(directory);
    expect(state.status).toBe('available');
    expect(state.projects).toEqual([{ projectId: UUID_A, name: 'Reléase work' }]);
    expect(state.memberships.get(sessionId)).toBe(UUID_A);
    expect(hashSessionId(sessionId)).toHaveLength(64);

    for (const path of [directory, join(directory, 'catalog'), join(directory, 'memberships')]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of [
      getProjectCatalogPath(UUID_A, directory),
      getProjectMembershipPath(sessionId, directory),
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(
      JSON.parse(await readFile(getProjectMembershipPath(sessionId, directory), 'utf8')),
    ).toEqual({ schemaVersion: 1, sessionId, projectId: UUID_A });
  });

  it('ignores only recognized abandoned temp files and leaves no writer temp files behind', async () => {
    const directory = await createDirectory();
    const sessionId = 'session-1';
    await createAndAssignProject(sessionId, 'Project', {
      directory,
      generateProjectId: () => UUID_A,
    });

    expect(await readdir(join(directory, 'catalog'))).toEqual([`${UUID_A}.json`]);
    expect(await readdir(join(directory, 'memberships'))).toEqual([
      `${hashSessionId(sessionId)}.json`,
    ]);

    const tempId = '123e4567-e89b-42d3-a456-426614174000';
    await writeFile(
      join(directory, 'catalog', `.${UUID_A}.json.1.${tempId}.tmp`),
      'in-flight catalog',
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, 'memberships', `.${hashSessionId(sessionId)}.json.1.${tempId}.tmp`),
      'in-flight membership',
      { mode: 0o600 },
    );

    expect(await readProjectStore(directory)).toMatchObject({
      status: 'available',
      projects: [{ projectId: UUID_A, name: 'Project' }],
    });

    await writeFile(join(directory, 'catalog', '.unrelated.tmp'), 'unexpected', { mode: 0o600 });
    expect(await readProjectStore(directory)).toMatchObject({ status: 'unavailable' });
  });

  it('allows duplicate names and preserves concurrent different-session assignments', async () => {
    const directory = await createDirectory();
    await createAndAssignProject('seed-a', 'Same name', {
      directory,
      generateProjectId: () => UUID_A,
    });
    await createAndAssignProject('seed-b', 'Same name', {
      directory,
      generateProjectId: () => UUID_B,
    });

    const results = await Promise.all([
      assignProject('session/a', UUID_A, { directory }),
      assignProject('session:b', UUID_B, { directory }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const state = await readProjectStore(directory);
    expect(state.projects).toEqual([
      { projectId: UUID_A, name: 'Same name' },
      { projectId: UUID_B, name: 'Same name' },
    ]);
    expect(state.memberships.get('session/a')).toBe(UUID_A);
    expect(state.memberships.get('session:b')).toBe(UUID_B);
  });

  it('rejects null and empty session IDs without trimming valid IDs', async () => {
    const directory = await createDirectory();
    expect(await createAndAssignProject(null, 'Project', { directory })).toMatchObject({
      ok: false,
      reason: 'invalid-session-id',
    });
    expect(await createAndAssignProject('', 'Project', { directory })).toMatchObject({
      ok: false,
      reason: 'invalid-session-id',
    });
    expect(
      await createAndAssignProject(' ', 'Project', {
        directory,
        generateProjectId: () => UUID_A,
      }),
    ).toMatchObject({ ok: true, sessionId: ' ' });
  });

  it('leaves a published project visible when assignment fails', async () => {
    const directory = await createDirectory();
    const result = await createAndAssignProject('session-1', 'Partial', {
      directory,
      generateProjectId: () => UUID_A,
      writeMembership: async () => {
        throw new Error('injected membership failure');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'partial',
      retryable: true,
      project: { projectId: UUID_A, name: 'Partial' },
      sessionId: 'session-1',
    });
    const state = await readProjectStore(directory);
    expect(state.projects).toEqual([{ projectId: UUID_A, name: 'Partial' }]);
    expect(state.memberships.size).toBe(0);
  });

  it('deletes only the catalog file so orphan memberships are inert', async () => {
    const directory = await createDirectory();
    await createAndAssignProject('session-1', 'Disposable', {
      directory,
      generateProjectId: () => UUID_A,
    });
    const membershipPath = getProjectMembershipPath('session-1', directory);

    expect(await deleteProject(UUID_A, { directory })).toEqual({
      ok: true,
      status: 'deleted',
      projectId: UUID_A,
    });
    expect((await lstat(membershipPath)).isFile()).toBe(true);
    const state = await readProjectStore(directory);
    expect(state.projects).toEqual([]);
    expect(state.memberships.size).toBe(0);

    expect(await unassignProject('session-1', { directory })).toEqual({
      ok: true,
      status: 'unassigned',
      sessionId: 'session-1',
    });
  });

  it('marks malformed or unsafe state unavailable and refuses to overwrite it', async () => {
    const directory = await createDirectory();
    const memberships = join(directory, 'memberships');
    await mkdir(join(directory, 'catalog'), { recursive: true, mode: 0o700 });
    await mkdir(memberships, { recursive: true, mode: 0o700 });
    const path = join(memberships, `${hashSessionId('session-1')}.json`);
    await writeFile(path, '{broken', { mode: 0o600 });

    expect(await readProjectStore(directory)).toMatchObject({ status: 'unavailable' });
    expect(await unassignProject('session-1', { directory })).toMatchObject({
      ok: false,
      reason: 'projects-unavailable',
    });
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  it('rejects symlinked project state', async () => {
    const directory = await createDirectory();
    const target = join(directory, '..', 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);

    expect(await readProjectStore(directory)).toMatchObject({ status: 'unavailable' });
    expect(await createAndAssignProject('session-1', 'Unsafe', { directory })).toMatchObject({
      ok: false,
      reason: 'projects-unavailable',
    });
  });
});
