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
    '@earendil-works/pi-ai': fileURLToPath(createJiti(piEntry).esmResolve('@earendil-works/pi-ai')),
    '@sinclair/typebox': host.resolve('typebox'),
  },
});
const { CaptureWorkerOwnership } = await jiti.import(
  '../../extensions/remembrancer/capture-jobs.ts',
);
const owner = CaptureWorkerOwnership.claim(database);
const { runCaptureWorker } = await jiti.import('../../extensions/remembrancer/capture-worker.ts');
await runCaptureWorker({
  database,
  inbox,
  owner,
  budgetMs: process.env.CAPTURE_PAUSE_TEST ? 30_000 : 1500,
  graceMs: process.env.CAPTURE_PAUSE_TEST ? 200 : 30,
});
if (!['cooperative', 'task'].includes(process.env.CAPTURE_HANG_STAGE))
  throw Error('A hanging operation unexpectedly settled');
