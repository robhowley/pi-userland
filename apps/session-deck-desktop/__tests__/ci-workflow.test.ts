import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_ROOT = new URL('../../../.github/workflows/', import.meta.url);
const packageWorkflow = readFileSync(new URL('ci.yml', WORKFLOWS_ROOT), 'utf8');
const desktopWorkflow = readFileSync(new URL('session-deck-desktop.yml', WORKFLOWS_ROOT), 'utf8');

const packageTrigger = `on:
  push:
    branches:
      - main
  pull_request:

permissions:`;

const desktopTrigger = `on:
  push:
    branches:
      - main
  pull_request:
    paths:
      - apps/session-deck-desktop/**
      - packages/pi-session-deck/extensions/**
      - packages/pi-session-deck/package.json
      - packages/pi-session-deck/tsconfig*.json
      - .github/workflows/**
      - package.json
      - pnpm-lock.yaml
      - pnpm-workspace.yaml
      - tsconfig.base.json
      - eslint.config.js
      - .prettierrc
      - .prettierignore

permissions:`;

const pullRequestCancellation = "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}";
const packageConcurrencyGroup =
  "  group: packages-ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}-{1}', github.run_id, github.run_attempt) }}";
const desktopConcurrencyGroup =
  "  group: session-deck-desktop-ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}-{1}', github.run_id, github.run_attempt) }}";

describe('Session Deck CI workflow contract', () => {
  it('keeps the repository-owned CI policy', () => {
    expect(packageWorkflow).toContain(packageTrigger);
    expect(desktopWorkflow).toContain(desktopTrigger);

    expect(packageWorkflow).toContain('jobs:\n  package-checks:\n');
    expect(packageWorkflow).toContain('\n  package-tests:\n');
    expect(desktopWorkflow).toContain('jobs:\n  desktop-checks:\n');
    expect(desktopWorkflow).toContain('\n  desktop-tests:\n');

    for (const workflow of [packageWorkflow, desktopWorkflow]) {
      expect(workflow).not.toMatch(/^ {4}(?:if|needs):/mu);
      expect(workflow).toContain(pullRequestCancellation);
    }

    expect(packageWorkflow).toContain(packageConcurrencyGroup);
    expect(desktopWorkflow).toContain(desktopConcurrencyGroup);
  });
});
