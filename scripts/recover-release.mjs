import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const registry = 'https://registry.npmjs.org';

export function command(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function selectReleases(input, root, run = command) {
  const tags = input
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!tags.length) throw new Error('Provide at least one existing release tag.');
  const config = JSON.parse(readFileSync(path.join(root, '.github/release-please-config.json')));
  const seen = new Set();
  return tags.map((tag) => {
    // Only stable package release tags. Inputs are always passed as arguments, never shell code.
    const match =
      /^(pi-[a-z0-9]+(?:-[a-z0-9]+)*)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
    if (!match) throw new Error(`Invalid release tag: ${tag}`);
    const [, component, version] = match;
    const packagePath = `packages/${component}`;
    if (!Object.hasOwn(config.packages, packagePath)) {
      throw new Error(`Package is not allowlisted: ${packagePath}`);
    }
    if (seen.has(packagePath)) throw new Error(`Select only one tag per package: ${packagePath}`);
    seen.add(packagePath);
    const commit = run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], root);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Invalid commit for ${tag}`);
    const metadata = JSON.parse(
      run('git', ['show', `${commit}:${packagePath}/package.json`], root),
    );
    const name = `@robhowley/${component}`;
    if (metadata.name !== name || metadata.version !== version || metadata.private === true) {
      throw new Error(`Tag/package mismatch or private package: ${tag}`);
    }
    return { tag, commit, packagePath, name, version };
  });
}

export function recover(input, root, run = command, log = console.log) {
  // Validate the entire selection before any install, build, or publication.
  const releases = selectReleases(input, root, run);
  const results = [];
  for (const release of releases) {
    const { tag, commit, packagePath, name, version } = release;
    let temporary;
    let checkout;
    try {
      // A successful versions response proves absence without treating auth/network errors
      // (including ambiguous package-level E404s) as permission to publish.
      const versions = JSON.parse(
        run('npm', ['view', name, 'versions', '--json', '--registry', registry], root),
      );
      const published = typeof versions === 'string' ? [versions] : versions;
      if (!Array.isArray(published) || !published.every((value) => typeof value === 'string')) {
        throw new Error(`Unexpected npm versions response for ${name}`);
      }
      if (published.includes(version)) {
        results.push(`${tag}: skipped (already published)`);
        continue;
      }
      temporary = mkdtempSync(path.join(tmpdir(), 'release-recovery-'));
      checkout = path.join(temporary, 'source');
      run('git', ['worktree', 'add', '--detach', checkout, commit], root);
      log(`${tag}: publishing ${name}@${version} from ${commit}`);
      run('pnpm', ['install', '--frozen-lockfile'], checkout);
      run('pnpm', ['-r', '--filter', './packages/*', '--if-present', 'build'], checkout);
      run(
        'npm',
        ['publish', '--access', 'public', '--registry', registry],
        path.join(checkout, packagePath),
      );
      results.push(`${tag}: published (${commit})`);
    } catch (error) {
      results.push(`${tag}: FAILED (${error.message})`);
    } finally {
      if (checkout) {
        try {
          run('git', ['worktree', 'remove', '--force', checkout], root);
        } catch (error) {
          results.push(`${tag}: FAILED (checkout cleanup: ${error.message})`);
        }
      }
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }
  log(`Recovery summary:\n${results.join('\n')}`);
  return results.some((result) => result.includes(': FAILED')) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = recover(process.env.RECOVERY_TAGS ?? '', process.cwd());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
