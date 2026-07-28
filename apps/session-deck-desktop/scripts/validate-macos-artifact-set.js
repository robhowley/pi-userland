#!/usr/bin/env node
/* global process, console */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { macosArtifactStem, normalizeReleaseVersion } from './build-macos-artifacts.js';
import { formatSha256Line, sha256File } from './checksum-artifacts.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const ARCHITECTURES = /** @type {const} */ (['arm64', 'x64']);
const PAYLOAD_EXTENSIONS = /** @type {const} */ (['zip', 'dmg']);

/** @param {string} version */
export function expectedMacosArtifactNames(version) {
  const names = [];
  for (const arch of ARCHITECTURES) {
    const stem = macosArtifactStem(version, arch);
    for (const extension of [...PAYLOAD_EXTENSIONS, 'metadata.json']) {
      const name = `${stem}.${extension}`;
      names.push(name, `${name}.sha256`);
    }
  }
  return names.sort();
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} field */
function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Artifact metadata ${field} must be a non-empty string.`);
  }
  return value;
}

/** @param {string} artifactPath */
async function validateFileAndSidecar(artifactPath) {
  const fileStats = await lstat(artifactPath);
  if (!fileStats.isFile() || fileStats.size <= 0) {
    throw new Error(`Expected a non-empty regular file: ${artifactPath}`);
  }
  const hash = await sha256File(artifactPath);
  const sidecarPath = `${artifactPath}.sha256`;
  const sidecarStats = await lstat(sidecarPath);
  if (!sidecarStats.isFile()) throw new Error(`Expected a regular checksum file: ${sidecarPath}`);
  const sidecar = await readFile(sidecarPath, 'utf8');
  const expectedSidecar = formatSha256Line(hash, basename(artifactPath));
  if (sidecar !== expectedSidecar) {
    throw new Error(`Checksum sidecar does not match ${basename(artifactPath)}.`);
  }
  return { hash, bytes: fileStats.size };
}

/** @param {string} artifactDir @param {string} version @param {'arm64' | 'x64'} arch */
async function validateArchitectureMetadata(artifactDir, version, arch) {
  const stem = macosArtifactStem(version, arch);
  const metadataPath = join(artifactDir, `${stem}.metadata.json`);
  await validateFileAndSidecar(metadataPath);

  const parsed = /** @type {unknown} */ (JSON.parse(await readFile(metadataPath, 'utf8')));
  if (!isRecord(parsed)) throw new Error(`${basename(metadataPath)} must contain a JSON object.`);
  const exactFields = {
    schemaVersion: 1,
    product: 'session-deck-desktop',
    packageName: '@robhowley/pi-session-deck',
    version,
    platform: 'macos',
    arch,
    signed: true,
    notarized: true,
  };
  for (const [field, expected] of Object.entries(exactFields)) {
    if (parsed[field] !== expected) {
      throw new Error(
        `${basename(metadataPath)} has invalid ${field}; expected ${String(expected)}.`,
      );
    }
  }

  if (!Array.isArray(parsed['artifacts']) || parsed['artifacts'].length !== 2) {
    throw new Error(`${basename(metadataPath)} must describe exactly the ZIP and DMG.`);
  }

  const expectedPayloadNames = PAYLOAD_EXTENSIONS.map((extension) => `${stem}.${extension}`).sort();
  const metadataByName = new Map();
  for (const value of parsed['artifacts']) {
    if (!isRecord(value))
      throw new Error(`${basename(metadataPath)} has an invalid artifact entry.`);
    const name = requireString(value['name'], 'artifacts[].name');
    if (metadataByName.has(name))
      throw new Error(`${basename(metadataPath)} repeats artifact ${name}.`);
    metadataByName.set(name, value);
  }
  if (JSON.stringify([...metadataByName.keys()].sort()) !== JSON.stringify(expectedPayloadNames)) {
    throw new Error(`${basename(metadataPath)} does not describe the expected ZIP and DMG.`);
  }

  for (const payloadName of expectedPayloadNames) {
    const actual = await validateFileAndSidecar(join(artifactDir, payloadName));
    const entry = /** @type {Record<string, unknown>} */ (metadataByName.get(payloadName));
    if (entry['sha256'] !== actual.hash) {
      throw new Error(`${basename(metadataPath)} has the wrong hash for ${payloadName}.`);
    }
    if (entry['bytes'] !== actual.bytes) {
      throw new Error(`${basename(metadataPath)} has the wrong byte size for ${payloadName}.`);
    }
  }
}

/** @param {string} artifactDir @param {string} version */
export async function validateCompleteMacosArtifactSet(artifactDir, version) {
  const normalizedVersion = normalizeReleaseVersion(version);
  const expectedNames = expectedMacosArtifactNames(normalizedVersion);
  const entries = await readdir(artifactDir, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Incomplete desktop artifact inventory. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`,
    );
  }

  await Promise.all(
    ARCHITECTURES.map((arch) => validateArchitectureMetadata(artifactDir, normalizedVersion, arch)),
  );
  return expectedNames;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let version = null;
  let artifactDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') {
      version = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--artifact-dir') {
      artifactDir = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg ?? ''}`);
    }
  }
  if (!version) throw new Error('Missing --version <pi-session-deck-version>.');
  if (!artifactDir) throw new Error('Missing --artifact-dir <directory>.');
  return { version, artifactDir: resolve(PACKAGE_ROOT, artifactDir) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const names = await validateCompleteMacosArtifactSet(options.artifactDir, options.version);
    console.log(`Validated ${names.length} signed and notarized Session Deck desktop files.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
