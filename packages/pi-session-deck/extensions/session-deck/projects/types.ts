export interface SessionDeckProject {
  projectId: string;
  name: string;
}

export interface SessionDeckProjectState {
  status: 'available' | 'unavailable';
  projects: SessionDeckProject[];
}

export interface ProjectCatalogRecordV1 extends SessionDeckProject {
  schemaVersion: 1;
}

export interface ProjectMembershipRecordV1 {
  schemaVersion: 1;
  sessionId: string;
  projectId: string;
}

export type ProjectStoreSnapshot =
  | {
      status: 'available';
      projects: SessionDeckProject[];
      memberships: ReadonlyMap<string, string>;
    }
  | {
      status: 'unavailable';
      projects: [];
      memberships: ReadonlyMap<string, never>;
      message: string;
    };

export type ProjectActionFailureReason =
  | 'invalid-session-id'
  | 'invalid-project-id'
  | 'invalid-project-name'
  | 'project-not-found'
  | 'projects-unavailable'
  | 'write-failed';

export type ProjectActionResult =
  | {
      ok: true;
      status: 'created-and-assigned';
      project: SessionDeckProject;
      sessionId: string;
    }
  | {
      ok: true;
      status: 'assigned';
      projectId: string;
      sessionId: string;
    }
  | {
      ok: true;
      status: 'unassigned';
      sessionId: string;
    }
  | {
      ok: true;
      status: 'deleted';
      projectId: string;
    }
  | {
      ok: false;
      status: 'partial';
      reason: 'write-failed';
      retryable: true;
      message: string;
      project: SessionDeckProject;
      sessionId: string;
    }
  | {
      ok: false;
      status: 'failed';
      reason: ProjectActionFailureReason;
      retryable: boolean;
      message: string;
    };
