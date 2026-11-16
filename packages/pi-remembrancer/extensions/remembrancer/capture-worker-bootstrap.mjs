// Only the originating Node Pi installation supplies jiti and the public SDK.
// No local dependency search, extension discovery, or fallback loader.
import process from 'node:process';
import { createRequire } from 'node:module';
import { appendFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [piEntry, database, inbox] = process.argv.slice(2);
let owner;
let loading = true;
try {
  const entry = realpathSync(piEntry);
  const host = createRequire(entry);
  const { createJiti } = host('jiti');
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    alias: {
      '@earendil-works/pi-coding-agent': join(dirname(entry), 'index.js'),
      '@sinclair/typebox': host.resolve('typebox'),
    },
  });
  const { CaptureWorkerOwnership } = await jiti.import('./capture-jobs.ts');
  try {
    owner = CaptureWorkerOwnership.claim(database);
  } catch (error) {
    if (error.errcode === 5 || error.message.startsWith('A capture worker already owns'))
      process.exit(0);
    throw error;
  }
  // Singleton is acquired before loading the SDK or importing handoffs.
  const { runCaptureWorker } = await jiti.import('./capture-worker.ts');
  loading = false;
  await runCaptureWorker({ database, inbox, owner });
  owner = undefined;
  process.exit(0);
} catch (error) {
  owner?.release();
  // Deliberately omit provider responses, which can contain credentials.
  try {
    appendFileSync(
      database + '.capture.log',
      `${new Date().toISOString()} Worker bootstrap failed: ${loading ? error.message : error.name}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* evidence remains for recovery */
  }
  process.exit(1);
}
