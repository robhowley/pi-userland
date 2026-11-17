import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
const [piEntry, database, inbox] = process.argv.slice(2);
const host = createRequire(piEntry);
const { createJiti } = host('jiti');
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@earendil-works/pi-coding-agent': fileURLToPath(
      new URL('./capture-worker-hang-sdk.mjs', import.meta.url),
    ),
    '@sinclair/typebox': host.resolve('typebox'),
  },
});
const { CaptureWorkerOwnership } = await jiti.import(
  '../../extensions/remembrancer/capture-jobs.ts',
);
const owner = CaptureWorkerOwnership.claim(database);
const { runCaptureWorker } = await jiti.import('../../extensions/remembrancer/capture-worker.ts');
await runCaptureWorker({ database, inbox, owner, budgetMs: 1500, graceMs: 30 });
if (!['cooperative', 'task'].includes(process.env.CAPTURE_HANG_STAGE))
  throw Error('A hanging operation unexpectedly settled');
