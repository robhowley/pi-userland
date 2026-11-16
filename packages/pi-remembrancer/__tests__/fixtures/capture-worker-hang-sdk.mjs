// Fault injection around the real public SDK, never production extension loading.
import process from 'node:process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const sdk = await import(pathToFileURL(join(dirname(process.argv[2]), 'index.js')).href);
export const ModelRuntime = sdk.ModelRuntime;
export const SettingsManager = sdk.SettingsManager;
export const SessionManager = sdk.SessionManager;
export const createExtensionRuntime = sdk.createExtensionRuntime;
const never = () => new Promise(() => {});
export async function createAgentSession(options) {
  const stage = process.env.CAPTURE_HANG_STAGE;
  if (stage === 'setup') {
    if (process.env.CAPTURE_DESCENDANT_PID) {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      });
      writeFileSync(process.env.CAPTURE_DESCENDANT_PID, String(child.pid));
    }
    writeFileSync(process.env.CAPTURE_HANG_MARKER, stage);
    return never();
  }
  const result = await sdk.createAgentSession(options);
  if (stage === 'prompt')
    result.session.prompt = () => {
      writeFileSync(process.env.CAPTURE_HANG_MARKER, stage);
      return never();
    };
  if (stage === 'cleanup')
    result.session.dispose = () => {
      writeFileSync(process.env.CAPTURE_HANG_MARKER, stage);
      return never();
    };
  return result;
}
