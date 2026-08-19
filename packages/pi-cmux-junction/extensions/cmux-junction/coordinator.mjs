#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { classifyExecFileFailure, resolveCmuxExecutable } from './cmux-runtime.mjs';
import {
  LIFECYCLE_ACK_KIND,
  LIFECYCLE_COMMON_FIELDS,
  LIFECYCLE_IDENTITY_FIELDS,
  LIFECYCLE_MESSAGE_KINDS,
  LIFECYCLE_PROTOCOL,
  LIFECYCLE_SNAPSHOT_FIELDS,
  LIFECYCLE_STATES,
  LIFECYCLE_TOOL_NAME_PATTERN,
  MAX_LIFECYCLE_FRAME_BYTES,
} from './lifecycle-protocol.mjs';

export const STATUS_KEY = 'pi-junction';
export const RECONNECT_GRACE_MS = 5_000;

const states = new Set(LIFECYCLE_STATES);
const activeRanks = new Map([
  ['thinking', 1],
  ['tool-running', 2],
  ['awaiting-input', 3],
  ['error', 4],
  ['compacting', 5],
]);
const ledgerFields = [
  'schemaVersion',
  'target',
  'nextGenerationBySurface',
  'owners',
  'desired',
  'applied',
  'updatedAt',
];
const statusFields = ['state', 'label', 'revision', 'transitionAt'];
const durableOwnerFields = [
  'workspaceId',
  'surfaceId',
  'sessionId',
  'runtimeId',
  'pid',
  'processStartedAt',
  'connectionId',
  'ownerGeneration',
  'acceptedRevision',
  'heartbeatAt',
  'connected',
  'replayPending',
  'disconnectedAt',
  'liveness',
  'snapshot',
];
const durableSnapshotFields = ['state', 'toolName', 'transitionAt', 'lastEventAt', 'compactionAt'];

function hasControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(reason) {
  return { ok: false, reason };
}

function exactFields(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function validIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !hasControl(value);
}

function validTime(value, nullable = false) {
  return (
    (nullable && value === null) ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

function validSnapshot(value, requireExactFields = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    (requireExactFields && !exactFields(value, durableSnapshotFields)) ||
    !states.has(value.state)
  ) {
    return false;
  }
  if (
    (value.toolName !== null &&
      (typeof value.toolName !== 'string' || !LIFECYCLE_TOOL_NAME_PATTERN.test(value.toolName))) ||
    (value.toolName !== null && value.state !== 'tool-running') ||
    !validTime(value.transitionAt) ||
    !validTime(value.lastEventAt, true) ||
    !validTime(value.compactionAt, true)
  ) {
    return false;
  }
  if (value.state !== 'idle' && value.state !== 'unknown' && value.lastEventAt === null) {
    return false;
  }
  if (value.state === 'compacting' && value.compactionAt === null) return false;
  if (
    value.compactionAt !== null &&
    (value.lastEventAt === null || value.compactionAt > value.lastEventAt)
  ) {
    return false;
  }
  return true;
}

export function decodeWireLine(line, target) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_LIFECYCLE_FRAME_BYTES) {
    return fail('size');
  }
  if (line.includes('\n') || line.includes('\r') || line.includes('\0')) return fail('control');
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return fail('json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('type');
  if (value.protocol !== LIFECYCLE_PROTOCOL) return fail('protocol');
  if (!LIFECYCLE_MESSAGE_KINDS.includes(value.kind)) return fail('kind');
  if (
    !exactFields(
      value,
      value.kind === 'snapshot' ? LIFECYCLE_SNAPSHOT_FIELDS : LIFECYCLE_COMMON_FIELDS,
    )
  ) {
    return fail('fields');
  }
  for (const field of LIFECYCLE_IDENTITY_FIELDS) {
    if (!validIdentity(value[field])) return fail('identity');
  }
  if (value.workspaceId !== target.workspaceId) return fail('target');
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !validTime(value.processStartedAt) ||
    (!Number.isSafeInteger(value.ownerGeneration) && value.ownerGeneration !== null) ||
    (typeof value.ownerGeneration === 'number' && value.ownerGeneration <= 0) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !validTime(value.sentAt)
  ) {
    return fail('number');
  }
  if (value.kind === 'goodbye' && value.ownerGeneration === null) return fail('generation');
  if (value.kind === 'snapshot' && !validSnapshot(value, false)) return fail('snapshot');
  return { ok: true, value };
}

