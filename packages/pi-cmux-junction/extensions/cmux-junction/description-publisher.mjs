import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import { MAX_PRESENTATION_J1_BYTES } from './presentation-j1.mjs';

export const DESCRIPTION_OUTPUT_BOUND = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const metricFields = [
  'sourceCount',
  'blockCount',
  'itemCount',
  'rowCount',
  'recordCount',
  'fieldCount',
  'byteCount',
];

function dataRecord(value, fields) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return fields.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
    })
  );
}

export function validateDescriptionTarget(value, target) {
  try {
    if (!dataRecord(value, ['socketPath', 'windowId', 'workspaceId'])) return null;
    const { socketPath, windowId, workspaceId } = value;
    if (
      typeof socketPath !== 'string' ||
      !socketPath.trim() ||
      !isAbsolute(socketPath) ||
      [...socketPath].some((character) => {
        const code = character.codePointAt(0);
        return code <= 31 || (code >= 127 && code <= 159);
      })
    )
      return null;
    if (
      typeof windowId !== 'string' ||
      !uuid.test(windowId) ||
      typeof workspaceId !== 'string' ||
      !uuid.test(workspaceId)
    )
      return null;
    if (
      target !== undefined &&
      (typeof target !== 'string' || workspaceId.toLowerCase() !== target.toLowerCase())
    )
      return null;
    return Object.freeze({
      socketPath: normalize(socketPath),
      windowId: windowId.toLowerCase(),
      workspaceId: workspaceId.toLowerCase(),
    });
  } catch {
    return null;
  }
}

function validProjection(value) {
  try {
    if (!value || !Object.isFrozen(value)) return false;
    const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
    if (
      !dataRecord(
        value,
        kind === 'clear' ? ['kind', 'metrics'] : ['kind', 'j1', 'digest', 'metrics'],
      )
    )
      return false;
    if (
      !dataRecord(value.metrics, metricFields) ||
      !Object.isFrozen(value.metrics) ||
      !metricFields.every(
        (field) => Number.isSafeInteger(value.metrics[field]) && value.metrics[field] >= 0,
      )
    )
      return false;
    if (kind === 'clear') return metricFields.every((field) => value.metrics[field] === 0);
    // J2 only: 67-byte ASCII/US header, then RS at 67 and body at 68.
    // Old J1 remains foreign; this does not grant migration or cleanup authority.
    return (
      kind === 'set' &&
      typeof value.j1 === 'string' &&
      value.j1.startsWith('J2\u001f') &&
      /^[a-f0-9]{64}$/u.test(value.j1.slice(3, 67)) &&
      value.j1.slice(67, 70) === '\u001eS\u001f' &&
      createHash('sha256').update(value.j1.slice(68), 'utf8').digest('hex') ===
        value.j1.slice(3, 67) &&
      value.j1.trim() === value.j1 &&
      !value.j1.includes('\0') &&
      value.metrics.byteCount <= MAX_PRESENTATION_J1_BYTES &&
      Buffer.byteLength(value.j1, 'utf8') === value.metrics.byteCount &&
      Buffer.from(value.j1, 'utf8').toString('utf8') === value.j1 &&
      createHash('sha256').update(value.j1, 'utf8').digest('hex') === value.digest
    );
  } catch {
    return false;
  }
}

// This runner returns raw bytes: replacement decoding must never verify publication.
export function runDescriptionCommand(file, args, env, execute = execFile) {
  return new Promise((resolve) => {
    try {
      execute(
        file,
        args,
        {
          env,
          encoding: 'buffer',
          shell: false,
          windowsHide: true,
          timeout: 2_000,
          killSignal: 'SIGKILL',
          maxBuffer: DESCRIPTION_OUTPUT_BOUND,
        },
        (error, stdout) => {
          resolve(error ? { ok: false } : { ok: true, stdout });
        },
      );
    } catch {
      resolve({ ok: false });
    }
  });
}

export function readDescriptionCommandJson(result) {
  if (result?.ok !== true) throw new Error('process');
  const raw = result.stdout;
  if (!Buffer.isBuffer(raw) && typeof raw !== 'string') throw new Error('output');
  if (Buffer.byteLength(raw) > DESCRIPTION_OUTPUT_BOUND) throw new Error('output');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
  );
  return JSON.parse(text);
}

// Both calls are explicitly surface-scoped. A workspace fallback or focused
// identity is not evidence that the producer still belongs to this coordinator.
export async function resolveDescriptionTarget(target, surfaceId, runCommand) {
  try {
    const args = ['--socket', target.socketPath];
    const resolved = readDescriptionCommandJson(
      await runCommand([
        ...args,
        'rpc',
        'agent.resolve_delivery_target',
        JSON.stringify({ surface_id: surfaceId, workspace_id: target.workspaceId }),
      ]),
    );
    if (
      resolved?.source !== 'surface' ||
      resolved.surface_id !== surfaceId ||
      resolved.workspace_id !== target.workspaceId
    )
      return null;
    const identified = readDescriptionCommandJson(
      await runCommand([
        ...args,
        'identify',
        '--id-format',
        'both',
        '--json',
        '--workspace',
        target.workspaceId,
        '--surface',
        surfaceId,
      ]),
    );
    const caller = identified?.caller;
    if (
      caller?.workspace_id !== target.workspaceId ||
      caller.surface_id !== surfaceId ||
      caller.surface_type !== 'terminal' ||
      caller.is_browser_surface !== false
    )
      return null;
    return validateDescriptionTarget(
      {
        socketPath: target.socketPath,
        workspaceId: caller.workspace_id,
        windowId: caller.window_id,
      },
      target.workspaceId,
    );
  } catch {
    return null;
  }
}

