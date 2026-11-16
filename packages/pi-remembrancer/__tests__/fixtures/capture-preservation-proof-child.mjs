// Production preservation with no host settings or SDK session startup.
import process from 'node:process';
import { constants } from 'node:fs';
import fs, { copyFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setInterval, clearInterval } from 'node:timers';

const [encoded, stopAt] = process.argv.slice(2);
const input = JSON.parse(encoded);
// Keep the IPC channel referenced while waiting to be killed at a checkpoint.
process.on('message', () => {});
async function pause(step) {
  if (step !== stopAt) return;
  process.send({ step });
  await new Promise((resolve) => process.once('message', resolve));
}
if (stopAt === 'ancestors-created') {
  const open = fs.open;
  let first = true;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (first) {
      first = false;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await pause('ancestors-created');
        await sync();
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}
const { preserveHandoff: preserveProof } =
  await import('../../extensions/remembrancer/capture-handoff.ts');
const ticker =
  stopAt === 'returned' ? setInterval(() => process.send({ tick: true }), 10) : undefined;
const result = await preserveProof(input, {
  copy: async (source, destination, flags) => {
    if (flags & constants.COPYFILE_FICLONE_FORCE)
      throw Object.assign(new Error('Fixture forces full copy'), { code: 'ENOTSUP' });
    await copyFile(source, destination, flags);
  },
  after: pause,
});
clearInterval(ticker);
await pause('returned');
process.send({ step: 'completed', admissionOrder: result.manifest.admissionOrder });
process.removeAllListeners('message');
process.disconnect();
