#!/usr/bin/env node
/* global process, console */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatSha256Line, sha256File } from './checksum-artifacts.js';
import { runTauri } from './run-tauri.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const TAURI_CONF_PATH = resolve(PACKAGE_ROOT, 'src-tauri/tauri.conf.json');
const CARGO_TOML_PATH = resolve(PACKAGE_ROOT, 'src-tauri/Cargo.toml');
const BUNDLE_ROOT = resolve(PACKAGE_ROOT, 'src-tauri/target/release/bundle');
const DEFAULT_ARTIFACT_DIR = resolve(PACKAGE_ROOT, 'dist/artifacts');
const PRODUCT_NAME = 'Session Deck Desktop';
const ARTIFACT_PREFIX = 'session-deck-desktop';
/**
 * @typedef {{
 *   version: string,
 *   arch: string,
 *   target: string | null,
 *   skipBuild: boolean,
 *   artifactDir: string,
 * }} MacosArtifactOptions
 */

/**
 * @typedef {{ name: string, sha256: string, bytes: number }} ArtifactMetadata
 */

/**
 * @typedef {{
 *   schemaVersion: 1,
 *   product: 'session-deck-desktop',
 *   packageName: '@robhowley/pi-session-deck',
 *   version: string,
 *   platform: 'macos',
 *   arch: string,
 *   signed: boolean,
 *   notarized: false,
 *   artifacts: ArtifactMetadata[],
 * }} ReleaseArtifactMetadata
 */

/**
 * @param {string[]} argv
 * @returns {MacosArtifactOptions}
 */
export function parseMacosArtifactArgs(argv = process.argv.slice(2)) {
  let version = process.env['SESSION_DECK_VERSION'] ?? null;
  let archOverride = process.env['SESSION_DECK_DESKTOP_ARCH'] ?? null;
  let target = process.env['SESSION_DECK_DESKTOP_TARGET'] ?? null;
  let skipBuild = false;
  let artifactDir = DEFAULT_ARTIFACT_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') {
      continue;
    }

    if (arg === '--skip-build') {
      skipBuild = true;
      continue;
    }

    if (arg === '--version') {
      version = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--version=')) {
      version = readEqualsOptionValue(arg, '--version=');
      continue;
    }

    if (arg === '--arch') {
      archOverride = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--arch=')) {
      archOverride = readEqualsOptionValue(arg, '--arch=');
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

  const targetArch = target === null ? null : targetToArtifactArch(target);
  const arch = normalizeArtifactArch(archOverride ?? targetArch ?? hostArch());

  return {
    version: normalizeReleaseVersion(version),
    arch,
    target,
    skipBuild,
    artifactDir,
  };
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} optionName
 * @returns {string}
 */
function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return value;
}

/**
 * @param {string} arg
 * @param {string} prefix
 * @returns {string}
 */
function readEqualsOptionValue(arg, prefix) {
  const value = arg.slice(prefix.length);
  if (value.length === 0) {
    throw new Error(`Missing value for ${prefix.slice(0, -1)}.`);
  }
  return value;
}

/**
 * @param {string} rawVersion
 * @returns {string}
 */
