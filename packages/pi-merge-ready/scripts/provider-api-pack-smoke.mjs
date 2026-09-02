import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'pi-merge-ready-provider-api-'));

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const packMetadata = JSON.parse(packOutput);
  const tarballName = packMetadata[0]?.filename;
  if (typeof tarballName !== 'string') {
    throw new Error('npm pack did not report a tarball filename');
  }

  execFileSync('tar', ['-xzf', join(tempRoot, tarballName)], { cwd: tempRoot });
  const packedRoot = join(tempRoot, 'package');
  const providerApiJs = join(packedRoot, 'dist/extensions/merge-ready/provider-api.js');
  const providerApiDts = join(packedRoot, 'dist/extensions/merge-ready/provider-api.d.ts');
  if (!existsSync(providerApiJs) || !existsSync(providerApiDts)) {
    throw new Error('packed provider-api JavaScript or declaration file is missing');
  }

  const packageScope = join(tempRoot, 'node_modules/@robhowley');
  mkdirSync(packageScope, { recursive: true });
  symlinkSync(packedRoot, join(packageScope, 'pi-merge-ready'), 'dir');

  const runtimeSmoke = join(tempRoot, 'provider-api-runtime-smoke.mjs');
  writeFileSync(
    runtimeSmoke,
    `import { defineMergeReadyProvider, registerMergeReadyProvider } from '@robhowley/pi-merge-ready/provider-api';
if (typeof defineMergeReadyProvider !== 'function' || typeof registerMergeReadyProvider !== 'function') {
  throw new Error('packed provider-api exports are incomplete');
}
`,
  );
  await import(pathToFileURL(runtimeSmoke).href);

  const typeSmoke = join(tempRoot, 'provider-api-type-smoke.ts');
  const piTypes = join(tempRoot, 'pi-coding-agent.d.ts');
  writeFileSync(
    typeSmoke,
    `import { defineMergeReadyProvider } from '@robhowley/pi-merge-ready/provider-api';
import type { MergeReadyProviderV1 } from '@robhowley/pi-merge-ready/provider-api';

const provider: MergeReadyProviderV1 = {
  apiVersion: 1,
  id: 'smoke',
  matchUrl: () => null,
  matchRemote: () => null,
  read: async () => ({
    kind: 'found',
    pullRequest: {
      lifecycle: 'open',
      number: 1,
      title: 'Smoke',
      url: 'https://code.example/shop/repo/changes/1',
      headRefName: 'feature',
      baseRefName: 'main',
    },
    facts: {
      draft: { kind: 'known', value: false },
      hasConflicts: { kind: 'known', value: false },
      behindBase: { kind: 'known', value: false },
      sourceMergeGate: { kind: 'known', value: 'clear' },
      requiredChecks: { kind: 'known', value: [] },
      sourceReviewGate: { kind: 'known', value: { state: 'satisfied' } },
      unresolvedConversations: { kind: 'partial', value: [], message: 'first page only' },
      conversationResolutionRequired: { kind: 'known', value: false },
    },
  }),
};
defineMergeReadyProvider(provider);
`,
  );
  writeFileSync(
    piTypes,
    `declare module '@earendil-works/pi-coding-agent' {
  export interface ExtensionAPI {
    events: {
      on(channel: string, handler: (data: unknown) => void): () => void;
    };
  }
}
`,
  );
  execFileSync(
    resolve(packageRoot, '../../node_modules/.bin/tsc'),
    [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      typeSmoke,
      piTypes,
    ],
    { cwd: tempRoot, stdio: 'inherit' },
  );

  console.log('provider-api packed import and declaration smoke passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
