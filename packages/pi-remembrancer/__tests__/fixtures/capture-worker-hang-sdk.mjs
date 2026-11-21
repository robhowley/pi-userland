// Fault injection around the real public SDK, never production extension loading.
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const sdk = await import(pathToFileURL(join(dirname(process.argv[2]), 'index.js')).href);
export const getPackageDir = sdk.getPackageDir;
export const ModelRuntime = sdk.ModelRuntime;
export const SettingsManager = sdk.SettingsManager;
export const SessionManager = sdk.SessionManager;
export const createExtensionRuntime = sdk.createExtensionRuntime;
const never = () => new Promise(() => {});
export async function createAgentSession(options) {
  const stage = process.env.CAPTURE_HANG_STAGE;
  if (stage === 'setup') {
    writeFileSync(process.env.CAPTURE_HANG_MARKER, stage);
    return never();
  }
  const result = await sdk.createAgentSession(options);
  if (stage === 'prompt')
    result.session.prompt = () => {
      writeFileSync(process.env.CAPTURE_HANG_MARKER, stage);
      return never();
    };
  if (stage === 'cooperative') {
    let settle;
    result.session.prompt = () => {
      writeFileSync(process.env.CAPTURE_HANG_MARKER, stage);
      return new Promise((resolve) => {
        settle = resolve;
      });
    };
    result.session.abort = async () => {
      writeFileSync(process.env.CAPTURE_HANG_MARKER + '.aborted', 'yes');
      await new Promise((resolve) => setTimeout(resolve, 15));
      writeFileSync(process.env.CAPTURE_HANG_MARKER + '.cleaned', 'yes');
      settle();
    };
  }
  if (stage === 'cleanup')
    result.session.dispose = () => {
      writeFileSync(process.env.CAPTURE_HANG_MARKER, stage);
      return never();
    };
  return result;
}
