#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

export const PROTOCOL = 'pi-junction.lifecycle.v1';
export const STATUS_KEY = 'pi-junction';
export const MAX_FRAME_BYTES = 16 * 1024;
export const RECONNECT_GRACE_MS = 5_000;

const states = new Set([
  'idle',
  'thinking',
  'tool-running',
  'awaiting-input',
  'compacting',
  'error',
  'unknown',
]);
const activeRanks = new Map([
  ['thinking', 1],
  ['tool-running', 2],
  ['awaiting-input', 3],
  ['error', 4],
  ['compacting', 5],
]);
const commonFields = [
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
const snapshotFields = [
  ...commonFields,
  'state',
  'toolName',
  'transitionAt',
  'lastEventAt',
  'compactionStartedAt',
  'compactionProgressAt',
];
const identityFields = ['workspaceId', 'surfaceId', 'sessionId', 'runtimeId', 'connectionId'];
const toolNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,63}$/u;

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

export function decodeWireLine(line, target) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
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
  if (value.protocol !== PROTOCOL) return fail('protocol');
  if (value.kind !== 'snapshot' && value.kind !== 'goodbye') return fail('kind');
  if (!exactFields(value, value.kind === 'snapshot' ? snapshotFields : commonFields)) {
    return fail('fields');
  }
  for (const field of identityFields) {
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
  if (value.kind === 'snapshot') {
    if (!states.has(value.state)) return fail('state');
    if (
      (value.toolName !== null &&
        (typeof value.toolName !== 'string' || !toolNamePattern.test(value.toolName))) ||
      (value.toolName !== null && value.state !== 'tool-running')
    ) {
      return fail('toolName');
    }
    if (
      !validTime(value.transitionAt) ||
      !validTime(value.lastEventAt, true) ||
      !validTime(value.compactionStartedAt, true) ||
      !validTime(value.compactionProgressAt, true)
    ) {
      return fail('number');
    }
    if (
      value.state === 'compacting' &&
      (value.compactionStartedAt === null || value.compactionProgressAt === null)
    ) {
      return fail('compaction');
    }
  }
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
  if (owner.heartbeatAt > now + 10_000) return 'stale';
  if (probe === 'match' && age <= 30_000 && !owner.disconnectedAt) return 'live';
  return 'stale';
}

function displayState(owner, now) {
  if (owner.liveness !== 'live') return 'unknown';
  const snapshot = owner.snapshot;
  if (snapshot.state === 'unknown') return 'unknown';
  if (snapshot.state === 'idle') return 'idle';
  if (
    snapshot.transitionAt > now + 5_000 ||
    snapshot.lastEventAt === null ||
    snapshot.lastEventAt > now + 5_000 ||
    now - snapshot.lastEventAt > 120_000
  ) {
    return 'unknown';
  }
  if (snapshot.state === 'compacting') {
    const progressAt = snapshot.compactionProgressAt;
    const startedAt = snapshot.compactionStartedAt;
    if (
      progressAt === null ||
      startedAt === null ||
      progressAt > now + 5_000 ||
      now - progressAt > 120_000 ||
      now - startedAt > 600_000
    ) {
      return 'unknown';
    }
  }
  return snapshot.state;
}

