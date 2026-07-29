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
const buildHeader = buildJob.slice(0, buildJob.indexOf('    strategy:\n'));
const publicationHeader = publicationJob.slice(0, publicationJob.indexOf('    steps:\n'));

describe('Session Deck release workflow contract', () => {
  it('runs only for pushes to main', () => {
    expect(workflow).toContain('on:\n  push:\n    branches: [main]\n');
    expect(workflow).not.toMatch(
      /^  (?:pull_request|pull_request_target|workflow_dispatch|schedule|merge_group):/mu,
    );
  });

  it('keeps the desktop build and publication behind the exact release-created condition', () => {
    expect(buildHeader.match(/^    needs:.*$/gmu)).toEqual(['    needs: release']);
    expect(buildHeader.match(/^    if:.*$/gmu)).toEqual([
      "    if: needs.release.outputs.pi_session_deck_released == 'true'",
    ]);
    expect(publicationHeader.match(/^    needs:.*$/gmu)).toEqual([
      '    needs: [release, session-deck-desktop-build]',
    ]);
    expect(publicationHeader.match(/^    if:.*$/gmu)).toEqual([
      "    if: needs.release.outputs.pi_session_deck_released == 'true'",
    ]);
  });

  it('keeps exactly one unconditional arm64/x64 build matrix', () => {
    const matrix = buildJob.slice(
      buildJob.indexOf('    strategy:\n'),
      buildJob.indexOf('    runs-on: '),
    );

    expect(matrix).toBe(
      [
        '    strategy:',
        '      fail-fast: true',
        '      matrix:',
        '        include:',
        '          - runner: macos-15',
        '            target: aarch64-apple-darwin',
        '            arch: arm64',
        '          - runner: macos-15-intel',
        '            target: x86_64-apple-darwin',
        '            arch: x64',
        '',
      ].join('\n'),
    );
    expect(matrix).not.toMatch(/\b(?:if|exclude|paths?|labels?|changed-files?)\b/iu);
  });

  it('keeps release jobs isolated from classifier and selective path logic', () => {
    const selectionReferences =
      /classifier|selective|run_(?:desktop|web_sync|desktop_js|native)|changed-files|path-filter|paths-ignore/iu;

    expect(buildJob).not.toMatch(selectionReferences);
    expect(publicationJob).not.toMatch(selectionReferences);
  });

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

  it('skips pi-session-deck before the generic npm publish loop reaches publish', () => {
    const skipCondition = 'if [ "$pkg" = "packages/pi-session-deck" ]; then';
    const continuePosition = releaseJob.indexOf('continue', releaseJob.indexOf(skipCondition));
    const publishPosition = releaseJob.indexOf('(cd "$pkg" && npm publish)');

    expect(releaseJob).toContain(skipCondition);
    expect(continuePosition).toBeGreaterThan(releaseJob.indexOf(skipCondition));
    expect(publishPosition).toBeGreaterThan(continuePosition);
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
