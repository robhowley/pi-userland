import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerJunctionCommand } from './command.js';
import { registerJunctionLifecycle } from './lifecycle.js';

export default function (pi: ExtensionAPI): void {
  registerJunctionCommand(pi);
  registerJunctionLifecycle(pi);
}