export function decodeWireMessage(value, target) {
  let line;
  try {
    line = JSON.stringify(value);
  } catch {
    return fail('json');
  }
  return decodeWireLine(line, target);
}

export function createAck(message, acceptedGeneration, acceptedRevision) {
  return {
    protocol: LIFECYCLE_PROTOCOL,
    kind: LIFECYCLE_ACK_KIND,
    workspaceId: message.workspaceId,
    surfaceId: message.surfaceId,
    sessionId: message.sessionId,
    runtimeId: message.runtimeId,
    pid: message.pid,
    processStartedAt: message.processStartedAt,
    connectionId: message.connectionId,
    acceptedGeneration,
    acceptedRevision,
    acceptedKind: message.kind,
  };
}

function ownerStableIdentityMatches(owner, message) {
  return (
    owner.surfaceId === message.surfaceId &&
    owner.sessionId === message.sessionId &&
    owner.runtimeId === message.runtimeId &&
    owner.pid === message.pid &&
    owner.processStartedAt === message.processStartedAt
  );
}

function ownerIdentityMatches(owner, message) {
  return ownerStableIdentityMatches(owner, message) && owner.connectionId === message.connectionId;
}

function ownerFenceMatches(owner, message) {
  return ownerIdentityMatches(owner, message) && owner.ownerGeneration === message.ownerGeneration;
}

function statusEqual(left, right) {
  return left?.state === right?.state && left?.label === right?.label;
}

function aggregateLabel(state, toolName = null) {
  switch (state) {
    case 'compacting':
      return 'Compacting';
    case 'error':
      return 'Error';
    case 'awaiting-input':
      return 'Needs input';
    case 'tool-running':
      return toolName ? `Tool running: ${toolName}` : 'Tool running';
    case 'thinking':
      return 'Thinking';
    case 'unknown':
      return 'Unknown';
    case 'idle':
      return 'Idle';
    default:
      return null;
  }
}

export function probePidStart(pid, expectedStartedAt, dependencies = {}) {
  const signal = dependencies.signal ?? ((candidate) => process.kill(candidate, 0));
  try {
    signal(pid);
  } catch (error) {
    return error?.code === 'ESRCH' ? 'missing' : 'unverifiable';
  }
  const readStart =
    dependencies.readStart ??
    ((candidate) => {
      const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(candidate)], {
        encoding: 'utf8',
        timeout: 1_000,
      });
      return result.status === 0 ? result.stdout.trim() : '';
    });
  const observed = Date.parse(readStart(pid));
  if (!Number.isFinite(observed)) return 'unverifiable';
  return Math.abs(observed - expectedStartedAt) <= 1_500 ? 'match' : 'reused';
}

export function classifyOwner(owner, now, probePid) {
  const probe = probePid(owner.pid, owner.processStartedAt);
  const age = now - owner.heartbeatAt;
  if (probe === 'missing' || probe === 'reused' || age > 300_000) return 'dead';
  if (owner.replayPending || owner.heartbeatAt > now + 10_000) return 'stale';
  if (probe === 'match' && age <= 30_000 && !owner.disconnectedAt) return 'live';
  return 'stale';
}

function displayState(owner, now) {
  if (owner.liveness !== 'live') return 'unknown';
  const snapshot = owner.snapshot;
  const compactionPresent = snapshot.compactionAt !== null;
  if (
    snapshot.transitionAt > now + 5_000 ||
    (snapshot.lastEventAt !== null && snapshot.lastEventAt > now + 5_000) ||
    (compactionPresent &&
      (snapshot.compactionAt > now + 5_000 ||
        now - snapshot.compactionAt > 600_000 ||
        snapshot.lastEventAt === null ||
        snapshot.compactionAt > snapshot.lastEventAt))
  ) {
    return 'unknown';
  }
  if (
    compactionPresent &&
    snapshot.state !== 'compacting' &&
    now - snapshot.compactionAt <= 120_000
  ) {
    return 'unknown';
  }
  if (snapshot.state === 'unknown') return 'unknown';
  if (snapshot.state === 'idle') return 'idle';
  if (snapshot.lastEventAt === null || now - snapshot.lastEventAt > 120_000) return 'unknown';
  if (
    snapshot.state === 'compacting' &&
    (!compactionPresent || now - snapshot.compactionAt > 120_000)
  ) {
    return 'unknown';
  }
  return snapshot.state;
}

