import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { projectPresentationJ1 } from './presentation-j1.mjs';
import { decodePresentationRequest } from './presentation-protocol.mjs';

export const MAX_PRESENTATION_SOURCES = 16;
export const PRESENTATION_DISCONNECT_GRACE_MS = 5_000;
export const PRESENTATION_RECEIPT_EXPIRY_MS = 60_000;
export const PRESENTATION_MAINTENANCE_MS = 30_000;

function reject(reason) {
  return { ok: false, reason };
}

function sourceTuple(target, message) {
  return Object.freeze([
    normalize(target.socketPath),
    message.workspaceId,
    message.surfaceId,
    message.sessionId,
    message.runtimeId,
    message.pid,
    message.processStartedAt,
  ]);
}

export function presentationSourceId(tuple) {
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

function sameTuple(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function orderedBlocks(sources) {
  const blocks = [];
  for (const source of sources.values()) {
    for (const view of source.views) {
      blocks.push(
        Object.freeze({ sourceId: source.sourceId, producer: view.producer, items: view.items }),
      );
    }
  }
  blocks.sort(
    (left, right) =>
      (left.producer.key < right.producer.key
        ? -1
        : left.producer.key > right.producer.key
          ? 1
          : 0) || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0),
  );
  return Object.freeze(blocks);
}

function bindingMatches(binding, source, message) {
  return (
    binding.sourceId === source.sourceId &&
    binding.connectionId === message.connectionId &&
    binding.generation === message.sourceGeneration
  );
}

function capacityAccepted(capacity, blocks) {
  if (!capacity) return true;
  try {
    const result = capacity(blocks);
    return result === true || result?.ok === true;
  } catch {
    return false;
  }
}

function projected(blocks) {
  const result = projectPresentationJ1(blocks);
  return result.kind === 'reject' ? null : result;
}

export function createPresentationCore(options) {
  const now = options.now ?? Date.now;
  const probePid = options.probePid ?? (() => 'unverifiable');
  const digest = options.sourceId ?? presentationSourceId;
  let sources = new Map();
  let bindings = new Map();
  let nextGeneration = 0;
  let blocks = Object.freeze([]);
  let projection = projectPresentationJ1(blocks);

  const notifyProjection = () => {
    try {
      Promise.resolve(options.onProjection?.(projection)).catch(() => undefined);
    } catch {
      // Publication cannot change committed source acceptance or delay its ACK.
    }
  };

  const notifyIfEmptied = (previousSize) => {
    if (previousSize > 0 && sources.size === 0) options.onEmpty?.();
  };

  const decode = (input, kind) => {
    const decoded = decodePresentationRequest(input);
    if (!decoded.ok || decoded.value.kind !== kind) return null;
    return decoded.value;
  };

  const identify = (message) => {
    const tuple = sourceTuple(options.target, message);
    try {
      const sourceId = digest(tuple);
      if (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceId)) return null;
      return { tuple, sourceId };
    } catch {
      return null;
    }
  };

  const acceptSnapshot = (input, socketToken) => {
    const message = decode(input, 'snapshot');
    if (!message) return reject('fenced');
    if (message.workspaceId !== options.target.workspaceId) return reject('wrong-target');
    if (typeof socketToken !== 'string' || socketToken.length === 0) return reject('fenced');

    const identity = identify(message);
    if (!identity) return reject('identity-collision');
    const existing = sources.get(identity.sourceId);
    if (existing && !sameTuple(existing.tuple, identity.tuple)) {
      return reject('identity-collision');
    }

    const socketBinding = bindings.get(socketToken);
    if (socketBinding && socketBinding.sourceId !== identity.sourceId) return reject('fenced');
    if (socketBinding && (!existing || existing.socketToken !== socketToken)) {
      return reject('fenced');
    }

    let generation;
    let draftNextGeneration = nextGeneration;
    const continuing = existing && existing.connectionId === message.connectionId;
    if (continuing) {
      generation = existing.generation;
      if (message.sourceGeneration !== null && message.sourceGeneration !== existing.generation) {
        return reject('fenced');
      }
      if (message.revision <= existing.acceptedRevision) return reject('stale-revision');
    } else if (message.sourceGeneration === null || !existing) {
      generation = nextGeneration + 1;
      draftNextGeneration = generation;
    } else {
      return reject('fenced');
    }

    if (socketBinding && socketBinding.generation !== generation) return reject('fenced');
    const pid = probePid(message.pid, message.processStartedAt);
    if (pid === 'missing' || pid === 'reused') return reject('dead-source');

    const receiptAt = now();
    const candidate = Object.freeze({
      sourceId: identity.sourceId,
      tuple: identity.tuple,
      workspaceId: message.workspaceId,
      surfaceId: message.surfaceId,
      sessionId: message.sessionId,
      runtimeId: message.runtimeId,
      pid: message.pid,
      processStartedAt: message.processStartedAt,
      connectionId: message.connectionId,
      generation,
      acceptedRevision: message.revision,
      socketToken,
      receiptAt,
      connected: true,
      disconnectedAt: null,
      views: message.views,
    });
    const draftSources = new Map(sources);
    draftSources.set(identity.sourceId, candidate);
    if (draftSources.size > MAX_PRESENTATION_SOURCES) return reject('source-limit');
    const draftBlocks = orderedBlocks(draftSources);
    const draftProjection = projected(draftBlocks);
    if (!draftProjection || !capacityAccepted(options.capacity, draftBlocks)) {
      return reject('capacity');
    }

    const draftBindings = new Map(bindings);
    draftBindings.set(socketToken, {
      sourceId: identity.sourceId,
      connectionId: message.connectionId,
      generation,
    });
    sources = draftSources;
    bindings = draftBindings;
    nextGeneration = draftNextGeneration;
    blocks = draftBlocks;
    projection = draftProjection;
    notifyProjection();
    return {
      ok: true,
      acceptedGeneration: generation,
      acceptedRevision: message.revision,
    };
  };

  const goodbye = (input, socketToken) => {
    const message = decode(input, 'goodbye');
    if (!message) return reject('fenced');
    if (message.workspaceId !== options.target.workspaceId) return reject('wrong-target');
    const identity = identify(message);
    if (!identity) return reject('identity-collision');
    const source = sources.get(identity.sourceId);
    if (source && !sameTuple(source.tuple, identity.tuple)) return reject('identity-collision');
    const binding = bindings.get(socketToken);
    if (
      !source ||
      source.socketToken !== socketToken ||
      !binding ||
      !bindingMatches(binding, source, message) ||
      source.connectionId !== message.connectionId ||
      source.generation !== message.sourceGeneration ||
      message.revision <= source.acceptedRevision
    ) {
      return reject('fenced');
    }

    const previousSize = sources.size;
    const draftSources = new Map(sources);
    draftSources.delete(identity.sourceId);
    const draftBlocks = orderedBlocks(draftSources);
    const draftProjection = projected(draftBlocks);
    if (!draftProjection) return reject('capacity');
    sources = draftSources;
    blocks = draftBlocks;
    projection = draftProjection;
    notifyProjection();
    // Retain the physical binding until EOF so traffic after goodbye remains fenced.
    notifyIfEmptied(previousSize);
    return {
      ok: true,
      removed: true,
      acceptedGeneration: source.generation,
      acceptedRevision: message.revision,
    };
  };

  const connectionClosed = (socketToken) => {
    const binding = bindings.get(socketToken);
    if (!binding) return { ok: true, changed: false };
    const draftBindings = new Map(bindings);
    draftBindings.delete(socketToken);
    bindings = draftBindings;
    const source = sources.get(binding.sourceId);
    if (!source || source.socketToken !== socketToken) return { ok: true, changed: false };
    const draftSources = new Map(sources);
    draftSources.set(
      binding.sourceId,
      Object.freeze({ ...source, connected: false, disconnectedAt: now() }),
    );
    sources = draftSources;
    return { ok: true, changed: true };
  };

  const maintain = () => {
    const currentTime = now();
    const previousSize = sources.size;
    const draftSources = new Map(sources);
    const draftBindings = new Map(bindings);
    for (const [sourceId, source] of sources) {
      const pid = probePid(source.pid, source.processStartedAt);
      const disconnected =
        source.disconnectedAt !== null &&
        currentTime - source.disconnectedAt >= PRESENTATION_DISCONNECT_GRACE_MS;
      const expired = currentTime - source.receiptAt >= PRESENTATION_RECEIPT_EXPIRY_MS;
      if (pid !== 'missing' && pid !== 'reused' && !disconnected && !expired) continue;
      draftSources.delete(sourceId);
      if (source.socketToken && draftBindings.get(source.socketToken)?.sourceId === sourceId) {
        draftBindings.delete(source.socketToken);
      }
    }
    const draftBlocks = orderedBlocks(draftSources);
    const draftProjection = projected(draftBlocks);
    if (!draftProjection) return { ok: true, changed: false };
    sources = draftSources;
    bindings = draftBindings;
    blocks = draftBlocks;
    projection = draftProjection;
    if (previousSize !== sources.size) notifyProjection();
    notifyIfEmptied(previousSize);
    return { ok: true, changed: previousSize !== sources.size };
  };

  return {
    acceptSnapshot,
    goodbye,
    connectionClosed,
    maintain,
    blocks: () => blocks,
    projection: () => projection,
    isQuiescent: () => sources.size === 0,
    diagnostics: () => ({
      sourceCount: sources.size,
      blockCount: blocks.length,
      connectedCount: [...sources.values()].filter((source) => source.connected).length,
      nextGeneration,
    }),
  };
}
