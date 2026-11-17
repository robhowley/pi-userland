// Publication only, with no SDK, credentials, settings or Taskwarrior access.
import process from 'node:process';
import { preserveHandoff } from '../../extensions/remembrancer/capture-handoff.ts';

const [encoded, acceptedAt] = process.argv.slice(2);
// Only the informational wall-clock timestamp changes, not filesystem clocks.
Date.prototype.toISOString = () => acceptedAt;
const { manifest } = await preserveHandoff(JSON.parse(encoded));
process.stdout.write(JSON.stringify(manifest) + '\n');