export function normalizeReleaseVersion(rawVersion) {
  const version = rawVersion.trim().replace(/^v/u, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid pi-session-deck release version: ${rawVersion}`);
  }
  return version;
}

/**
 * @param {string} rawArch
 * @returns {string}
 */
export function normalizeArtifactArch(rawArch) {
  switch (rawArch) {
    case 'aarch64':
    case 'arm64':
      return 'arm64';
    case 'amd64':
    case 'x64':
    case 'x86_64':
      return 'x64';
    case 'universal':
    case 'universal-apple-darwin':
      return 'universal';
    default:
      throw new Error(`Unsupported macOS artifact architecture: ${rawArch}`);
  }
}

/**
 * @param {string} target
 * @returns {string | null}
 */
function targetToArtifactArch(target) {
  switch (target) {
    case 'aarch64-apple-darwin':
      return 'arm64';
    case 'x86_64-apple-darwin':
      return 'x64';
    case 'universal-apple-darwin':
      return 'universal';
    default:
      return null;
  }
}

/**
 * @param {string} version
 * @param {string} arch
 * @returns {string}
 */
export function macosArtifactStem(version, arch) {
  return `${ARTIFACT_PREFIX}-v${normalizeReleaseVersion(version)}-macos-${normalizeArtifactArch(arch)}`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} tauriConfigText
 * @param {string} cargoTomlText
 * @param {string} version
 * @returns {{ tauriConfigText: string, cargoTomlText: string }}
 */
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

/**
 * @param {string} version
 * @returns {Promise<void>}
 */
export async function writeDesktopReleaseVersion(version) {
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

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function runCommand(command, args, cwd = PACKAGE_ROOT) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} exited from signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve(undefined);
    });
  });
}

/**
 * @returns {Promise<string>}
 */
async function findAppBundle() {
  const macosBundleDir = join(BUNDLE_ROOT, 'macos');
  const entries = await readdir(macosBundleDir, { withFileTypes: true });
  const exactName = `${PRODUCT_NAME}.app`;
  const exact = entries.find((entry) => entry.isDirectory() && entry.name === exactName);
  if (exact) {
    return join(macosBundleDir, exact.name);
  }

  const firstApp = entries.find((entry) => entry.isDirectory() && extname(entry.name) === '.app');
  if (firstApp) {
    return join(macosBundleDir, firstApp.name);
  }

  throw new Error(`No .app bundle found in ${macosBundleDir}.`);
}

/**
 * @returns {Promise<string | null>}
 */
async function findDmgArtifact() {
  const dmgDir = join(BUNDLE_ROOT, 'dmg');
  let entries;
  try {
    entries = await readdir(dmgDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }

  const dmgs = entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.dmg')
    .map((entry) => entry.name)
    .sort();

  if (dmgs.length === 0) {
    return null;
  }

  const last = dmgs[dmgs.length - 1];
  if (typeof last !== 'string') {
    return null;
  }
  return join(dmgDir, last);
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException}
 */
function isMissingPathError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * @param {string} appBundlePath
 * @param {string} zipPath
 * @returns {Promise<void>}
 */
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

/**
 * @param {string} artifactPath
 * @returns {Promise<ArtifactMetadata>}
 */
async function writeArtifactChecksum(artifactPath) {
  const [artifactStats, sha256] = await Promise.all([stat(artifactPath), sha256File(artifactPath)]);
  await writeFile(
    `${artifactPath}.sha256`,
    formatSha256Line(sha256, basename(artifactPath)),
    'utf8',
  );
  return {
    name: basename(artifactPath),
    sha256,
    bytes: artifactStats.size,
  };
}

/**
 * @param {MacosArtifactOptions} options
 * @returns {Promise<ReleaseArtifactMetadata>}
 */
export async function buildMacosArtifactsFromOptions(options) {
  const shouldSign = process.env['SESSION_DECK_DESKTOP_SIGN'] === 'true';
  if (hostPlatform() !== 'darwin' && !options.skipBuild) {
    throw new Error('macOS desktop artifacts must be built on a macOS runner.');
  }

  await writeDesktopReleaseVersion(options.version);

  if (!shouldSign) {
    console.warn(
      'Building unsigned Session Deck desktop artifacts. Configure Developer ID signing/notarization before treating these as production-trusted downloads.',
    );
  }

  if (!options.skipBuild) {
    const tauriArgs = ['build', '--bundles', 'app,dmg', '--ci'];
    if (options.target !== null) {
      tauriArgs.push('--target', options.target);
    }
    if (!shouldSign) {
      tauriArgs.push('--no-sign');
    }

    const exitCode = await runTauri(tauriArgs);
    if (exitCode !== 0) {
      throw new Error(`tauri build exited with code ${exitCode}`);
    }
  }

  await rm(options.artifactDir, { recursive: true, force: true });
  await mkdir(options.artifactDir, { recursive: true });

  const stem = macosArtifactStem(options.version, options.arch);
  const appBundlePath = await findAppBundle();
  const zipPath = join(options.artifactDir, `${stem}.zip`);
  await zipAppBundle(appBundlePath, zipPath);

  /** @type {ArtifactMetadata[]} */
  const artifacts = [await writeArtifactChecksum(zipPath)];

  const dmgArtifactPath = await findDmgArtifact();
  if (dmgArtifactPath !== null) {
    const dmgPath = join(options.artifactDir, `${stem}.dmg`);
    await copyFile(dmgArtifactPath, dmgPath);
    artifacts.push(await writeArtifactChecksum(dmgPath));
  } else {
    console.warn('No Tauri DMG output found; uploading the zipped .app artifact only.');
  }

  /** @type {ReleaseArtifactMetadata} */
  const metadata = {
    schemaVersion: 1,
    product: 'session-deck-desktop',
    packageName: '@robhowley/pi-session-deck',
    version: options.version,
    platform: 'macos',
    arch: options.arch,
    signed: shouldSign,
    notarized: false,
    artifacts,
  };
  const metadataPath = join(options.artifactDir, `${stem}.metadata.json`);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  artifacts.push(await writeArtifactChecksum(metadataPath));

  return metadata;
}

/**
 * @param {string[]} argv
 * @returns {Promise<ReleaseArtifactMetadata>}
 */
export async function buildMacosArtifacts(argv = process.argv.slice(2)) {
  return buildMacosArtifactsFromOptions(parseMacosArtifactArgs(argv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const metadata = await buildMacosArtifacts();
    console.log(
      `Prepared ${metadata.artifacts.length} Session Deck desktop artifact(s) for ${metadata.version}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