export function aggregateOwners(owners, now) {
  const ordered = [...owners].sort((left, right) =>
    `${left.surfaceId}\0${left.sessionId}\0${String(left.ownerGeneration).padStart(16, '0')}`.localeCompare(
      `${right.surfaceId}\0${right.sessionId}\0${String(right.ownerGeneration).padStart(16, '0')}`,
    ),
  );
  if (ordered.length === 0) return { state: null, label: null };

  let winner = null;
  let winnerRank = 0;
  let unresolved = false;
  const liveNonIdle = [];
  for (const owner of ordered) {
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

function safeInitialLedger(value, target, now) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.target?.socketPath !== target.socketPath ||
    value.target?.workspaceId !== target.workspaceId ||
    !Array.isArray(value.owners) ||
    !value.nextGenerationBySurface ||
    typeof value.nextGenerationBySurface !== 'object'
  ) {
    return emptyLedger(target, now);
  }
  const ledger = clone(value);
  ledger.owners = ledger.owners.filter(
    (owner) =>
      owner && typeof owner.surfaceId === 'string' && Number.isSafeInteger(owner.ownerGeneration),
  );
  for (const owner of ledger.owners) {
    owner.connected = false;
    owner.replayPending = true;
    owner.disconnectedAt = null;
    owner.liveness = 'stale';
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
  const ledger = safeInitialLedger(options.initialLedger, options.target, now());
  const owners = new Map(ledger.owners.map((owner) => [owner.surfaceId, owner]));
  let operationTail = Promise.resolve();
  let publication = null;
  let deliveryOutcome = null;
  let retryCount = 0;
  let retryScheduled = false;
  let finalClearReadyAt = null;
  let finalClearStartedAt = null;
  let finalClearAttempts = 0;

  const snapshotLedger = () => ({
    ...ledger,
    target: { ...ledger.target },
    nextGenerationBySurface: { ...ledger.nextGenerationBySurface },
    owners: [...owners.values()]
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId))
      .map((owner) => clone(owner)),
    desired: { ...ledger.desired },
    applied: { ...ledger.applied },
  });

  const persistCurrent = async () => {
    ledger.updatedAt = now();
    ledger.owners = [...owners.values()];
    await persist(snapshotLedger());
  };

  const recompute = () => {
    const aggregate = aggregateOwners(owners.values(), now());
    if (!statusEqual(aggregate, ledger.desired)) {
      if (aggregate.state === null && ledger.desired.state !== null) {
        finalClearReadyAt = now() + RECONNECT_GRACE_MS;
        finalClearStartedAt = null;
        finalClearAttempts = 0;
      } else if (aggregate.state !== null) {
        finalClearReadyAt = null;
        finalClearStartedAt = null;
        finalClearAttempts = 0;
      }
      ledger.desired = {
        ...aggregate,
        revision: ledger.desired.revision + 1,
        transitionAt: now(),
      };
    }
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
    if (publication || statusEqual(ledger.desired, ledger.applied)) return;
    if (ledger.desired.state === null && finalClearReadyAt !== null && now() < finalClearReadyAt) {
      scheduleReconcile(finalClearReadyAt - now());
      return;
    }
    if (ledger.desired.state === null && finalClearAttempts >= 3) return;
    publication = (async () => {
      while (!statusEqual(ledger.desired, ledger.applied)) {
        const attempted = { ...ledger.desired };
        const clearing = attempted.state === null;
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
          } else {
            const delays = [1_000, 2_000, 5_000, 10_000];
            scheduleReconcile(delays[Math.min(retryCount, delays.length - 1)]);
            retryCount += 1;
          }
          return;
        }
        retryCount = 0;
        await enqueue(async () => {
          ledger.applied = attempted;
          await persistCurrent();
          if (attempted.state === null && owners.size === 0) options.onFinalClear?.();
        });
      }
    })().finally(() => {
      publication = null;
    });
  };

  const mutate = (operation) =>
    enqueue(async () => {
      const result = operation();
      recompute();
      await persistCurrent();
      kickPublication();
      return result;
    });

  const acceptSnapshot = async (input) => {
    const decoded = decodeWireMessage(input, options.target);
    if (!decoded.ok || decoded.value.kind !== 'snapshot') return decoded;
    const message = decoded.value;
    return await mutate(() => {
      const existing = owners.get(message.surfaceId);
      let generation = message.ownerGeneration;
      let replay = false;
      if (generation === null) {
        if (existing && ownerIdentityMatches(existing, message)) {
          generation = existing.ownerGeneration;
          replay = existing.replayPending === true;
        } else {
          const previousGeneration = Object.prototype.hasOwnProperty.call(
            ledger.nextGenerationBySurface,
            message.surfaceId,
          )
            ? Number(ledger.nextGenerationBySurface[message.surfaceId])
            : 0;
          generation =
            Math.max(
              Number.isSafeInteger(previousGeneration) ? previousGeneration : 0,
              existing?.ownerGeneration ?? 0,
            ) + 1;
          Object.defineProperty(ledger.nextGenerationBySurface, message.surfaceId, {
            configurable: true,
            enumerable: true,
            value: generation,
            writable: true,
          });
        }
      } else if (
        !existing ||
        existing.ownerGeneration !== message.ownerGeneration ||
        !ownerStableIdentityMatches(existing, message)
      ) {
        return fail('fence');
      } else {
        replay = existing.replayPending === true;
      }
      if (existing && generation === existing.ownerGeneration) {
        if (!ownerStableIdentityMatches(existing, message)) return fail('fence');
        if (
          (!replay && message.revision <= existing.acceptedRevision) ||
          (replay && message.revision < existing.acceptedRevision)
        ) {
          return fail('revision');
        }
      }
      const owner = {
        workspaceId: message.workspaceId,
        surfaceId: message.surfaceId,
        sessionId: message.sessionId,
        runtimeId: message.runtimeId,
        pid: message.pid,
        processStartedAt: message.processStartedAt,
        connectionId: message.connectionId,
        ownerGeneration: generation,
        acceptedRevision: message.revision,
        heartbeatAt: message.sentAt,
        connected: true,
        replayPending: false,
        disconnectedAt: null,
        liveness: 'stale',
        snapshot: {
          state: message.state,
          toolName: message.toolName,
          transitionAt: message.transitionAt,
          lastEventAt: message.lastEventAt,
          compactionStartedAt: message.compactionStartedAt,
          compactionProgressAt: message.compactionProgressAt,
        },
      };
      owner.liveness = classifyOwner(owner, now(), probePid);
      if (owner.liveness === 'dead') {
        owners.delete(message.surfaceId);
        return fail('dead');
      }
      owners.set(message.surfaceId, owner);
      return {
        ok: true,
        acceptedGeneration: generation,
        acceptedRevision: message.revision,
      };
    });
  };

  const goodbye = async (input) => {
    const decoded = decodeWireMessage(input, options.target);
    if (!decoded.ok || decoded.value.kind !== 'goodbye') return decoded;
    const message = decoded.value;
    return await mutate(() => {
      const owner = owners.get(message.surfaceId);
      if (!ownerFenceMatches(owner ?? {}, message) || message.revision <= owner.acceptedRevision) {
        return { ok: true, removed: false };
      }
      owners.delete(message.surfaceId);
      return { ok: true, removed: true };
    });
  };

  const connectionClosed = async ({ surfaceId, connectionId, ownerGeneration }) =>
    await mutate(() => {
      const owner = owners.get(surfaceId);
      if (
        !owner ||
        owner.connectionId !== connectionId ||
        owner.ownerGeneration !== ownerGeneration
      ) {
        return { ok: true, changed: false };
      }
      owner.connected = false;
      owner.disconnectedAt = now();
      owner.liveness = classifyOwner(owner, now(), probePid);
      if (owner.liveness === 'dead') owners.delete(surfaceId);
      return { ok: true, changed: true };
    });

  const maintain = async () =>
    await mutate(() => {
      for (const [surfaceId, owner] of owners) {
        owner.liveness = classifyOwner(owner, now(), probePid);
        if (
          owner.liveness === 'dead' ||
          (owner.disconnectedAt !== null && now() - owner.disconnectedAt >= RECONNECT_GRACE_MS)
        ) {
          owners.delete(surfaceId);
        }
      }
      return { ok: true };
    });

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
        await handle.writeFile(`${JSON.stringify(ledger)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await io.rename(temporary, path);
      const directoryHandle = await io.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    },
  };
}

function parseRuntimeArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined)
      throw new Error('invalid coordinator arguments');
    values[name.slice(2)] = value;
  }
  for (const name of ['listen', 'ledger', 'cmux-socket', 'workspace']) {
    if (!validIdentity(values[name]) && name === 'workspace')
      throw new Error('invalid coordinator target');
    if (typeof values[name] !== 'string' || values[name].length === 0) {
      throw new Error('missing coordinator argument');
    }
  }
  return values;
}

async function resolveCmuxExecutable(env) {
  const bundled = env.CMUX_BUNDLED_CLI_PATH?.trim();
  if (!bundled) return 'cmux';
  try {
    await access(bundled, fsConstants.X_OK);
    return bundled;
  } catch {
    return 'cmux';
  }
}

function runCmux(file, args, env) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error) => {
        if (!error) return resolve({ ok: true, outcome: 'delivered' });
        if (error.killed) return resolve({ ok: false, outcome: 'timed-out' });
        if (error.signal) return resolve({ ok: false, outcome: 'signaled' });
        if (typeof error.code === 'number') return resolve({ ok: false, outcome: 'exit-failed' });
        return resolve({ ok: false, outcome: 'spawn-failed' });
      },
    );
  });
}

export async function runCoordinatorRuntime(argv = process.argv.slice(2), runtime = {}) {
  const args = parseRuntimeArgs(argv);
  const target = { socketPath: args['cmux-socket'], workspaceId: args.workspace };
  const store = createAtomicLedgerStore(args.ledger);
  const initialLedger = await store.read();
  const env = runtime.env ?? process.env;
  const cmuxFile = await resolveCmuxExecutable(env);
  let stopAfterClear = () => {};
  const core = createCoordinatorCore({
    target,
    initialLedger,
    persist: (ledger) => store.write(ledger),
    probePid: runtime.probePid ?? probePidStart,
    schedule: (callback, delay) => setTimeout(callback, delay).unref(),
    onFinalClear: () => stopAfterClear(),
    publish: (status) =>
      runCmux(
        cmuxFile,
        status.label === null
          ? [
              '--socket',
              target.socketPath,
              'clear-status',
              STATUS_KEY,
              '--workspace',
              target.workspaceId,
            ]
          : [
              '--socket',
              target.socketPath,
              'set-status',
              STATUS_KEY,
              status.label,
              '--workspace',
              target.workspaceId,
            ],
        env,
      ),
  });

  await mkdir(dirname(args.listen), { recursive: true, mode: 0o700 });
  await chmod(dirname(args.listen), 0o700);
  await rm(args.listen, { force: true });
  const server = createServer((socket) => {
    let buffer = '';
    let malformed = 0;
    let ownerFence = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES * 2) return socket.destroy();
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
          message.kind === 'snapshot' ? core.acceptSnapshot(message) : core.goodbye(message);
        void operation.then((result) => {
          if (result.ok && message.kind === 'snapshot') {
            ownerFence = {
              surfaceId: message.surfaceId,
              connectionId: message.connectionId,
              ownerGeneration: result.acceptedGeneration,
            };
          }
          socket.write(`${JSON.stringify(result)}\n`);
        });
      }
    });
    socket.on('close', () => {
      if (!ownerFence) return;
      void core.connectionClosed(ownerFence).then(() => {
        setTimeout(() => void core.maintain(), RECONNECT_GRACE_MS).unref();
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.listen, () => resolve());
  });
  await chmod(args.listen, 0o600);
  const maintenance = setInterval(() => {
    void core.maintain().then(() => core.reconcile());
  }, 30_000);
  maintenance.unref();
  stopAfterClear = () => {
    clearInterval(maintenance);
    server.close(() => void rm(args.listen, { force: true }));
  };
  return { server, core };
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  runCoordinatorRuntime().catch(() => {
    process.exitCode = 1;
  });
}
