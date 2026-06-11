import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getErrorMessage } from '../internal.js';
import { MERGE_READY_WATCH_UI_SERVICE } from './supervisor-state.js';
import type { MergeReadyWatchSessionRunner } from './session-runner.js';

export type MergeReadyWatchUiRunner = Pick<
  MergeReadyWatchSessionRunner,
  | 'addWatch'
  | 'getDefaultCwd'
  | 'openWatch'
  | 'readTranscriptForWatch'
  | 'removeWatch'
  | 'stopWatch'
  | 'listWatches'
>;

export type CreateMergeReadyWatchUiSupervisorServerOptions = {
  host?: string;
  packageVersion: string;
  port?: number;
  publicDir: string;
  runner: MergeReadyWatchUiRunner;
  snapshotLoaded: boolean;
  snapshotSignature: string;
  token: string;
};

export type MergeReadyWatchUiSupervisorServer = {
  close: () => Promise<void>;
  port: number;
  startedAt: string;
};

const STATIC_FILE_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export async function createMergeReadyWatchUiSupervisorServer(
  options: CreateMergeReadyWatchUiSupervisorServerOptions,
): Promise<MergeReadyWatchUiSupervisorServer> {
  const startedAt = new Date().toISOString();
  const host = options.host ?? '127.0.0.1';

  const server = createServer((request, response) => {
    void handleMergeReadyWatchUiRequest({
      request,
      response,
      options,
      startedAt,
    }).catch((error) => {
      sendJson(response, 500, {
        error: getErrorMessage(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine merge-ready watch UI server port.');
  }

  return {
    port: address.port,
    startedAt,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleMergeReadyWatchUiRequest(options: {
  options: CreateMergeReadyWatchUiSupervisorServerOptions;
  request: IncomingMessage;
  response: ServerResponse;
  startedAt: string;
}): Promise<void> {
  const url = new URL(options.request.url ?? '/', 'http://127.0.0.1');
  const { pathname } = url;

  if (pathname === '/api/health' && options.request.method === 'GET') {
    sendJson(options.response, 200, {
      service: MERGE_READY_WATCH_UI_SERVICE,
      pid: process.pid,
      port: resolveLocalPort(options.request),
      startedAt: options.startedAt,
      packageVersion: options.options.packageVersion,
      snapshotLoaded: options.options.snapshotLoaded,
      snapshotSignature: options.options.snapshotSignature,
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (!isAuthorized(options.request, options.options.token)) {
      sendJson(options.response, 401, {
        error: 'Unauthorized',
      });
      return;
    }

    await handleMergeReadyWatchUiApiRequest(options, url);
    return;
  }

  await handleStaticMergeReadyWatchUiRequest(options.response, options.options.publicDir, pathname);
}

async function handleMergeReadyWatchUiApiRequest(
  options: {
    options: CreateMergeReadyWatchUiSupervisorServerOptions;
    request: IncomingMessage;
    response: ServerResponse;
    startedAt: string;
  },
  url: URL,
): Promise<void> {
  const { pathname } = url;

  if (pathname === '/api/watches' && options.request.method === 'GET') {
    sendJson(options.response, 200, {
      defaultCwd: options.options.runner.getDefaultCwd(),
      watches: options.options.runner.listWatches(),
    });
    return;
  }

  if (pathname === '/api/watches' && options.request.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(options.request);
    } catch (error) {
      sendJson(options.response, 400, {
        error: getErrorMessage(error),
      });
      return;
    }

    const urlValue = typeof body['url'] === 'string' ? body['url'] : undefined;
    if (!urlValue) {
      sendJson(options.response, 400, {
        error: 'Body must include url.',
      });
      return;
    }

    const cwd = typeof body['cwd'] === 'string' ? body['cwd'] : undefined;
    const added = await options.options.runner.addWatch({
      url: urlValue,
      ...(cwd === undefined ? {} : { cwd }),
    });
    sendJson(options.response, 200, added);
    return;
  }

  const stopMatch = matchWatchRoute(pathname, '/stop');
  if (stopMatch && options.request.method === 'POST') {
    const stopped = await options.options.runner.stopWatch(stopMatch.id);
    if (!stopped) {
      sendJson(options.response, 404, {
        error: 'Watch not found.',
      });
      return;
    }

    sendJson(options.response, 200, { watch: stopped });
    return;
  }

  const transcriptMatch = matchWatchRoute(pathname, '/transcript');
  if (transcriptMatch && options.request.method === 'GET') {
    const tail = clampTranscriptTail(url.searchParams.get('tail'));
    const transcript = await options.options.runner.readTranscriptForWatch(
      transcriptMatch.id,
      tail,
    );
    if (!transcript) {
      sendJson(options.response, 404, {
        error: 'Watch not found.',
      });
      return;
    }

    sendJson(options.response, 200, transcript);
    return;
  }

  const openMatch = matchWatchRoute(pathname, '/open');
  if (openMatch && options.request.method === 'POST') {
    const opened = await options.options.runner.openWatch(openMatch.id);
    if (!opened) {
      sendJson(options.response, 404, {
        error: 'Watch not found.',
      });
      return;
    }

    sendJson(options.response, 200, opened);
    return;
  }

  const deleteMatch = matchDeleteWatchRoute(pathname);
  if (deleteMatch && options.request.method === 'DELETE') {
    const removed = await options.options.runner.removeWatch(deleteMatch.id);
    if (!removed) {
      sendJson(options.response, 409, {
        error: 'Unable to remove watch while it is active or missing.',
      });
      return;
    }

    sendJson(options.response, 200, { removed: true });
    return;
  }

  sendJson(options.response, 404, {
    error: 'Not found',
  });
}

async function handleStaticMergeReadyWatchUiRequest(
  response: ServerResponse,
  publicDir: string,
  pathname: string,
): Promise<void> {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const publicRoot = path.resolve(publicDir);
  const filePath = path.resolve(publicRoot, normalizedPath.replace(/^\//u, ''));
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    sendText(response, 404, 'Not found');
    return;
  }
  const extension = path.extname(filePath);
  const contentType = STATIC_FILE_CONTENT_TYPES[extension];
  if (!contentType) {
    sendText(response, 404, 'Not found');
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function resolveLocalPort(request: IncomingMessage): number {
  const address = request.socket.localPort;
  return typeof address === 'number' ? address : 0;
}

function matchWatchRoute(
  pathname: string,
  suffix: '/open' | '/stop' | '/transcript',
): { id: string } | null {
  const match = new RegExp(`^/api/watches/([^/]+)${suffix}$`, 'u').exec(pathname);
  if (!match?.[1]) {
    return null;
  }

  return { id: decodeURIComponent(match[1]) };
}

function matchDeleteWatchRoute(pathname: string): { id: string } | null {
  const match = /^\/api\/watches\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) {
    return null;
  }

  return { id: decodeURIComponent(match[1]) };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 64 * 1024) {
      throw new Error('Request body too large.');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function clampTranscriptTail(rawTail: string | null): number {
  if (!rawTail) {
    return 200;
  }

  const parsed = Number(rawTail);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 200;
  }

  return Math.min(1_000, Math.trunc(parsed));
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(text);
}