export function aggregateOwners(owners, now) {
  let ownerCount = 0;
  let winner = null;
  let winnerRank = 0;
  let unresolved = false;
  const liveNonIdle = [];
  for (const owner of owners) {
    ownerCount += 1;
    const state = displayState(owner, now);
    const rank = activeRanks.get(state) ?? 0;
    if (owner.liveness === 'live' && state !== 'idle') liveNonIdle.push({ owner, state });
    if (rank > 0) {
      if (rank > winnerRank) {
        winner = state;
        winnerRank = rank;
      }
    } else if (state === 'unknown') {
      unresolved = true;
    }
  }
  if (ownerCount === 0) return { state: null, label: null };
  if (winner) {
    const toolName =
      winner === 'tool-running' &&
      liveNonIdle.length === 1 &&
      liveNonIdle[0].state === 'tool-running'
        ? liveNonIdle[0].owner.snapshot.toolName
        : null;
    return { state: winner, label: aggregateLabel(winner, toolName) };
  }
  if (unresolved) return { state: 'unknown', label: aggregateLabel('unknown') };
  return { state: 'idle', label: aggregateLabel('idle') };
}

function emptyLedger(target, now) {
  return {
    schemaVersion: 1,
    target: { ...target },
    nextGenerationBySurface: {},
    owners: [],
    desired: { state: null, label: null, revision: 0, transitionAt: now },
    applied: { state: null, label: null, revision: 0, transitionAt: now },
    updatedAt: now,
  };
}

function validStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!exactFields(value, statusFields)) return false;
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !validTime(value.transitionAt)
  ) {
    return false;
  }
  if (value.state === null) return value.label === null;
  if (!states.has(value.state) || typeof value.label !== 'string' || hasControl(value.label)) {
    return false;
  }
  if (value.state === 'tool-running') {
    if (value.label === 'Tool running') return true;
    const toolName = value.label.startsWith('Tool running: ')
      ? value.label.slice('Tool running: '.length)
      : '';
    return LIFECYCLE_TOOL_NAME_PATTERN.test(toolName);
  }
  return value.label === aggregateLabel(value.state);
}

function validDurableOwner(owner, target, counters, updatedAt) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false;
  if (!exactFields(owner, durableOwnerFields)) return false;
  for (const field of LIFECYCLE_IDENTITY_FIELDS) {
    if (!validIdentity(owner[field])) return false;
  }
  return (
    owner.workspaceId === target.workspaceId &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    validTime(owner.processStartedAt) &&
    Number.isSafeInteger(owner.ownerGeneration) &&
    owner.ownerGeneration > 0 &&
    Number.isSafeInteger(owner.acceptedRevision) &&
    owner.acceptedRevision >= 0 &&
    validTime(owner.heartbeatAt) &&
    owner.heartbeatAt <= updatedAt &&
    typeof owner.connected === 'boolean' &&
    typeof owner.replayPending === 'boolean' &&
    validTime(owner.disconnectedAt, true) &&
    (owner.connected ? owner.disconnectedAt === null : owner.disconnectedAt !== null) &&
    (owner.liveness === 'live'
      ? owner.connected && !owner.replayPending && owner.disconnectedAt === null
      : owner.liveness === 'stale') &&
    counters[owner.surfaceId] >= owner.ownerGeneration &&
    validSnapshot(owner.snapshot)
  );
}

