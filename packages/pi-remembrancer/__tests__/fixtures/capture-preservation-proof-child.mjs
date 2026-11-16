// Only Node built-ins and the Phase 0A prototype. No host settings or SDK startup.
import process from 'node:process';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { preserveProof } from './capture-preservation-proof.ts';

const [encoded, stopAt] = process.argv.slice(2);
const input = JSON.parse(encoded);
// Keep the IPC channel referenced while waiting to be killed at a checkpoint.
process.on('message', () => {});
async function pause(step) {
  if (step !== stopAt) return;
  process.send({ step });
  await new Promise(() => {});
}
await preserveProof(input, {
  copy: async (source, destination, flags) => {
    if (flags & constants.COPYFILE_FICLONE_FORCE)
      throw Object.assign(new Error('Fixture forces full copy'), { code: 'ENOTSUP' });
    await copyFile(source, destination, flags);
  },
  after: pause,
});
await pause('returned');
