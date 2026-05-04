/**
 * Protected path detection for the yolo-seatbelt safety guard.
 *
 * Phase D: Simplified - uses BUILTIN_RULES directly.
 */

import { BUILTIN_RULES, RuleDefinition } from './rules.js';

/**
 * List of protected path prefixes/patterns (legacy array for compatibility)
 * @deprecated Use BUILTIN_RULES with irreversible.path-* patterns instead
 */
export const PROTECTED_PATHS = [
  '.git',
  '.env',
  '.env.',
  '.ssh',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  '.pem',
];

/**
 * Check if a resolved path targets a protected location.
 *
 * Uses prefix matching for directories and exact/filename matching for files.
 *
 * @param resolvedPath - Absolute or normalized path to check
 * @returns true if path targets a protected location, false otherwise
 */
export function isProtectedPath(resolvedPath: string): boolean {
  const normalizedPath = resolvedPath.replace(/\\/g, '/').replace(/\/+$/, '');

  for (const protectedPath of PROTECTED_PATHS) {
    const protectedNormalized = protectedPath.replace(/\\/g, '/');

    if (normalizedPath === protectedNormalized) {
      return true;
    }

    if (normalizedPath.startsWith(protectedNormalized + '/')) {
      return true;
    }

    const pathParts = normalizedPath.split('/');
    for (let i = 0; i < pathParts.length; i++) {
      if (pathParts[i] === protectedPath) {
        return true;
      }
    }

    if (protectedPath === '.env') {
      for (const part of pathParts) {
        if (part === '.env' || part.startsWith('.env.')) {
          return true;
        }
      }
    }

    if (protectedPath === '.pem') {
      for (const part of pathParts) {
        if (part === '.pem' || part.endsWith('.pem')) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a path segment (filename or directory name) is protected.
 *
 * @param pathSegment - Single path component to check
 * @returns true if the segment is protected
 */
export function isProtectedPathSegment(pathSegment: string): boolean {
  const normalized = pathSegment.replace(/\\/g, '/');

  for (const protectedPath of PROTECTED_PATHS) {
    if (normalized === protectedPath) {
      return true;
    }
    if (protectedPath === '.env') {
      if (normalized === '.env' || normalized.startsWith('.env.')) {
        return true;
      }
    }
    if (protectedPath === '.pem') {
      if (normalized === '.pem' || normalized.endsWith('.pem')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get the irreversible path rule definition that matches a path.
 *
 * @param resolvedPath - Absolute or normalized path to check
 * @returns RuleDefinition if a path rule matches, undefined otherwise
 */
export function getProtectedPathRule(resolvedPath: string): RuleDefinition | undefined {
  for (const rule of BUILTIN_RULES) {
    if (rule.pattern.test(resolvedPath)) {
      return rule;
    }
  }
  return undefined;
}
