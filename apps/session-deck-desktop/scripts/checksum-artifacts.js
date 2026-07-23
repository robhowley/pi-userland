#!/usr/bin/env node
/* global process, console */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(undefined));
  });
  return hash.digest('hex');
}

/**
 * @param {string} hash
 * @param {string} fileName
 * @returns {string}
 */
export function formatSha256Line(hash, fileName) {
  return `${hash}  ${fileName}\n`;
}

/**
 * @param {string} filePath
 * @returns {Promise<{ filePath: string, checksumPath: string, sha256: string }>}
 */
export async function writeChecksumForFile(filePath) {
  const sha256 = await sha256File(filePath);
  const checksumPath = `${filePath}.sha256`;
  await writeFile(checksumPath, formatSha256Line(sha256, basename(filePath)), 'utf8');
  return { filePath, checksumPath, sha256 };
}

/**
 * @param {string[]} filePaths
 * @returns {Promise<Array<{ filePath: string, checksumPath: string, sha256: string }>>}
 */
export async function checksumArtifacts(filePaths = process.argv.slice(2)) {
  if (filePaths.length === 0) {
    throw new Error('Usage: node scripts/checksum-artifacts.js <artifact> [artifact...]');
  }

  /** @type {Array<{ filePath: string, checksumPath: string, sha256: string }>} */
  const results = [];
  for (const filePath of filePaths) {
    results.push(await writeChecksumForFile(filePath));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await checksumArtifacts();
    for (const result of results) {
      console.log(`${result.sha256}  ${result.filePath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
