#!/usr/bin/env node
/* global process, console */
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatSha256Line, sha256File } from './checksum-artifacts.js';
import { runTauri } from './run-tauri.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const TAURI_CONF_PATH = resolve(PACKAGE_ROOT, 'src-tauri/tauri.conf.json');
const CARGO_TOML_PATH = resolve(PACKAGE_ROOT, 'src-tauri/Cargo.toml');
const DEFAULT_ARTIFACT_DIR = resolve(PACKAGE_ROOT, 'dist/artifacts');
const PRODUCT_NAME = 'Session Deck Desktop';
const ARTIFACT_PREFIX = 'session-deck-desktop';
const TRUSTED_RELEASE_ENV = [
  'APPLE_SIGNING_IDENTITY',
  'APPLE_TEAM_ID',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_PATH',
];

/**
 * @typedef {{
 *   version: string,
 *   arch: 'arm64' | 'x64',
 *   target: string | null,
 *   skipBuild: boolean,
 *   artifactDir: string,
 *   trustedRelease: boolean,
 * }} MacosArtifactOptions
 */

/** @typedef {{ name: string, sha256: string, bytes: number }} ArtifactMetadata */

/**
 * @typedef {{
 *   schemaVersion: 1,
 *   product: 'session-deck-desktop',
 *   packageName: '@robhowley/pi-session-deck',
 *   version: string,
 *   platform: 'macos',
 *   arch: 'arm64' | 'x64',
 *   signed: boolean,
 *   notarized: boolean,
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
  let trustedRelease = false;
  let artifactDir = DEFAULT_ARTIFACT_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;

    if (arg === '--skip-build') {
      skipBuild = true;
      continue;
    }
    if (arg === '--trusted-release') {
      trustedRelease = true;
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

  const targetArch = target === null ? null : artifactArchForTarget(target);
  const overrideArch = archOverride === null ? null : normalizeArtifactArch(archOverride);
  if (targetArch !== null && overrideArch !== null && targetArch !== overrideArch) {
    throw new Error(
      `Target ${target} produces ${targetArch}, not requested architecture ${overrideArch}.`,
    );
  }
  if (trustedRelease && target === null) {
    throw new Error('Trusted releases require an explicit --target.');
  }

  return {
    version: normalizeReleaseVersion(version),
    arch: targetArch ?? overrideArch ?? normalizeArtifactArch(hostArch()),
    target,
    skipBuild,
    artifactDir,
    trustedRelease,
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

/** @param {string} target @returns {'arm64' | 'x64'} */
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

/** @param {string | null} target */
export function bundleRootForTarget(target) {
  return target === null
    ? resolve(PACKAGE_ROOT, 'src-tauri/target/release/bundle')
    : resolve(PACKAGE_ROOT, 'src-tauri/target', target, 'release/bundle');
}

/** @param {string} version @param {string} arch */
export function macosArtifactStem(version, arch) {
  return `${ARTIFACT_PREFIX}-v${normalizeReleaseVersion(version)}-macos-${normalizeArtifactArch(arch)}`;
}

/**
 * Return every missing trusted-release variable without exposing any value.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function missingTrustedReleaseEnvironment(env = process.env) {
  return TRUSTED_RELEASE_ENV.filter((name) => !env[name]?.trim());
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
export async function preflightTrustedReleaseEnvironment(env = process.env) {
  const missingEnvironment = missingTrustedReleaseEnvironment(env);
  if (missingEnvironment.length > 0) {
    throw new Error(
      `Trusted release credentials are incomplete: ${missingEnvironment.join(', ')}.`,
    );
  }
  const teamId = /** @type {string} */ (env['APPLE_TEAM_ID']);
  validateAppleTeamId(teamId);
  const apiKeyPath = /** @type {string} */ (env['APPLE_API_KEY_PATH']);
  const [apiKeyStats, apiKeyText] = await Promise.all([
    stat(apiKeyPath),
    readFile(apiKeyPath, 'utf8'),
  ]);
  if (
    !apiKeyStats.isFile() ||
    apiKeyStats.size <= 0 ||
    !apiKeyText.includes('-----BEGIN PRIVATE KEY-----') ||
    !apiKeyText.includes('-----END PRIVATE KEY-----')
  ) {
    throw new Error(
      'APPLE_API_KEY_PATH must reference a non-empty App Store Connect private API key.',
    );
  }
}

/** @param {boolean} trustedRelease @param {boolean} postBuildVerified */
export function releaseTrustMetadata(trustedRelease, postBuildVerified) {
  if (trustedRelease && !postBuildVerified) {
    throw new Error('Trusted release metadata requires successful post-build verification.');
  }
  return {
    signed: trustedRelease && postBuildVerified,
    notarized: trustedRelease && postBuildVerified,
  };
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

/** @param {string} command @param {string[]} args @param {string} [cwd] */
async function runCommand(command, args, cwd = PACKAGE_ROOT) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal !== null) return reject(new Error(`${command} exited from signal ${signal}`));
      if (code !== 0) return reject(new Error(`${command} exited with code ${code ?? 1}`));
      resolvePromise(undefined);
    });
  });
}

