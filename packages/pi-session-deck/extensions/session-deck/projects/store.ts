import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  ProjectCatalogRecordV1,
  ProjectMembershipRecordV1,
  ProjectStoreSnapshot,
  SessionDeckProject,
} from './types.js';

const PROJECTS_PATH_SEGMENTS = ['.pi', 'session-deck', 'projects'] as const;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MEMBERSHIP_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;
const PROJECT_STORE_TEMP_FILE_PATTERN =
  /^\.(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})\.json\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const MAX_PROJECT_NAME_CODE_POINTS = 80;

export class ProjectStoreError extends Error {
  constructor(
    public readonly code: 'projects-unavailable' | 'project-exists' | 'write-failed',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

export function getDefaultProjectsDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ...PROJECTS_PATH_SEGMENTS);
}

export function getProjectCatalogDirectory(directory = getDefaultProjectsDirectory()): string {
  return join(directory, 'catalog');
}

export function getProjectMembershipsDirectory(directory = getDefaultProjectsDirectory()): string {
  return join(directory, 'memberships');
}

export function getProjectCatalogPath(
  projectId: string,
  directory = getDefaultProjectsDirectory(),
): string {
  return join(getProjectCatalogDirectory(directory), `${projectId}.json`);
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

export function getProjectMembershipPath(
  sessionId: string,
  directory = getDefaultProjectsDirectory(),
): string {
  return join(getProjectMembershipsDirectory(directory), `${hashSessionId(sessionId)}.json`);
}

export function isValidProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value);
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function normalizeProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > MAX_PROJECT_NAME_CODE_POINTS ||
    /\p{Cc}/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export async function readProjectStore(
  directory = getDefaultProjectsDirectory(),
): Promise<ProjectStoreSnapshot> {
  try {
    const rootStatus = await inspectDirectory(directory);
    if (rootStatus === 'missing') return available([], new Map());
    if (rootStatus === 'unsafe') return unavailable('Project storage directory is unsafe.');

    const rootEntries = await readdir(directory, { withFileTypes: true });
    if (
      rootEntries.some(
        (entry) =>
          !((entry.name === 'catalog' || entry.name === 'memberships') && entry.isDirectory()),
      )
    ) {
      return unavailable('Project storage contains an unexpected entry.');
    }

    const catalog = await readCatalog(directory);
    const membershipRecords = await readMemberships(directory);
    const projectIds = new Set(catalog.map((project) => project.projectId));
    const memberships = new Map<string, string>();
    for (const membership of membershipRecords) {
      if (projectIds.has(membership.projectId)) {
        memberships.set(membership.sessionId, membership.projectId);
      }
    }
    return available(catalog, memberships);
  } catch (error) {
    return unavailable(getErrorMessage(error));
  }
}

export async function publishProject(
  project: SessionDeckProject,
  directory = getDefaultProjectsDirectory(),
): Promise<void> {
  if (!isValidProjectId(project.projectId) || normalizeProjectName(project.name) !== project.name) {
    throw new ProjectStoreError('write-failed', 'Invalid project record.');
  }
  await assertStoreAvailable(directory);
  await ensureStoreDirectories(directory);
  const record: ProjectCatalogRecordV1 = {
    schemaVersion: 1,
    projectId: project.projectId,
    name: project.name,
  };
  await writeNewPrivateJson(getProjectCatalogPath(project.projectId, directory), record);
}

export async function writeProjectMembership(
  membership: Omit<ProjectMembershipRecordV1, 'schemaVersion'>,
  directory = getDefaultProjectsDirectory(),
): Promise<void> {
  if (!isValidSessionId(membership.sessionId) || !isValidProjectId(membership.projectId)) {
    throw new ProjectStoreError('write-failed', 'Invalid project membership.');
  }
  await assertStoreAvailable(directory);
  await ensureStoreDirectories(directory);
  const record: ProjectMembershipRecordV1 = { schemaVersion: 1, ...membership };
  await replacePrivateJson(getProjectMembershipPath(membership.sessionId, directory), record);
}

export async function removeProjectMembership(
  sessionId: string,
  directory = getDefaultProjectsDirectory(),
): Promise<void> {
  if (!isValidSessionId(sessionId)) {
    throw new ProjectStoreError('write-failed', 'Invalid session ID.');
  }
  await assertStoreAvailable(directory);
  try {
    await unlink(getProjectMembershipPath(sessionId, directory));
  } catch (error) {
    if (!isMissingError(error)) throw toWriteError(error);
  }
}

export async function removeProject(
  projectId: string,
  directory = getDefaultProjectsDirectory(),
): Promise<void> {
  if (!isValidProjectId(projectId)) {
    throw new ProjectStoreError('write-failed', 'Invalid project ID.');
  }
  await assertStoreAvailable(directory);
  try {
    await unlink(getProjectCatalogPath(projectId, directory));
  } catch (error) {
    if (!isMissingError(error)) throw toWriteError(error);
  }
}

