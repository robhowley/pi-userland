#!/usr/bin/env node
/* global process, console */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} findIdentityOutput
 * @returns {{ APPLE_SIGNING_IDENTITY: string, APPLE_TEAM_ID: string }}
 */
export function deriveAppleSigningIdentity(findIdentityOutput) {
  const identityLines = findIdentityOutput
    .split(/\r?\n/u)
    .filter((line) => /^\s*\d+\)/u.test(line));

  if (identityLines.length !== 1) {
    throw new Error(
      `Expected exactly one codesigning identity in the temporary keychain; found ${identityLines.length}.`,
    );
  }

  const lineMatch = identityLines[0]?.match(/^\s*\d+\)\s+[A-F0-9]{40}\s+"(.+)"\s*$/u);
  if (!lineMatch) {
    throw new Error('Could not parse the codesigning identity in the temporary keychain.');
  }

  const signingIdentity = lineMatch[1] ?? '';
  const identityMatch = signingIdentity.match(/^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/u);
  if (!identityMatch) {
    throw new Error(
      'The temporary keychain must contain one Developer ID Application identity ending in a ten-character Team ID.',
    );
  }

  return {
    APPLE_SIGNING_IDENTITY: signingIdentity,
    APPLE_TEAM_ID: identityMatch[1] ?? '',
  };
}

function main() {
  const values = deriveAppleSigningIdentity(readFileSync(0, 'utf8'));
  for (const [name, value] of Object.entries(values)) {
    process.stdout.write(`${name}=${value}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
