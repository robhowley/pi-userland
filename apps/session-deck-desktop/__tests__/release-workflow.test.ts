import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../../.github/workflows/release-please.yml', import.meta.url),
  'utf8',
);
const builder = readFileSync(
  new URL('../scripts/build-macos-artifacts.js', import.meta.url),
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

describe('Session Deck release workflow contract', () => {
  it('has no credential-backed desktop release inputs or alternate release mode', () => {
    const secretNames = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu)].map(
      (match) => match[1],
    );
    const variableNames = [...workflow.matchAll(/\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/gu)].map(
      (match) => match[1],
    );

    expect(secretNames).toEqual([]);
    expect(variableNames).toEqual([]);
    expect(builder).not.toMatch(/process\.env\[[^\]]+\]/u);
    expect(buildJob).not.toMatch(/^\s+environment:/mu);
  });

  it('builds and stages one native app ZIP and checksum per architecture', () => {
    expect(buildJob).toContain('runner: macos-15\n            target: aarch64-apple-darwin');
    expect(buildJob).toContain('runner: macos-15-intel\n            target: x86_64-apple-darwin');
    expect(buildJob).toContain('--target "${{ matrix.target }}"');
    expect(buildJob).toContain('--artifact-dir "dist/artifacts-${{ matrix.arch }}"');
    expect(buildJob).toContain('-macos-${{ matrix.arch }}.zip');
    expect(buildJob).toContain('-macos-${{ matrix.arch }}.zip.sha256');
    expect(buildJob).not.toContain('dist/artifacts-${{ matrix.arch }}/*');
  });

  it('fans in and validates exactly four named non-empty files and both checksums', () => {
    for (const suffix of [
      '${stem}-arm64.zip',
      '${stem}-arm64.zip.sha256',
      '${stem}-x64.zip',
      '${stem}-x64.zip.sha256',
    ]) {
      expect(publicationJob).toContain(`"${suffix}"`);
    }
    expect(publicationJob).toContain('diff -u "$RUNNER_TEMP/expected-assets.txt"');
    expect(publicationJob).toContain('test -f "$artifact_dir/$name"');
    expect(publicationJob).toContain('test ! -L "$artifact_dir/$name"');
    expect(publicationJob).toContain('test -s "$artifact_dir/$name"');
    expect(publicationJob.match(/sha256sum "\$\{stem\}/gu)).toHaveLength(2);
    expect(publicationJob.match(/\| cmp -/gu)).toHaveLength(2);
    expect(publicationJob).toContain('expected_tag="pi-session-deck-v${SESSION_DECK_VERSION}"');
    expect(publicationJob).toContain("require('./packages/pi-session-deck/package.json').version");
  });

  it('requires an empty draft, uploads without clobbering, and publishes GitHub first', () => {
    expect(publicationJob).toContain('\'.isDraft\' "$RUNNER_TEMP/release-before.json")" = true');
    expect(publicationJob).toContain(
      '\'.assets | length\' "$RUNNER_TEMP/release-before.json")" = 0',
    );
    expect(publicationJob).toContain('Refusing to overwrite preexisting release assets');
    expect(publicationJob).not.toContain('--clobber');
    expect(publicationJob).not.toContain('npm view');
    expect(publicationJob).not.toContain('npm pack');

    const orderedMarkers = [
      'name: Validate four desktop release files',
      'name: Require an empty draft and prepare release notes',
      'gh release upload',
      'gh release edit',
      'name: Publish pi-session-deck after public release',
      'npm publish',
    ];
    const positions = orderedMarkers.map((marker) => publicationJob.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('discloses the ad-hoc trust model and safe first-launch override', () => {
    for (const text of [workflow, runbook]) {
      expect(text).toContain('ad-hoc signed');
      expect(text).toContain('not Developer ID signed');
      expect(text).toContain('not notarized');
      expect(text).toContain('System Settings → Privacy & Security → Open Anyway');
    }
    expect(`${workflow}\n${runbook}`).not.toMatch(/xattr|spctl\s+--master-disable/iu);
  });

  it('keeps npm trusted publishing runtime and OIDC permissions', () => {
    expect(workflow.match(/npm publish/gu)).toHaveLength(2);
    expect(releaseJob).toContain("node-version: '22.14'");
    expect(publicationJob).toContain("node-version: '22.14'");
    expect(releaseJob).toContain('npm install -g npm@11');
    expect(publicationJob).toContain('npm install -g npm@11');
    expect(publicationJob).toContain('id-token: write');
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/u);
  });
});
