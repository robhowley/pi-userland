/**
 * Workspace boundary check for the yolo-seatbelt safety guard.
 *
 * Phase A: Now uses the RuleDefinition system with id 'boundary.outside-workspace'
 * for user-configurable severity overrides.
 */

import * as path from 'path';
import { BOUNDARY_RULES, RuleDefinition } from './rules.js';

/**
 * Check if a resolved path is inside the current working directory.
 *
 * Handles relative paths (../, ./), normalizes the path, and verifies
 * the resolved path is within the workspace boundary.
 *
 * @param resolvedPath - Absolute or normalized path to check
 * @param cwd - Current working directory
 * @returns true if path is inside workspace, false otherwise
 */
export function isInsideWorkspace(resolvedPath: string, cwd: string): boolean {
  try {
    // Normalize cwd - remove trailing slashes
    const normalizedCwd = path.resolve(cwd).replace(/\/+$/, '');

    // Resolve the path relative to cwd if it's not absolute
    let normalizedPath: string;
    if (path.isAbsolute(resolvedPath)) {
      normalizedPath = path.resolve(resolvedPath);
    } else {
      normalizedPath = path.resolve(normalizedCwd, resolvedPath);
    }

    // Normalize both paths for comparison
    const normalizedPathClean = normalizedPath.replace(/\/+$/, '');
    const normalizedCwdClean = normalizedCwd.replace(/\/+$/, '');

    // Check if path is inside cwd
    // Path must start with cwd followed by either end or a separator
    return (
      normalizedPathClean === normalizedCwdClean ||
      normalizedPathClean.startsWith(normalizedCwdClean + path.sep)
    );
  } catch {
    // If path resolution fails, return false (safe default)
    return false;
  }
}

/**
 * Check if a path segment could resolve outside the workspace.
 *
 * This is a quick check for common dangerous patterns like ../ or absolute paths
 * that don't require full path resolution.
 *
 * @param pathSegment - Path segment to check
 * @param cwd - Current working directory
 * @returns true if path appears to be outside workspace, false otherwise
 */
export function isOutsideWorkspaceQuickCheck(pathSegment: string, cwd: string): boolean {
  const normalizedCwd = path.resolve(cwd);

  // Absolute paths that are not inside cwd
  if (path.isAbsolute(pathSegment)) {
    try {
      const resolvedPath = path.resolve(pathSegment);
      return !resolvedPath.startsWith(normalizedCwd + path.sep) && resolvedPath !== normalizedCwd;
    } catch {
      return true; // Safe default
    }
  }

  // Paths starting with ../ are likely outside
  if (pathSegment.startsWith('../')) {
    return true;
  }

  // Paths with multiple ../ segments
  if (pathSegment.includes('../')) {
    return true;
  }

  // Single .. segment
  if (pathSegment === '..' || pathSegment === '../') {
    return true;
  }

  return false;
}

/**
 * Check if a command targets paths outside the workspace.
 * Returns the boundary rule if matched.
 *
 * @param command - Raw command string to check
 * @param cwd - Current working directory
 * @returns RuleDefinition if outside workspace pattern matches, undefined otherwise
 */
export function getBoundaryRule(command: string, cwd: string): RuleDefinition | undefined {
  // Check for paths outside workspace
  const absolutePathRegex = /(["']?)(\/(?:[^\s"']+\/?)+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = absolutePathRegex.exec(command)) !== null) {
    const pathStr = match[2];
    if (pathStr && !isInsideWorkspace(pathStr, cwd)) {
      return BOUNDARY_RULES[0]; // boundary.outside-workspace
    }
  }
  return undefined;
}

/**
 * Get the boundary rule ID for outside workspace detection.
 * @deprecated Use getBoundaryRule() instead
 * @param command - Raw command string
 * @param cwd - Current working directory
 * @returns Rule ID if outside workspace, undefined otherwise
 */
export function getOutsideWorkspaceRuleId(command: string, cwd: string): string | undefined {
  const rule = getBoundaryRule(command, cwd);
  return rule?.id;
}