async function readCatalog(directory: string): Promise<SessionDeckProject[]> {
  const catalogDirectory = getProjectCatalogDirectory(directory);
  const entries = await readJsonDirectory(catalogDirectory);
  const projects: SessionDeckProject[] = [];
  for (const entry of entries) {
    if (!PROJECT_ID_PATTERN.test(entry.slice(0, -'.json'.length))) {
      throw new Error('Project catalog contains an invalid filename.');
    }
    const projectId = entry.slice(0, -'.json'.length);
    const candidate = await readPrivateJson(join(catalogDirectory, entry));
    if (candidate === undefined) continue;
    const record = normalizeCatalogRecord(candidate, projectId);
    if (record === null) throw new Error('Project catalog contains an invalid record.');
    projects.push({ projectId: record.projectId, name: record.name });
  }
  return projects.sort((left, right) => left.projectId.localeCompare(right.projectId));
}

async function readMemberships(directory: string): Promise<ProjectMembershipRecordV1[]> {
  const membershipsDirectory = getProjectMembershipsDirectory(directory);
  const entries = await readJsonDirectory(membershipsDirectory);
  const memberships: ProjectMembershipRecordV1[] = [];
  for (const entry of entries) {
    if (!MEMBERSHIP_FILE_PATTERN.test(entry)) {
      throw new Error('Project memberships contain an invalid filename.');
    }
    const expectedHash = entry.slice(0, -'.json'.length);
    const candidate = await readPrivateJson(join(membershipsDirectory, entry));
    if (candidate === undefined) continue;
    const record = normalizeMembershipRecord(candidate, expectedHash);
    if (record === null) throw new Error('Project memberships contain an invalid record.');
    memberships.push(record);
  }
  return memberships;
}

async function readJsonDirectory(path: string): Promise<string[]> {
  const status = await inspectDirectory(path);
  if (status === 'missing') return [];
  if (status === 'unsafe') throw new Error('Project storage subdirectory is unsafe.');
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (isProjectStoreTempFile(entry.name) && entry.isFile()) continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error('Project storage contains an unexpected entry.');
    }
    files.push(entry.name);
  }
  return files.sort();
}

async function readPrivateJson(path: string): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !isCurrentUserOwned(info.uid) || (info.mode & 0o777) !== 0o600) {
      throw new Error('Project storage file is unsafe.');
    }
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

function normalizeCatalogRecord(
  candidate: unknown,
  expectedProjectId: string,
): ProjectCatalogRecordV1 | null {
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, ['schemaVersion', 'projectId', 'name']) ||
    candidate['schemaVersion'] !== 1 ||
    candidate['projectId'] !== expectedProjectId ||
    !isValidProjectId(candidate['projectId'])
  ) {
    return null;
  }
  const name = normalizeProjectName(candidate['name']);
  return name !== null && name === candidate['name']
    ? { schemaVersion: 1, projectId: candidate['projectId'], name }
    : null;
}

function normalizeMembershipRecord(
  candidate: unknown,
  expectedHash: string,
): ProjectMembershipRecordV1 | null {
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, ['schemaVersion', 'sessionId', 'projectId']) ||
    candidate['schemaVersion'] !== 1 ||
    !isValidSessionId(candidate['sessionId']) ||
    !isValidProjectId(candidate['projectId']) ||
    hashSessionId(candidate['sessionId']) !== expectedHash
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    sessionId: candidate['sessionId'],
    projectId: candidate['projectId'],
  };
}

async function assertStoreAvailable(directory: string): Promise<void> {
  const state = await readProjectStore(directory);
  if (state.status === 'unavailable') {
    throw new ProjectStoreError('projects-unavailable', state.message);
  }
}

async function ensureStoreDirectories(directory: string): Promise<void> {
  for (const path of [
    directory,
    getProjectCatalogDirectory(directory),
    getProjectMembershipsDirectory(directory),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await inspectDirectory(path)) !== 'safe') {
      throw new ProjectStoreError('projects-unavailable', 'Project storage directory is unsafe.');
    }
  }
}

async function inspectDirectory(path: string): Promise<'safe' | 'missing' | 'unsafe'> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && isCurrentUserOwned(info.uid) && (info.mode & 0o777) === 0o700
      ? 'safe'
      : 'unsafe';
  } catch (error) {
    return isMissingError(error) ? 'missing' : 'unsafe';
  }
}

async function replacePrivateJson(path: string, value: unknown): Promise<void> {
  const tempPath = getProjectStoreTempPath(path);
  try {
    await writeFile(tempPath, serialize(value), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(tempPath, path);
  } catch (error) {
    throw toWriteError(error);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function writeNewPrivateJson(path: string, value: unknown): Promise<void> {
  const tempPath = getProjectStoreTempPath(path);
  try {
    await writeFile(tempPath, serialize(value), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await link(tempPath, path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new ProjectStoreError('project-exists', 'Project ID already exists.');
    }
    throw toWriteError(error);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function available(
  projects: SessionDeckProject[],
  memberships: Map<string, string>,
): ProjectStoreSnapshot {
  return { status: 'available', projects, memberships };
}

function unavailable(message: string): ProjectStoreSnapshot {
  return {
    status: 'unavailable',
    projects: [],
    memberships: new Map<string, never>(),
    message,
  };
}

function getProjectStoreTempPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

function isProjectStoreTempFile(name: string): boolean {
  return PROJECT_STORE_TEMP_FILE_PATTERN.test(name);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toWriteError(error: unknown): ProjectStoreError {
  return error instanceof ProjectStoreError
    ? error
    : new ProjectStoreError('write-failed', getErrorMessage(error));
}

function hasExactKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCurrentUserOwned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function isMissingError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
