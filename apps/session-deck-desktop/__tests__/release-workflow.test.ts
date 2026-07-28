import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveAppleSigningIdentity } from '../scripts/derive-apple-signing-identity.js';

const workflow = readFileSync(
  new URL('../../../.github/workflows/release-please.yml', import.meta.url),
  'utf8',
);
const runbook = readFileSync(new URL('../RELEASE.md', import.meta.url), 'utf8');
const releaseJob = workflow.slice(
  workflow.indexOf('  release:\n'),
  workflow.indexOf('  session-deck-desktop-build:\n'),
);
const buildJob = workflow.slice(
  workflow.indexOf('  session-deck-desktop-build:\n'),
  workflow.indexOf('  session-deck-publish:\n'),
);
const publicationJob = workflow.slice(workflow.indexOf('  session-deck-publish:\n'));
const fingerprint = 'A'.repeat(40);

function identityLine(identity: string, index = 1): string {
  return `  ${index}) ${fingerprint} "${identity}"`;
}

describe('Apple signing identity derivation', () => {
  it('exports the exact Developer ID identity and its Team ID', () => {
    const identity = 'Developer ID Application: Example Company, Inc. (TEAMID1234)';
    const output = `${identityLine(identity)}\n     1 valid identities found\n`;

    expect(deriveAppleSigningIdentity(output)).toEqual({
      APPLE_SIGNING_IDENTITY: identity,
      APPLE_TEAM_ID: 'TEAMID1234',
    });
  });

  it.each([
    {
      case: 'zero identities',
      output: '     0 valid identities found\n',
      error: 'Expected exactly one codesigning identity',
    },
    {
      case: 'multiple identities',
      output: `${identityLine('Developer ID Application: One (TEAMID1234)')}\n${identityLine(
        'Developer ID Application: Two (OTHER12345)',
        2,
      )}\n     2 valid identities found\n`,
      error: 'Expected exactly one codesigning identity',
    },
    {
      case: 'malformed Team ID',
      output: `${identityLine('Developer ID Application: Example (TEAMID123)')}\n`,
      error: 'ten-character Team ID',
    },
    {
      case: 'unrelated identity',
      output: `${identityLine('Apple Development: Example (TEAMID1234)')}\n`,
      error: 'Developer ID Application identity',
    },
  ])('rejects $case', ({ output, error }) => {
    expect(() => deriveAppleSigningIdentity(output)).toThrow(error);
  });
});

describe('Session Deck release workflow contract', () => {
  it('uses exactly the five repository Apple settings and derives signer details internally', () => {
    const secretNames = [
      ...new Set(
        [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu)].map((match) => match[1]),
      ),
    ].sort();
    const variableNames = [
      ...new Set(
        [...workflow.matchAll(/\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/gu)].map((match) => match[1]),
      ),
    ].sort();

    expect(secretNames).toEqual([
      'APPLE_API_PRIVATE_KEY',
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
    ]);
    expect(variableNames).toEqual(['APPLE_API_ISSUER', 'APPLE_API_KEY']);
    expect(workflow).not.toMatch(/^\s+environment:/mu);
    expect(`${workflow}\n${runbook}`).not.toMatch(
      /session-deck-release|immutable-releases|isImmutable/iu,
    );
    expect(buildJob).toContain('derive-apple-signing-identity.js >> "$GITHUB_ENV"');
    expect(buildJob).toContain('if: always()');
  });

  it('preserves native targets, draft no-clobber staging, and publication order', () => {
    expect(buildJob).toContain('runner: macos-15\n            target: aarch64-apple-darwin');
    expect(buildJob).toContain('runner: macos-15-intel\n            target: x86_64-apple-darwin');
    expect(publicationJob).toContain('artifact:validate');
    expect(publicationJob).toContain('\'.isDraft\' "$RUNNER_TEMP/release-before.json")" = true');
    expect(publicationJob).toContain(
      '\'.assets | length\' "$RUNNER_TEMP/release-before.json")" = 0',
    );
    expect(publicationJob).toContain('Refusing to overwrite preexisting release assets');
    expect(publicationJob).not.toContain('--clobber');
    expect(publicationJob).toContain(
      '\'.assets | length\' "$RUNNER_TEMP/release-after.json")" = 12',
    );
    expect(publicationJob).toContain(
      '\'.isDraft\' "$RUNNER_TEMP/release-published.json")" = false',
    );

    const orderedMarkers = [
      'artifact:validate',
      'gh release upload',
      'gh release edit',
      'release-published.json")" = false',
      'name: Publish pi-session-deck after public release',
      'npm publish',
    ];
    const positions = orderedMarkers.map((marker) => publicationJob.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('uses the trusted-publishing runtime floor in both npm publication jobs', () => {
    expect(workflow.match(/npm publish/gu)).toHaveLength(2);
    expect(releaseJob).toContain("node-version: '22.14'");
    expect(publicationJob).toContain("node-version: '22.14'");
    expect(releaseJob).toContain('npm install -g npm@11');
    expect(publicationJob).toContain('npm install -g npm@11');
  });
});