function safeInitialLedger(value, target, now) {
  const invalid = () => emptyLedger(target, now);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (!exactFields(value, ledgerFields) || value.schemaVersion !== 1) return invalid();
  if (
    !value.target ||
    typeof value.target !== 'object' ||
    Array.isArray(value.target) ||
    !exactFields(value.target, ['socketPath', 'workspaceId']) ||
    value.target.socketPath !== target.socketPath ||
    value.target.workspaceId !== target.workspaceId ||
    !validIdentity(value.target.socketPath) ||
    !validIdentity(value.target.workspaceId) ||
    !Array.isArray(value.owners) ||
    !value.nextGenerationBySurface ||
    typeof value.nextGenerationBySurface !== 'object' ||
    Array.isArray(value.nextGenerationBySurface) ||
    !validStatus(value.desired) ||
    !validStatus(value.applied) ||
    !validTime(value.updatedAt) ||
    value.applied.revision > value.desired.revision ||
    value.desired.transitionAt > value.updatedAt ||
    value.applied.transitionAt > value.updatedAt
  ) {
    return invalid();
  }
  for (const [surfaceId, generation] of Object.entries(value.nextGenerationBySurface)) {
    if (!validIdentity(surfaceId) || !Number.isSafeInteger(generation) || generation <= 0) {
      return invalid();
    }
  }
  const surfaces = new Set();
  for (const owner of value.owners) {
    if (
      !validDurableOwner(owner, target, value.nextGenerationBySurface, value.updatedAt) ||
      surfaces.has(owner.surfaceId)
    ) {
      return invalid();
    }
    surfaces.add(owner.surfaceId);
  }

  const ledger = clone(value);
  for (const owner of ledger.owners) {
    owner.connected = false;
    owner.replayPending = true;
    owner.disconnectedAt = now;
    owner.liveness = 'stale';
    owner.socketToken = null;
  }
  return ledger;
}

function genericOutcome(result) {
  if (result?.ok === true) return 'delivered';
  return ['exit-failed', 'timed-out', 'signaled', 'spawn-failed'].includes(result?.outcome)
    ? result.outcome
    : 'failed';
}

