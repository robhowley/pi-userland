import { randomUUID } from 'node:crypto';
import {
  isValidProjectId,
  isValidSessionId,
  normalizeProjectName,
  ProjectStoreError,
  publishProject,
  readProjectStore,
  removeProject,
  removeProjectMembership,
  writeProjectMembership,
} from './store.js';
import type { ProjectActionResult, ProjectStoreSnapshot, SessionDeckProject } from './types.js';

export interface ProjectActionOptions {
  directory?: string;
  generateProjectId?: () => string;
  readStore?: (directory?: string) => Promise<ProjectStoreSnapshot>;
  publishProject?: (project: SessionDeckProject, directory?: string) => Promise<void>;
  writeMembership?: (
    membership: { sessionId: string; projectId: string },
    directory?: string,
  ) => Promise<void>;
  removeMembership?: (sessionId: string, directory?: string) => Promise<void>;
  removeProject?: (projectId: string, directory?: string) => Promise<void>;
}

export async function createAndAssignProject(
  sessionId: unknown,
  name: unknown,
  options: ProjectActionOptions = {},
): Promise<ProjectActionResult> {
  if (!isValidSessionId(sessionId)) return invalidSessionId();
  const normalizedName = normalizeProjectName(name);
  if (normalizedName === null) {
    return failure(
      'invalid-project-name',
      'Project name must be 1–80 characters and contain no control characters.',
      false,
    );
  }

  const state = await readAvailableStore(options);
  if (!state.ok) return state.result;

  const publish = options.publishProject ?? publishProject;
  let project: SessionDeckProject | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const projectId = (options.generateProjectId ?? randomUUID)();
    if (!isValidProjectId(projectId)) {
      return failure('write-failed', 'Project ID generation failed.', true);
    }
    const candidate = { projectId, name: normalizedName };
    try {
      await publish(candidate, options.directory);
      project = candidate;
      break;
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === 'project-exists') continue;
      return storeFailure(error);
    }
  }
  if (project === undefined) {
    return failure('write-failed', 'Could not allocate a new project ID.', true);
  }

  try {
    await (options.writeMembership ?? writeProjectMembership)(
      { sessionId, projectId: project.projectId },
      options.directory,
    );
  } catch (error) {
    return {
      ok: false,
      status: 'partial',
      reason: 'write-failed',
      retryable: true,
      message: `Project was created, but assignment failed: ${getErrorMessage(error)}`,
      project,
      sessionId,
    };
  }

  const latest = await (options.readStore ?? readProjectStore)(options.directory);
  if (
    latest.status !== 'available' ||
    !latest.projects.some((candidate) => candidate.projectId === project.projectId)
  ) {
    return {
      ok: false,
      status: 'partial',
      reason: 'write-failed',
      retryable: true,
      message: 'Project changed before assignment could be confirmed.',
      project,
      sessionId,
    };
  }

  return { ok: true, status: 'created-and-assigned', project, sessionId };
}

export async function assignProject(
  sessionId: unknown,
  projectId: unknown,
  options: ProjectActionOptions = {},
): Promise<ProjectActionResult> {
  if (!isValidSessionId(sessionId)) return invalidSessionId();
  if (!isValidProjectId(projectId)) return invalidProjectId();
  const state = await readAvailableStore(options);
  if (!state.ok) return state.result;
  if (!state.store.projects.some((project) => project.projectId === projectId)) {
    return failure('project-not-found', 'Project does not exist.', true);
  }

  try {
    await (options.writeMembership ?? writeProjectMembership)(
      { sessionId, projectId },
      options.directory,
    );
  } catch (error) {
    return storeFailure(error);
  }

  const latest = await (options.readStore ?? readProjectStore)(options.directory);
  if (latest.status === 'unavailable') {
    return failure('projects-unavailable', latest.message, true);
  }
  if (!latest.projects.some((project) => project.projectId === projectId)) {
    return failure(
      'project-not-found',
      'Project changed before assignment could be confirmed.',
      true,
    );
  }
  return { ok: true, status: 'assigned', projectId, sessionId };
}

export async function unassignProject(
  sessionId: unknown,
  options: ProjectActionOptions = {},
): Promise<ProjectActionResult> {
  if (!isValidSessionId(sessionId)) return invalidSessionId();
  const state = await readAvailableStore(options);
  if (!state.ok) return state.result;
  try {
    await (options.removeMembership ?? removeProjectMembership)(sessionId, options.directory);
    return { ok: true, status: 'unassigned', sessionId };
  } catch (error) {
    return storeFailure(error);
  }
}

export async function deleteProject(
  projectId: unknown,
  options: ProjectActionOptions = {},
): Promise<ProjectActionResult> {
  if (!isValidProjectId(projectId)) return invalidProjectId();
  const state = await readAvailableStore(options);
  if (!state.ok) return state.result;
  if (!state.store.projects.some((project) => project.projectId === projectId)) {
    return failure('project-not-found', 'Project does not exist.', true);
  }
  try {
    await (options.removeProject ?? removeProject)(projectId, options.directory);
    return { ok: true, status: 'deleted', projectId };
  } catch (error) {
    return storeFailure(error);
  }
}

async function readAvailableStore(
  options: ProjectActionOptions,
): Promise<
  | { ok: true; store: Extract<ProjectStoreSnapshot, { status: 'available' }> }
  | { ok: false; result: ProjectActionResult }
> {
  const store = await (options.readStore ?? readProjectStore)(options.directory);
  return store.status === 'available'
    ? { ok: true, store }
    : {
        ok: false,
        result: failure('projects-unavailable', store.message, true),
      };
}

function invalidSessionId(): ProjectActionResult {
  return failure('invalid-session-id', 'A non-empty session ID is required.', false);
}

function invalidProjectId(): ProjectActionResult {
  return failure('invalid-project-id', 'A valid project ID is required.', false);
}

function storeFailure(error: unknown): ProjectActionResult {
  return failure(
    error instanceof ProjectStoreError && error.code === 'projects-unavailable'
      ? 'projects-unavailable'
      : 'write-failed',
    getErrorMessage(error),
    true,
  );
}

function failure(
  reason: Extract<ProjectActionResult, { ok: false; status: 'failed' }>['reason'],
  message: string,
  retryable: boolean,
): ProjectActionResult {
  return { ok: false, status: 'failed', reason, message, retryable };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
