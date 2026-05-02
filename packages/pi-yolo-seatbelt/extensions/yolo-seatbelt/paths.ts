/**
 * Protected path detection for the yolo-seatbelt safety guard.
 *
 * Detects writes/deletes targeting sensitive paths like .git, .env files,
 * SSH keys, and credentials files.
 */

/** List of protected path prefixes/patterns */
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
 * Uses prefix matching for directories (e.g., .git matches .git/ dir)
 * and exact/filename matching for files.
 *
 * @param resolvedPath - Absolute or normalized path to check
 * @returns true if path targets a protected location, false otherwise
 */
export function isProtectedPath(resolvedPath: string): boolean {
  // Normalize the path for comparison
  const normalizedPath = resolvedPath.replace(/\\/g, '/').replace(/\/+$/, ''); // trailing slashes

  // Check each protected path
  for (const protectedPath of PROTECTED_PATHS) {
    const protectedNormalized = protectedPath.replace(/\\/g, '/');

    // For directory patterns (those ending with / or being a directory):
    // Match if the path starts with the protected path followed by / or is exactly the protected path
    // For file patterns:
    // Match only if the path is exactly the protected path or ends with the protected path as a filename

    if (normalizedPath === protectedNormalized) {
      // Exact match
      return true;
    }

    // Check if it's a directory prefix match (e.g., .git matches .git/ or .git/something)
    if (normalizedPath.startsWith(protectedNormalized + '/')) {
      return true;
    }

    // Check if protected path appears as a directory component
    // e.g., /repo/.git/anything should match .git
    const pathParts = normalizedPath.split('/');
    for (let i = 0; i < pathParts.length; i++) {
      if (pathParts[i] === protectedPath) {
        return true;
      }
    }

    // Handle .env.* patterns - match .env followed by . or end
    if (protectedPath === '.env') {
      for (const part of pathParts) {
        if (part === '.env' || part.startsWith('.env.')) {
          return true;
        }
      }
    }

    // Handle .pem files - match files ending with .pem
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
 * Useful for checking individual components without full path resolution.
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
    // Handle .env.* patterns - must be .env followed by . or end
    if (protectedPath === '.env') {
      if (normalized === '.env' || normalized.startsWith('.env.')) {
        return true;
      }
    }
    // Handle .pem files - match files ending with .pem
    if (protectedPath === '.pem') {
      if (normalized === '.pem' || normalized.endsWith('.pem')) {
        return true;
      }
    }
  }

  return false;
}