export function createCoordinatorCore(options) {
  const now = options.now ?? Date.now;
  const probePid = options.probePid ?? (() => 'unverifiable');
  const persist = options.persist ?? (async () => {});
  const publish = options.publish ?? (async () => ({ ok: true }));
  let ledger = safeInitialLedger(options.initialLedger, options.target, now());
  let owners = new Map(ledger.owners.map((owner) => [owner.surfaceId, owner]));
  let socketBindings = new Map();
  const pendingClosures = new Map();
  let operationTail = Promise.resolve();
  let publication = null;
  let deliveryOutcome = null;
  let retryScheduled = false;
  let finalClearObligated = false;
  let finalClearReadyAt = null;
  let finalClearStartedAt = null;
  let finalClearAttempts = 0;

  const snapshotLedger = (sourceLedger = ledger, sourceOwners = owners) => ({
    ...sourceLedger,
    target: { ...sourceLedger.target },
    nextGenerationBySurface: { ...sourceLedger.nextGenerationBySurface },
    owners: [...sourceOwners.values()]
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId))
      .map((owner) => {
        const durableOwner = clone(owner);
        delete durableOwner.socketToken;
        return durableOwner;
      }),
    desired: { ...sourceLedger.desired },
    applied: { ...sourceLedger.applied },
  });

  const recompute = (draft) => {
    const aggregate = aggregateOwners(draft.owners.values(), now());
    if (!statusEqual(aggregate, draft.ledger.desired)) {
      if (aggregate.state === null) {
        draft.finalClearObligated = true;
        draft.finalClearReadyAt = draft.clearImmediately ? now() : now() + RECONNECT_GRACE_MS;
        draft.finalClearStartedAt = null;
        draft.finalClearAttempts = 0;
      } else {
        draft.finalClearObligated = false;
        draft.finalClearReadyAt = null;
        draft.finalClearStartedAt = null;
        draft.finalClearAttempts = 0;
      }
      draft.ledger.desired = {
        ...aggregate,
        revision: draft.ledger.desired.revision + 1,
        transitionAt: now(),
      };
    }
  };

  const createDraft = () => {
    const draftLedger = clone(ledger);
    const draftOwners = new Map([...owners].map(([key, owner]) => [key, clone(owner)]));
    return {
      ledger: draftLedger,
      owners: draftOwners,
      socketBindings: new Map([...socketBindings].map(([key, binding]) => [key, clone(binding)])),
      finalClearObligated,
      finalClearReadyAt,
      finalClearStartedAt,
      finalClearAttempts,
      clearImmediately: false,
    };
  };

  const commitDraft = (draft) => {
    ledger = draft.ledger;
    owners = draft.owners;
    socketBindings = draft.socketBindings;
    finalClearObligated = draft.finalClearObligated;
    finalClearReadyAt = draft.finalClearReadyAt;
    finalClearStartedAt = draft.finalClearStartedAt;
    finalClearAttempts = draft.finalClearAttempts;
  };

  const persistDraft = async (draft) => {
    draft.ledger.updatedAt = now();
    draft.ledger.owners = [...draft.owners.values()];
    await persist(snapshotLedger(draft.ledger, draft.owners));
  };

  const enqueue = (operation) => {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const scheduleReconcile = (delay) => {
    if (!options.schedule || retryScheduled) return;
    retryScheduled = true;
    options.schedule(() => {
      retryScheduled = false;
      kickPublication();
    }, delay);
  };

  const kickPublication = () => {
    if (
      publication ||
      (!finalClearObligated && statusEqual(ledger.desired, ledger.applied)) ||
      (ledger.desired.state === null && finalClearAttempts >= 3)
    ) {
      return;
    }
    publication = (async () => {
      while (finalClearObligated || !statusEqual(ledger.desired, ledger.applied)) {
        const attempted = { ...ledger.desired };
        const clearing = attempted.state === null;
        if (clearing && finalClearReadyAt !== null && now() < finalClearReadyAt) {
          scheduleReconcile(finalClearReadyAt - now());
          return;
        }
        if (clearing && finalClearAttempts >= 3) return;
        if (clearing) {
          finalClearStartedAt ??= now();
          finalClearAttempts += 1;
        }
        const result = await publish({ state: attempted.state, label: attempted.label });
        deliveryOutcome = genericOutcome(result);
        if (result?.ok !== true) {
          if (!statusEqual(attempted, ledger.desired)) continue;
          if (clearing) {
            const offsets = [500, 1_500];
            const offset = offsets[finalClearAttempts - 1];
            if (offset !== undefined) {
              scheduleReconcile(Math.max(0, finalClearStartedAt + offset - now()));
            } else {
              options.onFinalClear?.();
            }
          }
          return;
        }
        await enqueue(async () => {
          const draft = createDraft();
          draft.ledger.applied = attempted;
          await persistDraft(draft);
          commitDraft(draft);
          if (attempted.state === null && statusEqual(attempted, ledger.desired)) {
            finalClearObligated = false;
            if (owners.size === 0) options.onFinalClear?.();
          }
        });
      }
    })()
      .catch(() => {
        deliveryOutcome = 'persistence-failed';
      })
      .finally(() => {
        publication = null;
      });
  };

  const mutate = (operation) =>
    enqueue(async () => {
      const draft = createDraft();
      const result = operation(draft);
      if (result?.ok === false) return result;
      recompute(draft);
      await persistDraft(draft);
      commitDraft(draft);
      kickPublication();
      return result;
    });

  const assignGeneration = (draftLedger, surfaceId, existing) => {
    const previousGeneration = Object.prototype.hasOwnProperty.call(
      draftLedger.nextGenerationBySurface,
      surfaceId,
    )
      ? Number(draftLedger.nextGenerationBySurface[surfaceId])
      : 0;
    const generation =
      Math.max(
        Number.isSafeInteger(previousGeneration) ? previousGeneration : 0,
        existing?.ownerGeneration ?? 0,
      ) + 1;
    Object.defineProperty(draftLedger.nextGenerationBySurface, surfaceId, {
      configurable: true,
      enumerable: true,
      value: generation,
      writable: true,
    });
    return generation;
  };

  const bindingMatches = (binding, message, generation = message.ownerGeneration) =>
    binding.surfaceId === message.surfaceId &&
    binding.sessionId === message.sessionId &&
    binding.runtimeId === message.runtimeId &&
    binding.pid === message.pid &&
    binding.processStartedAt === message.processStartedAt &&
    binding.connectionId === message.connectionId &&
    (generation === null || binding.ownerGeneration === generation);

  const acceptSnapshot = async (input, socketToken) => {
    const decoded = decodeWireMessage(input, options.target);
    if (!decoded.ok || decoded.value.kind !== 'snapshot') return decoded;
    if (!validIdentity(socketToken)) return fail('socket');
    const message = decoded.value;
    return await mutate((draft) => {
      const binding = draft.socketBindings.get(socketToken);
      if (binding && !bindingMatches(binding, message)) return fail('socket-owner');

      const existing = draft.owners.get(message.surfaceId);
      if (binding && (!existing || existing.socketToken !== socketToken)) return fail('fence');

      let generation = message.ownerGeneration;
      if (generation === null) {
        if (existing && ownerIdentityMatches(existing, message)) {
          generation = existing.ownerGeneration;
        } else {
          generation = assignGeneration(draft.ledger, message.surfaceId, existing);
        }
      } else if (!existing) {
        // The prior lease was reaped. A fresh physical socket may safely register
        // the same live process and receive a newly coordinator-assigned generation.
        generation = assignGeneration(draft.ledger, message.surfaceId, null);
      } else if (
        existing.ownerGeneration !== message.ownerGeneration ||
        !ownerIdentityMatches(existing, message)
      ) {
        return fail('fence');
      }

      if (existing && generation === existing.ownerGeneration) {
        if (!ownerIdentityMatches(existing, message)) return fail('fence');
        if (existing.socketToken !== null && existing.socketToken !== socketToken && binding) {
          return fail('fence');
        }
        if (message.revision <= existing.acceptedRevision) return fail('revision');
      }

      const candidate = {
        workspaceId: message.workspaceId,
        surfaceId: message.surfaceId,
        sessionId: message.sessionId,
        runtimeId: message.runtimeId,
        pid: message.pid,
        processStartedAt: message.processStartedAt,
        connectionId: message.connectionId,
        ownerGeneration: generation,
        acceptedRevision: message.revision,
        heartbeatAt: now(),
        connected: true,
        replayPending: false,
        disconnectedAt: null,
        liveness: 'stale',
        socketToken,
        snapshot: {
          state: message.state,
          toolName: message.toolName,
          transitionAt: message.transitionAt,
          lastEventAt: message.lastEventAt,
          compactionAt: message.compactionAt,
        },
      };
      candidate.liveness = classifyOwner(candidate, now(), probePid);
      if (candidate.liveness === 'dead') {
        if (
          existing &&
          existing.socketToken === socketToken &&
          ownerIdentityMatches(existing, message) &&
          existing.ownerGeneration === generation
        ) {
          draft.owners.delete(message.surfaceId);
        }
        return fail('dead');
      }
      draft.owners.set(message.surfaceId, candidate);
      draft.socketBindings.set(socketToken, {
        surfaceId: message.surfaceId,
        sessionId: message.sessionId,
        runtimeId: message.runtimeId,
        pid: message.pid,
        processStartedAt: message.processStartedAt,
        connectionId: message.connectionId,
        ownerGeneration: generation,
      });
      return {
        ok: true,
        acceptedGeneration: generation,
        acceptedRevision: message.revision,
      };
    });
  };

  const goodbye = async (input, socketToken) => {
    const decoded = decodeWireMessage(input, options.target);
    if (!decoded.ok || decoded.value.kind !== 'goodbye') return decoded;
    if (!validIdentity(socketToken)) return fail('socket');
    const message = decoded.value;
    return await mutate((draft) => {
      const binding = draft.socketBindings.get(socketToken);
      const owner = draft.owners.get(message.surfaceId);
      if (
        !binding ||
        !bindingMatches(binding, message) ||
        !owner ||
        owner.socketToken !== socketToken ||
        !ownerFenceMatches(owner, message) ||
        message.revision <= owner.acceptedRevision
      ) {
        return fail('fence');
      }
      draft.owners.delete(message.surfaceId);
      draft.socketBindings.delete(socketToken);
      return {
        ok: true,
        removed: true,
        acceptedGeneration: message.ownerGeneration,
        acceptedRevision: message.revision,
      };
    });
  };

  const connectionClosed = async (socketToken) => {
    const binding = socketBindings.get(socketToken);
    socketBindings.delete(socketToken);
    if (!binding) return { ok: true, changed: false };
    const disconnectedAt = now();
    try {
      return await mutate((draft) => {
        draft.socketBindings.delete(socketToken);
        const owner = draft.owners.get(binding.surfaceId);
        if (!owner || owner.socketToken !== socketToken) return { ok: true, changed: false };
        owner.connected = false;
        owner.disconnectedAt = disconnectedAt;
        owner.liveness = classifyOwner(owner, now(), probePid);
        if (owner.liveness === 'dead') draft.owners.delete(binding.surfaceId);
        return { ok: true, changed: true };
      });
    } catch (error) {
      pendingClosures.set(socketToken, { binding, disconnectedAt });
      throw error;
    }
  };

  const maintain = async () => {
    const closures = [...pendingClosures];
    const result = await mutate((draft) => {
      for (const [socketToken, closure] of closures) {
        const owner = draft.owners.get(closure.binding.surfaceId);
        if (owner?.socketToken !== socketToken) continue;
        owner.connected = false;
        owner.disconnectedAt = closure.disconnectedAt;
      }
      for (const [surfaceId, owner] of draft.owners) {
        owner.liveness = classifyOwner(owner, now(), probePid);
        if (owner.replayPending) owner.liveness = 'stale';
        if (
          owner.liveness === 'dead' ||
          (owner.disconnectedAt !== null && now() - owner.disconnectedAt >= RECONNECT_GRACE_MS)
        ) {
          if (owner.replayPending) draft.clearImmediately = true;
          draft.owners.delete(surfaceId);
        }
      }
      return { ok: true };
    });
    for (const [socketToken] of closures) pendingClosures.delete(socketToken);
    return result;
  };

  const reconcile = async () => {
    await operationTail;
    kickPublication();
    if (publication) await publication;
  };

  const drain = async () => {
    for (;;) {
      await operationTail;
      const active = publication;
      if (!active) return;
      await active;
    }
  };

  return {
    acceptSnapshot,
    goodbye,
    connectionClosed,
    maintain,
    reconcile,
    drain,
    ledger: snapshotLedger,
    diagnostics: () => ({
      targetHash: createHash('sha256')
        .update(`${options.target.socketPath}\0${options.target.workspaceId}`)
        .digest('hex')
        .slice(0, 16),
      ownerCount: owners.size,
      desired: { state: ledger.desired.state, revision: ledger.desired.revision },
      applied: { state: ledger.applied.state, revision: ledger.applied.revision },
      queueDepth: publication ? 1 : 0,
      deliveryOutcome,
    }),
  };
}

