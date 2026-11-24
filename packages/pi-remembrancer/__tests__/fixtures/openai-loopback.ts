import type { ServerResponse } from 'node:http';

/** Deterministic OpenAI SSE framing for local SDK tests, not a provider emulator. */
export function writeCompletion(
  response: ServerResponse,
  delta: unknown,
  finishReason: string,
  model = 'fixture',
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [value, reason] of [
    [delta, null],
    [{}, finishReason],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`,
    );
  }
  response.end('data: [DONE]\n\n');
}
