import process from 'node:process';
import { register } from 'node:module';

register('./typescript-loader.mjs', import.meta.url);
const { CheckpointStore } = await import('../../extensions/remembrancer/checkpoints.ts');

const [, , path, action, sessionId, file] = process.argv;
if (!path) throw new Error('Missing checkpoint database path');
const store = new CheckpointStore(path);

function claim() {
  try {
    store.claimReview();
    return 'acquired';
  } catch (error) {
    if (!/already open in another Pi process/u.test(String(error))) throw error;
    return 'busy';
  }
}

if (action === 'hold') {
  if (claim() !== 'acquired') throw new Error('Child could not own the review');
  process.on('message', (message) => {
    if (message !== 'release') throw new Error('Unknown lock-owner command');
    store.releaseReview();
    process.disconnect();
  });
  process.on('disconnect', () => {
    // A disconnected parent must not leave a test owner alive.
    store.close();
  });
  process.send('owned');
} else {
  try {
    if (action === 'claim') process.stdout.write(claim());
    else if (action === 'enroll' && sessionId && file) {
      store.enroll(sessionId, file);
      process.stdout.write(JSON.stringify(store.sources()));
    } else throw new Error('Unknown checkpoint child action');
  } finally {
    store.close();
  }
}
