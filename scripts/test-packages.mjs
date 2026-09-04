import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = path.join(root, 'packages');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const requestedPackages = new Set(process.argv.slice(2).filter((argument) => argument !== '--'));
let testPackageCount = 0;

for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const packageDirectory = path.join(packagesDirectory, entry.name);
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  if (!existsSync(packageJsonPath)) continue;

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (
    requestedPackages.size > 0 &&
    !requestedPackages.has(entry.name) &&
    !requestedPackages.has(packageJson.name)
  ) {
    continue;
  }
  if (!packageJson.scripts?.test) continue;
  if (packageJson.scripts.test !== 'vitest run __tests__') {
    throw new Error(
      `${packageJson.name} has an unsupported test script: ${packageJson.scripts.test}`,
    );
  }

  testPackageCount += 1;
  console.log(`\n> ${packageJson.name}`);

  const result = spawnSync(
    pnpm,
    ['exec', 'vitest', 'run', '__tests__', '--maxWorkers=1', '--minWorkers=1'],
    {
      cwd: packageDirectory,
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (testPackageCount === 0) throw new Error('No package test scripts found.');
