import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_ROOT = new URL('../../../.github/workflows/', import.meta.url);
const workflow = readFileSync(new URL('ci.yml', WORKFLOWS_ROOT), 'utf8');
const trigger = workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\n\npermissions:'));
const jobsStart = workflow.indexOf('jobs:\n');
const jobs = workflow.slice(jobsStart);

function jobSlice(name: string): string {
  const marker = `  ${name}:\n`;
  const start = jobs.indexOf(marker);
  if (start < 0) throw new Error(`Missing CI job: ${name}`);

  const bodyStart = start + marker.length;
  const nextJob = jobs.slice(bodyStart).search(/^ {2}[a-z][a-z0-9-]*:\n/mu);
  return jobs.slice(start, nextJob < 0 ? undefined : bodyStart + nextJob);
}

function expectCommandsInOrder(source: string, commands: string[]): void {
  const positions = commands.map((command) => source.indexOf(command));
  expect(
    positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)),
    ),
  ).toBe(true);
}

const classifierJob = jobSlice('classify-impact');
const packageChecksJob = jobSlice('package-checks');
const packageTestsJob = jobSlice('package-tests');
const desktopChecksJob = jobSlice('desktop-checks');
const desktopTestsJob = jobSlice('desktop-tests');
const gateJob = jobSlice('ci-gate');
const backslash = String.fromCharCode(92);
const shellIndent = ' '.repeat(10);
function indentShell(lines: string[]): string {
  return lines.map((line) => (line ? `${shellIndent}${line}` : '')).join('\n');
}

const aptInstall = indentShell([
  'sudo apt-get update',
  `sudo apt-get install -y --no-install-recommends ${backslash}`,
  `  pkg-config ${backslash}`,
  `  libglib2.0-dev ${backslash}`,
  `  libgtk-3-dev ${backslash}`,
  `  libwebkit2gtk-4.1-dev ${backslash}`,
  `  libayatana-appindicator3-dev ${backslash}`,
  `  librsvg2-dev ${backslash}`,
  `  libxdo-dev ${backslash}`,
  '  libssl-dev',
]);

const expectedConcurrency = [
  'concurrency:',
  "  group: ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}-{1}', github.run_id, github.run_attempt) }}",
  "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
].join('\n');

const expectedWebDiff = indentShell([
  `git diff --exit-code -- ${backslash}`,
  `  apps/session-deck-desktop/web/index.html ${backslash}`,
  `  apps/session-deck-desktop/web/style.css ${backslash}`,
  '  apps/session-deck-desktop/web/session-deck-ui.js',
]);

type GateInputs = {
  classifierResult: string;
  classificationError: string;
  packageChecksResult: string;
  packageTestsResult: string;
  runDesktop: string;
  desktopChecksResult: string;
  desktopTestsResult: string;
};

function optionTwoGatePasses(inputs: GateInputs): boolean {
  if (
    inputs.classifierResult !== 'success' ||
    inputs.classificationError !== 'false' ||
    inputs.packageChecksResult !== 'success' ||
    inputs.packageTestsResult !== 'success'
  ) {
    return false;
  }

  return (
    (inputs.runDesktop === 'true' &&
      inputs.desktopChecksResult === 'success' &&
      inputs.desktopTestsResult === 'success') ||
    (inputs.runDesktop === 'false' &&
      inputs.desktopChecksResult === 'skipped' &&
      inputs.desktopTestsResult === 'skipped')
  );
}

