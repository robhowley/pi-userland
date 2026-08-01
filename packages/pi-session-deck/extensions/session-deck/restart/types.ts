export type ManagedRestartAgentDir =
  | { mode: 'ambient'; path?: string }
  | { mode: 'default'; path?: never }
  | { mode: 'custom'; path: string };

export interface ManagedRestartRecipeV1 {
  schemaVersion: 1;
  runtimeId: string;
  launch: {
    piExecutable: string;
    effectivePath: string;
    agentDir: ManagedRestartAgentDir;
    sessionDir?: { mode: 'explicit'; path: string };
  };
  cwd: string;
  tmux: {
    socketSelector: string;
    sessionName: string;
    windowIndex: number;
    paneIndex: number;
  };
  createdAt: string;
  binding?: {
    sessionId: string;
    sessionFile: string;
    pid: number;
    osProcessStartedAt: string;
    boundAt: string;
  };
}

export type RestartJournalState =
  | 'preparing'
  | 'term-sent'
  | 'kill-sent'
  | 'stopped'
  | 'spawn-requested'
  | 'observing'
  | 'restarted'
  | 'stop-failed'
  | 'stopped-not-restarted'
  | 'outcome-unknown';

interface RestartJournalBase {
  schemaVersion: 1;
  runtimeId: string;
  generation: string;
  operationId: string;
  coordinator: { pid: number; osProcessStartedAt: string };
  oldPid: number;
  oldOsProcessStartedAt: string;
  oldPresenceStartedAt: string;
  pane: {
    id: string;
    socketPath: string;
    sessionName: string;
    windowIndex: number;
    paneIndex: number;
  };
  updatedAt: string;
}

type PreviousRemainOnExit = { explicit: boolean; value?: string };
type RestartTerminalState =
  | 'restarted'
  | 'stop-failed'
  | 'stopped-not-restarted'
  | 'outcome-unknown';
type RestartRecoveryState = Exclude<RestartJournalState, 'preparing' | RestartTerminalState>;

export type RestartJournalV1 = RestartJournalBase &
  (
    | {
        state: 'preparing';
        previousRemainOnExit?: PreviousRemainOnExit;
        messageCode?: never;
      }
    | {
        state: RestartRecoveryState;
        previousRemainOnExit: PreviousRemainOnExit;
        messageCode?: never;
      }
    | {
        state: RestartTerminalState;
        previousRemainOnExit: PreviousRemainOnExit;
        messageCode: RestartReasonCode;
      }
  );

export interface RestartSessionRequest {
  runtimeId: string;
  generation: string;
  operationId: string;
}

export type RestartSessionStatus =
  | 'restarted'
  | 'not-eligible'
  | 'stale-generation'
  | 'already-in-progress'
  | 'stop-failed'
  | 'stopped-not-restarted'
  | 'outcome-unknown';

export type RestartReasonCode =
  | 'replacement-observed'
  | 'managed-recipe-unavailable'
  | 'recipe-not-bound'
  | 'recipe-invalid'
  | 'runtime-unavailable'
  | 'identity-mismatch'
  | 'session-file-unavailable'
  | 'cwd-unavailable'
  | 'pi-executable-unavailable'
  | 'tmux-target-unavailable'
  | 'tmux-pane-mismatch'
  | 'unsafe-descendants'
  | 'hosting-runtime'
  | 'coordinator-runtime'
  | 'generation-changed'
  | 'operation-in-progress'
  | 'termination-failed'
  | 'pane-did-not-stop'
  | 'respawn-failed'
  | 'replacement-unobserved'
  | 'operation-state-unknown';

export interface RestartSessionResult {
  ok: boolean;
  status: RestartSessionStatus;
  operationId: string;
  reason: RestartReasonCode;
  retryable: boolean;
  message: string;
}

export type RestartEligibility =
  | {
      available: true;
      generation: string;
      operation?: {
        operationId: string;
        status: RestartJournalState;
        retryable: boolean;
      };
    }
  | { available: false; reason: RestartReasonCode };