function readDescription(result, target) {
  const value = readDescriptionCommandJson(result);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof value.window_id !== 'string' ||
    !uuid.test(value.window_id) ||
    value.window_id.toLowerCase() !== target.windowId ||
    !Array.isArray(value.workspaces)
  )
    throw new Error('shape');
  const matches = value.workspaces.filter(
    (row) =>
      row &&
      typeof row.id === 'string' &&
      uuid.test(row.id) &&
      row.id.toLowerCase() === target.workspaceId,
  );
  if (matches.length !== 1 || !Object.hasOwn(matches[0], 'description')) throw new Error('target');
  const description = matches[0].description;
  if (description !== null && typeof description !== 'string') throw new Error('description');
  return description;
}

/** @param {{ target?: unknown, runCommand: (args: string[]) => Promise<unknown>, workspaceId?: string }} options */
export function createDescriptionPublisher({ target: input, runCommand, workspaceId }) {
  let target = validateDescriptionTarget(input, workspaceId);
  let ownership = target ? 'unclaimed' : 'disabled';
  let desired = null;
  let applied = null;
  let dirty = false;
  let running = null;
  let requested = false;
  let stopping = false;
  let revision = 0;
  let uncertain = null;
  const bytes = (intent) => (intent.kind === 'set' ? intent.j1 : null);
  let args = target ? ['--socket', target.socketPath, '--json', '--id-format', 'both'] : [];
  const read = async () =>
    readDescription(
      await runCommand([...args, 'workspace', 'list', '--window', target.windowId]),
      target,
    );

  const attempt = async () => {
    const intent = desired;
    dirty = true;
    try {
      const observed = await read();
      if (stopping) return;
      // Resolve the prior action before comparing against the newest intent.
      if (uncertain && observed === bytes(uncertain)) {
        applied = uncertain;
        uncertain = null;
        ownership = 'held';
      }
      if (
        observed === bytes(intent) &&
        ((ownership === 'unclaimed' && observed === null) ||
          (ownership === 'held' && observed === bytes(applied)))
      ) {
        applied = intent;
        uncertain = null;
        ownership = 'held';
        dirty = desired !== intent;
        return;
      }
      const expected = ownership === 'held' ? bytes(applied) : null;
      if (observed !== expected) {
        ownership = 'lost';
        return;
      }
      // There is no CAS: a foreign write after this preflight may be overwritten
      // (or erased by clear). A foreign write before readback is detected, not undone.
      const action = intent.kind === 'set' ? 'set-description' : 'clear-description';
      const command = [
        ...args,
        'workspace-action',
        '--window',
        target.windowId,
        '--action',
        action,
        '--workspace',
        target.workspaceId,
      ];
      if (intent.kind === 'set') command.push('--description', intent.j1);
      uncertain = intent;
      const result = await runCommand(command);
      if (result?.ok !== true) return;
      const verified = await read();
      if (verified === bytes(intent)) {
        uncertain = null;
        applied = intent;
        ownership = 'held';
        dirty = desired !== intent;
      } else if (verified !== expected) {
        ownership = 'lost';
      }
    } catch {
      // Failure preserves the last verified state. Only reconcile requests retries.
    }
  };

  const reconcile = () => {
    if (stopping || !desired || ownership === 'disabled' || ownership === 'lost')
      return Promise.resolve();
    requested = true;
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        do {
          requested = false;
          await attempt();
        } while (requested && !stopping && ownership !== 'lost');
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  return {
    // Bind only once, from a verified live producer, never retarget a coordinator.
    bindTarget(input) {
      const resolved = validateDescriptionTarget(input, workspaceId);
      if (!resolved || stopping) return false;
      if (target) return Object.keys(resolved).every((key) => resolved[key] === target[key]);
      target = resolved;
      args = ['--socket', target.socketPath, '--json', '--id-format', 'both'];
      ownership = 'unclaimed';
      return true;
    },
    setDesired(projection) {
      if (stopping || !validProjection(projection)) return false;
      if (ownership === 'disabled') return true;
      revision += 1;
      desired =
        projection.kind === 'clear'
          ? { kind: 'clear', revision }
          : {
              kind: 'set',
              j1: projection.j1,
              digest: projection.digest,
              byteCount: projection.metrics.byteCount,
              revision,
            };
      dirty = true;
      return true;
    },
    reconcile,
    async drain() {
      if (running) await running;
    },
    async shutdown() {
      stopping = true;
      requested = false;
      if (running) await running;
    },
    isIdle: () => running === null,
    needsClearRetry: () =>
      !stopping &&
      desired?.kind === 'clear' &&
      dirty &&
      ownership !== 'disabled' &&
      ownership !== 'lost',
    diagnostics: () =>
      ownership === 'disabled'
        ? { ownership: 'disabled' }
        : {
            ownership,
            desired: desired?.kind ?? 'no-intent',
            applied: applied?.kind ?? 'unknown',
            dirty,
            running: running !== null,
            stopping,
          },
  };
}
