import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { command, recover, selectReleases } from './recover-release.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'test-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  const git = (...args) => command('git', args, root);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('.github/release-please-config.json', {
    packages: { 'packages/pi-one': {}, 'packages/pi-two': {} },
  });
  for (const component of ['pi-one', 'pi-two']) {
    write(`packages/${component}/package.json`, {
      name: `@robhowley/${component}`,
      version: '1.0.0',
    });
  }
  git('add', '.');
  git('commit', '-qm', 'release');
  const commit = git('rev-parse', 'HEAD');
  git('tag', '-a', 'pi-one-v1.0.0', '-m', 'annotated release');
  git('tag', 'pi-two-v1.0.0');
  write('packages/pi-one/package.json', { name: '@robhowley/pi-one', version: '2.0.0' });
  git('add', '.');
  git('commit', '-qm', 'later changes');
  return { root, write, git, commit };
}

function mockCommands(root, behavior = {}) {
  const calls = [];
  const run = (file, args, cwd) => {
    calls.push({ file, args, cwd });
    if (file === 'git') return command(file, args, cwd);
    if (file === 'npm' && args[0] === 'view') return behavior.view?.(args[1]) ?? '["0.9.0"]';
    if (file === 'npm' && args[0] === 'publish') return behavior.publish?.(cwd) ?? '';
    if (file === 'pnpm') return '';
    assert.fail(`Unexpected command: ${file} ${args}`);
  };
  const logs = [];
  return {
    calls,
    run,
    logs,
    recover: (input) => recover(input, root, run, (value) => logs.push(value)),
  };
}

test('selection accepts explicit allowlisted existing tags and resolves annotated tags to commits', (t) => {
  const { root, commit } = fixture(t);
  const releases = selectReleases('pi-one-v1.0.0,\npi-two-v1.0.0', root);
  assert.equal(releases.length, 2);
  assert.ok(releases.every((release) => release.commit === commit));
});

test('invalid, missing, duplicate, unlisted, and shell-like selections fail before publication', (t) => {
  const { root } = fixture(t);
  const mock = mockCommands(root);
  for (const input of [
    '',
    'main',
    'pi-one-v1.0.0;echo',
    '$(touch /tmp/no)',
    'pi-unknown-v1.0.0',
    'pi-one-v9.0.0',
    'pi-one-v1.0.0 pi-one-v1.0.0',
    'pi-one-v1.0.0 pi-two-v9.0.0',
  ]) {
    assert.throws(() => mock.recover(input));
  }
  assert.ok(mock.calls.every((call) => call.file === 'git'));
});

test('tag version, package name, and public package must match', (t) => {
  const { root, git, write } = fixture(t);
  git('tag', 'pi-one-v3.0.0');
  assert.throws(() => selectReleases('pi-one-v3.0.0', root), /mismatch/);
  for (const metadata of [
    { name: '@someone/pi-one', version: '4.0.0' },
    { name: '@robhowley/pi-one', version: '4.0.0', private: true },
  ]) {
    write('packages/pi-one/package.json', metadata);
    git('add', '.');
    git('commit', '-qm', 'invalid metadata');
    git('tag', '-f', 'pi-one-v4.0.0');
    assert.throws(() => selectReleases('pi-one-v4.0.0', root), /mismatch|private/);
  }
});

test('already published exact versions skip checkout, install, build, and publish', (t) => {
  const { root } = fixture(t);
  const mock = mockCommands(root, { view: () => '["0.9.0","1.0.0"]' });
  assert.equal(mock.recover('pi-one-v1.0.0'), 0);
  assert.ok(mock.logs[0].includes('skipped'));
  assert.equal(mock.calls.filter((call) => call.file !== 'git').length, 1);
});

test('query errors and malformed responses never permit publication', (t) => {
  const { root } = fixture(t);
  for (const error of [
    'E401 auth',
    'E404 package not found',
    'ETIMEDOUT network',
    'E403 forbidden',
    'invalid JSON',
    '{}',
  ]) {
    const mock = mockCommands(root, {
      view: () => {
        if (error.startsWith('E')) throw new Error(error);
        return error;
      },
    });
    assert.equal(mock.recover('pi-one-v1.0.0'), 1);
    assert.ok(!mock.calls.some((call) => call.file === 'pnpm' || call.args[0] === 'publish'));
  }
});

test('publication failure does not prevent later selections; uses exact resolved commits and existing build commands', (t) => {
  const { root, commit, git } = fixture(t);
  const published = [];
  const mock = mockCommands(root, {
    publish: (cwd) => {
      const metadata = JSON.parse(readFileSync(path.join(cwd, 'package.json')));
      assert.equal(command('git', ['rev-parse', 'HEAD'], cwd), commit);
      assert.equal(metadata.version, '1.0.0');
      published.push(metadata.name);
      if (metadata.name.endsWith('pi-one')) throw new Error('publish denied');
    },
  });
  const originalRun = mock.run;
  const run = (file, args, cwd) => {
    const result = originalRun(file, args, cwd);
    // Simulate a tag moving after resolution. Checkout must still use the saved SHA.
    if (file === 'git' && args[0] === 'rev-parse') git('tag', '-f', 'pi-one-v1.0.0');
    return result;
  };
  assert.equal(
    recover('pi-one-v1.0.0 pi-two-v1.0.0', root, run, (value) => mock.logs.push(value)),
    1,
  );
  assert.deepEqual(published, ['@robhowley/pi-one', '@robhowley/pi-two']);
  assert.deepEqual(
    mock.calls.filter((call) => call.file === 'pnpm').map((call) => call.args),
    [
      ['install', '--frozen-lockfile'],
      ['-r', '--filter', './packages/*', '--if-present', 'build'],
      ['install', '--frozen-lockfile'],
      ['-r', '--filter', './packages/*', '--if-present', 'build'],
    ],
  );
  assert.match(mock.logs.at(-1), /pi-one-v1.0.0: FAILED[\s\S]*pi-two-v1.0.0: published/);
  assert.equal(git('worktree', 'list', '--porcelain').split('worktree ').length, 2);
});

test('query failure also continues to later eligible packages', (t) => {
  const { root } = fixture(t);
  const mock = mockCommands(root, {
    view: (name) => {
      if (name.endsWith('pi-one')) throw new Error('E401');
      return '["0.9.0"]';
    },
  });
  assert.equal(mock.recover('pi-one-v1.0.0 pi-two-v1.0.0'), 1);
  assert.equal(mock.calls.filter((call) => call.args[0] === 'publish').length, 1);
});
