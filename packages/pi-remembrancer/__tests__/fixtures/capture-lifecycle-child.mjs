// Load the installed extension through the host's real loader (including aliases).
// Only the terminal context is replaced; lifecycle, launch, review and notices are real.
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setImmediate, setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [hostEntry, installed, inputFile, action, marker] = process.argv.slice(2);
const { loadExtensions } = await import(
  pathToFileURL(join(dirname(hostEntry), 'core/extensions/loader.js')).href
);
const input = JSON.parse(readFileSync(inputFile, 'utf8'));
const loaded = await loadExtensions(
  [join(installed, 'extensions/remembrancer/index.ts')],
  input.execution.cwd,
);
if (loaded.errors.length) throw Error(JSON.stringify(loaded.errors));
const handlers = loaded.extensions[0].handlers;
const notifications = [];
let finishing = false;
const ctx = {
  cwd: input.execution.cwd,
  mode: 'tui',
  thinkingLevel: input.execution.runtime.thinkingLevel,
  model: {
    ...input.execution.runtime.model,
    // Values must be re-resolved from configuration, never saved in a handoff.
    headers: Object.fromEntries(
      input.execution.runtime.headerNames.map((name) => [name, 'secret-do-not-save']),
    ),
  },
  isProjectTrusted: () => input.execution.runtime.projectTrusted,
  sessionManager: {
    getSessionFile: () => input.source.file,
    getSessionId: () => input.source.sessionId,
  },
  ui: {
    notify(message, level) {
      notifications.push({ message, level });
      if (action === 'observe' && !finishing) {
        finishing = true;
        setImmediate(async () => {
          await emit('session_shutdown', { reason: 'quit' });
          writeFileSync(marker, JSON.stringify(notifications));
          process.exit(0);
        });
      }
    },
  },
};
// The unbound host runtime throws if the extension tries to start a chat turn.
async function emit(name, event) {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}
if (action === 'admit') {
  await emit('session_shutdown', { reason: 'quit' });
  if (notifications.length) throw Error(JSON.stringify(notifications));
  process.exit(0);
}
// Keep the simulated terminal open. The extension tick itself is unreferenced.
setTimeout(() => {
  throw Error('Timed out waiting for committed notice');
}, 20_000);
await emit('session_start', { reason: 'startup' });
writeFileSync(marker + '.started', 'yes');