/** @param {string} command @param {string[]} args @param {string} [cwd] */
async function runCommandOutput(command, args, cwd = PACKAGE_ROOT) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** @param {string} bundleRoot */
async function findAppBundle(bundleRoot) {
  const macosBundleDir = join(bundleRoot, 'macos');
  const entries = await readdir(macosBundleDir, { withFileTypes: true });
  const exactName = `${PRODUCT_NAME}.app`;
  const exact = entries.find((entry) => entry.isDirectory() && entry.name === exactName);
  if (exact) return join(macosBundleDir, exact.name);

  const firstApp = entries.find((entry) => entry.isDirectory() && extname(entry.name) === '.app');
  if (firstApp) return join(macosBundleDir, firstApp.name);
  throw new Error(`No .app bundle found in ${macosBundleDir}.`);
}

/** @param {string} bundleRoot */
async function findDmgArtifact(bundleRoot) {
  const dmgDir = join(bundleRoot, 'dmg');
  let entries;
  try {
    entries = await readdir(dmgDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  const dmgs = entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.dmg')
    .map((entry) => entry.name)
    .sort();
  const last = dmgs.at(-1);
  return last === undefined ? null : join(dmgDir, last);
}

/** @param {unknown} error @returns {error is NodeJS.ErrnoException} */
function isMissingPathError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

/** @param {string} artifactPath @returns {Promise<ArtifactMetadata>} */
async function writeArtifactChecksum(artifactPath) {
  const [artifactStats, sha256] = await Promise.all([stat(artifactPath), sha256File(artifactPath)]);
  if (artifactStats.size <= 0) throw new Error(`Artifact is empty: ${artifactPath}`);
  await writeFile(
    `${artifactPath}.sha256`,
    formatSha256Line(sha256, basename(artifactPath)),
    'utf8',
  );
  return { name: basename(artifactPath), sha256, bytes: artifactStats.size };
}

/** @param {string} teamId */
function validateAppleTeamId(teamId) {
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error('APPLE_TEAM_ID must be exactly 10 uppercase letters or digits.');
  }
}

/**
 * @param {string} details
 * @param {string} expectedSigningIdentity
 * @param {string} expectedTeamId
 * @param {string} path
 */
export function assertDeveloperIdSignatureDetails(
  details,
  expectedSigningIdentity,
  expectedTeamId,
  path = 'Signed artifact',
) {
  validateAppleTeamId(expectedTeamId);
  const lines = details.split(/\r?\n/u);
  const authorityLines = lines.filter((line) => line.startsWith('Authority='));
  const leafAuthorityLine = authorityLines[0];
  if (!leafAuthorityLine?.startsWith('Authority=Developer ID Application:')) {
    throw new Error(`${path} is not signed with a Developer ID Application certificate.`);
  }
  if (leafAuthorityLine !== `Authority=${expectedSigningIdentity}`) {
    throw new Error(`${path} leaf authority does not exactly match APPLE_SIGNING_IDENTITY.`);
  }

  const teamIdentifierLines = lines.filter((line) => line.startsWith('TeamIdentifier='));
  if (
    teamIdentifierLines.length !== 1 ||
    teamIdentifierLines[0] !== `TeamIdentifier=${expectedTeamId}`
  ) {
    throw new Error(`${path} TeamIdentifier does not exactly match APPLE_TEAM_ID.`);
  }
}

/**
 * @param {string} path
 * @param {string} expectedSigningIdentity
 * @param {string} expectedTeamId
 */
async function verifyDeveloperIdSignature(path, expectedSigningIdentity, expectedTeamId) {
  await runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path]);
  const details = await runCommandOutput('/usr/bin/codesign', ['-dv', '--verbose=4', path]);
  assertDeveloperIdSignatureDetails(details, expectedSigningIdentity, expectedTeamId, path);
}

/**
 * @param {string} appBundlePath
 * @param {'arm64' | 'x64'} arch
 * @param {string} signingIdentity
 * @param {string} teamId
 */
async function verifyAppBundle(appBundlePath, arch, signingIdentity, teamId) {
  const executableName = await runCommandOutput('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleExecutable',
    join(appBundlePath, 'Contents/Info.plist'),
  ]);
  if (executableName.length === 0 || executableName.includes('/')) {
    throw new Error(`Invalid CFBundleExecutable in ${appBundlePath}.`);
  }
  const actualArchitectures = (
    await runCommandOutput('/usr/bin/lipo', [
      '-archs',
      join(appBundlePath, 'Contents/MacOS', executableName),
    ])
  ).split(/\s+/u);
  const expectedArchitecture = arch === 'arm64' ? 'arm64' : 'x86_64';
  if (actualArchitectures.length !== 1 || actualArchitectures[0] !== expectedArchitecture) {
    throw new Error(
      `${appBundlePath} executable architecture is ${actualArchitectures.join(', ')}, expected only ${expectedArchitecture}.`,
    );
  }

  await verifyDeveloperIdSignature(appBundlePath, signingIdentity, teamId);
  await runCommand('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    appBundlePath,
  ]);
  await runCommand('/usr/bin/xcrun', ['stapler', 'validate', appBundlePath]);
}