export function createAtomicLedgerStore(path, filesystem = {}) {
  const io = {
    chmod: filesystem.chmod ?? chmod,
    mkdir: filesystem.mkdir ?? mkdir,
    open: filesystem.open ?? open,
    rename: filesystem.rename ?? rename,
    readFile: filesystem.readFile ?? readFile,
    rm: filesystem.rm ?? rm,
  };
  return {
    async read() {
      try {
        return JSON.parse(await io.readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    async write(ledger) {
      const directory = dirname(path);
      const temporary = `${path}.tmp-${process.pid}`;
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
      await io.chmod(directory, 0o700);
      const handle = await io.open(temporary, 'w', 0o600);
      try {
        await io.chmod(temporary, 0o600);
        await handle.writeFile(`${JSON.stringify(ledger)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await io.rename(temporary, path);
      await io.chmod(path, 0o600);
      const directoryHandle = await io.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    },
  };
}

export function parseRuntimeArgs(argv) {
  const expected = new Set(['listen', 'ledger', 'cmux-socket', 'workspace']);
  const values = {};
  if (argv.length !== expected.size * 2) throw new Error('invalid coordinator arguments');
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const name = option?.startsWith('--') ? option.slice(2) : '';
    if (!expected.has(name) || value === undefined || Object.hasOwn(values, name)) {
      throw new Error('invalid coordinator arguments');
    }
    values[name] = value;
  }
  for (const name of expected) {
    if (typeof values[name] !== 'string' || values[name].length === 0) {
      throw new Error('missing coordinator argument');
    }
  }
  if (!validIdentity(values.workspace)) throw new Error('invalid coordinator target');
  return values;
}

const statusStyles = {
  idle: { icon: 'pause.circle.fill', color: '#8E8E93', priority: 0 },
  thinking: { icon: 'brain', color: '#4C8DFF', priority: 0 },
  'tool-running': { icon: 'wrench.fill', color: '#4C8DFF', priority: 0 },
  'awaiting-input': { icon: 'bell.fill', color: '#FF9F0A', priority: 100 },
  compacting: { icon: 'trash.fill', color: '#4C8DFF', priority: 0 },
  error: { icon: 'exclamationmark.triangle.fill', color: '#FF453A', priority: 100 },
  unknown: { icon: 'questionmark.circle', color: '#8E8E93', priority: 50 },
};

export function buildCmuxStatusArgs(target, status) {
  if (status.label === null) {
    return [
      '--socket',
      target.socketPath,
      'clear-status',
      STATUS_KEY,
      '--workspace',
      target.workspaceId,
    ];
  }

  if (!Object.hasOwn(statusStyles, status.state)) {
    throw new Error(`missing cmux status style for state: ${String(status.state)}`);
  }
  const style = statusStyles[status.state];
  return [
    '--socket',
    target.socketPath,
    'set-status',
    STATUS_KEY,
    status.label,
    '--workspace',
    target.workspaceId,
    '--icon',
    style.icon,
    '--color',
    style.color,
    '--priority',
    String(style.priority),
  ];
}

export function runCmux(file, args, env, execute = execFile) {
  return new Promise((resolve) => {
    execute(
      file,
      args,
      { env, timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false },
      (error) => {
        if (!error) return resolve({ ok: true, outcome: 'delivered' });
        const failure = classifyExecFileFailure(error);
        const outcome = {
          timeout: 'timed-out',
          signal: 'signaled',
          exit: 'exit-failed',
          spawn: 'spawn-failed',
        }[failure.kind];
        return resolve({ ok: false, outcome });
      },
    );
  });
}

export async function runCoordinatorRuntime(argv = process.argv.slice(2), runtime = {}) {
  const args = parseRuntimeArgs(argv);
  const target = { socketPath: args['cmux-socket'], workspaceId: args.workspace };
  const store = runtime.store ?? createAtomicLedgerStore(args.ledger);
  const initialLedger = await store.read();
  const env = runtime.env ?? process.env;
  const cmuxFile = await resolveCmuxExecutable(env, runtime.access);
  let stopAfterClear = () => {};
  const core = createCoordinatorCore({
    target,
    initialLedger,
    now: runtime.now,
    persist: (ledger) => store.write(ledger),
    probePid: runtime.probePid ?? probePidStart,
    schedule: runtime.schedule ?? ((callback, delay) => setTimeout(callback, delay).unref()),
    onFinalClear: () => stopAfterClear(),
    publish:
      runtime.publish ??
      ((status) =>
        runCmux(cmuxFile, buildCmuxStatusArgs(target, status), env, runtime.execFile ?? execFile)),
  });

  const runtimeMkdir = runtime.mkdir ?? mkdir;
  const runtimeChmod = runtime.chmod ?? chmod;
  const runtimeRm = runtime.rm ?? rm;
  await runtimeMkdir(dirname(args.listen), { recursive: true, mode: 0o700 });
  await runtimeChmod(dirname(args.listen), 0o700);
  await runtimeRm(args.listen, { force: true });
  const sockets = new Set();
  const server = createServer((socket) => {
    const socketToken = (runtime.randomId ?? randomUUID)();
    sockets.add(socket);
    let buffer = '';
    let malformed = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const decoded = decodeWireLine(line, target);
        if (!decoded.ok) {
          malformed += 1;
          if (malformed >= 3) socket.destroy();
          continue;
        }
        const message = decoded.value;
        const operation =
          message.kind === 'snapshot'
            ? core.acceptSnapshot(message, socketToken)
            : core.goodbye(message, socketToken);
        void operation
          .then((result) => {
            if (result.ok) {
              socket.write(
                `${JSON.stringify(
                  createAck(message, result.acceptedGeneration, result.acceptedRevision),
                )}\n`,
              );
            }
          })
          .catch(() => undefined);
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LIFECYCLE_FRAME_BYTES) socket.destroy();
    });
    socket.on('close', () => {
      sockets.delete(socket);
      void core
        .connectionClosed(socketToken)
        .catch(() => undefined)
        .finally(() => {
          const schedule =
            runtime.schedule ?? ((callback, delay) => setTimeout(callback, delay).unref());
          schedule(() => void core.maintain().catch(() => undefined), RECONNECT_GRACE_MS);
        });
    });
  });
  let bound = false;
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(args.listen, () => {
        server.off('error', onError);
        bound = true;
        resolve();
      });
    });
    await runtimeChmod(args.listen, 0o600);
  } catch (error) {
    if (bound) await new Promise((resolve) => server.close(() => resolve()));
    await runtimeRm(args.listen, { force: true });
    throw error;
  }
  const maintenance = setInterval(() => {
    void core
      .maintain()
      .then(() => core.reconcile())
      .catch(() => undefined);
  }, 30_000);
  maintenance.unref();
  let stopping = false;
  stopAfterClear = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(maintenance);
    for (const socket of sockets) socket.destroy();
    server.close(() => void runtimeRm(args.listen, { force: true }));
  };
  return { server, core, close: stopAfterClear };
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  runCoordinatorRuntime().catch(() => {
    process.exitCode = 1;
  });
}
