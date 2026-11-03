import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import remembrancer from '../extensions/remembrancer/index.js';

it('loads without accessing the Pi API', () => {
  const pi = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      throw new Error(`Unexpected Pi API access: ${String(property)}`);
    },
  });

  expect(() => remembrancer(pi)).not.toThrow();
});