describe('Session Deck CI workflow contract', () => {
  it('runs only on main pushes and pull requests', () => {
    expect(trigger).toBe(
      ['on:', '  push:', '    branches:', '      - main', '  pull_request:'].join('\n'),
    );
    expect(workflow).not.toMatch(
      /^ {2}(?:schedule|workflow_dispatch|merge_group|pull_request_target):/mu,
    );
    expect(workflow).not.toMatch(/^ {2}paths(?:-ignore)?:/mu);
    expect(workflow).toContain('permissions:\n  contents: read');
  });

  it('uses the exact PR-only concurrency contract', () => {
    expect(workflow).toContain(expectedConcurrency);
  });

  it('keeps tests in the consolidated workflow', () => {
    expect(readdirSync(WORKFLOWS_ROOT)).not.toContain('tests.yml');
  });

  it('has exactly the six Option 2 jobs', () => {
    expect([...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)].map((match) => match[1])).toEqual([
      'classify-impact',
      'package-checks',
      'package-tests',
      'desktop-checks',
      'desktop-tests',
      'ci-gate',
    ]);
  });

  it('keeps package checks and tests independent of classification and apt setup', () => {
    for (const packageJob of [packageChecksJob, packageTestsJob]) {
      expect(packageJob).not.toMatch(/^ {4}needs:/mu);
      expect(packageJob).not.toContain('needs.classify-impact');
      expect(packageJob).not.toContain('apt-get');
      expect(packageJob).not.toContain('Install Tauri Linux system dependencies');
    }

    expectCommandsInOrder(packageChecksJob, [
      'run: pnpm install --frozen-lockfile',
      "run: pnpm -r --filter './packages/*' --if-present build",
      'run: pnpm lint',
      'run: pnpm format:check',
      'run: pnpm typecheck',
    ]);
    expectCommandsInOrder(packageTestsJob, [
      'run: pnpm install --frozen-lockfile',
      "run: pnpm -r --filter './packages/*' --if-present build",
      'run: node --test .github/scripts/__tests__/session-deck-ci-classifier.test.mjs',
      'run: pnpm test',
    ]);
  });

  it('runs desktop checks and tests only after a fail-closed classifier decision', () => {
    const condition =
      "    if: ${{ always() && (needs.classify-impact.result != 'success' || needs.classify-impact.outputs.run_desktop != 'false') }}";

    for (const desktopJob of [desktopChecksJob, desktopTestsJob]) {
      expect(desktopJob).toContain('    needs: classify-impact');
      expect(desktopJob).toContain(condition);
      expect(desktopJob.match(/^ {4}if:.*$/gmu)).toEqual([condition]);
      expect(desktopJob).toContain(aptInstall);
    }

    expect(classifierJob).toContain('fetch-depth: 0');
    expect(classifierJob).toContain(
      "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    );
    expect(classifierJob).toContain('run_desktop: ${{ steps.classify.outputs.run_desktop }}');
    expect(classifierJob).toContain(
      'classification_error: ${{ steps.classify.outputs.classification_error }}',
    );
  });

  it('retains complete desktop checks evidence and exact web parity paths', () => {
    expect(desktopChecksJob).toContain(expectedWebDiff);
    expectCommandsInOrder(desktopChecksJob, [
      'run: pnpm install --frozen-lockfile',
      "run: pnpm -r --filter './packages/*' --if-present build",
      'pnpm --filter ./apps/session-deck-desktop sync:web',
      expectedWebDiff,
      'run: pnpm --filter ./apps/session-deck-desktop build',
      'run: pnpm --filter ./apps/session-deck-desktop lint',
      'run: pnpm --filter ./apps/session-deck-desktop format:check',
      'run: pnpm --filter ./apps/session-deck-desktop typecheck',
    ]);
    expectCommandsInOrder(desktopTestsJob, [
      'run: pnpm install --frozen-lockfile',
      'run: pnpm --filter ./apps/session-deck-desktop test',
    ]);

    expect(workflow.match(/sudo apt-get install -y --no-install-recommends/gu)).toHaveLength(2);
    expect(classifierJob).not.toContain('apt-get');
  });

  it('has one direct, always-running CI Gate with no work or network step', () => {
    expect(workflow.match(/^ +name: CI Gate$/gmu)).toHaveLength(1);
    expect(workflow).toContain(
      [
        '  ci-gate:',
        '    name: CI Gate',
        '    needs:',
        '      - classify-impact',
        '      - package-checks',
        '      - package-tests',
        '      - desktop-checks',
        '      - desktop-tests',
      ].join('\n'),
    );
    expect(gateJob).toContain('    if: ${{ always() }}');
    expect(gateJob).toContain('    timeout-minutes: 1');
    expect(gateJob).not.toContain('continue-on-error');
    expect(gateJob).not.toMatch(/^\s+uses:/mu);
    expect(gateJob).not.toMatch(/actions\//u);
    expect(gateJob).not.toMatch(/\b(?:apt-get|curl|wget|git|npm|pnpm)\b/u);

    expect(gateJob).toContain(
      [
        '      CLASSIFIER_RESULT: ${{ needs.classify-impact.result }}',
        '      CLASSIFICATION_ERROR: ${{ needs.classify-impact.outputs.classification_error }}',
        '      PACKAGE_CHECKS_RESULT: ${{ needs.package-checks.result }}',
        '      PACKAGE_TESTS_RESULT: ${{ needs.package-tests.result }}',
        '      RUN_DESKTOP: ${{ needs.classify-impact.outputs.run_desktop }}',
        '      DESKTOP_CHECKS_RESULT: ${{ needs.desktop-checks.result }}',
        '      DESKTOP_TESTS_RESULT: ${{ needs.desktop-tests.result }}',
      ].join('\n'),
    );
    expect(gateJob).toContain(
      indentShell([
        'set -euo pipefail',
        '',
        '[[ "$CLASSIFIER_RESULT" == success ]]',
        '[[ "$CLASSIFICATION_ERROR" == false ]]',
        '[[ "$PACKAGE_CHECKS_RESULT" == success ]]',
        '[[ "$PACKAGE_TESTS_RESULT" == success ]]',
        '',
        'case "$RUN_DESKTOP:$DESKTOP_CHECKS_RESULT:$DESKTOP_TESTS_RESULT" in',
        '  true:success:success|false:skipped:skipped) ;;',
        '  *) exit 1 ;;',
        'esac',
      ]),
    );
  });

  it.each([
    [
      'selected desktop succeeds',
      {
        classifierResult: 'success',
        classificationError: 'false',
        packageChecksResult: 'success',
        packageTestsResult: 'success',
        runDesktop: 'true',
        desktopChecksResult: 'success',
        desktopTestsResult: 'success',
      },
      true,
    ],
    [
      'selected desktop fails',
      {
        classifierResult: 'success',
        classificationError: 'false',
        packageChecksResult: 'success',
        packageTestsResult: 'success',
        runDesktop: 'true',
        desktopChecksResult: 'failure',
        desktopTestsResult: 'success',
      },
      false,
    ],
    [
      'unselected desktop is skipped',
      {
        classifierResult: 'success',
        classificationError: 'false',
        packageChecksResult: 'success',
        packageTestsResult: 'success',
        runDesktop: 'false',
        desktopChecksResult: 'skipped',
        desktopTestsResult: 'skipped',
      },
      true,
    ],
    [
      'unselected desktop unexpectedly runs',
      {
        classifierResult: 'success',
        classificationError: 'false',
        packageChecksResult: 'success',
        packageTestsResult: 'success',
        runDesktop: 'false',
        desktopChecksResult: 'success',
        desktopTestsResult: 'skipped',
      },
      false,
    ],
    [
      'selector is missing or invalid',
      {
        classifierResult: 'success',
        classificationError: 'false',
        packageChecksResult: 'success',
        packageTestsResult: 'success',
        runDesktop: '',
        desktopChecksResult: 'skipped',
        desktopTestsResult: 'skipped',
      },
      false,
    ],
    [
      'classifier reports an error',
      {
        classifierResult: 'success',
        classificationError: 'true',
        packageChecksResult: 'success',
        packageTestsResult: 'success',
        runDesktop: 'true',
        desktopChecksResult: 'success',
        desktopTestsResult: 'success',
      },
      false,
    ],
    [
      'classifier does not succeed',
      {
        classifierResult: 'failure',
        classificationError: 'false',
        packageChecksResult: 'success',
        packageTestsResult: 'success',
        runDesktop: 'true',
        desktopChecksResult: 'success',
        desktopTestsResult: 'success',
      },
      false,
    ],
    [
      'package checks fail',
      {
        classifierResult: 'success',
        classificationError: 'false',
        packageChecksResult: 'failure',
        packageTestsResult: 'success',
        runDesktop: 'false',
        desktopChecksResult: 'skipped',
        desktopTestsResult: 'skipped',
      },
      false,
    ],
  ] as const)('applies the Option 2 gate truth table: %s', (_name, inputs, expected) => {
    expect(optionTwoGatePasses(inputs)).toBe(expected);
  });

  it('keeps the CI Gate display name unique across repository workflows', () => {
    const displayNames = readdirSync(WORKFLOWS_ROOT)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .flatMap((file) => {
        const contents = readFileSync(new URL(file, WORKFLOWS_ROOT), 'utf8');
        return contents.match(/^ +name: CI Gate$/gmu) ?? [];
      });

    expect(displayNames).toHaveLength(1);
  });
});
