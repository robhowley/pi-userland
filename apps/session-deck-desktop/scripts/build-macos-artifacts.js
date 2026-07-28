#!/usr/bin/env node
/* global process, console */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { platform as hostPlatform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTauri } from './run-tauri.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const TAURI_CONF_PATH = resolve(PACKAGE_ROOT, 'src-tauri/tauri.conf.json');
const CARGO_TOML_PATH = resolve(PACKAGE_ROOT, 'src-tauri/Cargo.toml');
const DEFAULT_ARTIFACT_DIR = resolve(PACKAGE_ROOT, 'dist/artifacts');
const PRODUCT_NAME = 'Session Deck Desktop';
const ARTIFACT_PREFIX = 'session-deck-desktop';

/**
 * @typedef {{
 *   version: string,
 *   arch: 'arm64' | 'x64',
 *   target: 'aarch64-apple-darwin' | 'x86_64-apple-darwin',
 *   artifactDir: string,
 * }} MacosArtifactOptions
 */

/**
 * @param {string[]} argv
 * @returns {MacosArtifactOptions}
 */
export function parseMacosArtifactArgs(argv = process.argv.slice(2)) {
  let version = null;
  let target = null;
  let artifactDir = DEFAULT_ARTIFACT_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;

    if (arg === '--version') {
      version = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--version=')) {
      version = readEqualsOptionValue(arg, '--version=');
      continue;
    }
    if (arg === '--target') {
      target = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--target=')) {
      target = readEqualsOptionValue(arg, '--target=');
      continue;
    }
    if (arg === '--artifact-dir') {
      artifactDir = resolve(PACKAGE_ROOT, readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith('--artifact-dir=')) {
      artifactDir = resolve(PACKAGE_ROOT, readEqualsOptionValue(arg, '--artifact-dir='));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (version === null) {
    throw new Error('Missing --version <pi-session-deck-version> for desktop artifact naming.');
  }
  if (target === null) {
    throw new Error('Missing --target <aarch64-apple-darwin|x86_64-apple-darwin>.');
  }

  const arch = artifactArchForTarget(target);
  const releaseTarget = /** @type {'aarch64-apple-darwin' | 'x86_64-apple-darwin'} */ (target);
  return {
    version: normalizeReleaseVersion(version),
    arch,
    target: releaseTarget,
    artifactDir,
  };
}

/** @param {string[]} argv @param {number} index @param {string} optionName */
function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return value;
}

/** @param {string} arg @param {string} prefix */
function readEqualsOptionValue(arg, prefix) {
  const value = arg.slice(prefix.length);
  if (value.length === 0) throw new Error(`Missing value for ${prefix.slice(0, -1)}.`);
  return value;
}

/** @param {string} rawVersion */
export function normalizeReleaseVersion(rawVersion) {
  const version = rawVersion.trim().replace(/^v/u, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid pi-session-deck release version: ${rawVersion}`);
  }
  return version;
}

/** @param {string} rawArch @returns {'arm64' | 'x64'} */
export function normalizeArtifactArch(rawArch) {
  switch (rawArch) {
    case 'aarch64':
    case 'arm64':
      return 'arm64';
    case 'amd64':
    case 'x64':
    case 'x86_64':
      return 'x64';
    default:
      throw new Error(`Unsupported macOS artifact architecture: ${rawArch}`);
  }
}

/**
 * @param {string} target
 * @returns {'arm64' | 'x64'}
 */
export function artifactArchForTarget(target) {
  switch (target) {
    case 'aarch64-apple-darwin':
      return 'arm64';
    case 'x86_64-apple-darwin':
      return 'x64';
    default:
      throw new Error(`Unsupported macOS release target: ${target}`);
  }
}

/** @param {string} target */
export function bundleRootForTarget(target) {
  return resolve(PACKAGE_ROOT, 'src-tauri/target', target, 'release/bundle');
}

/** @param {string} version @param {string} arch */
export function macosArtifactStem(version, arch) {
  return `${ARTIFACT_PREFIX}-v${normalizeReleaseVersion(version)}-macos-${normalizeArtifactArch(arch)}`;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} tauriConfigText @param {string} cargoTomlText @param {string} version */
export function applyDesktopReleaseVersion(tauriConfigText, cargoTomlText, version) {
  const normalizedVersion = normalizeReleaseVersion(version);
  const tauriConfig = /** @type {Record<string, unknown>} */ (JSON.parse(tauriConfigText));
  const bundle = isRecord(tauriConfig['bundle']) ? tauriConfig['bundle'] : {};
  const macOS = isRecord(bundle['macOS']) ? bundle['macOS'] : {};

  tauriConfig['version'] = normalizedVersion;
  macOS['bundleVersion'] = normalizedVersion;
  bundle['macOS'] = macOS;
  tauriConfig['bundle'] = bundle;

  const nextCargoTomlText = cargoTomlText.replace(
    /(^\[package\][\s\S]*?^version = ").*?("$)/mu,
    `$1${normalizedVersion}$2`,
  );
  if (
    nextCargoTomlText === cargoTomlText &&
    !cargoTomlText.includes(`version = "${normalizedVersion}"`)
  ) {
    throw new Error('Could not find [package] version in src-tauri/Cargo.toml.');
  }

  return {
    tauriConfigText: `${JSON.stringify(tauriConfig, null, 2)}\n`,
    cargoTomlText: nextCargoTomlText,
  };
}

/** @param {string} version */
async function writeDesktopReleaseVersion(version) {
  const [tauriConfigText, cargoTomlText] = await Promise.all([
    readFile(TAURI_CONF_PATH, 'utf8'),
    readFile(CARGO_TOML_PATH, 'utf8'),
  ]);
  const next = applyDesktopReleaseVersion(tauriConfigText, cargoTomlText, version);
  await Promise.all([
    writeFile(TAURI_CONF_PATH, next.tauriConfigText, 'utf8'),
    writeFile(CARGO_TOML_PATH, next.cargoTomlText, 'utf8'),
  ]);
}

/** @param {string} command @param {string[]} args */
async function runCommand(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: PACKAGE_ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal !== null) return reject(new Error(`${command} exited from signal ${signal}`));
      if (code !== 0) return reject(new Error(`${command} exited with code ${code ?? 1}`));
      resolvePromise(undefined);
    });
  });
}

/** @param {string} command @param {string[]} args */
async function runCommandOutput(command, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal !== null) return reject(new Error(`${command} exited from signal ${signal}`));
      if (code !== 0) {
        return reject(new Error(`${command} exited with code ${code ?? 1}: ${output.trim()}`));
      }
      resolvePromise(output.trim());
    });
  });
}

/**
 * @param {string} output
 * @param {'arm64' | 'x64'} arch
 * @param {string} [path]
 */
export function assertExecutableArchitecture(output, arch, path = 'Desktop executable') {
  const actualArchitectures = output.trim() === '' ? [] : output.trim().split(/\s+/u);
  const expectedArchitecture = arch === 'arm64' ? 'arm64' : 'x86_64';
  if (actualArchitectures.length !== 1 || actualArchitectures[0] !== expectedArchitecture) {
    throw new Error(
      `${path} architecture is ${actualArchitectures.join(', ') || 'unknown'}, expected only ${expectedArchitecture}.`,
    );
  }
}

/** @param {string} details @param {string} [path] */
export function assertAdHocSignature(details, path = 'Desktop app') {
  if (!/^Signature=adhoc$/mu.test(details)) {
    throw new Error(`${path} does not have an ad-hoc signature.`);
  }
  if (/^Authority=/mu.test(details)) {
    throw new Error(`${path} unexpectedly has an authenticated signing authority.`);
  }
}

/**
 * @param {string} appBundlePath
 * @param {'arm64' | 'x64'} arch
 */
async function verifyAppBundle(appBundlePath, arch) {
  const appStats = await stat(appBundlePath);
  if (!appStats.isDirectory()) throw new Error(`Expected an app bundle: ${appBundlePath}`);

  const executableName = await runCommandOutput('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleExecutable',
    join(appBundlePath, 'Contents/Info.plist'),
  ]);
  if (executableName.length === 0 || executableName.includes('/')) {
    throw new Error(`Invalid CFBundleExecutable in ${appBundlePath}.`);
  }

  const executablePath = join(appBundlePath, 'Contents/MacOS', executableName);
  const executableStats = await stat(executablePath);
  if (
    !executableStats.isFile() ||
    executableStats.size <= 0 ||
    (executableStats.mode & 0o111) === 0
  ) {
    throw new Error(`Expected a non-empty executable file: ${executablePath}`);
  }

  const architectures = await runCommandOutput('/usr/bin/lipo', ['-archs', executablePath]);
  assertExecutableArchitecture(architectures, arch, executablePath);

  await runCommand('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appBundlePath,
  ]);
  const signatureDetails = await runCommandOutput('/usr/bin/codesign', [
    '-dv',
    '--verbose=4',
    appBundlePath,
  ]);
  assertAdHocSignature(signatureDetails, appBundlePath);
}

/** @param {string} appBundlePath @param {string} zipPath */
async function zipAppBundle(appBundlePath, zipPath) {
  await runCommand('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    '--sequesterRsrc',
    '--zlibCompressionLevel',
    '9',
    appBundlePath,
    zipPath,
  ]);
}

/** @param {string} filePath */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(undefined));
  });
  return hash.digest('hex');
}

/** @param {string} artifactPath */
export async function writeArtifactChecksum(artifactPath) {
  const artifactStats = await stat(artifactPath);
  if (!artifactStats.isFile() || artifactStats.size <= 0) {
    throw new Error(`Artifact is not a non-empty regular file: ${artifactPath}`);
  }

  const sha256 = await sha256File(artifactPath);
  const checksumPath = `${artifactPath}.sha256`;
  await writeFile(checksumPath, `${sha256}  ${basename(artifactPath)}\n`, 'utf8');
  return { checksumPath, sha256 };
}

/** @param {MacosArtifactOptions} options */
export function tauriBuildArgsForOptions(options) {
  return ['build', '--bundles', 'app', '--ci', '--target', options.target];
}

/** @param {MacosArtifactOptions} options */
export async function buildMacosArtifactsFromOptions(options) {
  if (hostPlatform() !== 'darwin') {
    throw new Error('macOS desktop artifacts must be built and verified on a macOS runner.');
  }
  if (artifactArchForTarget(options.target) !== options.arch) {
    throw new Error(
      `Target ${options.target} does not match artifact architecture ${options.arch}.`,
    );
  }

  await writeDesktopReleaseVersion(options.version);
  const exitCode = await runTauri(tauriBuildArgsForOptions(options));
  if (exitCode !== 0) throw new Error(`tauri build exited with code ${exitCode}`);

  const appBundlePath = join(bundleRootForTarget(options.target), 'macos', `${PRODUCT_NAME}.app`);
  await verifyAppBundle(appBundlePath, options.arch);

  await rm(options.artifactDir, { recursive: true, force: true });
  await mkdir(options.artifactDir, { recursive: true });
  const zipPath = join(
    options.artifactDir,
    `${macosArtifactStem(options.version, options.arch)}.zip`,
  );
  await zipAppBundle(appBundlePath, zipPath);
  const checksum = await writeArtifactChecksum(zipPath);

  return { version: options.version, arch: options.arch, zipPath, ...checksum };
}

/** @param {string[]} argv */
export async function buildMacosArtifacts(argv = process.argv.slice(2)) {
  return buildMacosArtifactsFromOptions(parseMacosArtifactArgs(argv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await buildMacosArtifacts();
    console.log(`Prepared ${basename(result.zipPath)} and its SHA-256 sidecar.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