/**
 * @param {string} dmgPath
 * @param {'arm64' | 'x64'} arch
 * @param {string} signingIdentity
 * @param {string} teamId
 */
async function verifyDmg(dmgPath, arch, signingIdentity, teamId) {
  await runCommand('/usr/bin/hdiutil', ['verify', dmgPath]);
  await verifyDeveloperIdSignature(dmgPath, signingIdentity, teamId);
  await runCommand('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=4',
    dmgPath,
  ]);
  await runCommand('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);

  const mountPoint = await mkdtemp(join(tmpdir(), 'session-deck-dmg-'));
  try {
    await runCommand('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mountPoint,
      dmgPath,
    ]);
    const mountedApp = join(mountPoint, `${PRODUCT_NAME}.app`);
    await stat(mountedApp);
    await verifyAppBundle(mountedApp, arch, signingIdentity, teamId);
  } finally {
    await runCommand('/usr/bin/hdiutil', ['detach', mountPoint]).catch(() => undefined);
    await rm(mountPoint, { recursive: true, force: true });
  }
}

/** @param {MacosArtifactOptions} options */
export function tauriBuildArgsForOptions(options) {
  const args = ['build', '--bundles', 'app,dmg', '--ci'];
  if (options.target !== null) args.push('--target', options.target);
  if (!options.trustedRelease) args.push('--no-sign');
  return args;
}

/** @param {MacosArtifactOptions} options */
function validateOptions(options) {
  if (options.target !== null && artifactArchForTarget(options.target) !== options.arch) {
    throw new Error(
      `Target ${options.target} does not match artifact architecture ${options.arch}.`,
    );
  }
  if (options.trustedRelease && options.target === null) {
    throw new Error('Trusted releases require an explicit target.');
  }
}

/** @param {MacosArtifactOptions} options @returns {Promise<ReleaseArtifactMetadata>} */
export async function buildMacosArtifactsFromOptions(options) {
  validateOptions(options);
  if (hostPlatform() !== 'darwin' && (!options.skipBuild || options.trustedRelease)) {
    throw new Error('macOS desktop artifacts must be built and verified on a macOS runner.');
  }

  if (options.trustedRelease) {
    await preflightTrustedReleaseEnvironment();
  } else {
    console.warn('Building unsigned local Session Deck desktop artifacts.');
  }

  await writeDesktopReleaseVersion(options.version);
  if (!options.skipBuild) {
    const exitCode = await runTauri(tauriBuildArgsForOptions(options));
    if (exitCode !== 0) throw new Error(`tauri build exited with code ${exitCode}`);
  }

  const bundleRoot = bundleRootForTarget(options.target);
  const appBundlePath = await findAppBundle(bundleRoot);
  const dmgArtifactPath = await findDmgArtifact(bundleRoot);
  if (options.trustedRelease && dmgArtifactPath === null) {
    throw new Error(`Trusted release requires a DMG in ${join(bundleRoot, 'dmg')}.`);
  }

  let postBuildVerified = false;
  if (options.trustedRelease) {
    const signingIdentity = /** @type {string} */ (process.env['APPLE_SIGNING_IDENTITY']);
    const teamId = /** @type {string} */ (process.env['APPLE_TEAM_ID']);
    await verifyAppBundle(appBundlePath, options.arch, signingIdentity, teamId);
    await verifyDmg(/** @type {string} */ (dmgArtifactPath), options.arch, signingIdentity, teamId);
    postBuildVerified = true;
  }
  const trust = releaseTrustMetadata(options.trustedRelease, postBuildVerified);

  await rm(options.artifactDir, { recursive: true, force: true });
  await mkdir(options.artifactDir, { recursive: true });
  const stem = macosArtifactStem(options.version, options.arch);
  const zipPath = join(options.artifactDir, `${stem}.zip`);
  await zipAppBundle(appBundlePath, zipPath);

  /** @type {ArtifactMetadata[]} */
  const artifacts = [await writeArtifactChecksum(zipPath)];
  if (dmgArtifactPath !== null) {
    const dmgPath = join(options.artifactDir, `${stem}.dmg`);
    await copyFile(dmgArtifactPath, dmgPath);
    artifacts.push(await writeArtifactChecksum(dmgPath));
  } else {
    console.warn('No Tauri DMG output found; local output contains the zipped app only.');
  }

  /** @type {ReleaseArtifactMetadata} */
  const metadata = {
    schemaVersion: 1,
    product: 'session-deck-desktop',
    packageName: '@robhowley/pi-session-deck',
    version: options.version,
    platform: 'macos',
    arch: options.arch,
    ...trust,
    artifacts,
  };
  const metadataPath = join(options.artifactDir, `${stem}.metadata.json`);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await writeArtifactChecksum(metadataPath);
  return metadata;
}

/** @param {string[]} argv */
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
