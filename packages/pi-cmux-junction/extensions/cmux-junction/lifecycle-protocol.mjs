export const LIFECYCLE_PROTOCOL = 'pi-junction.lifecycle.v1';
export const MAX_LIFECYCLE_FRAME_BYTES = 16 * 1024;
export const MAX_LIFECYCLE_TOOL_NAME_LENGTH = 64;

export const LIFECYCLE_STATES = [
  'idle',
  'thinking',
  'tool-running',
  'awaiting-input',
  'compacting',
  'error',
  'unknown',
];

export const LIFECYCLE_MESSAGE_KINDS = ['snapshot', 'goodbye'];
export const LIFECYCLE_ACK_KIND = 'ack';

export const LIFECYCLE_COMMON_FIELDS = [
  'protocol',
  'kind',
  'workspaceId',
  'surfaceId',
  'sessionId',
  'runtimeId',
  'pid',
  'processStartedAt',
  'connectionId',
  'ownerGeneration',
  'revision',
  'sentAt',
];

export const LIFECYCLE_SNAPSHOT_FIELDS = [
  ...LIFECYCLE_COMMON_FIELDS,
  'state',
  'toolName',
  'transitionAt',
  'lastEventAt',
  'compactionAt',
];

export const LIFECYCLE_ACK_FIELDS = [
  'protocol',
  'kind',
  'workspaceId',
  'surfaceId',
  'sessionId',
  'runtimeId',
  'pid',
  'processStartedAt',
  'connectionId',
  'acceptedGeneration',
  'acceptedRevision',
  'acceptedKind',
];

export const LIFECYCLE_IDENTITY_FIELDS = [
  'workspaceId',
  'surfaceId',
  'sessionId',
  'runtimeId',
  'connectionId',
];

export const LIFECYCLE_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,63}$/u;
